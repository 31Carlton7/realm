# Realm Plan 15 — Distribution readiness

- **W1 Auto-update scaffolding**: `electron-updater` wired (generic/GitHub provider), update-check UI in
  Settings→App (current version, "Check for updates", honest "updates unavailable: unsigned build /
  private repo" state — the repo is private, so the updater SHIPS DISABLED-BY-DEFAULT with the exact
  activation conditions documented: public releases or an update server + signing).
- **W2 Release discipline**: `pnpm release` — version bump, changelog stub from merged PR titles, dmg+zip
  + latest-mac.yml artifacts, git tag. No publishing.
- **W3 Signing/notarization scaffolding only**: electron-builder identity/notarize hooks behind env vars
  (`CSC_*`, `APPLE_*`), a docs page with the exact steps — CANNOT be executed here (needs Carlton's
  Apple Developer identity); the plan bans fake-signing workarounds.
