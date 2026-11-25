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

async function genesysGet(pathAndQuery, accessToken, cfg) {
  let res;
  try {
    res = await fetch(`https://api.${cfg.genesys.region}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new HttpError(502, `Cannot reach Genesys Cloud: ${err.message}`);
  }
  if (res.status === 401) throw new HttpError(401, 'Genesys Cloud rejected the token');
  if (!res.ok) throw new HttpError(502, `Genesys Cloud answered HTTP ${res.status}`);
  return res.json();
}

export async function verifyGenesysToken(accessToken, cfg) {
  if (!genesysConfigured(cfg)) {
    // Fail closed: without a pinned org id we cannot tell whose token this is.
    throw new HttpError(503, 'Genesys Cloud sign-in is not configured (run npm run genesys:setup)');
  }
  if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 4096) {
    throw new HttpError(400, 'Missing or malformed access token');
  }
  // Who is this (users/me) and which OAuth client was the token issued to (tokens/me)?
  const [me, tokenInfo] = await Promise.all([
    genesysGet('/api/v2/users/me?expand=organization', accessToken, cfg),
    genesysGet('/api/v2/tokens/me', accessToken, cfg),
  ]);
  if (me.organization?.id !== cfg.genesys.orgId) {
    throw new HttpError(403, 'Token belongs to a different Genesys Cloud organization');
  }
  // A valid token that another app in the same org obtained for this user must
  // not open WX-84 ("token substitution"): only tokens issued to our own client.
  if (tokenInfo.OAuthClient?.id !== cfg.genesys.oauthClientId) {
    throw new HttpError(403, 'Token was not issued to the WX-84 OAuth client');
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
