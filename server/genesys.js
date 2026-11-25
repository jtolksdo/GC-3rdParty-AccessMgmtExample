// Server-side verification of a Genesys Cloud access token.
//
// The browser hands us an access token it obtained via OAuth (PKCE). We never
// trust what the browser *says* about the user - we ask Genesys Cloud
// ourselves, using the region from OUR config (never a URL supplied by the
// client, otherwise an attacker could point us at a fake "Genesys" server).
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function genesysConfigured(cfg) {
  return Boolean(cfg.genesys.region && cfg.genesys.orgId && cfg.genesys.oauthClientId);
}

export async function verifyGenesysToken(accessToken, cfg) {
  if (!genesysConfigured(cfg)) {
    // Fail closed: without a pinned org id we cannot tell whose token this is.
    throw new HttpError(503, 'Genesys Cloud sign-in is not configured (run npm run genesys:setup)');
  }
  if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 4096) {
    throw new HttpError(400, 'Missing or malformed access token');
  }
  let res;
  try {
    res = await fetch(`https://api.${cfg.genesys.region}/api/v2/users/me?expand=organization`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new HttpError(502, `Cannot reach Genesys Cloud: ${err.message}`);
  }
  if (res.status === 401) throw new HttpError(401, 'Genesys Cloud rejected the token');
  if (!res.ok) throw new HttpError(502, `Genesys Cloud answered HTTP ${res.status}`);
  const me = await res.json();
  if (me.organization?.id !== cfg.genesys.orgId) {
    throw new HttpError(403, 'Token belongs to a different Genesys Cloud organization');
  }
  return {
    id: me.id,
    name: me.name,
    email: String(me.email || '').toLowerCase(),
    username: String(me.username || '').toLowerCase(),
    orgId: me.organization.id,
    orgName: me.organization.name,
  };
}
