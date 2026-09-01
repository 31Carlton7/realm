# Realm

Local-first agent control plane for macOS — profiles → spaces, split panes for agents / terminals / browser / simulator / artifacts, a context pool, and an MCP gateway. See `docs/superpowers/specs/2026-08-17-realm-v1-design.md`.

## Dev
- Node ≥ 22.13, pnpm 10, macOS.
- Hugeicons Pro token in `.npmrc` (see `.npmrc.example`).
- `pnpm install && pnpm dev`
- Tests: `pnpm test`  ·  Types: `pnpm typecheck`
- Data lives in `~/Realm/` (override with `REALM_HOME`).

## Agent sessions
- **Claude** sessions run on `@anthropic-ai/claude-agent-sdk`, which drives the `claude` CLI: install it and log in first (`claude auth login`). An expired login shows up as an error in the transcript.
- Offline / UI work: `REALM_ENABLE_FAKE_AGENT=1 pnpm dev` registers a scripted **Fake agent** (echoes what you send) next to Claude in New → Session….
- **MCP gateway** — third-party MCP servers are configured in a space's settings, not per-agent: every session gets one Realm gateway endpoint, and credentials or OAuth tokens never reach the agent CLI. Every proxied tool call shows up in the Activity view (space settings → Activity, or "MCP Activity" in the command palette).

## Skills

`skills/` holds skills Realm ships, one folder per skill, laid out exactly like the library at
`~/Realm/skills/` (spec §7) so installing one is a copy. `SkillSync` — per-profile enablement and
the symlink into each session's `.claude/skills/` — is not built yet, so until it is, enable a
bundled skill by hand:

```sh
ln -s "$PWD/skills/mac" ~/.claude/skills/mac
```

- **`mac`** — the [mac-cli](https://macoscli.sh) binary: Calendar, Reminders, Contacts, Mail,
  Messages, Notes, Music, TV, Shortcuts, Finder, and iWork from the shell. Realm spawns agents and
  terminals with its own environment inherited, so `mac` is already on a session's `PATH` whenever
  it is on the `PATH` Realm was launched from — the skill exists to make it *discoverable*, not
  reachable. Note that a Realm launched from Finder rather than a terminal inherits launchd's
  minimal `PATH`, which has neither `mac` nor `claude`/`codex`/`node` on it; that is a packaging
  problem for all of them, not a mac-cli one.
