# Getting started
1. `pnpm install` (the Hugeicons Pro registry token must be available — in a repo `.npmrc` copied from `.npmrc.example`, or in `~/.npmrc`)
2. `pnpm --filter @realm/server build` (desktop dev spawns `apps/server/dist/main.js` on Electron's own binary, run as Node with `ELECTRON_RUN_AS_NODE`; set `REALM_NODE` to run it on a specific node binary instead, or `REALM_SERVER_ENTRY` to point at another build). The root `pnpm dev` script runs this build for you before starting.
3. `pnpm dev`
4. Agent sessions: Claude sessions need the `claude` CLI installed and logged in (`claude auth login`); the session's install card tells you when it isn't. To work without a Claude login, run `REALM_ENABLE_FAKE_AGENT=1 pnpm dev` — the Fake agent echoes messages and exercises the whole transcript / permission / interrupt path.
Layout: `apps/desktop` (Electron+React), `apps/server` (realm-server), `packages/contracts` (zod + layout ops + session events), `packages/adapters` (agent adapters: Claude, Codex, ACP, Fake), `packages/ui` (Hugeicons + theme).
Session data: `sessions` + `session_events` tables in `~/Realm/realm.db`; the transcript is rebuilt from events (`sessions.events`) on relaunch and a later message resumes the provider session.
The renderer talks to realm-server only over WebSocket (`ws://127.0.0.1:<port>`); the port arrives via preload arg `--realm-port`.

## GitHub sign-in for MCP

GitHub's MCP server (`api.githubcopilot.com/mcp/`) issues no client to apps on the fly, so Connect signs in with the GitHub CLI's existing login (`gh auth token`), a pasted personal access token, or the device flow. The device flow uses Realm's own GitHub OAuth App ("Realm", owned by 31Carlton7, managed at github.com/settings/developers): device flow enabled, callback `http://127.0.0.1/oauth/callback`, and user tokens that do not expire, because the device flow keeps no refresh path. Its client id is `GITHUB_OAUTH_CLIENT_ID` in `apps/server/src/mcp/providers.ts`, and the sheet asks for the scopes `repo read:org workflow`. `REALM_GITHUB_CLIENT_ID=<id> pnpm dev` tries another app locally.
