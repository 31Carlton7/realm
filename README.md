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

## Packaging

- `pnpm dist` — full build + DMG and zip in `apps/desktop/release/` (`pnpm dist:dir` stops at an
  unpacked `Realm.app` for fast iteration). Under the hood: root `pnpm build`, then
  `apps/desktop/scripts/stage-pack.mjs` stages `.pack-stage/` (a `pnpm deploy` of realm-server with
  its production `node_modules`, the bundled `skills/`, the ScrollPhase helper, the icon), then
  electron-builder (`apps/desktop/electron-builder.yml`) packs it — server and skills as real files
  under `Contents/Resources/`, never inside the asar, because `node-pty`'s native prebuilds and a
  spawnable server entry can't load from an archive.
- No system Node needed: the packaged app runs realm-server under its own binary with
  `ELECTRON_RUN_AS_NODE`. Launched from Finder (launchd's minimal `PATH`), main adopts the login
  shell's `PATH` at startup (`login-shell-path.ts`) before anything spawns, so agent CLIs and
  `mac` resolve; if the login shell can't be asked (exotic shell, timeout), it falls back to the
  inherited `PATH` plus `/opt/homebrew/bin:/usr/local/bin`. Terminals spawn login shells (`-l`).
- Proof: `node apps/desktop/scripts/packaged-smoke.cjs` launches the packaged binary with a
  scratch `REALM_HOME` and a stripped `PATH=/usr/bin:/bin` and asserts boot, `agents.probe`
  finding `claude`, bundled skills, and a terminal resolving `claude`.
- **Unsigned by default**: with no signing credentials in the env, `pnpm dist` builds an unsigned,
  un-notarized app (`scripts/pack.mjs` passes `-c.mac.identity=null` and says so). A copy
  downloaded to another Mac will be quarantined: first launch needs right-click → Open, and on
  Apple Silicon Gatekeeper may report the app "damaged" — clear it with
  `xattr -cr /Applications/Realm.app`. Locally built copies launch normally. Signing and
  notarization are fully wired and env-activated (`CSC_LINK`/`CSC_KEY_PASSWORD` +
  `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`): with those set, the same `pnpm dist`
  signs, notarizes and staples with zero code changes — exact steps in `docs/dev/signing.md`.

## Releasing

- `pnpm release` — bumps the app version (patch; `--minor` / `--major` for more), prepends a
  changelog stub to `CHANGELOG.md` from merged PR titles since the last tag (via `gh` when it
  answers, else git log's squash-merge subjects; offline it degrades to plain commit subjects),
  builds the dmg + zip + `latest-mac.yml` through the normal `pnpm dist`, commits, and creates the
  `vX.Y.Z` tag **locally**. It never pushes and never publishes — it ends by printing the exact
  manual next steps (review the stub, push branch + tag, `gh release create` with the artifacts).
  `--dry-run` shows the whole plan without touching anything.

## Updates

- The app carries auto-update scaffolding (`electron-updater`, Settings → App → Updates), but the
  updater **ships disabled** and the Settings row says why instead of pretending. The gate
  (`apps/desktop/src/main/updater.ts`) only ever enables when ALL of: packaged app, signed build,
  and `UPDATE_FEED_LIVE` flipped true.
- Why disabled: this repo is **private**. electron-updater's GitHub provider can only read private
  release assets with an API token, and shipping a GitHub token inside the app would hand it to
  every user — banned, permanently. And updates into an unsigned app can't pass Squirrel.Mac's
  signature validation anyway.
- Activation conditions (both required): **(1)** releases reachable without credentials — public
  GitHub releases carrying the dmg/zip + `latest-mac.yml` that `pnpm release` builds, or a generic
  update server (any static host serving the same files) swapped into `electron-builder.yml`'s
  `publish` block; **(2)** signed + notarized builds (`docs/dev/signing.md`). Then flip
  `UPDATE_FEED_LIVE` in `updater.ts` — nothing else changes: the Settings row starts offering a
  real check, and quit-and-install already tears the server child down cleanly
  (`before-quit-for-update`).

## Importing from the agent CLIs

Settings → **Import** brings what Claude Code, Codex and Cursor already have on disk into Realm:
transcripts, the Claude memory tool's per-project fact folders, and user-level skills.

- **The agents' directories are read-only.** `~/.claude`, `~/.codex`, `~/.cursor`, `~/.agents` and
  `~/.gemini` are copied *from* — never written, moved or cleaned up. Everything the import produces
  lands in Realm's database or under `~/Realm/`.
- **`import.scan` writes nothing.** It opens files, matches candidates to spaces and answers; no
  space, session or environment is created by looking. Only `import.apply` writes, and only for the
  keys it is handed — so the preview you approve is the work that happens.
- **Space matching is most-specific-location-wins** (`apps/server/src/import/match.ts`): walking the
  cwd and its parent, asking in turn for an environment, a project root, a space folder, and a
  directory named after a space. The walk is bounded (`MATCH_MAX_HOPS`) because one broadly-registered
  ancestor would otherwise capture every session on the machine. Anything unmatched falls to a
  profile's `Imported` space, and every row shows the rule that placed it so a wrong guess is visible.
- **Imported sessions keep their provider id** when the recorded cwd still exists, so sending a
  message resumes the real CLI conversation. Where the directory is gone the link is left off and the
  session imports as searchable history. Re-target rows in the preview: `sessions.moveToSpace` refuses
  once a session has events, and an imported session has a transcript from the moment it exists.
- **Memory is not flattened into the space doc.** Fact files are copied to
  `~/Realm/memory/imported/<spaceId>/<project>/` and the index goes into the space's memory document
  between `<!-- realm:imported-memory -->` markers (replaced on re-import, never duplicated). The
  largest folder here was 712k characters against a 100k doc cap; inlining would have dropped most of
  it and called that an import.
- **Skills are copied, never symlinked or overwritten**, and land unscoped — visible in every space,
  the honest translation of "installed for my user".

One transcript is not one file. Codex rewrites a whole thread into a new rollout file every time it
is resumed — on one machine here, 241 files were 71 conversations, with 158 of them replays of a
single Stora thread. The scan keeps the fullest copy of each and counts the rest, so the panel offers
conversations rather than files.

Two scripts, from `apps/server`:

- `tsx scripts/live-import-check.ts` — prints what an import would do against this machine's real CLI
  directories, reading a `VACUUM INTO` copy of the database so it can reason over your actual spaces
  without being able to write to them.
- `tsx scripts/undo-import.ts --all-imported --sweep-environments` — takes an import back out. Only
  rows whose dispatch origin is `import` are touched, and the agents' own directories are never read
  or written. Worth knowing about before a big import: an imported session cannot be re-targeted
  afterwards, and the environment rows an import leaves behind will out-match everything on the next
  run if they are not swept with it.

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
