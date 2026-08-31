# Realm Plan 8 — Skills, MCP connections, memory, and Realm settings

> Written against `docs/superpowers/specs/2026-08-29-agent-config-surfaces.md`, which proved its findings
> live against the installed CLIs rather than inferring them from docs.

**User direction:** build SkillSync; add `@`-mention in the prompter to call a skill; a skills library; MCP
connections; a memory manager; all configurable in Realm settings.

## What the research changed

The premise this plan was commissioned on — "skills are a Claude Code concept, so a library reaches one of
three agents" — is **false**. All three CLIs ship first-class `SKILL.md`. Two accept a skills root
**per-invocation with no writes to user-owned files**:

- **Claude Code**: `plugins: [{ type: "local", path, skipMcpDiscovery: true }]` with `settingSources: []`.
  Verified: a scratch skill surfaced as `realm:realm-injected` while the user's 29 installed skills were
  isolated out entirely.
- **Codex**: `skills/extraRoots/set`, an app-server JSON-RPC method (found by generating TS bindings from the
  0.146.0 binary). No config key or CLI flag exists — the protocol method is the only route.
- **Cursor**: **do not build a skills path at all.** Its discovery globs are marked `requiresThirdParty` and
  dropped unless a server-gated predicate returns true. Three probes returned 19 commands; a parallel probe
  returned 64, and the difference could not be reproduced under any condition — including with
  `CURSOR_CONFIG_DIR` redirected. Realm can neither read nor set the predicate, and it varied between runs of
  the same binary. Cursor's MCP support, by contrast, is genuine and verified: ACP `session/new` `mcpServers`
  was honored (a client-supplied server's marker file appeared).

**MCP is already per-session on all three**, and Realm's adapters already pass it correctly — including ACP's
stdio-`env`-as-array quirk. The only gap is upstream: `apps/server/src/sessions/service.ts:276` hardcodes
`mcpServers: []`.

## Two findings that constrain the design

**Never write user-owned config.** `~/.claude.json` is 113 KB of hot telemetry with real config interleaved,
and its mtime advanced repeatedly during the research session. Any read-modify-write is a lost-update race
against a live process.

**Realm is already polluting a user file today.** `~/.codex/config.toml` holds four dead
`[projects."/private/var/.../realm-work-XXXX"]` trust entries — Codex wrote them on Realm's behalf, pointing
at temp directories that no longer exist. Worth fixing, and a warning about the whole category.

**Delete the v1 spec §7 symlink strategy.** It buys nothing for Claude or Codex, and because Codex and Cursor
both scan `~/.agents/skills`, a symlink there leaks Realm's entire library into every terminal the user opens.

## Workstreams

### W1 — SkillSync (per-invocation, not sync-to-disk)

Realm owns `~/Realm/skills/<name>/SKILL.md`. Nothing is copied, symlinked, or written into `~/.claude`,
`~/.codex`, `~/.cursor`, or `~/.agents`. At session start the adapters are handed the root:

- Claude: the `plugins` + `settingSources: []` shape above.
- Codex: call `skills/extraRoots/set` after the thread exists; **feature-detect** — this machine runs a preview
  build ahead of public, so absence of the method must degrade, not throw.
- Cursor: unsupported. Say so in the UI; do not fake it.

Per-space enable/disable, since a Work space and a School space want different skills. The mac-cli skill
already written in `skills/mac/SKILL.md` is the first consumer and stops being latent.

### W1 carry-forwards (found while implementing, must not be dropped)

**`settingSources: []` is a bigger hammer than "skills isolation" implies.** It also drops the user's
`~/.claude/CLAUDE.md`, the repo's `.claude/` settings, and `.mcp.json`. So enabling one skill in a space
silently changes what that space's Claude sessions inherit. W1 contained it — the option is *absent*, not
empty, when a space has no enabled skills, so today's behaviour is exactly preserved for any space that
manages none. Two follow-ups are now required, not optional:

- **W3 must re-inject `~/.claude/CLAUDE.md`** through the `systemContext` seam it is already wiring.
- **W5 must say this out loud** beside the toggle: Realm's library replaces your installed skills for this space.

**Codex extra roots are per-connection, not per-thread.** `skills/extraRoots/set` takes no `threadId` and the
adapter shares one process, so two spaces with different skills enabled each see the other's. This is the
documented trade (the alternative loses the process refcount). W4 scopes it prompt-side; W5 should name it.

### W2 — MCP connections

Fill the `mcpServers: []` gap at `service.ts:276`. Servers configured in Realm, scoped per space, passed
per-session to all three adapters. `https://mcp.vercel.com` is one row, not an integration. This is what
"connect external gateways" actually meant, and it is also how the deferred simulator support arrives.

Also clean up the four stale Codex trust entries Realm caused, and stop creating new ones.

### W3 — Memory manager

`thread/start` returns `instructionSources` naming the exact `AGENTS.md` files Codex loaded — ground truth for
the pane rather than a guess. Claude has `CLAUDE.md` with an import hierarchy. **Cursor takes no durable-context
parameter at all** (ACP `session/new` is `{cwd, mcpServers}`), so it is a read-only row.

One opt-in `AGENTS.md` in Realm-**created** space folders only. Never in a directory the user made.

There is also an unwired seam worth using: `StartOptions.systemContext` is read **only** by the Claude adapter.
Codex accepts the same thing as `developerInstructions` on `thread/start`. Wiring that gives the memory manager
a real per-session channel on two agents instead of one.

### W4 — `@`-mention in the prompter

**`@` must never be sent literally.** It resolves before the message leaves Realm:

- Claude → `/realm:<name>` at position 0
- Codex → a native `{ type: "skill" }` input item
- Cursor → `/<name>` (unverified — treat as best-effort)

Autocomplete over enabled skills for the session's agent. A skill the current agent cannot run must not be
offered. This lands in `Composer.tsx` and must follow the attachments work, not race it.

### W5 — Realm settings

One home for skills, MCP and memory, per-space where the underlying capability is per-space. Follow
`docs/superpowers/specs/2026-08-27-design-language.md`; the existing space-settings sheet is the pattern.

Every surface states per-agent reality — the attachments work established this idiom and it applies directly:
a skills library that silently does nothing for Cursor is the failure mode to avoid.

## Explicitly not built

Symlinks into `~/.agents/skills`. Generated-block edits of `~/.claude.json` or `~/.codex/config.toml`.
`CODEX_HOME` / `CLAUDE_CONFIG_DIR` redirection — it takes auth and history with it.

## Execution notes

Sequential implementers. Gates: `SHELL=/bin/bash pnpm vitest run` (one pty test flakes under zsh),
`pnpm -r typecheck`, `pnpm -r build`. Mutation-grade. Commit before mutating — `git checkout --` restores from
HEAD. Never modify anything under `~/.claude`, `~/.codex`, `~/.cursor`. Feature-detect Codex methods.
