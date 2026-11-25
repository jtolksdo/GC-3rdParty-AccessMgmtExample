// WX-84 Weather Command Unit - local demo server (zero dependencies).
//
//   npm start            -> http://localhost:3000            (cockpit / agent tool)
//                           http://localhost:3000/customer/  (customer web-messaging page)
//
// Every API request is authorized against data/users.txt at request time.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, getConfig } from './config.js';
import { STATION_IDS, publicStations } from './stations.js';
import * as perms from './permissions.js';
import * as sessions from './sessions.js';
import * as audit from './audit.js';
import { getWeather } from './weather.js';
import { verifyGenesysToken, genesysConfigured, HttpError } from './genesys.js';
import { findToolUser } from './identity.js';
import { cleanCustomerName } from './customer.js';

perms.ensureUsersFile();

const HOST = process.env.HOST || '127.0.0.1'; // loopback only: not reachable from your LAN
const PUBLIC_DIR = path.join(ROOT, 'public');
const CUSTOMER_DIR = path.join(ROOT, 'customer');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/;

// Only Genesys Cloud may embed the agent tool in an iframe (clickjacking protection).
const GENESYS_FRAME_ANCESTORS = [
  "'self'", 'https://*.pure.cloud', 'https://*.mypurecloud.com', 'https://*.mypurecloud.de',
  'https://*.mypurecloud.ie', 'https://*.mypurecloud.jp', 'https://*.mypurecloud.com.au',
  'https://*.genesys.cloud',
].join(' ');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------- helpers ---

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 16 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

/**
 * True only for requests typed into a browser on THIS machine. Requests that
 * arrive through a tunnel (cloudflared, ngrok) also come from 127.0.0.1, but
 * carry forwarding headers and a public Host - those are treated as remote.
 */
function isLocalRequest(req) {
  const addr = req.socket.remoteAddress || '';
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
  const forwarded = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'cf-connecting-ip', 'x-real-ip']
    .some((h) => req.headers[h] !== undefined);
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return loopback && !forwarded && ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

function localLoginAllowed(req) {
  return getConfig().allowLocalLogin && isLocalRequest(req);
}

function authenticate(req) {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  const session = sessions.getSession(match?.[1]);
  if (!session) throw new HttpError(401, 'Not signed in');
  const user = perms.findUser(session.username);
  if (!user) {
    sessions.deleteSession(match[1]);
    throw new HttpError(401, 'This user no longer exists');
  }
  return { token: match[1], session, user };
}

function requireAdmin(ctx, action) {
  if (ctx.user.role !== 'admin') {
    audit.record({ actor: ctx.user.username, source: ctx.session.source, action, result: 'DENIED', detail: 'admin clearance required' });
    throw new HttpError(403, 'ACCESS DENIED - admin clearance required');
  }
}

function describeMe(ctx) {
  return {
    username: ctx.user.username,
    role: ctx.user.role,
    stations: perms.allowedStations(ctx.user),
    source: ctx.session.source,
    genesys: ctx.session.genesys ? { name: ctx.session.genesys.name, email: ctx.session.genesys.email } : null,
    permissionsVersion: perms.permissionsVersion(),
  };
}

/** Log a station access once per session and permission version (polling would flood the log). */
function recordStationAccess(ctx, stationId, result) {
  const key = `${stationId}:${perms.permissionsVersion()}:${result}`;
  if (ctx.session.seen.has(key)) return;
  ctx.session.seen.add(key);
  audit.record({ actor: ctx.user.username, source: ctx.session.source, action: 'VIEW STATION', target: stationId, result });
}

// ----------------------------------------------------------------- routes ---

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/config$/, (req) => {
  const cfg = getConfig();
  return {
    appName: 'WX-84 Weather Command Unit',
    localLogin: localLoginAllowed(req),
    genesys: {
      configured: genesysConfigured(cfg),
      region: cfg.genesys.region,
      oauthClientId: cfg.genesys.oauthClientId,
    },
    messenger: {
      configured: Boolean(cfg.genesys.messengerDeploymentId),
      deploymentId: cfg.genesys.messengerDeploymentId,
      environment: cfg.genesys.messengerEnvironment,
      scriptUrl: cfg.genesys.messengerScriptUrl || `https://apps.${cfg.genesys.region}/genesys-bootstrap/genesys.min.js`,
    },
    stations: publicStations(),
  };
});

route('GET', /^\/api\/login-users$/, (req) => {
  if (!localLoginAllowed(req)) throw new HttpError(403, 'Local sign-in is only available on this computer');
  return { users: perms.getUsers().map(({ username, role }) => ({ username, role })) };
});

route('POST', /^\/api\/session\/local$/, async (req) => {
  if (!localLoginAllowed(req)) throw new HttpError(403, 'Local sign-in is only available on this computer');
  const { username } = await readJson(req);
  const user = perms.findUser(username);
  if (!user) throw new HttpError(404, 'Unknown user');
  const token = sessions.createSession({ username: user.username, source: 'local' });
  audit.record({ actor: user.username, source: 'local', action: 'SIGN-IN', result: 'GRANTED' });
  return { token };
});

