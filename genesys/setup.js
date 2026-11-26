#!/usr/bin/env node
// WX-84 - Genesys Cloud provisioning script (idempotent, zero dependencies).
//
// Creates or updates everything the demo needs in a Genesys Cloud org:
//   agents (users + roles + invite) -> group -> one queue whose members are the
//   group -> name bot + inbound message flow -> removal of the retired station
//   queues -> Messenger configuration + deployment -> PKCE OAuth client
//   -> Interaction Widget integration -> config/config.json + data/users.txt
//
// Usage:
//   npm run genesys:setup                                   create / update
//   npm run genesys:setup -- --public-url https://abc.trycloudflare.com
//   npm run genesys:status                                  read-only check (--dry-run)
//   add --no-phones to skip the optional WebRTC phone per agent
//
// Credentials (Client Credentials grant, role e.g. Master Admin), first match wins:
//   1. env GENESYS_CLIENT_ID / GENESYS_CLIENT_SECRET
//   2. macOS keychain: service "wx84-genesys-setup", accounts "client-id" / "client-secret"
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, CONFIG_FILE, getConfig } from '../server/config.js';
import { USERS_FILE, ensureUsersFile, getUsers, saveUsers } from '../server/permissions.js';

// ------------------------------------------------------------------ names ---

const NAMES = {
  group: 'WX-84 Agents',
  flow: 'WX-84 Station Router',
  botFlow: 'WX-84 Name Collector',
  messengerConfig: 'WX-84 Flight Weather Desk',
  deployment: 'WX-84 Flight Weather Desk',
  oauthClient: 'WX-84 Agent Console (PKCE)',
  integration: 'WX-84 Weather Command Unit',
  // Every chat goes to this one queue. Its members are the group above, so
  // whoever is in "WX-84 Agents" takes chats; WX-84 decides what each one sees.
  queue: 'WX-84 Weather Desk',
  // Station queues of the first design. The setup deletes them once the router
  // no longer sends chats there.
  retiredQueues: ['WX-84 Menlo Park', 'WX-84 Indianapolis', 'WX-84 Melbourne', 'WX-84 Supervisor'],
};
const FLOW_DIR = path.join(ROOT, 'genesys', 'flow');
// Deployed in this order: the station router calls the name bot by name.
const FLOWS = [
  { name: NAMES.botFlow, type: 'digitalbot', file: 'wx84-name-collector.yaml' },
  { name: NAMES.flow, type: 'inboundshortmessage', file: 'wx84-station-router.yaml' },
];
const AGENTS_FILE = path.join(ROOT, 'genesys', 'agents.json');
const KEYCHAIN_SERVICE = 'wx84-genesys-setup';

// ------------------------------------------------------------------- args ---

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_PHONES = args.includes('--no-phones');
const urlArg = args.find((a, i) => args[i - 1] === '--public-url') || args.find((a) => a.startsWith('--public-url='))?.split('=')[1];

// ----------------------------------------------------------------- output ---

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = c(32); const yellow = c(33); const red = c(31); const dim = c(2); const bold = c(1);
const step = (title) => console.log(`\n${bold(title)}`);
const ok = (msg) => console.log(`  ${green('✔')} ${msg}`);
const same = (msg) => console.log(`  ${dim('=')} ${msg}`);
const warn = (msg) => console.log(`  ${yellow('!')} ${msg}`);
const plan = (msg) => console.log(`  ${yellow('+')} ${msg} ${dim('(dry run: not created)')}`);
const fail = (msg) => { console.error(`\n${red('✖')} ${msg}\n`); process.exit(1); };

// ------------------------------------------------------------ credentials ---

