// Genesys Cloud sign-in from inside the agent desktop.
//
// The interaction widget is an iframe. Signing in inside the iframe is not
// reliable, so we open a popup (auth/popup.html) that runs the OAuth PKCE
// flow. Popup and iframe cannot share browser storage (the iframe's storage
// is partitioned under apps.<region>), so the popup hands the result to our
// server under a random one-time "handoff" id, and the iframe collects it.
import { ApiError } from './api.js';

export function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newHandoffId() {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

/** Must be called directly from a click handler, otherwise pop-up blockers interfere. */
export function openSignInPopup(handoff) {
  const w = 520;
  const h = 700;
  const left = Math.max(0, (screen.availWidth - w) / 2);
  const top = Math.max(0, (screen.availHeight - h) / 2);
  return window.open(
    `/auth/popup.html?handoff=${encodeURIComponent(handoff)}`,
    `wx84-signin-${handoff.slice(0, 8)}`,
    `popup=yes,width=${w},height=${h},left=${left},top=${top}`,
  );
}

let generation = 0;

/**
 * Poll the server until the popup has parked a result for this handoff id.
 * We deliberately do not watch popup.closed: Genesys' login page may set
 * Cross-Origin-Opener-Policy, which makes the popup look "closed" to us.
 */
export async function waitForHandoff(handoff, { timeoutMs = 120000, onTick } = {}) {
  const mine = ++generation;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    if (mine !== generation) throw new ApiError(0, 'SUPERSEDED');
    onTick?.(Math.ceil((until - Date.now()) / 1000));
    const res = await fetch(`/api/session/handoff/${handoff}`).catch(() => null);
    if (!res) continue;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
    if (!data.pending) return data;
  }
  throw new ApiError(408, 'SIGN-IN TIMED OUT - PRESS ENGAGE TO RETRY');
}
