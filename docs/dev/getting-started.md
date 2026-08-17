# Getting started
1. `pnpm install` (the Hugeicons Pro registry token must be available — in a repo `.npmrc` copied from `.npmrc.example`, or in `~/.npmrc`)
2. `pnpm --filter @realm/server build` (desktop dev spawns `apps/server/dist/main.js` with system `node`; set `REALM_NODE` to a specific binary or `REALM_SERVER_ENTRY` to another build). The root `pnpm dev` script runs this build for you before starting.
3. `pnpm dev`
Layout: `apps/desktop` (Electron+React), `apps/server` (realm-server), `packages/contracts` (zod + layout ops), `packages/ui` (Hugeicons).
The renderer talks to realm-server only over WebSocket (`ws://127.0.0.1:<port>`); the port arrives via preload arg `--realm-port`.
