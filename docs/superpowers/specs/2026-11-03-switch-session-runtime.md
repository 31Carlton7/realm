# Spec: switch where a session runs, mid-conversation

Date: 2026-11-03. Base: `main` at v2.7.0 (69cfdbc1). Status: **for approval, nothing built.**

The owner's ask: *"Ability to switch where the session is currently running on the fly (both Realm and
Realm Mobile)."* Move a live session to another place (a worktree on this Mac, another of your
computers, later a cloud machine), from the desktop or the phone. The agent continues from where it
stopped.

This is one slice of Plan 30 Phase 2 ("an always-on machine, picked under the prompter",
`plan/30-always-on-employee`). That phase says a session "can be moved to another machine through
git, and its worktree is recreated there". This spec designs the move. It reuses that phase's
machine picker and capability table, and it builds the narrow server-to-server link the picker
needs anyway.

## What exists today

| Piece | Where | What it means for a move |
|---|---|---|
| `Session.environmentId`; `cwd` derived from the environment | `contracts/entities.ts` | Where a session runs is already one column, so a move is a write to that column plus whatever travels with it |
| `sessions.setEnvironment` | `sessions/service.ts:1136` | Exists, but **refuses with `SESSION_STARTED` once a session has any events**. That guard is the whole reason a started session can't move today |
| `sessions.moveToSpace` | same, `:1158` | Moves the space and keeps the checkout (`carryEnvironment`). It closes the terminal when the cwd changes. This is a useful template for the bookkeeping |
| `sessions.switchAgent` / `handOver` | `sessions/handover.ts` | An engine switch in place. It clears `providerSessionId`, writes a hand-off note, and carries the conversation as text under `handoffContextKey`. **This is the fallback whenever a native resume can't follow the session** |
| `sessions.setAccount` → `AccountsService.carry` | `accounts/service.ts:137` | Copies Claude's `projects/<dir>/<id>.jsonl` (plus the sibling folder) or Codex's `sessions/Y/M/D/rollout-…-<id>.jsonl` between config folders, then resumes natively. **This is the mechanism a cross-machine native resume needs**; it just has to cross a machine instead of a folder |
| `noteContextReset`, `resumeOutcome` on `init` | `sessions/service.ts:2075` | A refused resume already shows up honestly in the transcript as `context_reset` |
| `AGENT_SESSION_RESUME`, `AGENT_CONVERSATION_REWIND` | `contracts/presets.ts` | The resume table for each engine (below) |
| Checkpoints (`refs/realm/checkpoints/<env>/<id>`) | `workspace/checkpoints.ts` | They already capture a dirty tree, untracked files included, as a commit. That commit is how uncommitted work travels |
| `realm serve`, `realm token`, `realm remote add` | `ctl/commands.ts` | A headless server on another machine, plus token-authenticated clients. **The desktop's own server can't dial another server yet** |
| Under-composer chip `strip-machine` | `Composer.tsx:1430` | Static text, "Agents run on this Mac". Plan 30 turns it into the picker |
| Phone vault holds `[PairedMac]` | `RealmKit/Keychain/Vault.swift` | The phone can keep several Macs, but `mobile.v1` has no move call and no machine list |

**Bottom line:** a started session can't change environment at all. An engine switch and an account
switch both work, and between them they already contain both carry strategies (native record copy and
text hand-off). What's missing is the move itself, a server-to-server link, and the UI.

## Model: the session's ownership moves; nothing runs it remotely

A session lives in exactly one server's `realm.db` and runs there. A cross-machine move **transfers
ownership**: the target gets the row, the events, the queue and the workspace, under the **same
session id**. The source keeps a *moved* stub that points at the target.

Rejected alternative: the source stays home and the target is only a runner that streams events back.
It's simpler for clients, but the session dies whenever the source sleeps, and keeping things running
while the laptop is closed is the main reason to move a session in the first place (Plan 30's
always-on machine).

Same-machine moves (checkout → worktree, worktree → worktree) are the same pipeline with no link and
no transfer.

## What the user sees

### Mac

- **The chip under the composer becomes the picker** (Plan 30's three groups: This Mac, Your
  computers, Cloud). On this Mac there's one more level: *This checkout · New worktree · existing
  worktrees*. The workspace selector already does this for unstarted sessions. It now works on
  started sessions too.
