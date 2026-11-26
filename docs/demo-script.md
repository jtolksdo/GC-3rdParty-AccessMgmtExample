# Demo script (about 10 minutes)

**Message:** *A partner app embedded in Genesys Cloud keeps its own access model. Genesys Cloud provides the verified identity, and the app decides what that identity may see. You need no second login, no shared secrets in the browser, and you get an audit trail.*

## Setup before the audience arrives

* WX-84 server running, tunnel running, setup run with the current tunnel URL.
* Browser window 1: customer page `http://localhost:3000/customer/`.
* Browser window 2 (Chrome profile "Menlo"): Genesys Cloud, agent **WX-84 Menlo Park**, On Queue.
* Browser window 3 (Chrome profile "Admin"): Genesys Cloud, agent **WX-84 Admin**, Off Queue for now.
* Browser window 4: `http://localhost:3000`, signed in locally as **admin**, maintenance panel open.
* All other WX-84 agents Off Queue. Every chat goes to the same queue, *WX-84 Weather Desk*, so whoever is On Queue gets the next chat.
* Between runs, press **New conversation** at the top of the customer page. It ends the previous chat in Genesys Cloud and clears it from the browser, so the next station choice starts a fresh conversation.
* Every demo agent has linked WX-84 once since the last change to the sign-in (one `SIGN-IN` per agent in the flight recorder). The link survives server restarts and renews itself every hour, so there is no sign-in during the demo.

## Storyline

1. **The tool on its own** (window 4, 1 min). Show the cockpit with all four stations (the admin is cleared for everything), then the permission file in a text editor: "This is the whole user database, on purpose."
2. **The customer** (window 1, 1 min). Pick *Menlo Park*, say hello. A bot asks for the last name; answer, for example, *Müller*. Point out that the station choice travels as a custom attribute and the name as participant data. Neither routes the chat: every chat goes to one queue whose members are the group *WX-84 Agents*.
3. **The agent** (window 2, 2 min). Accept the chat, open the WX-84 panel (cube icon above the right-hand panel), and watch it link itself, with no window and no click. (In Safari or an incognito window it asks for one click on *Engage link*, and a popup flashes.) The operator is *menlo*, verified by Genesys Cloud. The banner reads *Customer Müller requests Menlo Park: CLEARED*. The console shows only Menlo Park; the stations Menlo is not cleared for are hidden.
4. **Live revocation** (window 4 → 2, 2 min). In the maintenance panel, switch Menlo Park **off** for `menlo`, lift the guard, commit. Within seconds the station disappears from the agent's console, MASTER CAUTION flashes, the banner turns to DENIED, and the flight recorder shows the change. Switch it back on: the station returns.
5. **Wrong station** (2 min). Start a *Melbourne* chat; Menlo takes it. The console says *Customer requests Melbourne: ACCESS DENIED*, Melbourne stays hidden, and the attempt shows up red in the flight recorder. The agent transfers to a cleared colleague.
6. **Supervisor** (window 3, 1 min). Put the admin On Queue and Menlo Off Queue. Start a chat via the plain chat bubble, with no station. The admin's console shows all four stations, including Dortmund HQ.

## Questions you will get

| Question | Answer |
|---|---|
| "Why not just use the customer's choice to decide what the agent sees?" | Then whoever controls the chat controls the access. Permissions follow the **agent's identity**. The customer's choice only *highlights*. |
| "Why one queue instead of a queue per station?" | A queue per station would hide the problem: the right agent would always get the right chat. With one queue for the whole team, any agent can get any chat, and the partner app has to decide what each one sees. That is the realistic case. |
| "Where are the other stations?" | Hidden, because this agent is not cleared for them. Hiding is cosmetic: the server never sends their data, even if someone un-hides them with developer tools. |
| "Can't someone just call the WX-84 API directly?" | Not without a session. Through the internet they can only get one via a valid Genesys token from *your* org that maps to a WX-84 user. |
| "How does it sign in without asking?" | The agent is already signed in to Genesys Cloud. A hidden frame asks Genesys for a one-time code, Genesys hands it over without showing its login page, and the WX-84 server trades it for tokens with its client secret. Where the browser withholds the login cookie from embedded pages (Safari, incognito), the console falls back to a popup, once. |
| "Could another app's Genesys token open WX-84?" | No. WX-84 asks Genesys which OAuth client issued the token (`tokens/me`) and accepts only its own. |
| "Is the customer's name verified?" | No. The customer typed it; it is a claim, fine for a weather briefing. For real customer data, use Authenticated Web Messaging so Genesys Cloud receives a verified customer identity. WX-84 shows the name but never stores or logs it. |
| "Who may see the customer's name?" | Only agents whom Genesys Cloud lets see the conversation: WX-84 reads it with the agent's own token. Genesys protects the customer data, WX-84 protects its own data. |
| "Does this scale beyond a text file?" | The file is a stand-in for any policy store: database, IdP groups, Genesys groups. The pattern stays the same: verify identity, map identity, check per request, log. |
| "What does the partner need from Genesys?" | One OAuth client (Authorization Code, its secret only on the partner's server), one Interaction Widget, and the `users/me` and `tokens/me` calls. No Genesys data is stored by the partner. |
| "What happens when the Genesys token expires?" | Nothing the agent notices. The WX-84 server keeps a refresh token and renews the 1-hour token itself, in the background, without the agent and without the agent's Genesys login. Sessions are stored encrypted, so even a server restart does not ask anyone to sign in again. |
| "Why did the popup ask for my password, although I am signed in to Genesys?" | Agent Workspace stays signed in on its own token; the separate Genesys *login* session can end after about an hour. That only matters for the very first link of an agent: afterwards the refresh token makes the login session irrelevant. |
| "How often does an agent sign in to the partner app?" | Normally never: the first link happens silently because the agent just signed in to Genesys, and the server keeps the link alive with the refresh token. At most one click in browsers that block third-party cookies. How partners build this: [partner guide](partner-sso-guide.md). |
