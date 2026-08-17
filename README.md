# Realm

Local-first agent control plane for macOS — profiles → spaces, split panes for agents / terminals / browser / simulator / artifacts, a context pool, and an MCP gateway. See `docs/superpowers/specs/2026-08-17-realm-v1-design.md`.

## Dev
- Node ≥ 22.13, pnpm 10, macOS.
- Hugeicons Pro token in `.npmrc` (see `.npmrc.example`).
- `pnpm install && pnpm dev`
- Tests: `pnpm test`  ·  Types: `pnpm typecheck`
- Data lives in `~/Realm/` (override with `REALM_HOME`).

## Agent sessions
- **Claude** sessions run on `@anthropic-ai/claude-agent-sdk`, which drives the `claude` CLI: install it and log in first (`claude login`). An expired login shows up as an error in the transcript.
- Offline / UI work: `REALM_ENABLE_FAKE_AGENT=1 pnpm dev` registers a scripted **Fake agent** (echoes what you send) next to Claude in New → Session….
