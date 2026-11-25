// In-memory sessions. A session only remembers WHO you are (username + how
// you signed in). WHAT you may see is looked up fresh on every request.
//
// For Genesys sign-ins the session also keeps the agent's Genesys access token
// on the server ("backend for frontend" pattern): the browser only ever holds
// our own opaque session token, never the Genesys token.
import crypto from 'node:crypto';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const HANDOFF_TTL_MS = 2 * 60 * 1000;
const sessions = new Map();
const handoffs = new Map();

export function createSession({ username, source, genesys = null, genesysAccessToken = null }) {
  const token = crypto.randomBytes(24).toString('base64url');
  sessions.set(token, {
    username, source, genesys, genesysAccessToken,
    createdAt: Date.now(), seen: new Set(),
  });
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function deleteSession(token) {
  sessions.delete(token);
}

// --- Popup sign-in handoff -------------------------------------------------
// The widget iframe and the sign-in popup cannot share browser storage
// (storage partitioning), so the popup parks the result here under a random,
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

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of handoffs) if (entry.expires < now) handoffs.delete(id);
  for (const [token, s] of sessions) if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(token);
}, 60 * 1000).unref();
