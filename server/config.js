// Loads config/config.json (created by the Genesys setup script) merged over
// defaults, with environment variables on top. Re-read when the file changes,
// so running `npm run genesys:setup` does not require a server restart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = path.join(ROOT, 'config', 'config.json');

const DEFAULTS = {
  port: 3000,
  allowLocalLogin: true,
  genesys: {
    region: 'usw2.pure.cloud',
    orgId: '',
    oauthClientId: '',
    messengerDeploymentId: '',
    messengerEnvironment: 'prod-usw2',
    messengerScriptUrl: '', // taken from the deployment's snippet by the setup script
  },
};

let cached = { mtimeMs: null, file: {} };

function readFileConfig() {
  try {
    const { mtimeMs } = fs.statSync(CONFIG_FILE);
    if (cached.mtimeMs === mtimeMs) return cached.file;
    const file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cached = { mtimeMs, file };
    return file;
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Cannot read ${CONFIG_FILE}: ${err.message}`);
  }
}

export function getConfig() {
  const file = readFileConfig();
  const cfg = {
    ...DEFAULTS,
    ...file,
    genesys: { ...DEFAULTS.genesys, ...(file.genesys || {}) },
  };
  const env = process.env;
  if (env.PORT) cfg.port = Number(env.PORT);
  if (env.ALLOW_LOCAL_LOGIN) cfg.allowLocalLogin = env.ALLOW_LOCAL_LOGIN !== 'false';
  if (env.GENESYS_REGION) cfg.genesys.region = env.GENESYS_REGION;
  if (env.GENESYS_ORG_ID) cfg.genesys.orgId = env.GENESYS_ORG_ID;
  if (env.GENESYS_OAUTH_CLIENT_ID) cfg.genesys.oauthClientId = env.GENESYS_OAUTH_CLIENT_ID;
  if (env.GENESYS_MESSENGER_DEPLOYMENT_ID) cfg.genesys.messengerDeploymentId = env.GENESYS_MESSENGER_DEPLOYMENT_ID;
  if (env.GENESYS_MESSENGER_ENVIRONMENT) cfg.genesys.messengerEnvironment = env.GENESYS_MESSENGER_ENVIRONMENT;
  return cfg;
}
