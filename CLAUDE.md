# GC-3rdParty-AccessMgmtExample (WX-84)

Public demo for Genesys Cloud partners: a third-party tool with its own access management (plain-text permission file), embedded in the Genesys Cloud agent desktop as an Interaction Widget. Agent identity comes from Genesys Cloud (Authorization Code grant with the client secret on the server, refresh tokens, verified server-side; agents link once). Customer page starts Web Messaging with the custom attribute `location` (context, not routing); an Architect flow asks the last name and sends every chat to one queue, `WX-84 Weather Desk`, whose members are the group `WX-84 Agents`. The console shows only the stations the agent is cleared for and hides the rest.

**Language:** all code, UI, comments and docs in English (public repo). Conversation with Juergen in German is fine.

## Run

* `npm start`: server on http://localhost:3000 (console) and /customer/ (customer page). Zero npm dependencies, Node 20+.
* `npm run genesys:setup -- --public-url https://<tunnel>`: provisions the Genesys Cloud org (idempotent). `npm run genesys:status`: read-only.
* Browser preview: `.claude/launch.json` → name `wx84`.

## Genesys Cloud org

* Region **usw2** (`apps.usw2.pure.cloud`, Messenger env `prod-usw2`).
* Setup credentials: macOS keychain, service `wx84-genesys-setup`, accounts `client-id` / `client-secret`. Never in files.
* Object names all start with `WX-84` (queue, flows, group, Messenger, OAuth client, integration). See `genesys/setup.js` → `NAMES`.
* The only manual Genesys step after the setup: Admin > Contact Center > Panel Manager > Message > default panel = WX-84 Weather Command Unit (no API). The setup grants `agentUI:defaultPanels:view` through the role `WX-84 Agent`.

## Local-only files (git-ignored, never commit)

`data/users.txt`, `data/flight-recorder.log`, `data/sessions.enc` (encrypted sessions incl. refresh tokens), `config/config.json` (IDs only), `genesys/agents.json` (real e-mails).

## Conventions

* Authorization is enforced server-side only; UI hiding is cosmetic.
* Permissions are read per request (file mtime), never cached in sessions.
* Local operator keys only for loopback requests without proxy headers (`isLocalRequest`).
* Before each commit: `npm run scan` (secret scan, also installed as pre-commit hook).
* Genesys sign-in = Authorization Code grant with the client secret on the server (`server/genesys-auth.js`), **no PKCE** (Genesys then sends no refresh token). The server keeps the refresh token and renews the 1-hour access token itself; sessions are stored encrypted in `data/sessions.enc` (key derived from the client secret, keychain account `agent-client-secret`). Watch renewal with launch configuration `wx84-fast-refresh`. Partner-facing explanation: `docs/partner-sso-guide.md`; keep it current when the sign-in changes.
* Commits use the GitHub noreply address (repo-local `user.email`), never a private address.
* `docs/*.html` are standalone pages served by GitHub Pages (branch `main`, folder `/docs`). The same files are also published as claude.ai artifacts: for that, publish a copy without the first four lines (doctype, `<html>`, charset, viewport), which the artifact service adds itself.
