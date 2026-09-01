# Realm Plan 14 — Dogfood polish convoy

Small, independent chores each sized for one worktree session; the open-threads list made real.

- **W1 Ship log**: durable `ships` table (migration) written by `workspace.ship` (sha/branch/pr-url/
  environment/when); the space page History tab renders checkpoints ∪ ships and drops its "not recorded
  durably" apology.
- **W2 Profile page**: a `profile-page` item kind (sentinel `…005`) — the defining-scope home W4-p12
  pointed "Edit in profile" at: profile-scoped skills/MCP/memory listed and editable, spaces of the
  profile listed. Banner language consistent with the existing defining-scope editor.
- **W3 Cursor plan mode**: read `modes.availableModes` from ACP `session/new`, map Build/Plan where the
  agent offers an equivalent, flip `AGENT_SUPPORTS_PLAN_MODE["acp:cursor"]` only when a session's modes
  actually carry it (per-session capability, not a static lie). The chip may appear mid-session-start —
  the documented reason it was deferred; solve the materialization honestly (chip present but disabled
  until modes arrive).
- **W4 Browser allowlist UI**: the per-space allowlist (exists server-side, default allow-all) gets an
  editor on the space page Connections tab + the default posture decision surfaced ("All origins" vs
  listed), stated as guardrail-not-security per doctrine.
- **W5 Odds**: App-tab reduced-motion note; `sessions.send` `text.min(1)` relaxed so attachment-only
  messages send (adapters already cope — verify per adapter, the honesty table updates); the sidebar
  count pill for Tasks if W2-p13 lands first.
