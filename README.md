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
- **ACP agents** — Cursor, Gemini, OpenCode, GitHub Copilot, goose, Qwen Code, Grok and fx all speak the
  Agent Client Protocol, so they share one generic adapter (`packages/adapters/src/acp/`) and adding another
  is an `AcpAgentSpec` entry in `apps/server/src/app.ts`. Install and sign in to each out of band; Settings →
  Engines probes what is on the machine and shows the exact install or login command for what is not.
  Realm never calls ACP's `authenticate` itself.
  - Note that ACP has **deprecated `modes`/`models` in favour of `configOptions`**, and agents have split:
    Cursor still answers with the old shape, OpenCode answers with only the new one, Copilot sends both.
    `acpSessionConfig` (in `@realm/contracts`) normalizes both and carries the id to write back through —
    reading one channel and writing on the other is a silent no-op.
- Offline / UI work: `REALM_ENABLE_FAKE_AGENT=1 pnpm dev` registers a scripted **Fake agent** (echoes what you send) next to Claude in New → Session….
- **MCP gateway** — third-party MCP servers are configured in a space's settings, not per-agent: every session gets one Realm gateway endpoint, and credentials or OAuth tokens never reach the agent CLI. Every proxied tool call shows up in the Activity view (space settings → Activity, or "MCP Activity" in the command palette).

## Saved sign-ins (browser panes)

An agent driving a browser pane can sign you in to a site without ever seeing the password.

- **You enroll, in Settings → Sign-ins.** That is the only path. No tool, no RPC method, no file import
  and no chat message can create a credential — which is what makes the origin check below worth
  anything, since an agent that could enroll one could enroll it for whatever page it is standing on.
- **Values live in the OS Keychain**, encrypted by Electron's `safeStorage`
  (`apps/desktop/src/main/secret-store.ts`), decrypted only inside Realm's main process, and never
  readable back — not by you, not over IPC, not through the gateway. MCP OAuth tokens share the same
  store, so `realm.db` no longer holds them in the clear. (Per-server MCP `env`/`headers` still do;
  `MCP_SECRET_STORAGE_NOTE` says so.)
- **Every fill is gated three ways**: the pane's current origin, read from CDP, must exactly equal the
  origin you saved the credential for (no subdomains, no lookalikes); you approve that specific fill on
  a card naming the origin, username and label; and Touch ID confirms you are there. The card appears
  in every permission mode including `bypassPermissions`, is never batched, and answering "always"
  licenses nothing. Fills are logged to `~/Realm/logs/credential-audit.log` — timestamp, origin,
  credential id, outcome, never the value.
- **Typing into a password field with `browser_act` is still refused, in every mode.**
  `browser_fill_credential` is a separate op, not a way around it.
- **Two-factor is not automated, and will not be.** A Duo/Okta push cannot be driven from here, and a
  TOTP prompt is out of scope. Realm fills the username and password and stops; an SSO + 2FA sign-in
  stays partly manual, and you finish it in the pane. If TOTP support is ever added it would be a
  separately enrolled secret under the same rules — never a code the model sees.
- A Mac without a Touch ID sensor can save sign-ins but cannot fill them: `promptTouchID` is
  biometrics-only, with no password fallback. Settings says so on the tab.

## Packaging

- `pnpm dist` — full build + DMG and zip in `apps/desktop/release/` (`pnpm dist:dir` stops at an
  unpacked `Realm.app` for fast iteration). Under the hood: root `pnpm build`, then
  `apps/desktop/scripts/stage-pack.mjs` stages `.pack-stage/` (a `pnpm deploy` of realm-server with
  its production `node_modules`, the bundled `skills/`, the ScrollPhase helper, the icon), then
  electron-builder (`apps/desktop/electron-builder.yml`) packs it — server and skills as real files
  under `Contents/Resources/`, never inside the asar, because `node-pty`'s native prebuilds and a
  spawnable server entry can't load from an archive.
- `pnpm app:update` — the fast local update loop: builds the unpacked app, gracefully quits the
  installed `/Applications/Realm.app`, replaces it with rollback protection, and relaunches it.
  Set `REALM_APP_PATH=/another/location/Realm.app` to target a nonstandard install. This is for
  locally built unsigned copies; published builds continue to use the signed updater below.
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

- Signed packaged builds check the public GitHub release feed on launch, download a newer version
  in the background, and ask before restarting to install it. Settings → App → Updates also supports
  manual checks and installing a downloaded update.
- Public releases must carry the dmg, zip, and `latest-mac.yml` artifacts produced by `pnpm release`.
  The updater never embeds a GitHub token.
- The hard gate in `apps/desktop/src/main/updater.ts` still disables updates in development and in
  unsigned builds: macOS cannot apply an unsigned Squirrel update. Configure signing and
  notarization as described in `docs/dev/signing.md`; `pnpm app:update` handles local unsigned builds.

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
