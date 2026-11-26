# Genesys Cloud setup

This guide connects the local WX-84 console to a Genesys Cloud org. The provisioning script is idempotent: run it as often as you like, and it only creates what is missing.

## What gets created

| Object | Name | Purpose |
|---|---|---|
| 4 users | from `genesys/agents.json` | The agents *Admin, Menlo, Indianapolis, Melbourne* (each gets an invitation e-mail) |
| Group | `WX-84 Agents` | All four agents. The group is the member list of the queue, and only its members see the widget |
| Queue | `WX-84 Weather Desk` | Every customer chat. Its members come from the group, so any agent may get any chat; WX-84 decides what each one sees. The setup deletes the station queues of the first design (`WX-84 Menlo Park`, `WX-84 Indianapolis`, `WX-84 Melbourne`, `WX-84 Supervisor`) if they exist |
| WebRTC phone per agent (optional) | `<agent name> (WebRTC)` | Browser softphone, set as the agent's default station, so the desktop does not ask for a phone. Skipped if the org has no cloud-media telephony site, or with `--no-phones`. Web messaging works without it. |
| Digital bot flow | `WX-84 Name Collector` | Asks the customer for their last name (one slot, `builtin:any`, no Virtual Agent). Each bot session is billed as "Genesys Cloud for Bot Flow - Digital" (tokens) |
| Inbound message flow | `WX-84 Station Router` | Calls the name bot, attaches the answer as `wx84.lastName`, then transfers every chat to `WX-84 Weather Desk`. The custom attribute `location` travels along as context |
| Messenger configuration + deployment | `WX-84 Flight Weather Desk` | The chat on the customer page. *Conversation clear* is enabled, so the page's **New conversation** button (and the trash icon in the chat header) can end a chat and remove it from the browser |
| OAuth client (Code/PKCE) | `WX-84 Agent Console (PKCE)` | Agents sign in to WX-84 with their Genesys identity. Tokens last 12 hours; the WX-84 session ends with the token and the console renews it silently two minutes before |
| Interaction Widget | `WX-84 Weather Command Unit` | Shows the console inside web-messaging interactions on the `WX-84 Weather Desk` queue |

## Prerequisites

* Admin access to a Genesys Cloud org (this guide uses region **usw2**, `apps.usw2.pure.cloud`). For another region, set `"region"` in `config/config.json` (for example `mypurecloud.de`) before running the setup.
* Four mailboxes for the agents. Plus-addressing works well (`you+wx84-menlo@…`).
* **Genesys Cloud CX licenses** for the four agents (routing needs them). The script reports users without a license.
* **Chrome or Edge** for the agents.

## Step 1 - Client Credentials OAuth client (one-time, manual)

The setup script needs API access. In Genesys Cloud: **Admin → Integrations → OAuth → Add Client**

* App name: `WX-84 Setup`
* Grant type: **Client Credentials**
* Roles: **Master Admin** (simplest for a demo org; see the end of this page for a narrower list)

Save, then store client id and secret in the **macOS keychain**. Each command prompts for the value, so it never lands in your shell history:

```bash
security add-generic-password -s wx84-genesys-setup -a client-id -w
```

```bash
security add-generic-password -s wx84-genesys-setup -a client-secret -w
```

On Linux/Windows, export `GENESYS_CLIENT_ID` and `GENESYS_CLIENT_SECRET` instead. Never put the secret into a file in this repository.

## Step 2 - Who plays the agents

```bash
cp genesys/agents.example.json genesys/agents.json
```

Enter real e-mail addresses. `genesys/agents.json` is git-ignored. Adjust `"roles"` if your org uses an agent role with a different name (for example `"Agent"`).

## Step 3 - HTTPS tunnel

Genesys Cloud is served over HTTPS. Chrome 142+ also blocks public pages from framing `http://localhost` (*Local Network Access*). So the widget needs a public HTTPS URL that forwards to your machine:

```bash
brew install cloudflared
```

```bash
cloudflared tunnel --url http://localhost:3000
```

Copy the `https://….trycloudflare.com` URL it prints. A quick tunnel gets a **new URL on every start**; just re-run step 4 with the new URL. For a stable URL, use an ngrok account with a free static domain (`ngrok http --url=<your-domain> 3000`).

> Security: through the tunnel the console is reachable from the internet. WX-84 detects tunnelled requests and **disables the password-less operator keys** for them; only verified Genesys Cloud sign-in works there.

## Step 4 - Run the setup

```bash
npm start
```

```bash
npm run genesys:setup -- --public-url https://<your-tunnel>.trycloudflare.com
```

Read-only check of what exists:

```bash
npm run genesys:status
```

The script writes `config/config.json` (IDs only, no secrets). It also links the WX-84 users in `data/users.txt` to the agents' e-mail addresses. The running server picks up both files automatically.

## Step 5 - Agents

1. Each agent accepts the invitation e-mail and sets a password.
2. **Run the setup once more.** New users join the group, and with it the queue, only after they are active.
3. Each agent signs in to `https://apps.usw2.pure.cloud` (use separate Chrome profiles or incognito windows to run several agents at once) and goes **On Queue**. Genesys Cloud loads widgets at sign-in, so an agent who was already signed in when the setup ran must reload the page once.

Every chat goes to `WX-84 Weather Desk`, and Genesys offers it to any agent of the group who is On Queue and idle. To decide who gets the next chat, put only that agent On Queue.

## Step 6 - Test

