# Demo script (about 10 minutes)

**Message:** *A partner app embedded in Genesys Cloud keeps its own access model. Genesys Cloud provides the verified identity, and the app decides what that identity may see. You need no second login, no shared secrets in the browser, and you get an audit trail.*

## Setup before the audience arrives

* WX-84 server running, tunnel running, setup run with the current tunnel URL.
* Browser window 1: customer page `http://localhost:3000/customer/`.
* Browser window 2 (Chrome profile "Menlo"): Genesys Cloud, agent **WX-84 Menlo Park**, On Queue.
* Browser window 3 (Chrome profile "Admin"): Genesys Cloud, agent **WX-84 Admin**, On Queue (Supervisor queue).
* Browser window 4: `http://localhost:3000`, signed in locally as **admin**, maintenance panel open.

## Storyline

1. **The tool on its own** (window 4, 1 min). Show the cockpit with four stations, then the permission file in a text editor: "This is the whole user database, on purpose."
2. **The customer** (window 1, 1 min). Pick *Menlo Park*, say hello. A bot asks for the last name; answer, for example, *Müller*. Point out that the station choice travels as a custom attribute, the name as participant data, and routing is plain Architect.
3. **The agent** (window 2, 2 min). Accept the chat, open the WX-84 panel (cube icon above the right-hand panel), press *Engage link*. The popup flashes. The operator is *menlo*, verified by Genesys Cloud. The banner reads *Customer Müller requests Menlo Park: CLEARED*. Three stations are locked behind hazard plates.
4. **Live revocation** (window 4 → 2, 2 min). In the maintenance panel, switch Menlo Park **off** for `menlo`, lift the guard, commit. Within seconds the agent's station drops its lock plate, MASTER CAUTION flashes, and the flight recorder shows the change.
5. **Wrong agent** (2 min). Grant Menlo Park again. Start a *Melbourne* chat and transfer it to the Menlo queue. The agent's console says *Customer requests Melbourne: ACCESS DENIED*, and the attempt shows up red in the flight recorder.
6. **Supervisor** (window 3, 1 min). Start a chat via the plain chat bubble, with no station. It lands with the admin, whose console shows all four stations, including Dortmund HQ.

## Questions you will get

| Question | Answer |
|---|---|
| "Why not just use the customer's choice to decide what the agent sees?" | Then whoever controls the chat controls the access. Permissions follow the **agent's identity**. The customer's choice only *routes* and *highlights*. |
| "Can't someone just call the WX-84 API directly?" | Not without a session. Through the internet they can only get one via a valid Genesys token from *your* org that maps to a WX-84 user. |
| "Why a popup?" | Sign-in inside third-party iframes breaks: identity providers refuse framing, and browsers partition storage. A popup is the robust pattern, and it is instant when the agent is already signed in to Genesys Cloud. |
| "Is the customer's name verified?" | No. The customer typed it; it is a claim, fine for a weather briefing. For real customer data, use Authenticated Web Messaging so Genesys Cloud receives a verified customer identity. WX-84 shows the name but never stores or logs it. |
| "Who may see the customer's name?" | Only agents whom Genesys Cloud lets see the conversation: WX-84 reads it with the agent's own token. Genesys protects the customer data, WX-84 protects its own data. |
| "Does this scale beyond a text file?" | The file is a stand-in for any policy store: database, IdP groups, Genesys groups. The pattern stays the same: verify identity, map identity, check per request, log. |
| "What does the partner need from Genesys?" | One OAuth client (Code + PKCE), one Interaction Widget, and the `users/me` call. No Genesys data is stored by the partner. |
| "What happens when the Genesys token expires?" | The demo uses a 1-hour token. A production app re-runs the popup sign-in, which is silent while the agent's Genesys session is alive. |
