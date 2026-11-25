// Identity mapping: which WX-84 user is this (already verified) Genesys Cloud user?
//
// By the time this runs, server/genesys.js has proven the token is genuine and
// belongs to OUR Genesys Cloud org. This function only decides the mapping
// between the two worlds. Returning null means "no WX-84 account" and the
// agent sees ACCESS DENIED.

/**
 * @param {{id: string, name: string, email: string, username: string}} genesysUser
 *        verified identity from GET /api/v2/users/me (email/username lower-cased)
 * @param {Array<{username: string, role: string, stations: string[], genesysEmail: string}>} users
 *        all users from data/users.txt (genesysEmail lower-cased, may be '')
 * @returns {object|null} the matching WX-84 user, or null
 */
export function findToolUser(genesysUser, users) {
  // Rule: exact e-mail only. No username fallback, and an unlinked WX-84 user
  // (empty genesysEmail) never matches. Both sides are already lower-cased.
  const email = genesysUser?.email || '';
  if (!email) return null;
  const matches = users.filter((u) => u.genesysEmail && u.genesysEmail === email);
  // Two rows with the same e-mail are a configuration error: fail closed.
  return matches.length === 1 ? matches[0] : null;
}