1. Put only the Menlo agent On Queue. Open `http://localhost:3000/customer/` and click **Chat with Menlo Park**. Write "hello" and answer the bot with a last name.
2. The Menlo agent accepts the chat. In Agent Workspace the widget sits behind the **cube icon** in the toolbar above the right-hand panel (or under **Tools**). Open **WX-84 Weather Command Unit**. It links itself within a few seconds (lamp GENESYS turns green). If it says *AUTO-LINK NOT AVAILABLE*, press **Engage link**: a popup flashes and closes.
3. The console shows the operator `menlo / WX-84 Menlo Park`, identity source *Genesys Cloud*, **CUSTOMER MÜLLER REQUESTS MENLO PARK (KPAO) - CLEARED** (with the name you gave the bot), and only the Menlo Park station. The other stations are hidden.
4. Start a **Melbourne** chat while the Menlo agent is still the only one On Queue. The console shows **ACCESS DENIED** for the requested station, and Melbourne stays hidden. Transfer the chat to the Melbourne agent, whose console shows Melbourne.
5. On your Mac, sign in locally as `admin` (`http://localhost:3000`), open the **maintenance panel**, revoke a station, lift the guard, commit. The station disappears from the agent's console within ~4 seconds.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No WX-84 panel (no cube icon) in the interaction | The agent signed in before the setup created the widget: reload the page · the agent is not in the `WX-84 Agents` group · the conversation is not on the `WX-84 Weather Desk` queue |
| WX-84 panel is cut off on the right, with a horizontal scrollbar | The Agent Workspace column is wider than the browser window. Widen the window, collapse the interaction column («), or zoom out (Cmd/Ctrl −). The console itself fits down to about 230 px |
| Profile panel says "You do not have permission to view external contacts" | Unrelated to WX-84: the agents' roles lack `externalContacts:contact:view`. Close the panel or grant the permission |
| Widget panel stays blank | URL is `http://` (use the tunnel) · tunnel stopped or URL changed (re-run step 4) · the WX-84 server is not running |
| "AUTO-LINK NOT AVAILABLE" | Genesys' login did not recognize the browser. Two causes. **1. The Genesys login session has expired** although Agent Workspace is still open: the desktop stays signed in on its own token (for example across a browser restart), the login session does not. Press **Engage link**; if the popup asks for the Genesys password, sign in once, and from then on the panel links silently again. **2. Third-party cookies are blocked** (Safari, incognito windows, a Chrome setting, a company policy), so the embedded sign-in never sees the login session. Press **Engage link** for the popup. To make Chrome link silently: Settings → Privacy and security → Third-party cookies → *Allowed to use third-party cookies* → **Add** `[*.]pure.cloud`, then reload Agent Workspace. In an incognito window, use the eye icon in the address bar instead, or use a normal Chrome profile per agent |
| "Token was not issued to the WX-84 OAuth client" | The token came from another OAuth client. Sign in through the WX-84 console only; if the setup was re-run in another org, check `oauthClientId` in `config/config.json` |
| "POP-UP BLOCKED" | Allow pop-ups for the tunnel domain in Chrome |
| Popup shows `redirect_uri` error | The tunnel URL changed since the last setup run; re-run step 4 |
| "ACCESS DENIED - no WX-84 account for …" | No line in `data/users.txt` has exactly that Genesys e-mail in the `genesys` column, or two lines share it (see `server/identity.js`) |
| "Token belongs to a different Genesys Cloud organization" | You are signed in to another org in this browser |
| Chat went to an agent who is not cleared for the station | Expected: every agent of the group can get any chat. The console says ACCESS DENIED and keeps the station hidden. Transfer to a cleared colleague, grant the station in the maintenance panel, or put only the right agent On Queue for the demo |
| `NO STATION SPECIFIED BY CUSTOMER` in the console | The `location` attribute did not arrive before the first message: use the station buttons, not the bare chat bubble, and press **New conversation** between tests (Messenger keeps the last conversation in the browser, even across incognito tabs). Or the agent's role lacks permission to read conversations (`conversation:communication:view`) |
| `CONVERSATION LOOKUP FAILED` in the console | The text below it names Genesys' answer. An expired Genesys token no longer ends here: the console relinks by itself and repeats the lookup. To test renewal without waiting 12 hours, start the server with `WX84_GENESYS_SESSION_MAX_SECONDS=300` (launch configuration `wx84-short-sessions`): sessions last 5 minutes and renew after about 2 |
| Every server restart asks agents to sign in again | Sessions live in memory. The panels relink by themselves, silently while the agent's Genesys login session is alive, otherwise through the popup. A panel in a background window waits until it is visible again (Chrome slows background timers to about once a minute, which made silent sign-ins time out) and then relinks within seconds. Avoid restarting the server during a demo |
| `NO STATION CLEARED` in the console | The agent's line in `data/users.txt` lists no station. Grant one in the maintenance panel |
| Flow job failed | The script prints Architect's validation messages. Fix `genesys/flow/wx84-station-router.yaml` and re-run |
| Agent desktop says "no phone selected" | The phone step was skipped: the org has no active site with cloud media (Genesys Cloud Voice or BYOC Cloud) besides the Genesys core site, or no WebRTC base settings. Messaging still works; create the site/base settings and re-run to get phones |
| "no license assigned yet" | Assign a Genesys Cloud CX license to the user (Admin → People) |
| Customer page: "Messenger is not configured" | Run the setup; the page reads the deployment id from `config/config.json` |

## Narrower permissions for the setup client

Instead of Master Admin, a custom role with: `directory:user:add/view`, `directory:group:add/edit/view`, `authorization:role:view`, `authorization:grant:add`, `authorization:license:view`, `routing:queue:add/edit/view/delete`, `architect:job:create/view`, `architect:flow:view/edit/publish`, `webDeployments:configuration:add/edit/view`, `webDeployments:deployment:add/edit/view`, `oauth:client:add/edit/view`, `integrations:integration:add/edit/view`, and for the optional WebRTC phones `telephony:plugin:all`.