function keychain(account) {
  if (process.platform !== 'darwin') return '';
  try {
    return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function credentials() {
  const id = process.env.GENESYS_CLIENT_ID || keychain('client-id');
  const secret = process.env.GENESYS_CLIENT_SECRET || keychain('client-secret');
  if (!id || !secret) {
    fail(`No Genesys Cloud credentials found.
  Create an OAuth client (Admin > Integrations > OAuth, grant type "Client Credentials", role "Master Admin"),
  then store it in the macOS keychain (you will be prompted for each value):
    security add-generic-password -s ${KEYCHAIN_SERVICE} -a client-id -w
    security add-generic-password -s ${KEYCHAIN_SERVICE} -a client-secret -w
  or export GENESYS_CLIENT_ID and GENESYS_CLIENT_SECRET for this shell.`);
  }
  return { id, secret };
}

// ------------------------------------------------------------- API client ---

let region;
let accessToken;

async function login() {
  const { id, secret } = credentials();
  const res = await fetch(`https://login.${region}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(`Login to ${region} failed (HTTP ${res.status}): ${body.error_description || body.error || 'unknown error'}`);
  accessToken = body.access_token;
}

class ApiError extends Error {
  constructor(status, method, url, body) {
    super(`${method} ${url} -> HTTP ${status}: ${body?.message || JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

async function gc(method, url, body, attempt = 0) {
  const res = await fetch(`https://api.${region}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429 && attempt < 5) {
    const wait = Number(res.headers.get('retry-after') || 2) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return gc(method, url, body, attempt + 1);
  }
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return { message: text }; } })() : {};
  if (!res.ok) throw new ApiError(res.status, method, url, data);
  return data;
}

/** Collect all pages of a paged list endpoint. */
async function listAll(url) {
  const out = [];
  for (let page = 1; page < 50; page += 1) {
    const sep = url.includes('?') ? '&' : '?';
    const data = await gc('GET', `${url}${sep}pageSize=100&pageNumber=${page}`);
    out.push(...(data.entities || []));
    if (!data.pageCount || page >= data.pageCount) break;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

// ------------------------------------------------------------------ steps ---

async function org() {
  step('Organization');
  const me = await gc('GET', '/api/v2/organizations/me');
  const home = await gc('GET', '/api/v2/authorization/divisions/home');
  ok(`${me.name} (${me.id}) - region ${region}, home division "${home.name}"`);
  return { orgId: me.id, orgName: me.name, divisionId: home.id };
}

function loadAgents() {
  if (!fs.existsSync(AGENTS_FILE)) {
    fail(`Missing ${path.relative(ROOT, AGENTS_FILE)}.
  Copy genesys/agents.example.json to genesys/agents.json and enter the four agent e-mail addresses.`);
  }
  const data = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
  for (const [key, a] of Object.entries(data.agents || {})) {
    if (!a.email || a.email.endsWith('@example.com')) fail(`genesys/agents.json: agent "${key}" still has a placeholder e-mail`);
  }
  return data;
}

async function findUserByEmail(email) {
  const res = await gc('POST', '/api/v2/users/search', {
    query: [{ type: 'EXACT', fields: ['email'], value: email }],
  });
  return res.results?.[0] || null;
}

async function ensureAgents({ divisionId }, agentsFile) {
  step('Agents (users)');
  const roles = await listAll('/api/v2/authorization/roles');
  const wantedRoles = (agentsFile.roles || []).map((name) => {
    // Default role names differ in case between orgs ("employee" vs "Employee").
    const role = roles.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (!role) warn(`role "${name}" does not exist in this org - skipped`);
    return role;
  }).filter(Boolean);

  const result = {};
  for (const [key, agent] of Object.entries(agentsFile.agents)) {
    let user = await findUserByEmail(agent.email);
    if (user) {
      same(`${agent.name} <${agent.email}> exists (${user.state})`);
    } else if (DRY_RUN) {
      plan(`user ${agent.name} <${agent.email}>`);
      result[key] = null;
      continue;
    } else {
      user = await gc('POST', '/api/v2/users', { name: agent.name, email: agent.email, divisionId });
      ok(`created ${agent.name} <${agent.email}>`);
      try {
        await gc('POST', `/api/v2/users/${user.id}/invite`);
        ok(`  invitation e-mail sent - the agent sets a password from it`);
      } catch (err) {
        warn(`  could not send invitation (${err.status}) - use Admin > People > "Resend invite"`);
      }
    }
    if (!DRY_RUN && wantedRoles.length) {
      try {
        await gc('POST', `/api/v2/authorization/subjects/${user.id}/bulkadd`, {
          grants: wantedRoles.map((r) => ({ roleId: r.id, divisionId })),
        });
        same(`  roles: ${wantedRoles.map((r) => r.name).join(', ')}`);
      } catch (err) {
        warn(`  role grant failed: ${err.message}`);
      }
    }
    try {
      const lic = await gc('GET', `/api/v2/license/users/${user.id}`);
      const list = (lic.licenses || []).map((l) => (typeof l === 'string' ? l : l.description || l.id));
      if (!list.length) warn(`  no license assigned yet - routing needs a Genesys Cloud CX license (Admin > People > Licenses)`);
      else same(`  licenses: ${list.slice(0, 4).join(', ')}${list.length > 4 ? ` (+${list.length - 4} more)` : ''}`);
    } catch { /* license API not available for this client - ignore */ }
    result[key] = { ...agent, id: user.id };
  }
  return result;
}

async function ensureGroup(agents) {
  step('Group (takes the chats and sees the interaction widget)');
  const groups = await listAll('/api/v2/groups');
  let group = groups.find((g) => g.name === NAMES.group);
  if (!group) {
    if (DRY_RUN) { plan(`group "${NAMES.group}"`); return null; }
    group = await gc('POST', '/api/v2/groups', {
      name: NAMES.group,
      description: 'WX-84 agents: members of the WX-84 Weather Desk queue, see the WX-84 interaction widget',
      type: 'official',
      visibility: 'public',
      rulesVisible: true,
    });
    ok(`created group "${NAMES.group}"`);
  } else {
    same(`group "${NAMES.group}" exists`);
  }
  const members = await listAll(`/api/v2/groups/${group.id}/members`);
  const missing = Object.values(agents).filter((a) => a && !members.some((m) => m.id === a.id));
  if (missing.length && !DRY_RUN) {
    const fresh = await gc('GET', `/api/v2/groups/${group.id}`);
    await gc('POST', `/api/v2/groups/${group.id}/members`, { memberIds: missing.map((a) => a.id), version: fresh.version });
    ok(`added ${missing.map((a) => a.name).join(', ')}`);
  } else if (missing.length) {
    plan(`add ${missing.length} member(s)`);
  }
  return group;
}

/** Find a queue by its exact name (the name filter is a prefix match). */
async function findQueue(name) {
  const found = await gc('GET', `/api/v2/routing/queues?name=${enc(name)}&pageSize=25`);
  return (found.entities || []).find((q) => q.name === name) || null;
}

async function ensureQueue({ divisionId }, group) {
  step('Queue (every chat goes here; the group provides the members)');
  const name = NAMES.queue;
  const groupMember = group ? { id: group.id, type: 'GROUP' } : null;
  let queue = await findQueue(name);
  if (!queue) {
    if (DRY_RUN) { plan(`queue "${name}" with group "${NAMES.group}" as members`); return null; }
    queue = await gc('POST', '/api/v2/routing/queues', {
      name,
      description: 'WX-84 demo: every customer chat. Members come from the group WX-84 Agents.',
      division: { id: divisionId },
      acwSettings: { wrapupPrompt: 'OPTIONAL' },
      mediaSettings: { message: { alertingTimeoutSeconds: 30, serviceLevel: { percentage: 0.8, durationMs: 20000 } } },
      memberGroups: groupMember ? [groupMember] : [],
    });
    ok(`created queue "${name}" (members: group "${NAMES.group}")`);
  } else {
    queue = await gc('GET', `/api/v2/routing/queues/${queue.id}`);
    const linked = (queue.memberGroups || []).some((g) => g.id === group?.id);
    if (linked || !groupMember) {
      same(`queue "${name}" exists (members: group "${NAMES.group}")`);
    } else if (DRY_RUN) {
      plan(`link group "${NAMES.group}" to queue "${name}"`);
    } else {
      queue = await gc('PUT', `/api/v2/routing/queues/${queue.id}`, { ...queue, memberGroups: [...(queue.memberGroups || []), groupMember] });
      ok(`linked group "${NAMES.group}" to queue "${name}"`);
    }
  }
  // Genesys fills the member list from the group in the background.
  const members = await listAll(`/api/v2/routing/queues/${queue.id}/members`);
  if (members.length) same(`  ${members.length} member(s) from the group: ${members.map((m) => m.name).join(', ')}`);
  else warn('  no members yet - Genesys syncs the group within a minute; new users appear after accepting the invitation');
  return queue;
}

/** Delete the station queues of the first design, after the router stopped using them. */
async function retireOldQueues() {
  step('Retired station queues (first design)');
  for (const name of NAMES.retiredQueues) {
    const queue = await findQueue(name);
    if (!queue) { same(`"${name}" not present`); continue; }
    if (DRY_RUN) { console.log(`  ${yellow('-')} queue "${name}" ${dim('(dry run: not deleted)')}`); continue; }
    try {
      await gc('DELETE', `/api/v2/routing/queues/${queue.id}?forceDelete=true`);
      ok(`deleted queue "${name}"`);
    } catch (err) {
      warn(`could not delete "${name}": ${err.message}`);
    }
  }
}

const WEBRTC_META = 'inin_webrtc_softphone.json';

/**
 * Sites that can hold WebRTC phones: active, cloud media (Genesys Cloud Voice
 * or BYOC Cloud), and not the Genesys-managed core site (phones are rejected there).
 */
async function findPhoneSites() {
  const sites = await listAll('/api/v2/telephony/providers/edges/sites');
  const details = await Promise.all(sites.filter((s) => s.state === 'active')
    .map((s) => gc('GET', `/api/v2/telephony/providers/edges/sites/${s.id}`)));
  return details.filter((s) => !s.coreSite && s.mediaModel === 'Cloud').sort((a, b) => a.name.localeCompare(b.name));
}

async function ensurePhones(agents) {
  step('WebRTC phones (optional - web messaging works without a phone)');
  if (NO_PHONES) return same('skipped (--no-phones)');
  const sites = await findPhoneSites();
  if (!sites.length) return warn('no cloud-media telephony site (Genesys Cloud Voice or BYOC Cloud) - phones skipped');
  const site = sites[0];
  const baseRef = (await listAll('/api/v2/telephony/providers/edges/phonebasesettings'))
    .find((b) => b.phoneMetaBase?.id === WEBRTC_META);
  if (!baseRef) return warn('no WebRTC phone base settings (Admin > Telephony > Phone Management > Base Settings) - phones skipped');
  const base = await gc('GET', `/api/v2/telephony/providers/edges/phonebasesettings/${baseRef.id}`);
  const lineBaseId = base.lines?.[0]?.id;
  const others = sites.slice(1).map((s) => s.name);
  same(`site "${site.name}"${others.length ? ` (also possible: ${others.join(', ')})` : ''} · base settings "${base.name}"`);

  // The phone list only includes the owner when asked via "fields" (not "expand").
  const phones = await listAll('/api/v2/telephony/providers/edges/phones?fields=webRtcUser');
  for (const agent of Object.values(agents)) {
    if (!agent) continue;
    try {
      // Reuse any WebRTC phone the agent already has, whatever its name.
      let phone = phones.find((p) => p.webRtcUser?.id === agent.id);
      if (phone) {
        same(`${agent.name}: phone "${phone.name}" exists`);
      } else if (DRY_RUN) {
        plan(`WebRTC phone for ${agent.name}`);
        continue;
      } else {
        const name = `${agent.name} (WebRTC)`;
        phone = await gc('POST', '/api/v2/telephony/providers/edges/phones', {
          name,
          site: { id: site.id },
          phoneBaseSettings: { id: base.id },
          lineBaseSettings: { id: lineBaseId },
          phoneMetaBase: { id: WEBRTC_META },
          lines: [{ name: `${name}_1`, lineBaseSettings: { id: lineBaseId } }],
          webRtcUser: { id: agent.id },
        });
        ok(`${agent.name}: created phone "${name}"`);
      }
      // Genesys creates the matching station asynchronously.
      let station;
      for (let i = 0; i < 15 && !station; i += 1) {
        station = (await gc('GET', `/api/v2/stations?pageSize=25&webRtcUserId=${agent.id}`)).entities?.[0];
        if (!station) await sleep(2000);
      }
      if (!station) { warn(`${agent.name}: station not ready yet - run setup again in a minute`); continue; }
      const current = await gc('GET', `/api/v2/users/${agent.id}/station`);
      if (current.defaultStation?.id === station.id) same('  default station');
      else if (DRY_RUN) plan(`  set as default station of ${agent.name}`);
      else {
        await gc('PUT', `/api/v2/users/${agent.id}/station/defaultstation/${station.id}`);
        ok('  set as default station');
      }
    } catch (err) {
      warn(`${agent.name}: ${err.message}`);
    }
  }
}

async function findFlow({ name, type }) {
  const res = await gc('GET', `/api/v2/flows?name=${enc(name)}&type=${type}&pageSize=25`);
  return (res.entities || []).find((f) => f.name === name) || null;
}

/** Upload one Archy YAML file via the Architect jobs API; Genesys runs Archy server-side. */
async function deployFlow(spec) {
  const job = await gc('POST', '/api/v2/flows/jobs', {});
  const upload = await fetch(job.presignedUrl, {
    method: 'PUT',
    headers: job.headers || {},
    body: fs.readFileSync(path.join(FLOW_DIR, spec.file)),
  });
  if (!upload.ok) fail(`Flow upload failed: HTTP ${upload.status} ${await upload.text()}`);
  let status;
  for (let i = 0; i < 60; i += 1) {
    await sleep(3000);
    // Without expand=messages a failed job comes back without Archy's error text.
    status = await gc('GET', `/api/v2/flows/jobs/${job.id}?expand=messages`);
    if (['Success', 'Failure'].includes(status.status)) break;
  }
  if (status?.status !== 'Success') {
    const messages = (status?.messages || []).map((m) => m.text || JSON.stringify(m))
      .filter((t) => !/ArchSession|exit code|Architect Scripting errors/.test(t))
      .map((t) => `    - ${t}`).join('\n');
    fail(`Flow "${spec.name}" job ended with status ${status?.status || 'TIMEOUT'}\n${messages}`);
  }
  let flow = await findFlow(spec);
  if (flow && !flow.publishedVersion) {
    await gc('POST', `/api/v2/flows/actions/publish?flow=${flow.id}`);
    await sleep(3000);
    flow = await findFlow(spec);
  }
  return flow;
}

async function ensureFlows(queue) {
  step('Architect flows (name bot, then station router)');
  if (!DRY_RUN && !queue) fail(`Queue "${NAMES.queue}" is missing - cannot deploy the flows.`);
  let router = null;
  for (const spec of FLOWS) {
    let flow = await findFlow(spec);
    if (DRY_RUN) {
      if (flow) same(`flow "${spec.name}" exists (published: ${Boolean(flow.publishedVersion)})`);
      else plan(`flow "${spec.name}"`);
    } else {
      flow = await deployFlow(spec);
      ok(`flow "${spec.name}" deployed and published (${flow.id})`);
    }
    if (spec.type === 'inboundshortmessage') router = flow;
  }
  return router;
}

async function ensureMessenger(flow) {
  step('Messenger configuration + deployment');
  const configs = await listAll('/api/v2/webdeployments/configurations');
  let config = configs.find((x) => x.name === NAMES.messengerConfig);
  let version;
  if (!config) {
    if (DRY_RUN) { plan(`Messenger configuration "${NAMES.messengerConfig}"`); return null; }
    config = await gc('POST', '/api/v2/webdeployments/configurations', {
      name: NAMES.messengerConfig,
      description: 'WX-84 demo customer page',
      languages: ['en-us'],
      defaultLanguage: 'en-us',
      messenger: {
        enabled: true,
        styles: { primaryColor: '#c4501d' },
        launcherButton: { visibility: 'On' },
        apps: { conversations: { enabled: true } },
      },
    });
    const published = await gc('POST', `/api/v2/webdeployments/configurations/${config.id}/versions/draft/publish`);
    version = published.version;
    ok(`created and published Messenger configuration (version ${version})`);
  } else {
    const versions = await gc('GET', `/api/v2/webdeployments/configurations/${config.id}/versions`);
    // Only published versions are numeric; the draft is reported as "DRAFT".
    const active = (versions.entities || []).filter((v) => /^\d+$/.test(String(v.version)) && v.status !== 'Deleting');
    version = active.map((v) => v.version).sort((a, b) => Number(b) - Number(a))[0];
    if (!version && !DRY_RUN) {
      version = (await gc('POST', `/api/v2/webdeployments/configurations/${config.id}/versions/draft/publish`)).version;
    }
    same(`Messenger configuration exists (version ${version})`);
  }

  const deployments = await listAll('/api/v2/webdeployments/deployments');
  let deployment = deployments.find((d) => d.name === NAMES.deployment);
  const body = {
    name: NAMES.deployment,
    description: 'WX-84 demo customer page (http://localhost:3000/customer/)',
    // Demo setting. In production, list your real domains in allowedDomains instead.
    allowAllDomains: true,
    configuration: { id: config.id, version: String(version) },
    flow: flow ? { id: flow.id } : undefined,
  };
  if (!deployment) {
    if (DRY_RUN) { plan(`Messenger deployment "${NAMES.deployment}"`); return null; }
    deployment = await gc('POST', '/api/v2/webdeployments/deployments', body);
    ok('created Messenger deployment');
  } else if (!DRY_RUN && (deployment.flow?.id !== flow?.id || String(deployment.configuration?.version) !== String(version))) {
    deployment = await gc('PUT', `/api/v2/webdeployments/deployments/${deployment.id}`, { ...deployment, ...body });
    ok('updated Messenger deployment (flow / configuration version)');
  } else {
    same('Messenger deployment exists');
  }
  for (let i = 0; i < 20 && deployment.status !== 'Active'; i += 1) {
    await sleep(2000);
    deployment = await gc('GET', `/api/v2/webdeployments/deployments/${deployment.id}`);
  }
  if (deployment.status !== 'Active') warn(`deployment status is "${deployment.status}" - it may need a minute`);
  // Take script URL and environment from Genesys' own snippet instead of guessing them.
  const snippet = deployment.snippet || '';
  const scriptUrl = /https:\/\/[^'"\s]+genesys\.min\.js/.exec(snippet)?.[0] || '';
  const environment = /environment:\s*['"]([^'"]+)['"]/.exec(snippet)?.[1] || '';
  return { id: deployment.id, scriptUrl, environment };
}

async function ensureOAuthClient(redirectUris) {
  step('OAuth client for the agent console (Authorization Code + PKCE)');
  const clients = await listAll('/api/v2/oauth/clients');
  let client = clients.find((x) => x.name === NAMES.oauthClient);
  const body = {
    name: NAMES.oauthClient,
    description: 'WX-84 demo: agents sign in to the WX-84 console with their Genesys Cloud identity',
    authorizedGrantType: 'CODE',
    registeredRedirectUri: redirectUris,
    scope: ['users:readonly', 'conversations:readonly'],
    accessTokenValiditySeconds: 3600,
  };
  if (!client) {
    if (DRY_RUN) { plan(`OAuth client "${NAMES.oauthClient}"`); return null; }
    client = await gc('POST', '/api/v2/oauth/clients', body);
    ok(`created OAuth client (${client.id})`);
  } else {
    const current = [...(client.registeredRedirectUri || [])].sort().join();
    if (current !== [...redirectUris].sort().join() && !DRY_RUN) {
      client = await gc('PUT', `/api/v2/oauth/clients/${client.id}`, { ...body, roleIds: client.roleIds });
      ok(`updated redirect URIs: ${redirectUris.join(', ')}`);
    } else {
      same(`OAuth client exists (${client.id})`);
    }
  }
  return client;
}

async function ensureIntegration(publicUrl, group, queue) {
  step('Interaction Widget (client app inside the agent desktop)');
  const all = await listAll('/api/v2/integrations');
  let integration = all.find((x) => x.integrationType?.id === 'embedded-client-app-interaction-widget' && x.name === NAMES.integration);
  if (!integration) {
    if (DRY_RUN) { plan(`integration "${NAMES.integration}"`); return null; }
    integration = await gc('POST', '/api/v2/integrations', {
      name: NAMES.integration,
      integrationType: { id: 'embedded-client-app-interaction-widget' },
    });
    ok(`created integration (${integration.id})`);
  } else {
    same(`integration exists (${integration.id})`);
  }
  if (DRY_RUN) return integration;

  const current = await gc('GET', `/api/v2/integrations/${integration.id}/config/current`);
  const url = `${publicUrl}/?mode=genesys&conversationId={{gcConversationId}}&gcHostOrigin={{gcHostOrigin}}&gcTargetEnv={{gcTargetEnv}}`;
  await gc('PUT', `/api/v2/integrations/${integration.id}/config/current`, {
    name: NAMES.integration,
    version: current.version,
    notes: 'WX-84 demo - shows the WX-84 console in web-messaging interactions on the WX-84 Weather Desk queue',
    properties: {
      url,
      // allow-popups: the Genesys sign-in runs in a popup. Genesys accepts only
      // allow-forms|modals|popups|presentation|same-origin|scripts|downloads here,
      // so the popup inherits these flags (scripts + same-origin + forms are enough for OAuth).
      sandbox: 'allow-scripts,allow-same-origin,allow-forms,allow-modals,allow-popups',
      permissions: '',
      groups: group ? [group.id] : [],
      queueIdFilterList: queue ? [queue.id] : [],
      communicationTypeFilter: '',
    },
    advanced: {},
    credentials: {},
  });
  ok(`widget URL: ${url}`);
  if (integration.intendedState !== 'ENABLED') {
    await gc('PATCH', `/api/v2/integrations/${integration.id}`, { intendedState: 'ENABLED' });
    ok('integration enabled');
  }
  return integration;
}

function writeLocalConfig(values) {
  step('Local configuration');
  const existing = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  const next = {
    ...existing,
    port: existing.port || 3000,
    allowLocalLogin: existing.allowLocalLogin ?? true,
    publicUrl: values.publicUrl,
    genesys: { ...(existing.genesys || {}), ...values.genesys },
  };
  if (DRY_RUN) { plan(`write ${path.relative(ROOT, CONFIG_FILE)}`); return; }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
  ok(`wrote ${path.relative(ROOT, CONFIG_FILE)} (IDs only - no secrets)`);
}

function linkUsersFile(agents) {
  ensureUsersFile();
  const users = getUsers().map((u) => ({ ...u, stations: [...u.stations] }));
  let changed = 0;
  for (const [key, agent] of Object.entries(agents)) {
    const user = users.find((u) => u.username === key);
    if (user && agent && !user.genesysEmail) {
      user.genesysEmail = agent.email.toLowerCase();
      changed += 1;
    }
  }
  if (!changed) return same(`${path.relative(ROOT, USERS_FILE)} already linked`);
  if (DRY_RUN) return plan(`link ${changed} WX-84 user(s) to Genesys e-mails`);
  saveUsers(users);
  ok(`linked ${changed} WX-84 user(s) to their Genesys Cloud e-mail in ${path.relative(ROOT, USERS_FILE)}`);
}

// ------------------------------------------------------------------- main ---

async function main() {
  const cfg = getConfig();
  region = process.env.GENESYS_REGION || cfg.genesys.region;
  const publicUrl = (urlArg || cfg.publicUrl || `http://localhost:${cfg.port}`).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(publicUrl)) fail(`--public-url must start with https:// (got "${publicUrl}")`);

  console.log(bold(`WX-84 Genesys Cloud setup ${DRY_RUN ? '(dry run - read only)' : ''}`));
  console.log(dim(`  region ${region} · public URL ${publicUrl}`));
  if (publicUrl.startsWith('http://')) {
    warn('the public URL is plain http - Chrome blocks http://localhost inside Genesys Cloud. Start a tunnel and re-run with --public-url https://... (see docs/genesys-setup.md)');
  }

  await login();
  const organization = await org();
  const agentsFile = loadAgents();
  const agents = await ensureAgents(organization, agentsFile);
  const group = await ensureGroup(agents);
  const queue = await ensureQueue(organization, group);
  await ensurePhones(agents);
  const flow = await ensureFlows(queue);
  await retireOldQueues();
  const messenger = await ensureMessenger(flow);

  const redirectUris = [...new Set([`http://localhost:${cfg.port}/auth/popup.html`, `${publicUrl}/auth/popup.html`])];
  const client = await ensureOAuthClient(redirectUris);
  await ensureIntegration(publicUrl, group, queue);

  writeLocalConfig({
    publicUrl,
    genesys: {
      region,
      orgId: organization.orgId,
      oauthClientId: client?.id || cfg.genesys.oauthClientId,
      messengerDeploymentId: messenger?.id || cfg.genesys.messengerDeploymentId,
      messengerEnvironment: messenger?.environment || cfg.genesys.messengerEnvironment,
      messengerScriptUrl: messenger?.scriptUrl || cfg.genesys.messengerScriptUrl,
    },
  });
  linkUsersFile(agents);

  console.log(`\n${green(bold('Done.'))} Next steps:
  1. Each agent accepts the invitation e-mail and sets a password (first run only).
  2. Re-run this script once after that, so new users join the group (and with it the queue).
  3. Agents sign in to https://apps.${region}, go On Queue.
  4. Customer: open http://localhost:${cfg.port}/customer/ and pick a station.
  See docs/genesys-setup.md for details and troubleshooting.\n`);
}

main().catch((err) => fail(err.stack || err.message));