route('POST', /^\/api\/session\/genesys$/, async (req) => {
  const { accessToken, handoff } = await readJson(req);
  if (handoff !== undefined && !sessions.HANDOFF_ID.test(String(handoff))) throw new HttpError(400, 'Invalid handoff id');
  const park = (status, body) => handoff && sessions.parkHandoff(handoff, { status, body });
  try {
    const cfg = getConfig();
    const genesysUser = await verifyGenesysToken(accessToken, cfg);
    const user = findToolUser(genesysUser, perms.getUsers());
    if (!user) {
      audit.record({ actor: genesysUser.email || genesysUser.id, source: 'genesys', action: 'SIGN-IN', result: 'DENIED', detail: 'no WX-84 account mapped' });
      throw new HttpError(403, `ACCESS DENIED - no WX-84 account for ${genesysUser.name} <${genesysUser.email}>`);
    }
    const token = sessions.createSession({
      username: user.username,
      source: 'genesys',
      genesys: { id: genesysUser.id, name: genesysUser.name, email: genesysUser.email },
      genesysAccessToken: accessToken,
    });
    audit.record({ actor: user.username, source: 'genesys', action: 'SIGN-IN', result: 'GRANTED', detail: `as ${genesysUser.name} <${genesysUser.email}>` });
    park(200, { token });
    // With a handoff, the session token goes ONLY to the iframe that collects it.
    return handoff ? { ok: true, username: user.username } : { token };
  } catch (err) {
    if (err instanceof HttpError) park(err.status, { error: err.message });
    throw err;
  }
});

route('GET', /^\/api\/session\/handoff\/([A-Za-z0-9_-]{22,64})$/, (req, res, [id]) => {
  const result = sessions.collectHandoff(id);
  if (!result) return { pending: true };
  if (result.status !== 200) throw new HttpError(result.status, result.body.error);
  return result.body;
});

route('DELETE', /^\/api\/session$/, (req) => {
  const ctx = authenticate(req);
  sessions.deleteSession(ctx.token);
  audit.record({ actor: ctx.user.username, source: ctx.session.source, action: 'SIGN-OUT', result: 'OK' });
  return { ok: true };
});

route('GET', /^\/api\/me$/, (req) => describeMe(authenticate(req)));

route('GET', /^\/api\/weather$/, async (req) => {
  const ctx = authenticate(req);
  const allowed = perms.allowedStations(ctx.user);
  const weather = await getWeather();
  // Server-side filtering: data for stations you may not see never leaves the server.
  const stations = Object.fromEntries(allowed.map((id) => [id, weather.stations[id]]).filter(([, v]) => v));
  allowed.forEach((id) => recordStationAccess(ctx, id, 'GRANTED'));
  return { fetchedAt: weather.fetchedAt, source: weather.source, stations };
});

route('GET', /^\/api\/weather\/([a-z-]+)$/, async (req, res, [stationId]) => {
  const ctx = authenticate(req);
  if (!STATION_IDS.includes(stationId)) throw new HttpError(404, 'Unknown station');
  if (!perms.canAccess(ctx.user, stationId)) {
    recordStationAccess(ctx, stationId, 'DENIED');
    throw new HttpError(403, `ACCESS DENIED - ${ctx.user.username} has no clearance for ${stationId}`);
  }
  recordStationAccess(ctx, stationId, 'GRANTED');
  const weather = await getWeather();
  return { fetchedAt: weather.fetchedAt, source: weather.source, station: weather.stations[stationId] };
});

