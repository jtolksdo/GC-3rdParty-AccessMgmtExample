// Sessions. A session only remembers WHO you are (username + how you signed
// in). WHAT you may see is looked up fresh on every request.
//
// For Genesys sign-ins the session also keeps the agent's Genesys tokens on
// the server ("backend for frontend" pattern): the browser only ever holds our
// own opaque session token, never a Genesys token.
//
// Lifetime: a session ends after 12 hours without use, and after 7 days in any
// case. While the console is open it polls every few seconds, so an agent who
// works every day stays signed in; the server renews the Genesys token with the
// refresh token in the background.
//
// Persistence: when a key is configured, sessions are written to an encrypted
// file (AES-256-GCM), so restarting the server does not sign everyone out.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IDLE_TTL_MS = 12 * 60 * 60 * 1000;
const ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HANDOFF_TTL_MS = 2 * 60 * 1000;
const sessions = new Map();
const handoffs = new Map();

// ---------------------------------------------------------------- sessions ---

/**
 * tokens (Genesys sign-ins): { access, refresh, expiresAt }
 * genesys: { id, name, email } as verified with Genesys Cloud
 */
export function createSession({ username, source, genesys = null, tokens = null }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  sessions.set(token, { username, source, genesys, tokens, createdAt: now, lastSeen: now, seen: new Set() });
  saveSoon();
  return token;
}

const expired = (s, now = Date.now()) => now - s.lastSeen > IDLE_TTL_MS || now - s.createdAt > ABSOLUTE_TTL_MS;

export function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (expired(session)) {
    sessions.delete(token);
    saveSoon();
    return null;
  }
  session.lastSeen = Date.now();
  dirty = true; // written with the next periodic save, not on every poll
  return session;
}

export function deleteSession(token) {
  if (sessions.delete(token)) saveSoon();
}

/** All Genesys sessions, for the background renewal. */
export function genesysSessions() {
  return [...sessions.entries()].filter(([, s]) => s.source === 'genesys' && s.tokens);
}

/** Call after changing a session's tokens. */
export function changed() {
  saveSoon();
}

// --------------------------------------------------------------- handoffs ---
// The widget iframe and the sign-in popup cannot share browser storage
// (storage partitioning), so the sign-in parks its result here under a random,
// single-use id that only the iframe knows. The iframe collects it by polling.
export const HANDOFF_ID = /^[A-Za-z0-9_-]{22,64}$/;

export function parkHandoff(id, payload) {
  handoffs.set(id, { payload, expires: Date.now() + HANDOFF_TTL_MS });
}

export function collectHandoff(id) {
  const entry = handoffs.get(id);
  if (!entry) return null;
  handoffs.delete(id); // single use
  return entry.expires > Date.now() ? entry.payload : null;
}

// ------------------------------------------------------------ persistence ---

let store = null; // { file, key }
let dirty = false;
let saveTimer = null;

/**
 * Keep sessions across restarts in an encrypted file. Without a secret to
 * derive the key from, sessions stay in memory only.
 */
export function enablePersistence(file, secret) {
  if (!secret) return 'memory only (no key)';
  const key = crypto.hkdfSync('sha256', secret, 'wx84-session-store', 'aes-256-gcm v1', 32);
  store = { file, key: Buffer.from(key) };
  try {
    const box = JSON.parse(fs.readFileSync(file, 'utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', store.key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
    const now = Date.now();
    for (const [token, s] of Object.entries(JSON.parse(plain))) {
      const session = { ...s, seen: new Set() };
      if (!expired(session, now)) sessions.set(token, session);
    }
    return `encrypted file, ${sessions.size} session(s) restored`;
  } catch (err) {
    // Missing file, or a key from another client secret: start empty.
    return err.code === 'ENOENT' ? 'encrypted file (new)' : 'encrypted file (unreadable, started empty)';
  }
}

function saveSoon() {
  dirty = true;
  if (!store || saveTimer) return;
  saveTimer = setTimeout(save, 500);
}

function save() {
  saveTimer = null;
  if (!store || !dirty) return;
  dirty = false;
  const plain = JSON.stringify(Object.fromEntries([...sessions.entries()].map(([t, s]) => {
    const { seen, ...rest } = s; // the "already logged" set is not worth keeping
    return [t, rest];
  })));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', store.key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const box = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  const tmp = `${store.file}.tmp`;
  fs.mkdirSync(path.dirname(store.file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(box), { mode: 0o600 });
  fs.renameSync(tmp, store.file); // atomic: never a half-written file
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of handoffs) if (entry.expires < now) handoffs.delete(id);
  for (const [token, s] of sessions) if (expired(s, now)) { sessions.delete(token); dirty = true; }
  if (dirty) save();
}, 60 * 1000).unref();
