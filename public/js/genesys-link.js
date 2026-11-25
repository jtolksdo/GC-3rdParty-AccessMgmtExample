// Genesys Cloud sign-in from inside the agent desktop.
//
// 1. Silent: a hidden iframe runs the OAuth PKCE flow (auth/popup.html?silent=1).
//    If the agent is signed in to Genesys Cloud and the browser sends the login
//    cookie to embedded pages, Genesys redirects straight back with a code - no
//    window, no click. Genesys' login page itself refuses to be framed, so a
//    signed-out agent (or a browser that blocks third-party cookies) ends here.
// 2. Fallback: the same page in a popup, started by a click on "Engage link".
// Either way the page hands the result to our server under a random one-time
// "handoff" id, and the console collects it: popup and console cannot share
// browser storage (the console's storage is partitioned under apps.<region>).
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

/**
 * Start the silent sign-in in a hidden iframe. Calls onFail as soon as the
 * frame reports an error (e.g. Genesys answered with an OAuth error).
 * Returns a function that removes the frame.
 */
export function startSilentSignIn(handoff, onFail) {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.title = 'Genesys Cloud silent sign-in';
  frame.src = `/auth/popup.html?silent=1&handoff=${encodeURIComponent(handoff)}`;
  const onMessage = (event) => {
    if (event.origin === location.origin && event.source === frame.contentWindow
        && event.data?.wx84 === 'silent-signin-failed') onFail(event.data.reason);
  };
  window.addEventListener('message', onMessage);
  document.body.append(frame);
  return () => {
    window.removeEventListener('message', onMessage);
    frame.remove();
  };
}

let generation = 0;

/**
 * Poll the server until the popup has parked a result for this handoff id.
 * We deliberately do not watch popup.closed: Genesys' login page may set
 * Cross-Origin-Opener-Policy, which makes the popup look "closed" to us.
 */
export async function waitForHandoff(handoff, { timeoutMs = 120000, onTick, signal } = {}) {
  const mine = ++generation;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    if (mine !== generation) throw new ApiError(0, 'SUPERSEDED');
    if (signal?.aborted) throw new ApiError(0, String(signal.reason || 'ABORTED'));
    onTick?.(Math.ceil((until - Date.now()) / 1000));
    const res = await fetch(`/api/session/handoff/${handoff}`).catch(() => null);
    if (!res) continue;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
    if (!data.pending) return data;
  }
  throw new ApiError(408, 'SIGN-IN TIMED OUT - PRESS ENGAGE TO RETRY');
}