// Which station did the customer pick, and what last name did they give the bot?
// Read from the conversation's participant data with the agent's own Genesys
// token (kept server-side in the session), so Genesys Cloud decides whether this
// agent may see the conversation at all. The name is passed through, never logged.
route('GET', /^\/api\/genesys\/conversations\/([^/]+)\/station$/, async (req, res, [conversationId]) => {
  const ctx = authenticate(req);
  if (ctx.session.source !== 'genesys') throw new HttpError(400, 'Only available for Genesys Cloud sign-ins');
  if (!UUID.test(conversationId)) throw new HttpError(400, 'Invalid conversation id');
  const cfg = getConfig();
  const r = await fetch(`https://api.${cfg.genesys.region}/api/v2/conversations/${conversationId}`, {
    headers: { Authorization: `Bearer ${ctx.session.genesysAccessToken}` },
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 401) throw new HttpError(401, 'Genesys session expired - please reconnect');
  if (!r.ok) throw new HttpError(502, `Genesys Cloud answered HTTP ${r.status} for the conversation`);
  const conversation = await r.json();
  const attributes = Object.assign({}, ...(conversation.participants || []).map((p) => p.attributes || {}));
  const raw = String(attributes['wx84.station'] || attributes.location || '').toLowerCase().trim();
  return {
    stationId: STATION_IDS.includes(raw) ? raw : null,
    raw: raw || null,
    customer: { lastName: cleanCustomerName(attributes['wx84.lastName']) },
  };
});

route('GET', /^\/api\/admin\/users$/, (req) => {
  const ctx = authenticate(req);
  requireAdmin(ctx, 'OPEN ADMIN PANEL');
  return { users: perms.getUsers(), stations: publicStations(), permissionsVersion: perms.permissionsVersion() };
});

route('PUT', /^\/api\/admin\/users\/([a-z0-9._-]+)$/, async (req, res, [username]) => {
  const ctx = authenticate(req);
  requireAdmin(ctx, 'CHANGE PERMISSIONS');
  const body = await readJson(req);
  const users = perms.getUsers().map((u) => ({ ...u, stations: [...u.stations] }));
  const target = users.find((u) => u.username === username);
  if (!target) throw new HttpError(404, 'Unknown user');

  const role = body.role ?? target.role;
  if (!['admin', 'agent'].includes(role)) throw new HttpError(400, 'role must be admin or agent');
  if (target.username === ctx.user.username && role !== 'admin') {
    throw new HttpError(409, 'You cannot remove your own admin clearance');
  }
  const stations = body.stations ?? target.stations;
  if (!Array.isArray(stations) || !stations.every((s) => s === '*' || STATION_IDS.includes(s))) {
    throw new HttpError(400, `stations must be a list of: ${STATION_IDS.join(', ')} (or "*")`);
  }
  // Validation also prevents "|" or line breaks from corrupting the text file.
  const genesysEmail = String(body.genesysEmail ?? target.genesysEmail).trim().toLowerCase();
  if (genesysEmail && (!EMAIL.test(genesysEmail) || genesysEmail.length > 200)) {
    throw new HttpError(400, 'genesysEmail must be a valid e-mail address (or empty)');
  }

  const before = `${target.role} [${target.stations.join(',') || '-'}] ${target.genesysEmail || '-'}`;
  Object.assign(target, { role, stations: [...new Set(stations)], genesysEmail });
  const after = `${target.role} [${target.stations.join(',') || '-'}] ${target.genesysEmail || '-'}`;
  perms.saveUsers(users);
  audit.record({ actor: ctx.user.username, source: ctx.session.source, action: 'CHANGE PERMISSIONS', target: username, result: 'OK', detail: `${before} -> ${after}` });
  return { user: perms.findUser(username), permissionsVersion: perms.permissionsVersion() };
});

route('GET', /^\/api\/admin\/audit$/, (req) => {
  const ctx = authenticate(req);
  requireAdmin(ctx, 'READ FLIGHT RECORDER');
  return { entries: audit.recent(80) };
});

// ----------------------------------------------------------- static files ---

function serveStatic(req, res, pathname) {
  const isCustomer = pathname === '/customer' || pathname.startsWith('/customer/');
  if (pathname === '/customer') {
    res.writeHead(301, { Location: '/customer/' });
    return res.end();
  }
  const baseDir = isCustomer ? CUSTOMER_DIR : PUBLIC_DIR;
  let rel = isCustomer ? pathname.slice('/customer'.length) : pathname;
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(baseDir, decodeURIComponent(rel)));
  if (!file.startsWith(baseDir + path.sep)) return sendJson(res, 403, { error: 'Forbidden' }); // path traversal guard
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `frame-ancestors ${isCustomer ? "'self'" : GENESYS_FRAME_ANCESTORS}`,
    });
    res.end(data);
  });
}

// ----------------------------------------------------------------- server ---

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, pathname);
  }
  const match = routes.find((r) => r.method === req.method && r.pattern.test(pathname));
  if (!match) return sendJson(res, 404, { error: 'Unknown API route' });
  try {
    const params = match.pattern.exec(pathname).slice(1);
    const result = await match.handler(req, res, params);
    if (!res.headersSent) sendJson(res, 200, result);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('[server]', err);
    sendJson(res, status, { error: status === 500 ? 'Internal error' : err.message });
  }
});

const { port } = getConfig();
server.listen(port, HOST, () => {
  const cfg = getConfig();
  const line = '-'.repeat(64);
  console.log(`\n${line}\n  WX-84 WEATHER COMMAND UNIT - online\n${line}`);
  console.log(`  Agent tool      http://localhost:${port}/`);
  console.log(`  Customer page   http://localhost:${port}/customer/`);
  console.log(`  Permissions     ${path.relative(ROOT, perms.USERS_FILE)} (${perms.getUsers().length} users)`);
  console.log(`  Local sign-in   ${cfg.allowLocalLogin ? 'enabled (this computer only)' : 'disabled'}`);
  console.log(`  Genesys Cloud   ${genesysConfigured(cfg) ? `configured (${cfg.genesys.region})` : 'not configured - run npm run genesys:setup'}`);
  console.log(`  Messenger       ${cfg.genesys.messengerDeploymentId ? 'configured' : 'not configured'}\n${line}\n`);
});
