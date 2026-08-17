# Getting started
1. `pnpm install` (the Hugeicons Pro registry token must be available — in a repo `.npmrc` copied from `.npmrc.example`, or in `~/.npmrc`)
2. `pnpm --filter @realm/server build` (desktop dev spawns `apps/server/dist/main.js` with system `node`; set `REALM_NODE` to a specific binary or `REALM_SERVER_ENTRY` to another build). The root `pnpm dev` script runs this build for you before starting.
3. `pnpm dev`
4. Agent sessions: Claude sessions need the `claude` CLI installed and logged in (`claude auth login`); the adapter's probe (New → Session…) tells you when it isn't. To work without a Claude login, run `REALM_ENABLE_FAKE_AGENT=1 pnpm dev` — the Fake agent echoes messages and exercises the whole transcript / permission / interrupt path.
Layout: `apps/desktop` (Electron+React), `apps/server` (realm-server), `packages/contracts` (zod + layout ops + session events), `packages/adapters` (agent adapters: Claude, Fake), `packages/ui` (Hugeicons + theme).
Session data: `sessions` + `session_events` tables in `~/Realm/realm.db`; the transcript is rebuilt from events (`sessions.events`) on relaunch and a later message resumes the provider session.
The renderer talks to realm-server only over WebSocket (`ws://127.0.0.1:<port>`); the port arrives via preload arg `--realm-port`.
