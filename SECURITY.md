# Security

Shared Table starts coding agents on your computer and can let a phone reach them. Please read this before exposing it.

## Reporting a problem

Open a private report at https://github.com/iboss21/shared-table/security/advisories/new. Do not put exploit details in a public issue. Reports are answered by the publisher, LIKE A KING INC.

## What protects you

- **Host page.** The main page is served on `127.0.0.1` only. It rejects any other `Host` header (DNS rebinding), cross-site requests and POSTs without a matching `Origin`. The session cookie is `HttpOnly` and `SameSite=Strict`.
- **Phones.** Wi-Fi and tunnel traffic arrive on separate listeners that never grant host rights. A device gets in only by claiming a pairing code shown on the host: 144 random bits, single use, valid 10 minutes, at most 12 attempts a minute. The device then holds its own random secret; the server stores only its SHA-256 hash. Remove a device on the host to cut it off at once.
- **What a phone can do.** Read the conversation, send messages, stop a run, edit the board, switch or start conversations. It cannot turn phone access on or off, create pairing codes, remove devices or delete conversations.
- **Agents.** No shell is involved in starting them; prompts travel on stdin or as one argument. API-key environment variables are removed unless you pass `--allow-api-keys`, so each CLI uses its own sign-in. `advise` mode gives agents no tools; `read` mode gives read-only tools; only `build` mode lets them change files.
- **Host-only actions.** Running commands, reverting or applying file changes, switching project, changing settings and managing phones need the host computer's session. A paired phone can answer permission requests unless you switch that off in Settings.
- **Preview.** The Preview tab shows a page in a sandboxed frame. It can load `localhost`, `127.0.0.1` and `https` addresses only.
- **Page.** A strict Content-Security-Policy with no inline script, and agent output is rendered as text nodes, never as HTML.

## What does not protect you

- `build` mode gives agents edit and command rights in your project folder. A paired phone can send prompts to it and approve what agents ask for. Pair only devices you control.
- The Commands tab runs whatever you type, as you, in the project folder. It is as powerful as a terminal. Switch it off in Settings if you do not want it.
- "Same Wi-Fi" is plain HTTP on your network. Anyone on that network can see the traffic. Use "Anywhere" (HTTPS tunnel) on networks you do not trust.
- "Anywhere" routes through a third-party tunnel (Cloudflare quick tunnel or localhost.run). They carry your traffic; their terms apply.
- Conversations are saved unencrypted under `~/.shared-table/`. Everything you type is also sent to the providers behind the agents you address.
- Other software running under your user account is inside the trust boundary.
