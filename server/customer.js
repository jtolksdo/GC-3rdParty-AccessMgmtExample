// Customer data shown in the WX-84 console.
//
// The last name comes from the chat: the "WX-84 Name Collector" bot asks for it
// and the station router attaches it as participant data "wx84.lastName". The
// customer typed it, so it is an unverified claim AND untrusted input. The
// server reads it with the agent's own Genesys token, so an agent only sees it
// when Genesys Cloud lets them see the conversation. WX-84 never stores or
// logs it.

/**
 * @param {unknown} raw  value of participant data "wx84.lastName" (string, or undefined if unset)
 * @returns {string|null} the name to show in the console, or null to show none
 */
export function cleanCustomerName(raw) {
  // Rule (per Juergen): letters of any script incl. accents, spaces, hyphen and
  // apostrophe, at most 40 characters. Anything else: show no name at all,
  // rather than a "cleaned" version of something that was not a name.
  const name = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
  if (!name || name.length > 40) return null;
  return /^\p{L}[\p{L}\p{M} '’-]*$/u.test(name) ? name : null;
}
