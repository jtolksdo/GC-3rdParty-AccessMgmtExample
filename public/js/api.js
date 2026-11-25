// Tiny API client. The browser only holds our own opaque session token
// (never a Genesys token). Storage can be unavailable in some embedded
// contexts, so every access is guarded and falls back to memory.
const KEY = 'wx84.session';
let memoryToken = null;

export function getToken() {
  try { return localStorage.getItem(KEY) || memoryToken; } catch { return memoryToken; }
}
export function setToken(token) {
  memoryToken = token;
  try { localStorage.setItem(KEY, token); } catch { /* memory only */ }
}
export function clearToken() {
  memoryToken = null;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NO CONTACT WITH WX-84 SERVER');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
  return data;
}
