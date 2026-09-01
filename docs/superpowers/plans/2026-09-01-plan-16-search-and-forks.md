# Realm Plan 16 — Global search and session forks

- **W1 Search backend**: SQLite FTS5 over session events (user/assistant text), item titles, skills,
  memory docs — indexed incrementally on write (triggers or service hooks), per-profile scoped, migration
  with a backfill that tolerates large histories.
- **W2 Search UI**: ⌘K grows a deep-search mode (existing palette idiom — typing beyond command matches
  searches content; results grouped session/skill/memory with snippet + jump-to). Palette stays instant;
  search results may stream in.
- **W3 Session forks**: "Fork from here" on a checkpoint (History/checkpoint sheet): new session + fresh
  worktree restored to that checkpoint's tree, transcript seeded with a fenced summary-of-ancestor (the
  provider conversation CANNOT be rewound — documented; the fork is a workspace fork with context
  carried as text, stated in the UI).

# Plan 17 — Mobile pairing (DESIGN-GATED, not built unattended)
Pairing (à la `npx t3 pair --tailscale`) before any native client. Requires product decisions Carlton
must make in person: transport (tailscale/LAN), auth model, what a phone can approve. Written here so
the numbering is claimed; no autonomous build.
