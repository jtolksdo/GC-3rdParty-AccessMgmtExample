# Genesys Cloud setup

This guide connects the local WX-84 console to a Genesys Cloud org. The provisioning script is idempotent: run it as often as you like, and it only creates what is missing.

## What gets created

| Object | Name | Purpose |
|---|---|---|
| 4 users | from `genesys/agents.json` | The agents *Admin, Menlo, Indianapolis, Melbourne* (each gets an invitation e-mail) |
| Group | `WX-84 Agents` | Only these users see the widget |
| 4 queues | `WX-84 Menlo Park`, `WX-84 Indianapolis`, `WX-84 Melbourne`, `WX-84 Supervisor` | One agent each; the admin works the Supervisor queue |
| WebRTC phone per agent (optional) | `<agent name> (WebRTC)` | Browser softphone, set as the agent's default station, so the desktop does not ask for a phone. Skipped if the org has no cloud-media telephony site, or with `--no-phones`. Web messaging works without it. |
| Inbound message flow | `WX-84 Station Router` | Routes by the custom attribute `location` |
| Messenger configuration + deployment | `WX-84 Flight Weather Desk` | The chat on the customer page |
| OAuth client (Code/PKCE) | `WX-84 Agent Console (PKCE)` | Agents sign in to WX-84 with their Genesys identity |
| Interaction Widget | `WX-84 Weather Command Unit` | Shows the console inside web-messaging interactions on the WX-84 queues |

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
2. **Run the setup once more.** New users can only be added to queues after they are active.
3. Each agent signs in to `https://apps.usw2.pure.cloud` (use separate Chrome profiles or incognito windows to run several agents at once) and goes **On Queue**. Genesys Cloud loads widgets at sign-in, so an agent who was already signed in when the setup ran must reload the page once.

## Step 6 - Test

1. Open `http://localhost:3000/customer/` and click **Chat with Menlo Park**. Write "hello".
2. The Menlo agent accepts the chat. In Agent Workspace the widget sits behind the **cube icon** in the toolbar above the right-hand panel (or under **Tools**). Open **WX-84 Weather Command Unit** and press **Engage link**. A popup flashes and closes.
3. The console shows the operator `menlo / WX-84 Menlo Park`, identity source *Genesys Cloud*, and **CUSTOMER REQUESTS MENLO PARK (KPAO) - CLEARED**.
4. Transfer the chat to the Melbourne queue. The Melbourne agent sees Melbourne. Transfer a Melbourne chat to Menlo and the Menlo console shows **ACCESS DENIED** for the requested station.
5. On your Mac, sign in locally as `admin` (`http://localhost:3000`), open the **maintenance panel**, revoke a station, lift the guard, commit. The agent's console locks that station within ~4 seconds.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No WX-84 panel (no cube icon) in the interaction | The agent signed in before the setup created the widget: reload the page · the agent is not in the `WX-84 Agents` group · the conversation is not on a WX-84 queue |
| WX-84 panel is cut off on the right, with a horizontal scrollbar | The Agent Workspace column is wider than the browser window. Widen the window, collapse the interaction column («), or zoom out (Cmd/Ctrl −). The console itself fits down to about 230 px |
| Profile panel says "You do not have permission to view external contacts" | Unrelated to WX-84: the agents' roles lack `externalContacts:contact:view`. Close the panel or grant the permission |
| Widget panel stays blank | URL is `http://` (use the tunnel) · tunnel stopped or URL changed (re-run step 4) · the WX-84 server is not running |
| "POP-UP BLOCKED" | Allow pop-ups for the tunnel domain in Chrome |
| Popup shows `redirect_uri` error | The tunnel URL changed since the last setup run; re-run step 4 |
| "ACCESS DENIED - no WX-84 account for …" | No line in `data/users.txt` has exactly that Genesys e-mail in the `genesys` column, or two lines share it (see `server/identity.js`) |
| "Token belongs to a different Genesys Cloud organization" | You are signed in to another org in this browser |
| Chat lands in `WX-84 Supervisor` instead of the station | The `location` attribute did not arrive before the first message. Use the station buttons, not the bare chat bubble. Reload the page between tests. |
| `NO STATION SPECIFIED BY CUSTOMER` in the console | Same as above, or the agent's role lacks permission to read conversations (`conversation:communication:view`) |
| Flow job failed | The script prints Architect's validation messages. Fix `genesys/flow/wx84-station-router.yaml` and re-run |
| Agent desktop says "no phone selected" | The phone step was skipped: the org has no active site with cloud media (Genesys Cloud Voice or BYOC Cloud) besides the Genesys core site, or no WebRTC base settings. Messaging still works; create the site/base settings and re-run to get phones |
| "no license assigned yet" | Assign a Genesys Cloud CX license to the user (Admin → People) |
| Customer page: "Messenger is not configured" | Run the setup; the page reads the deployment id from `config/config.json` |

## Narrower permissions for the setup client

Instead of Master Admin, a custom role with: `directory:user:add/view`, `directory:group:add/edit/view`, `authorization:role:view`, `authorization:grant:add`, `authorization:license:view`, `routing:queue:add/edit/view`, `routing:queueMember:manage`, `architect:job:create/view`, `architect:flow:view/edit/publish`, `webDeployments:configuration:add/edit/view`, `webDeployments:deployment:add/edit/view`, `oauth:client:add/edit/view`, `integrations:integration:add/edit/view`, and for the optional WebRTC phones `telephony:plugin:all`.
