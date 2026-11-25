// The "flight recorder": an audit trail of sign-ins, granted/denied access
// and permission changes. Kept in memory for the admin panel and appended
// as JSON lines to data/flight-recorder.log.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const LOG_FILE = path.join(ROOT, 'data', 'flight-recorder.log');
const MAX_ENTRIES = 200;
const entries = [];

export function record({ actor, source, action, target = '', result, detail = '' }) {
  const entry = { at: new Date().toISOString(), actor, source, action, target, result, detail };
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  fs.appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, (err) => {
    if (err) console.warn(`[audit] cannot write ${LOG_FILE}: ${err.message}`);
  });
  const tag = result === 'DENIED' ? '\x1b[31mDENIED\x1b[0m' : result;
  console.log(`[audit] ${entry.at} ${actor} (${source}) ${action} ${target} ${tag} ${detail}`.trim());
  return entry;
}

export function recent(limit = 60) {
  return entries.slice(0, limit);
}
