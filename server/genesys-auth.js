// Genesys Cloud sign-in, production style: Authorization Code grant with the
// client secret on THIS server ("backend for frontend").
//
//   browser (hidden iframe or popup)            WX-84 server                   Genesys Cloud
//   GET /auth/start?handoff=..   ----------->   remember state         --302-> /oauth/authorize
//                                                                             (agent already signed in:
//                                                                              no login page)
//   GET /auth/callback?code&state <--------------------------------------- 302 with a one-time code
//                                               code + client secret  ----->  /oauth/token
//                                               access + REFRESH token <-----
//
// The browser only ever carries the one-time code, never a token. The server
// keeps the tokens and renews the access token with the refresh token, without
// the agent and without the agent's Genesys login session. That is what keeps
// the agent from being asked to sign in again and again.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { HttpError } from './genesys.js';

const KEYCHAIN_SERVICE = 'wx84-genesys-setup';
const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_MAX = 500;
const pending = new Map(); // state -> { handoff, silent, redirectUri, expires }

// ------------------------------------------------------------ client secret ---

let cachedSecret = '';
/**
 * The OAuth client's secret. Never in a file: env GENESYS_AGENT_CLIENT_SECRET,
 * or the macOS keychain entry the setup script writes (service
 * "wx84-genesys-setup", account "agent-client-secret").
 */
export function agentClientSecret() {
  if (cachedSecret) return cachedSecret;
  cachedSecret = process.env.GENESYS_AGENT_CLIENT_SECRET || '';
  if (!cachedSecret && process.platform === 'darwin') {
    try {
      cachedSecret = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'agent-client-secret', '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { /* not stored yet: run npm run genesys:setup */ }
  }
  return cachedSecret;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// -------------------------------------------------------------- the flow ---

/** Step 1: remember who asked, then send the browser to Genesys' authorize endpoint. */
export function authorizeUrl({ handoff, silent, redirectUri, cfg }) {
  if (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value); // bounded memory
  const state = b64url(crypto.randomBytes(18));
  pending.set(state, { handoff, silent, redirectUri, expires: Date.now() + PENDING_TTL_MS });
  // No PKCE here, on purpose: with a code_challenge Genesys treats the sign-in
  // as a PKCE flow and sends NO refresh token (tested 2026-11-26). The code is
  // still protected: only this server can redeem it (client secret), only at
  // the registered callback, and the one-time state ties it to this request.
  return `https://login.${cfg.genesys.region}/oauth/authorize?${new URLSearchParams({
    client_id: cfg.genesys.oauthClientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  })}`;
}

/** Step 2: Genesys came back. Returns the original request; single use. */
export function takePending(state) {
  const entry = pending.get(String(state || ''));
  pending.delete(String(state || ''));
  if (!entry || entry.expires < Date.now()) return null;
  return entry;
}

async function tokenRequest(form, cfg) {
  const secret = agentClientSecret();
  if (!secret) throw new HttpError(503, 'WX-84 server has no client secret for Genesys sign-in (run npm run genesys:setup)');
  let res;
  try {
    res = await fetch(`https://login.${cfg.genesys.region}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.genesys.oauthClientId}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HttpError(502, 'Genesys Cloud login is not reachable');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new HttpError(res.status === 400 || res.status === 401 ? 401 : 502,
      `GENESYS: ${body.error_description || body.error || `HTTP ${res.status}`}`);
  }
  const now = Date.now();
  return {
    access: body.access_token,
    refresh: body.refresh_token || null,
    issuedAt: now,
    expiresAt: now + (Number(body.expires_in) || 3600) * 1000,
  };
}

/** Step 3: one-time code + client secret -> access and refresh token. */
export function exchangeCode({ code, redirectUri }, cfg) {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, cfg);
}

/** Renewal: refresh token -> new access token AND a new refresh token (each refresh token works once). */
export function refreshTokens(refreshToken, cfg) {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, cfg);
}

/** Sign-out: revoke our access token at Genesys (best effort; the desktop's own token is not affected). */
export async function revokeToken(accessToken, cfg) {
  try {
    await fetch(`https://api.${cfg.genesys.region}/api/v2/tokens/me`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* the token expires on its own */ }
}

setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of pending) if (entry.expires < now) pending.delete(state);
}, 60 * 1000).unref();