- When you pick somewhere else on a started session, a **Move sheet** opens:
  - The header names both ends: *From MacBook Pro · ~/realm (main)*, *To Mac mini · new worktree*.
  - **Goes with it:** the conversation, *how it continues* ("Claude resumes exactly" or "Cursor
    continues from notes"), *12 changed files and 2 unpushed commits on `feat/x`*, and *3
    attachments*.
  - **Stays here:** the terminal (it closes), simulators and screens, browser panes, dev servers the
    agent started, ignored files (named when they look like secrets, e.g. `.env`), and rewinding to
    before the move.
  - **The target's gaps** come from Plan 30's capability table, for example *"Linux: no Xcode,
    simulators or `mac` CLI"*. The sheet also shows the engine's state there: *"Claude: signed in as
    …"*, or *"Codex isn't installed on Mac mini. Continue there with Claude?"*, which sends the move
    through `handOver`.
  - **Toggle:** *Leave my changes here too* (on by default, so the source tree is never touched). If
    you turn it off, the source is reset to HEAD after a checkpoint, and you can undo that.
  - **Move** button.
- **Mid-turn:** the sheet offers **Move after this turn**, which queues the move until the session
  goes idle (`whileSwitching`), or **Stop and move**. A pending permission request has to be answered
  first; Stop and move denies it.
- **During the move:** a progress row in the transcript (*Checking Mac mini → Packing → Sending 4.2
  MB → Starting Claude*). The composer still takes input, and messages queue. Every client draws the
  session as `moving`.
- **After the move:** one transcript line: *"Moved from MacBook Pro (~/realm) to Mac mini
  (~/Realm/worktrees/…/feat-x). The conversation continued."* (or "…carried as notes"). The sidebar
  row gets a machine badge. On the source, the session opens as a stub with *"This session now runs
  on Mac mini"*, **Open there** (once the desktop can reach that server) and **Move back**.

### Phone

- In `SessionView`, the composer settings row gets a chip: *"On MacBook Pro"*. Tapping it opens a
  sheet with the same destinations, from a new `session.moveOptions` call. The phone gets the same
  summary in a compact form, plus Move / Move after this turn.
- Progress and the result arrive as ordinary rows. The moved line is a `notice`, so phones on today's
  build draw it too.
- **Following the session:** if the phone is paired with the target, the session reopens through the
  target's channel and the same id keeps the same screen. If it isn't paired, the source vouches for
  the phone to the target over the server link (decision 3), and the phone adds the target to its
  vault without scanning a QR code. Without vouching, the stub says *"Pair Mac mini to keep
  following"*.
- Home lists the sessions needing you across **every** paired machine, with a machine label on each.

## What moves, and what doesn't

| Thing | Same machine (→ worktree) | Another machine |
|---|---|---|
| Transcript (events, seq, `seenSeq`), queue, title, goal state | Stays on the row | Copied into the target's DB under the same id; seq continues |
| Provider conversation | Record re-homed for the new cwd (see engines) | Record copied into the target's config folder, or carried as text |
| Uncommitted changes, untracked files | A pre-move checkpoint commit is checked out in the new worktree, then soft-reset so the changes stay uncommitted | The same checkpoint, plus the branch's unpushed commits, sent as a `git bundle` |
| The repo itself | Already there | The target finds the same `origin` URL among its spaces, or clones it with its own git credentials, or builds the repo from the bundle alone |
| Non-git folder | Not offered (a worktree needs git) | Tar, capped at 200 MB, otherwise refused with the size |
| Attachments (`tmp/attachments`), files a user message or the queue names | Unchanged | Copied, and paths are rewritten home-relative as events are imported |
| `files_made` outside the checkout | Unchanged | Copied up to the same cap, otherwise listed as left behind |
| Ignored files (`.env`, `node_modules`, build output) | **Never.** Listed by name if they look like secrets | **Never** |
| Terminal pty, agent-started processes, port block | Terminal closes; new block allocated (`ensureBlock`) | Same |
| Simulators, `realm-vm` machines, browser panes, `realm-computer` | Unaffected (they belong to the space or the Mac) | Stay on the source; the capability warning covers them |
| Checkpoints before the move | Still valid (same repo) | Stay on the source; the target starts a new lineage. Older turns show "Restore on MacBook Pro" |
| Engine account, credentials, secret answers | Unchanged | **Never carried.** The target uses its own sign-in |
| Memory context | Unchanged | Rebuilt from the target's memory repo (`memory.forgetSession`); syncing it between machines is Plan 30's setup sync |
| Sub-agent sessions | Stay; links still work | v1 refuses while a child is running; idle children stay where they are and link across |
| Teammate home sessions | Refused in v1 (moving a teammate is Plan 30's Lead placement) | Same |

## Resume constraints for each engine

| Engine | Same machine, new cwd | Another machine | Notes |
|---|---|---|---|
| **Claude** | Native. Copy `<cfg>/projects/<old-dir>/<id>.jsonl` and the sibling folder into `<cfg>/projects/<new-dir>/`. The CLI looks up a resume under the project folder for the cwd it starts in (P1 verifies this with a live capture) | Native. Same copy into the target's account folder, via `AccountsService.carry` generalized to (folder, cwd) → (folder, cwd) | The SDK forks to a new id on resume, and `init` records it. Truncating-resume cursors survive the copy, but restoring files needs the checkpoint refs, so rewind before the move works only on the source |
| **Codex** | Native. `thread/resume {threadId, cwd}` already takes the new `cwd` in `common` | Native. Copy the rollout under the same `sessions/Y/M/D/` path in the target's `CODEX_HOME` | An older codex on the target may decline a newer rollout. Then `context_reset` appears and the move falls back to notes. `thread/start` auto-trusts its cwd, and Realm only ever starts it in Realm-made worktree paths |
| **ACP kinds with `loadSession`** (cursor, gemini, opencode, copilot, goose, qwen, grok, fx, openhands, hermes) | Try `session/load {sessionId, cwd: new}`. If declined, `context_reset` plus notes | **Notes.** Every vendor keeps its store privately, and Realm has no locator for any of them | Adding a locator for a specific kind (Hermes and OpenHands are the likeliest) is Phase 4 |
| **acp:deepseek** | Notes | Notes | No session verbs at all |
| Engine missing or signed out on the target | — | Preflight blocks the move, or the user picks another engine there and the move goes through `handOver` | |

"Notes" is the existing `buildHandoffContext` plus generated hand-off notes, capped at
`HANDOFF_CONTEXT_MAX`, with `providerSessionId` cleared. Nothing new is built for it.

**Move note, for every engine.** The first turn after a move gets a one-time preface; it is not
user text and is stored on the `moved` event. It names the old and new cwd and machine, says the
paths in the conversation so far are under the old root, and lists what the target can't do. This is
how a native resume learns that it moved. Codex can't take new `developerInstructions` on resume,
which is why the preface goes on the turn rather than into instructions.

## The move pipeline, failure and rollback

Each move has a `moveId`, which is the idempotency key on both servers. The source stays in charge
until it commits.

1. **Preflight** (read-only): the target is reachable, its version is compatible, the engine is
   installed and signed in, it has repo access or will clone, there's enough disk, and the capability
   warnings are listed. Anything that fails here ends the move with the reason in the sheet. Nothing
   has changed yet.
2. **Freeze:** the session becomes `moving`. Sends queue (the phone's outbox already holds them),
   and the engine is stopped the way `reap` stops it.
3. **Snapshot:** a checkpoint labelled *Before move to Mac mini*. This is the undo point for the
   source tree.
4. **Place:** same machine: create the worktree (`EnvironmentService.createWorktree`) and apply the
   snapshot. Another machine: stream the bundle (manifest + events + git bundle + records +
   attachments, in chunks, with a hash on each) to the target's `moves.receive`. The target builds
   everything **hidden**, as a row in `moving_in`.
5. **Boot:** the target starts the engine with `resume`, sends nothing, and reports `resumeOutcome`.
   A declined resume isn't a failure: the target switches to notes and the outcome is recorded as
   `notes`.
6. **Commit:** the source sends `moves.commit`. The target makes the row visible and live. The source
   turns its row into the stub (`status: ended`, `movedTo {serverId, at}`), drains its queue to the
   target, and emits `moved`.

**Failure before commit** (any step from 1 to 5, a timeout, a cancel from the sheet): the target
throws away its hidden row and anything it created (the worktree via `discard`, the copied records).
The source unfreezes, keeps its engine stopped (the next send resumes as usual), and writes a
`move_failed` notice with the step and the reason. Nothing on the source has changed except the extra
checkpoint.

**The link drops during commit:** neither side runs a turn. The source retries
`moves.status {moveId}` with backoff, and the target answers `committed` or `pending`. A target that
never hears a commit expires its `moving_in` row after 24 h. A source that reboots mid-move asks the
target before it unfreezes. The move can never leave two live copies.

**Undo / move back:** this is just another move in the other direction. The source revives its stub
under the same id and appends the target's events after it. *Leave my changes here off* is undone by
restoring the snapshot checkpoint, like any other restore.

**Never automatic:** deleting the source worktree, pushing anything to a git remote (the bundle
travels only over the Realm link), or copying credentials.

## Contracts

- `SessionStatus` gains `moving`. `Session` gains `movedTo: {serverId, serverName, at} | null` and
  `machineId` (null = this server).
- New events: `moved {moveId, from, to, conversation: "native"|"notes", changes, leftBehind[], preface}`,
  `move_failed {moveId, step, reason}`. Mobile rows map both to `notice`.
- RPC: `sessions.moveOptions`, `sessions.move {id, to: {kind: "environment", environmentId} |
  {kind: "worktree", from?, base?} | {kind: "server", serverId, placement}, keepSourceChanges,
  when: "now"|"after-turn"|"stop"}`, `sessions.cancelMove`. Server-to-server: `moves.preflight`,
  `moves.receive`, `moves.commit`, `moves.status`, `moves.abort`.
- `mobile.v1` adds `session.moveOptions`, `session.move`, `machines.list` (an additive allowlist
  change) and `PROTOCOL.md` §8 rows.
- `realm move <session> --to <remote>|--worktree [NAME]` in the CLI, so headless servers and the
  Lead can use it.

## Phases and streams

Each bullet is one PR. P1 ships on its own. P2 and P3 need the server link.

**P1: move within one machine** (ships the pipeline with no network)

1. **@engines**: contracts (`moving`, `moved`, `move_failed`), `sessions.move` for environment and
   worktree targets, the snapshot→worktree apply, the Claude record re-homed per cwd, the Codex
   resume with the new cwd, ACP load then notes, the move preface, and rollback. Integration tests
   on fakes, plus a list of the mutants each guard has to kill (the started-guard bypass happens only
   on this path; the order is stop → context → row, as in `handOver`). Includes a live capture to
   confirm Claude's per-cwd lookup.
2. **@polish**: the workspace selector on started sessions, the Move sheet (same-machine half), the
   transcript progress row and moved line, and the "Move after this turn" queue chip.
3. **@mobile**: `session.moveOptions` / `session.move` in `mobile.v1` and `PROTOCOL.md`, the machine
   chip and destination sheet in `SessionView`, and the notice rows. Before/after simulator
   screenshots.

**P2: server link + machine list** (the narrow core of Plan 30 Phase 2)

4. **@oncall**: the desktop server dials saved remotes (`realm remote add` tokens, TLS/Tailscale) as a
   server-to-server client; `machines.list` (this Mac + remotes, with reachability, OS, version,
   engines installed and signed in, and Plan 30's capability row); and a "Connect another computer"
   flow that prints the `realm serve` and token commands.
5. **@polish**: the chip becomes the Plan 30 picker (This Mac / Your computers; Cloud greyed out until
   P4), with capability labels.

**P3: move to another machine**

6. **@engines**: the bundle format and `moves.*` two-phase protocol, chunked transfer with hashes,
   target adoption (matching the repo by origin, cloning, or bundle-only), attachment path rewriting,
   `AccountsService.carry` generalized across folder+cwd and machines, the stub and revival on move
   back, and `moves.status` recovery after a reboot. Tests boot two scratch-home servers in one
   process.
7. **@oncall**: the failure drills (kill the link at every step, reboot the source mid-commit, a full
   disk on the target, an older codex on the target), the 24 h expiry of `moving_in`, and the CLI
   `realm move`.
8. **@polish**: the full Move sheet (engine state on the target, capability gaps, secret-looking
   ignored files, the handOver offer when the engine is missing), the stub pane with Open there /
   Move back, and the sidebar machine badge.
9. **@mobile**: following a session across paired Macs by id, the machine label in Home's Needs-you
   list across all paired machines, and vouched pairing (if approved).

**P4: later**

10. **@engines/@oncall**: move to a new cloud machine (Plan 30's provisioning in your own provider
    account, then the P3 move), carrying checkpoint history in the bundle, per-kind ACP record
    locators, and a `session_move` tool so the Lead can send Mac-only work to a Mac.

## Decisions for the owner

1. **Ownership moves (recommended), or a remote runner streams back to a home server.** Moving
   ownership survives the source sleeping; a remote runner keeps one home DB.
2. **Write the copied Claude/Codex record into the target's default `~/.claude` / `~/.codex`.**
   `setAccount` already does this. The alternative is native resume only for sessions on
   Realm-managed account folders, with notes for everything else. Recommended: allow it. It's a
   transcript file, not config, and it's the only way `--resume` finds the conversation.
3. **Vouched pairing:** the source adds your phone to the target over the authenticated link, so the
   phone follows without a QR code. Recommended: yes, but only for a target saved with a token.
4. **The source tree after a move:** leave it untouched (recommended default), or offer the toggle
   that resets it after a checkpoint.
