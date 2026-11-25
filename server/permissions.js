// The permission store: one plain-text file, data/users.txt.
// Parsed on change (mtime check), so manual edits and admin-UI edits both
// take effect on the very next request.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { STATION_IDS } from './stations.js';

export const USERS_FILE = process.env.USERS_FILE || path.join(ROOT, 'data', 'users.txt');
const EXAMPLE_FILE = path.join(ROOT, 'data', 'users.example.txt');
const ROLES = ['admin', 'agent'];

let cache = { mtimeMs: null, users: [], warnings: [] };

export function ensureUsersFile() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.copyFileSync(EXAMPLE_FILE, USERS_FILE);
    console.log(`[permissions] created ${path.relative(ROOT, USERS_FILE)} from the example file`);
  }
}

export function parseUsers(text) {
  const users = [];
  const warnings = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [username = '', role = '', stations = '', genesysEmail = ''] = line.split('|').map((s) => s.trim());
    if (!/^[a-z0-9._-]+$/i.test(username)) {
      warnings.push(`line ${index + 1}: invalid username "${username}" - line ignored`);
      return;
    }
    // Fail closed: an unknown role becomes the least-privileged role.
    let safeRole = role.toLowerCase();
    if (!ROLES.includes(safeRole)) {
      warnings.push(`line ${index + 1}: unknown role "${role}" - treated as "agent"`);
      safeRole = 'agent';
    }
    const list = stations === '*' ? ['*'] : stations.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const id of list) {
      if (id !== '*' && !STATION_IDS.includes(id)) warnings.push(`line ${index + 1}: unknown station "${id}" - ignored`);
    }
    users.push({
      username: username.toLowerCase(),
      role: safeRole,
      stations: list.filter((id) => id === '*' || STATION_IDS.includes(id)),
      genesysEmail: genesysEmail.toLowerCase(),
    });
  });
  return { users, warnings };
}

export function getUsers() {
  const { mtimeMs } = fs.statSync(USERS_FILE);
  if (cache.mtimeMs !== mtimeMs) {
    const { users, warnings } = parseUsers(fs.readFileSync(USERS_FILE, 'utf8'));
    warnings.forEach((w) => console.warn(`[permissions] ${path.basename(USERS_FILE)} ${w}`));
    cache = { mtimeMs, users, warnings };
  }
  return cache.users;
}

/** Changes whenever the file changes - clients poll it to notice permission updates. */
export function permissionsVersion() {
  getUsers();
  return String(Math.round(cache.mtimeMs));
}

export function findUser(username) {
  return getUsers().find((u) => u.username === String(username || '').toLowerCase()) || null;
}

/** Station ids this user may see. Admins see everything. */
export function allowedStations(user) {
  if (!user) return [];
  if (user.role === 'admin' || user.stations.includes('*')) return [...STATION_IDS];
  return STATION_IDS.filter((id) => user.stations.includes(id));
}

export function canAccess(user, stationId) {
  return allowedStations(user).includes(stationId);
}

const HEADER = fs.readFileSync(EXAMPLE_FILE, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.startsWith('#'))
  .join('\n');

export function serializeUsers(users) {
  const w = (key, min) => Math.max(min, ...users.map((u) => String(u[key] ?? '').length));
  const wu = w('username', 8);
  const wr = 5;
  const stationText = (u) => (u.stations.includes('*') ? '*' : u.stations.join(','));
  const ws = Math.max(8, ...users.map((u) => stationText(u).length));
  const lines = users.map((u) =>
    `${u.username.padEnd(wu)} | ${u.role.padEnd(wr)} | ${stationText(u).padEnd(ws)} | ${u.genesysEmail}`.trimEnd());
  return `${HEADER}\n${lines.join('\n')}\n`;
}

/** Atomic write: temp file + rename, so a crash never leaves a half-written permission file. */
export function saveUsers(users) {
  const tmp = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmp, serializeUsers(users), 'utf8');
  fs.renameSync(tmp, USERS_FILE);
  cache.mtimeMs = null; // force re-read
  return getUsers();
}
