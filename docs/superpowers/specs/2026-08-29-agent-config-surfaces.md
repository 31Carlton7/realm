# Agent config surfaces — skills, MCP, memory across Claude Code / Codex / Cursor

**Date:** 2026-08-29 (research run 2026-08-31)
**Purpose:** Decide whether Realm can manage skills, MCP connections, and memory centrally,
and be honest per-agent about which features actually reach which CLI.
**Method:** Live probes against the binaries installed on this machine, their own generated
protocol schemas, and their shipped bundles — plus docs. Where docs and disk disagree,
**the disk wins** and this doc says so.

Versions probed:

| | Version | Driven by Realm via |
|---|---|---|
| Claude Code | `@anthropic-ai/claude-agent-sdk` **0.3.233** (in `packages/adapters/node_modules`) | Agent SDK `query()`, streaming input |
| Codex | `codex-cli` **0.146.0** | `codex app-server`, JSON-RPC/stdio |
| Cursor | `cursor-agent` **2026.07.25-e42b078** (bundles `@agentclientprotocol/sdk` 0.14.1) | `cursor-agent acp`, ACP/stdio |

---

## 0. The headline

The premise this research was commissioned to test — *"skills is largely a Claude Code
concept; a skills library would silently only work for one of three agents"* — **is wrong at
these versions.** All three CLIs ship a first-class Agent Skills implementation reading
`SKILL.md` with `name` + `description` frontmatter, all three expose skills over the
programmatic path Realm drives, and the ecosystem has already converged on a shared on-disk
convention (`~/.agents/skills`) that this machine is actively using.

Concretely, the following were **proven live**, not inferred:

1. **Claude Code** — `plugins: [{ type:'local', path, skipMcpDiscovery: true }]` with
   `settingSources: []` loaded a skill from a scratch directory and left the user's 29
   installed skills fully isolated out. Zero writes.
2. **Codex** — `skills/extraRoots/set`, an app-server JSON-RPC method, made a
   scratch-directory skill appear in `skills/list` at `scope=user`. Zero writes to `~/.codex`.
3. **Cursor** — ACP `session/new` `mcpServers` is genuinely honored: a client-supplied
   `{"command":"/bin/sh","args":["-c","touch <MARKER>; exec cat"]}` **created the marker file**.
   Not accept-and-discard.

So the "native-config escape hatch" from v1 spec §7 — symlinking skills into
`<cwd>/.claude/skills` and `.agents/skills` — is **not needed for Claude or Codex and should
be deleted from the spec.**

**The one real gap is Cursor.** It *reports* its skill catalog over ACP, so Realm can list and
invoke what Cursor already has — but there is no flag, no env var, and no ACP field that adds a
skills directory, and its filesystem discovery of other agents' skill dirs is gated by a
runtime predicate that was **off in every probe I ran on this machine** (§1.1.3). Treat Cursor
skills as read-only. The second gap is **memory**: Claude and Codex both take durable context
as a per-session protocol parameter; Cursor takes none.

---

## 1. Capability matrix

### 1.1 Skills

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| Concept exists | **Yes** | **Yes** (GA; the `[features] skills` flag is gone) | **Yes** |
| User-level dirs | `~/.claude/skills/` (29 installed here) | `~/.codex/skills/`, `~/.agents/skills/`, `~/.codex/skills/.system/` | `~/.cursor/skills/`, `~/.agents/skills/`, **plus `~/.claude/skills/` and `~/.codex/skills/`** |
| Project-level dirs | `<repo>/.claude/skills/` | `<repo>/.codex/skills/`, `<repo>/.agents/skills/` (cwd-chain to repo root) | `.cursor/skills/`, `.agents/skills/`, **plus `.claude/skills/`, `.codex/skills/`** |
| Reads other agents' dirs | **No** (verified: `.agents`, `.codex`, `.cursor`, bare `skills/` all ignored) | `~/.agents/skills` only | documented yes; **gated at runtime by `getThirdPartyExtensibilityEnabled()` and observed OFF here** (§1.1.3) |
| Frontmatter that matters | `name`, `description` | `name`, `description` (extra keys ignored) | `name`, `description` |
| Scope model | user / project / local | `SkillScope = user \| repo \| system \| admin` | `Builtin=0 < UserHome=1 < Workspace=2 < Plugin=3` |
| Invocation | auto-by-description; `/name` at **position 0** of the prompt | auto-by-description; **`$name`** in message text; `/skills` in TUI | auto-by-description; `/name` at position 0 |
| **Per-session injection, no write** | **Yes** — `plugins: [{type:'local', path}]` (proven) | **Yes** — `skills/extraRoots/set` (proven) | **No** |
| Realm can enumerate | `query.supportedCommands()` → 148 here | `skills/list {cwds?, forceReload?}` | `available_commands_update` notification |
| Realm can filter | `skills: string[] \| 'all'` (per-session) | `skills/config/write` (**writes user config**) | No |

#### 1.1.1 Claude Code — verified live

Frontmatter across the 29 installed skills: all 29 carry `name` + `description`; 3 `metadata`,
3 `origin`, 2 `disable-model-invocation`, 2 `allowed-tools`, 1 `user-invocable`, 1 `license`.
The SDK documents ~18 more (`when_to_use`, `argument-hint`, `arguments`, `disallowed-tools`,
`model`, `effort`, `context: fork`, `agent`, `background`, `hooks`, `paths`, `shell`,
`compatibility`). **Realm needs `name` and `description`. Do not build UI for the long tail.**

Probe A — discovery. `settingSources: ["user","project","local"]`, `skills: "all"`, cwd = a
probe repo containing one skill in each of five candidate directories:

```
TOTAL commands: 148
PROBES: probe-claude              ← only .claude/skills was read
USER SKILLS visible: caikins-swiftui, frontend-design, quiet-saas-ui
```

Probe B — the isolated-injection channel. `settingSources: []` plus
`plugins: [{ type:'local', path: '<scratch>/realm-plugin', skipMcpDiscovery: true }]`, where
the plugin is `.claude-plugin/plugin.json` + `skills/realm-injected/SKILL.md`:

```
TOTAL: 52
INJECTED: realm:realm-injected
USER SKILLS leaked (settingSources: []): (none — isolated)
```

Plugin skills are namespaced `plugin:skill`, so Realm's library surfaces as `realm:<name>`.
`skipMcpDiscovery: true` is documented as *"the SDK host owns this plugin's MCP connections"* —
exactly Realm's situation, since Realm runs its own gateway.

#### 1.1.2 Codex — verified live

`codex app-server generate-ts --out <dir>` against the installed 0.146.0 binary emits:

```
skills/list            { cwds?: string[], forceReload?: boolean }
                       → { data: [{ cwd, skills: SkillMetadata[], errors: SkillErrorInfo[] }] }
skills/extraRoots/set  { extraRoots: AbsolutePathBuf[] } → {}
skills/config/write    { path?, name?, enabled: boolean }   // persists to ~/.codex — avoid
skills/changed         (notification) — invalidation signal, re-run skills/list
```

```ts
type SkillMetadata = { name, description, shortDescription?, interface?, dependencies?,
                       path: AbsolutePathBuf, scope: SkillScope, enabled: boolean }
type SkillScope = "user" | "repo" | "system" | "admin"
```

`skills/extraRoots/set` result, followed by `skills/list`:

```
EXTRAROOTS: {}
  - realm-demo | scope=user | /private/tmp/.../scratchpad/fake-skill/realm-demo/SKILL.md
  - frontend-design | scope=user | /Users/carltonaikins/.agents/skills/frontend-design/SKILL.md
  - linear | scope=user | /Users/carltonaikins/.codex/skills/linear/SKILL.md
  - skill-creator | scope=system | /Users/carltonaikins/.codex/skills/.system/skill-creator/SKILL.md
```

Project-scope probe:

```
NONUSER: probe-agents  repo  <repo>/.agents/skills/probe-agents/SKILL.md
NONUSER: probe-codex   repo  <repo>/.codex/skills/probe-codex/SKILL.md
probes found: probe-agents(repo), probe-codex(repo)
```

Skills are injected into the model's first developer message as a **flat name + description +
absolute-path list** inside `<skills_instructions>` — progressive disclosure, the body stays on
disk. Budget is documented as ≤8,000 chars or 2% of the context window.

**Important negative:** there is **no config.toml key and no CLI flag** for extra skill roots.
`skills.extra_roots`, `skills_dir`, `skills.dirs`, `skills.roots`, `skills.additional_roots`,
`experimental_skills_dir` were all rejected as `unknown configuration field` under
`codex app-server --strict-config`. `skills/extraRoots/set` is the only programmatic route.
The config file offers enable/disable only, and `[[skills.config]] path` **must point at the
`SKILL.md` file** — a directory path silently no-ops.

Codex also has a plugin/marketplace layer (`plugin/list`, `marketplace/add`,
`plugin/skill/read`) shipping skills; 11 marketplace plugins are enabled in this user's
`config.toml`. Treat as read-only. Its `agents/openai.yaml` sidecar can declare
`dependencies.tools` with an MCP server, which the stable `skill_mcp_dependency_install`
feature will offer to install — the one place a *skill* can pull in an *MCP server*.

#### 1.1.3 Cursor — verified live, and it reads everything

`cursor-agent acp` → `initialize` → `session/new` pushes an `available_commands_update`
listing every command **and skill** it found. Cursor's docs say verbatim: *"For compatibility,
Cursor also loads skills from Claude and Codex directories: `.claude/skills/`,
`.codex/skills/`, `~/.claude/skills/`, and `~/.codex/skills/`."*

**Two probes disagreed, and the disagreement is the finding.**

| Probe | Conditions | Result |
|---|---|---|
| An independent probe run during this research | `CURSOR_CONFIG_DIR`/`CURSOR_DATA_DIR` redirected to scratch | **64 commands**, including `caikins-*`, `refactoring-ui`, `story` (only in `~/.claude/skills`) and `linear`, `monid`, `playwright`, `vercel-deploy` (only in `~/.codex/skills`) |
| **Three probes I ran myself** — 25s and 75s windows, two different cwds, and one with `CURSOR_CONFIG_DIR` redirected to scratch (session and model list still returned, so it was authenticated) | both real and scratch config | **19 commands every time** — 11 `(builtin skill)`, 6 `(global)`, 2 other. No cross-agent skills. No project-level probe skills. |

**I could not reproduce the 64-command result under any condition on this machine.** It is not
a timing artifact and it is not `CURSOR_CONFIG_DIR`. The mechanism is visible in Cursor's own
bundle: the skill/rule
discovery walker takes an injected predicate,

```js
class br { constructor(e,t,n,r){ …; this.getThirdPartyExtensibilityEnabled = r } }
// …
const i = this.getThirdPartyExtensibilityEnabled(), a = this.buildIncludeGlobs(i)
```

and the include-glob table marks the cross-agent patterns `requiresThirdParty` — the
`.claude/skills`, `.codex/skills`, `CLAUDE.md`, `CLAUDE.local.md`, `.claude/agents` entries are
**dropped from the glob set** when the predicate returns false. The constructor default is
`t ?? (()=>!0)`, but the ACP path injects a real resolver, and on this machine it evidently
resolves false. Likely a server-side gate (the 737KB `~/.cursor/statsig-cache.json`), possibly
interacting with the user's `privacyMode: 2` / `ghostMode: true` in `cli-config.json`. I could
not confirm which without mutating user state, and it is not worth mutating user state to find
out — because either way the conclusion is the same.

**Design consequence, and it is the important one for Realm:** *whether Cursor picks up a
skills directory is decided by a predicate Realm cannot read, cannot set, and which differs
between two runs of the same binary version.* Realm must not build a Cursor skills path that
depends on it. Anything built on `available_commands_update` must also treat it as a
replace-on-arrival stream whose size Realm cannot predict.

Two Cursor-specific traps:

- `~/.cursor/skills-cursor` is **server-managed** — `syncBuiltinSkills` does `mkdir -p` and
  overwrites it from Cursor's backend on a 24h interval. Never write there.
  `~/.cursor/skills` is the user-installable path.
- Cursor ships a hardcoded denylist suppressing specific *Codex* skill names:
  `imagegen`, `openai-docs`, `opneai-docs` (sic), `plugin-creator`, `skill-creator`,
  `skill-installer`.

**The gap:** `cursor-agent acp` accepts no flags of its own (`agent acp [options]` lists only
`-h`). There is no `CURSOR_SKILLS*` env var. ACP `session/new` is `{cwd, mcpServers}` and
nothing else. The only candidate injection point is the program-level **`--plugin-dir <path>`**
(repeatable) — plugins carry rules/skills/agents/hooks, and it parses before the subcommand
(`cursor-agent --plugin-dir X acp --help` works; `--bogus-flag-xyz acp --help` falls back to
program help). **Whether `--plugin-dir` contributes skills to an ACP session is unverified.
Test it before relying on it.**

### 1.2 MCP

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| User config | `~/.claude.json` `.mcpServers`; `~/.claude/mcp.json` | `~/.codex/config.toml` `[mcp_servers.NAME]` | `~/.cursor/mcp.json` `.mcpServers` |
| Project config | `<repo>/.mcp.json`; `~/.claude.json` `.projects["<path>"].mcpServers` | `<repo>/.codex/config.toml` — **trust-gated** | `<repo>/.cursor/mcp.json` |
| Transports | stdio, `sse`, `http`, in-process `sdk` | **stdio and streamable HTTP only — no SSE** | stdio, SSE, streamable HTTP (`mcpCapabilities:{http:true,sse:true}`) |
| **Per-session, no write** | **Yes** — `mcpServers` option | **Yes** — `thread/start` `config.mcp_servers`, *and* `-c 'mcp_servers.X={…}'` on spawn | **Yes** — `session/new` `mcpServers[]` |
| Suppress the user's servers | **Yes** — `strictMcpConfig: true` | No | No — session servers **merge over** `mcp.json`, last-wins by name |
| Subcommands that write | `claude mcp add` | `codex mcp add` | `cursor-agent mcp enable/disable` |

**Realm already does all three.** `packages/adapters/src/types.ts` carries
`mcpServers: McpStdioConfig[]` on `StartOptions`, and each adapter translates it:

- `claude-adapter.ts:84` — `Object.fromEntries(... [name, {type:'stdio', command, args, env}])`.
  The SDK type is `mcpServers?: Record<string, McpServerConfig>`, a **record keyed by name**,
  not an array. Some documentation shows an array; `sdk.d.ts:1734` and Realm's working code
  both say record. Disk wins.
- `codex-adapter.ts:57-61` + `:245` — `config: { mcp_servers: {...} }` on `thread/start`.
  `docs/dev/codex-app-server-protocol.md` §5 has the wire capture including the
  `mcpServer/startupStatus/updated` → `ready` handshake.
- `acp-adapter.ts:67-73` + `:352` — `session/new { cwd, mcpServers }`, with the ACP quirk that
  stdio `env` is an **array of `{name,value}` pairs, not a record** — and that quirk is
  enforced: Cursor validates with zod 0.14.1 before its own (more lenient) normalizer runs,
  so an `env` object map is rejected `invalid_union`, and `args`/`env` are both **required**.
  Realm's `acpMcpServers()` already emits the correct shape.

The missing piece is upstream: `apps/server/src/sessions/service.ts:276` hardcodes
`mcpServers: []`.

Two Codex traps worth recording:

- **`thread/start` `config` is not validated.** `{"bogus_key_xyz":1}` is silently accepted.
  Typos fail open. Validate keys during development with
  `codex app-server --strict-config -c 'key=value'`, which is a reliable key-existence oracle.
- `mcpServerStatus/list` returns only config-file servers, **not** thread-scoped ones. Use the
  `mcpServer/startupStatus/updated` notifications for readiness, which Realm's adapter
  already receives.

### 1.3 Memory

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| Durable file | `CLAUDE.md` | `AGENTS.md` | `.cursor/rules/*.mdc`, `.cursorrules`, `AGENTS.md`, `CLAUDE.md` |
| Hierarchy | managed policy → `~/.claude/CLAUDE.md` → repo root → ancestors → subdirs on demand → `CLAUDE.local.md`; additive | `~/.codex/AGENTS.md` → repo root → each ancestor down to cwd, concatenated with a `--- project-doc ---` separator into one **user**-role message | per ancestor dir, cwd upward: `.cursor/rules` → `CLAUDE.md`/`CLAUDE.local.md` → `AGENTS.md` |
| Reads other agents' files | no | only via `project_doc_fallback_filenames = ["CLAUDE.md"]` | **yes, natively** |
| Import syntax | `@path`, `@~/path`, max 4 hops, skipped in code fences | **none** — plain concatenation | none |
| Gated by | `settingSources` must include `'project'` | project trust (**config/hooks only — AGENTS.md still loads untrusted**) | — |
| **Per-session injection, no write** | **Yes** — `systemPrompt: {type:'preset', preset:'claude_code', append}` | **Yes** — `thread/start` `developerInstructions` / `baseInstructions`, or per-turn `additionalContext` | **No** |
| Which files were loaded | not reported | **`thread/start` → `instructionSources[]`** | not reported |
| Session memory | auto-memory at `~/.claude/projects/<proj>/memory/MEMORY.md`; `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | real feature (`memories_1.sqlite`, two-stage extract→consolidate pipeline, `MemoryCitation`, `thread/memoryMode/set`) but **`memories` is `stable false` on this machine** | none local — the IDE "Memories" is server-side, tied to Automations |

Live `instructionSources` probe, `thread/start` from `<repo>/sub` where `<repo>/AGENTS.md`,
`<repo>/sub/AGENTS.md`, and `<repo>/CLAUDE.md` all exist:

```
instructionSources: ["<repo>/AGENTS.md", "<repo>/sub/AGENTS.md"]
```

Root-first, leaf-last, `CLAUDE.md` ignored (unless `project_doc_fallback_filenames` says
otherwise). `instructionSources` is a gift for Realm's memory manager — ground truth about
what the agent actually read, rather than a guess.

Also note for anyone porting old config: **`experimental_instructions_file` has been removed**
from Codex and hard-fails under `--strict-config`. The replacement is `model_instructions_file`.

---

## 2. Per-session vs global-config verdict

| Feature | Claude Code | Codex | Cursor |
|---|---|---|---|
| Add an MCP server | **per-session** | **per-session** (two channels) | **per-session** |
| Hide the user's MCP servers | **per-session** (`strictMcpConfig`) | global only | not possible |
| Add a skills directory | **per-session** (`plugins`) | **per-connection** (`skills/extraRoots/set`) | **filesystem only** |
| Restrict visible skills | **per-session** (`skills: [...]`) | global only | not possible |
| Inject durable context | **per-session** (`systemPrompt.append`) | **per-session** (`developerInstructions`) | not possible |
| Isolate from user config | **per-session** (`settingSources: []`) | env only (`CODEX_HOME` — takes auth + sessions) | not possible |
| Enumerate what the agent has | `supportedCommands()` | `skills/list` | `available_commands_update` |
| Which memory files loaded | no | **yes** (`instructionSources`) | no |

Three asterisks:

**Codex `skills/extraRoots/set` is per-connection, not per-thread.** Its params are
`{ extraRoots }` with no `threadId`. `CodexAdapter` deliberately refcounts **one**
`codex app-server` process across every Realm session (`codex-adapter.ts:106-131`), so extra
roots set for one space apply to all Codex sessions. Realm has one choice: union every enabled
space's roots, or give Codex a process per space and lose the refcount. **Recommend the
union**, scoped by the prompt-side picker rather than at the root level.

**Claude's `settingSources: []` is all-or-nothing.** Turning it on for isolation also drops
the user's `~/.claude/CLAUDE.md` and their 29 skills. Realm sets `settingSources` nowhere
today, and under 0.3.233 the docstring reads *"When omitted, all sources are loaded (matches
CLI defaults)"* — so every Claude session Realm starts already inherits the full user
environment. That is probably right; it should be a documented choice, not an omission.

**Cursor's session MCP servers merge over `mcp.json`, last-wins by name.** Realm can *add* and
can *shadow a specific server by reusing its name*, but cannot *subtract*.

---

## 3. Writing to user-owned files

### 3.1 Why not to

`~/.claude.json` is **113,872 bytes** on this machine and is a live, hot state file. Its
top-level keys are overwhelmingly ephemeral: `numStartups`, `tipsHistory`,
`cachedStatsigGates`, `announcementImpressions`, `fullscreenUpsellSeenCount`,
`changelogLastFetched`, `skillUsage`, `toolUsage`, and a `projects` map of 43 entries each
carrying per-session telemetry (`lastCost`, `lastFpsAverage`, `lastTotalInputTokens`). Real
configuration — `mcpServers` (7 servers), per-project `mcpServers` (4 projects),
`allowedTools` — is **interleaved with all of it**.

Claude Code rewrites that file constantly during normal use. Measured directly: over the
course of this research session `~/.claude.json`'s mtime advanced repeatedly, while
`~/.codex/config.toml` (Aug 27) and every skills directory stayed untouched. A Realm
read-modify-write is therefore a **lost-update race**, not a theoretical one: Realm reads, the
CLI writes telemetry, Realm writes back, the CLI's write is gone. There is no lock and no
merge protocol.

### 3.2 It is already happening, and Realm caused it

`~/.codex/config.toml` currently contains four entries Realm is responsible for:

```toml
[projects."/private/var/folders/14/.../T/realm-work-fOtXFa"]
[projects."/private/var/folders/14/.../T/realm-work-K5gwMl"]
[projects."/private/var/folders/14/.../T/realm-work-VbarM7"]
[projects."/private/var/folders/14/.../T/realm-work-n87jwI"]
```

Realm did not write those — **Codex did, on Realm's behalf**, when Realm spawned it in
temporary directories. All four point at directories that no longer exist.

**Mechanism, isolated during Plan 8 W2 (codex-cli 0.146.0, scratch `CODEX_HOME`, six probe
configurations):** `thread/start` records its `cwd` as
`[projects."<canonicalized cwd>"] trust_level = "trusted"` whenever `$CODEX_HOME/config.toml`
has no entry for that path. Verified properties:

- It happens for **every** approval policy and sandbox mode, `untrusted`/`read-only` included —
  it is not a consequence of `bypassPermissions`, and the original guess that "the user then
  trusted" them is wrong; no user action is involved.
- `initialize` alone writes nothing. `ephemeral: true` does not suppress it. `ThreadStartParams`
  (fields recovered from the binary's TS bindings) has no opt-out.
- The write is **flushed asynchronously**: a client that kills the process ~800ms after
  `thread/start` never sees it, which is why a first probe found nothing.
- An existing entry for that path suppresses it, `trust_level = "untrusted"` included.

So Realm cannot prevent it, and should not want to for a real space folder or worktree — those
are stable directories under `~/Realm` that a user would expect to see trusted. What Realm
*could* prevent is pointing Codex at a directory that then stops existing. The four entries came
from `apps/server/scripts/live-agent-check.ts` calling `mkdtempSync(tmpdir(), "realm-work-")`,
once per run. Fixed in W2: the live checks share one fixed path
(`$TMPDIR/realm-live-workspace`, see `apps/server/scripts/live-workspace.ts`) and leave it on
disk, so at most one entry exists and it always points somewhere real.
That is the failure mode in miniature: an agent CLI treats its config as a mutable state store,
and a host app driving it accumulates garbage in the user's file. Small and harmless today; the
same mechanism becomes a data-loss vector once the writes get larger.

The trust gate itself is observable. `thread/start` in an untrusted directory logs
`Project-local config, hooks, and exec policies are disabled in the following folders until the
project is trusted` while still loading `AGENTS.md` and still loading repo-scope skills. **Realm
should surface that state rather than silently trusting on the user's behalf.**

### 3.3 The safe-write patterns, and what each costs

| Pattern | Cost / failure mode |
|---|---|
| **A. Per-invocation only (recommended where available)** — `plugins`, `skills/extraRoots/set`, `mcpServers`, `systemPrompt.append`, `developerInstructions` | Nothing to corrupt, clean up, or migrate. **Cost:** reaches Claude and Codex only. |
| **B. Realm-owned files in Realm's own tree** — library at `~/Realm/skills/`, handed to the agent by path | Realm owns every byte; the agent only reads. **Cost:** none for Claude/Codex. Does not reach Cursor. |
| **C. Project-scoped files inside a Realm-created space folder** — `<space>/.agents/skills/`, `<space>/AGENTS.md` | **The only route to Cursor.** Valid only when Realm created the folder — never a user's existing repo. **Cost:** invisible until `ls -a`; pollutes `git status` if the folder is a repo (needs `.gitignore`); Codex gates project *config* on trust (skills are exempt); one more thing to keep in sync. |
| **D. Symlinks into `~/.claude/skills` / `~/.agents/skills`** (v1 spec §7) | **Cost:** broken symlinks after Realm moves or deletes a skill, surfacing as `skills/list` `errors[]` in the user's *own* CLI outside Realm; no marker distinguishing Realm's links from the user's dirs; and since Cursor and Codex both scan `~/.agents/skills`, Realm's whole library silently appears in every terminal session the user opens. Reversible but loud. |
| **E. Generated-block markers in a user file** (`# BEGIN REALM` … `# END REALM`) | Least-bad **if** a write is ever unavoidable. **Cost:** needs atomic write (temp + `rename`) plus a backup, still races a CLI that rewrites the whole file, and TOML/JSON round-trips destroy comments and key ordering. `~/.codex/config.toml` is hand-edited and comment-bearing here — a bad trade. |
| **F. Redirecting the config dir** — `CLAUDE_CONFIG_DIR`, `CODEX_HOME` | Clean isolation, verified working (a scratch `CODEX_HOME` gets its own `config.toml`, `sessions/`, `skills/.system/`, and its own `auth.json` — an unauthenticated scratch home returns `401`). **Cost:** relocates auth and session history too. The user re-logs-in inside Realm and loses CLI history. Breaks the "uses your existing login" promise. |

**Recommendation: A for Claude and Codex, B for storage, C only for Cursor and only in
Realm-created space folders. Never D, never E, never F.**

### 3.4 Is there a per-invocation channel that avoids the problem entirely?

- **Claude Code — yes, completely.** Skills, MCP, and durable context all per-session, zero
  writes, both proven live.
- **Codex — yes, completely.** Same three, via `skills/extraRoots/set`, `thread/start.config`
  (or `-c` on the spawn), and `developerInstructions`.
- **Cursor — MCP yes; skills and memory no.** ACP `session/new` is `{cwd, mcpServers}` and
  nothing else. No instructions field, no skills field. This is a limitation of ACP 0.14.1 as
  Cursor implements it, not of Realm's adapter. (Current ACP has `additionalDirectories` on
  `NewSessionRequest`, but this cursor-agent build predates it and zod strips it.)

---

## 4. Recommended architecture

### 4.1 Skills library

**Storage:** `~/Realm/skills/<name>/SKILL.md`, Realm-owned, in the standard Agent Skills
layout. Import from `~/.claude/skills` / `~/.agents/skills` is always a **copy**, never a
symlink, and never writes back.

**Delivery, per agent — and the UI must say which is which:**

| Agent | Mechanism | Writes anything? |
|---|---|---|
| **Claude** | generate a local plugin at `~/Realm/generated/claude-plugin/` (`.claude-plugin/plugin.json` + `skills/<name>/`), pass `plugins: [{type:'local', path, skipMcpDiscovery:true}]`; scope with `skills: ['realm:a', …]`; leave `settingSources` at default so the user's own skills coexist | no — the generated dir is under `~/Realm` (pattern B) |
| **Codex** | `skills/extraRoots/set { extraRoots: ['~/Realm/skills'] }` once per `CodexConnection` after `initialize`; refresh on `skills/changed` | no |
| **Cursor** | **not supported — do not build it.** `.agents/skills` is not `requiresThirdParty`-gated, so `<space>/.agents/skills/` is the least-bad candidate if this is ever revisited, but three probes on this machine surfaced no project-level skills at all. | — |

Two leads worth one experiment each before any Cursor skills work is scheduled, and **neither
should be designed around until verified**: the program-level `--plugin-dir <path>` flag
(repeatable, parses before the `acp` subcommand, and plugins carry skills), and whether
`<space>/.agents/skills/` is picked up in a *trusted* workspace. If both fail, Cursor skills
are closed.

**Enumeration for the picker:** merge `supportedCommands()` (Claude), `skills/list` (Codex),
and `available_commands_update` (Cursor) into one
`{ agentKind, name, description, source: 'realm' | 'agent' }` list per session. Treat Cursor's
notification as a **replace-on-arrival stream** — the first one is incomplete.

### 4.2 MCP connections

The adapters are done; the source is missing. Replace the hardcoded `mcpServers: []` at
`apps/server/src/sessions/service.ts:276` with the space's enabled server set, resolved against
Keychain per v1 spec §7.

Two extensions worth considering, neither urgent:

- Realm's `McpStdioConfig` is **stdio-only**. All three support HTTP; Claude and Cursor also
  support SSE; **Codex supports no SSE at all**. If the v1 gateway proxies everything as one
  stdio server, none of this matters — keep it stdio-only until that design changes.
- `strictMcpConfig: true` as a **per-space Claude-only opt-in** ("only Realm's servers"). No
  equivalent exists for Codex or Cursor, so it must be labelled Claude-only in the UI. For
  Cursor there is a partial trick: session servers shadow `mcp.json` entries **by name**, so
  Realm can override a specific server but not hide the rest.

### 4.3 Memory manager

Three tiers, honest about reach:

1. **Realm profile context — Claude and Codex, no files.** The context-pool profile card from
   v1 spec §6 goes to Claude via `systemPrompt.append` (already wired,
   `claude-adapter.ts:83`) and to Codex via `thread/start` `developerInstructions`.
   **That second path is not wired** — `StartOptions.systemContext` is currently read only by
   the Claude adapter (`grep systemContext` finds exactly two hits: the type and
   `claude-adapter.ts:83`). Wiring it is a small, high-value change.

   **Cursor cannot receive it over ACP.** The only honest fallback is prepending it to the
   first user message of the session, where it is visible in the transcript. Do that, and say
   so in the UI, rather than pretending it is a system prompt.

2. **Read-only inspection — Codex today.** `thread/start` returns `instructionSources`: the
   exact `AGENTS.md` files loaded. Surface it in a Memory pane so the user sees ground truth.
   Claude has no equivalent response field (`getContextUsage()` gives a memory-files token
   bucket, not paths); Cursor reports nothing.

3. **Space-folder `AGENTS.md` — opt-in, Realm-created folders only.** For a space whose folder
   Realm created, one `AGENTS.md` at its root is the write worth allowing: a single file, at a
   visible path, in a format **both Codex and Cursor read**, inside the user's project folder
   rather than their home config. Gate it behind an explicit toggle. Do **not** also write
   `CLAUDE.md` — Claude gets the same content through `systemPrompt.append` with no file.

### 4.4 `@`-mention in the prompter

`Composer.tsx:136` is `onSend(draft.trim())` — a plain textarea sending plain text, with no
`@` handling anywhere in the codebase. So `@` is a **Realm-side affordance that must resolve
before send.** What it resolves *to* differs per agent:

| Agent | What Realm should send | Confidence |
|---|---|---|
| **Claude** | rewrite `@name` → `/realm:name` **at position 0** of the message | High — slash commands dispatch through the SDK as in the TUI, but **only at position 0**; a `/cmd` mid-sentence is literal text |
| **Codex** | send a `{ type:"skill", name, path }` input item alongside the `{type:"text"}` block | High — `UserInput` in the generated bindings is a union including `skill` and `mention` variants. The text form is `$name`, but the input item is native and needs no munging |
| **Cursor** | rewrite `@name` → `/name` at position 0 | Medium — Cursor's `handleSlashCommand` matches `/^\/(\S+)(?:\s+(.*))?$/` against the prompt text, so this should work; ACP `prompt` is `ContentBlock[]` with no command variant, so text is the only route |

Two things `@` must **not** be:

- **`@` must not be sent literally.** In none of the three does a raw `@name` in a
  programmatic message do anything defined. In Claude Code's TUI `@` is a *file*-reference
  autocomplete, and even there the SDK does not expand `@path` — it is literal text the model
  sees. Sending `@caikins-writing` is a coin flip, not a feature. (Note: `@skill-name` **is**
  the documented explicit-invocation syntax in the ChatGPT app for Codex skills — but the CLI
  form is `$skill-name`, and over app-server the input item is better than either.)
- **`@` must not imply the same guarantee on all three.** Build the menu from each agent's own
  enumeration call, so a skill that cannot be invoked never appears in it. Show the source
  (`realm` / `claude` / `codex` / `cursor`) next to each entry.

Realm's existing convention — adapters diverging openly, UI naming what each agent will do —
is exactly right here.

---

## 5. What should NOT be built

1. **The v1 spec §7 symlink strategy.** Superseded for Claude and Codex, which take a
   directory per-invocation. And because Cursor and Codex both scan `~/.agents/skills`, a
   symlink there leaks Realm's entire library into every terminal session the user opens.
   Delete it from the spec.

2. **Any writer for `~/.claude.json`.** 113KB of hot telemetry with config interleaved, no
   lock, rewritten constantly. Every per-session need it could serve is already served by
   `query()` options.

3. **A generated-block editor for `~/.codex/config.toml`.** Hand-edited and comment-bearing
   here; a TOML round-trip destroys comments and ordering; `thread/start.config` and
   `-c key=value` make it unnecessary.

4. **A skills library that claims to cover all three equally.** Claude and Codex get a clean
   per-session channel. Cursor has no reliable channel at all — its cross-agent discovery is
   gated by a predicate Realm cannot read or set, and was off in every probe here. Ship the
   library labelled "Claude Code and Codex", with Cursor's own skills listed read-only.

5. **A cross-agent memory manager built on writing memory files everywhere.** Three
   conventions with three hierarchies and three gating rules. Build the per-session injection
   path (Claude + Codex), the one opt-in `AGENTS.md` (Codex + Cursor), and accept that Cursor
   gets a visible first-message prepend for profile context.

6. **A per-space MCP allowlist promising isolation on all three.** `strictMcpConfig` is
   Claude-only. Codex and Cursor will still load the user's own servers alongside Realm's.
   Realm can *add* everywhere and *shadow-by-name* on Cursor; it cannot *subtract* on two of
   three.

7. **`CLAUDE_CONFIG_DIR` / `CODEX_HOME` redirection for isolation.** Takes auth and session
   history with it.

8. **Per-space Codex skill roots.** `skills/extraRoots/set` has no `threadId` and the adapter
   shares one process by design. Union the roots; scope with the picker.

9. **Anything depending on Codex `memories`.** The subsystem is real
   (`codex-rs/memories`, `memories_1.sqlite`, two-stage pipeline) but ships
   `stable / false` and is off on this machine. Do not surface it in Realm's memory manager.

---

## 6. Where documentation and disk disagree

| Claim | Disk says |
|---|---|
| Docs show the SDK `mcpServers` option as an array | `sdk.d.ts:1734` — `Record<string, McpServerConfig>`, keyed by name. Realm's working adapter agrees. |
| Older SDK guidance: `settingSources` defaults to none, so CLAUDE.md is not loaded | `sdk.d.ts` — *"When omitted, all sources are loaded (matches CLI defaults)… Must include `'project'` to load CLAUDE.md."* Behavior changed; 0.3.233 loads everything by default. |
| "Skills are a Claude Code concept" | All three ship `SKILL.md` implementations. `~/.agents/skills` is a shared cross-vendor root read by Codex and Cursor; Cursor additionally reads Claude's and Codex's own directories. |
| Codex's GitHub `docs/skills.md`, `docs/config.md`, `docs/agents_md.md` | One-line stubs redirecting to `learn.chatgpt.com`. The last real content in `docs/skills.md` is 2025-12-14 and describes a feature flag that no longer exists. Treat the in-repo docs as historical. |
| Codex docs list `.agents/skills` as the skills path | `$CODEX_HOME/skills` and `<repo>/.codex/skills` also load and are omitted from the docs table. Verified in 0.146.0. |
| Blog posts recommend `experimental_instructions_file` | **Removed.** Hard-fails under `--strict-config`. Use `model_instructions_file`. |
| Cursor docs describe `.cursor/skills` project scope | Real, but a short-window ACP probe misses it — the first `available_commands_update` carries builtins only. Poll or listen for later ones. |
| ACP `NewSessionRequest` has `additionalDirectories` | True in current ACP; **not honored** by this cursor-agent build (bundles SDK 0.14.1, zod strips it). Use `--add-dir` on the process. |

**One more caveat that colors everything above:** this machine's Codex install is a preview
build far ahead of the public repo — `codex features list` shows `goals`, `computer_use`,
`browser_use`, `image_generation`, `personality`, `multi_agent`, `code_mode_host` all
stable/true, and there are undocumented directories (`pets/`, `ambient-suggestions/`,
`visualizations/`). Do not assume a stock Codex install exposes the same surface. Realm should
feature-detect — `skills/list` and `experimentalFeature/list` both exist for exactly this.

---

## 7. Evidence log

All probes were read-only against user config; probe skills and repos live only in the session
scratchpad.

- `codex app-server generate-ts --out <scratch>` — full protocol bindings from `codex-cli 0.146.0`.
- `codex app-server --strict-config -c 'key=value'` — config-key existence oracle.
- `codex app-server` + `skills/extraRoots/set` → `skills/list` — extra-root injection.
- `codex app-server` + `skills/list {cwds:[<probe repo>]}` — project-scope root discovery.
- `codex app-server` + `thread/start` — `instructionSources`, trust-gate stderr, `config.mcp_servers` reaching `status:"ready"`.
- `codex debug prompt-input` — the exact `<skills_instructions>` and `<INSTRUCTIONS>` blocks the model sees.
- `@anthropic-ai/claude-agent-sdk` `query().supportedCommands()` across `settingSources` variants — Claude discovery and the isolated `plugins` channel.
- `cursor-agent acp` + `initialize` + `session/new` — capabilities, modes, models, `available_commands_update` (19 at 25s, 64 at full scan); MCP honored, proven by a marker-file side effect; zod shape enforcement (4 payload variants).
- `cursor-agent`'s bundled `index.js` — skill search-path functions, precedence enum, builtin-sync routine, Codex denylist, rules loader order, discovery glob set.
- `--help` for `codex`, `codex mcp`, `codex app-server`, `cursor-agent`, `cursor-agent mcp`, `cursor-agent plugin`, `cursor-agent acp`.
- Read-only: `~/.claude/skills` (29), `~/.claude.json`, `~/.claude/settings.json`,
  `~/.claude/mcp.json`, `~/.codex/config.toml`, `~/.codex/skills`, `~/.codex/rules/default.rules`,
  `~/.codex/memories_1.sqlite` (schema only), `~/.agents/skills` + `.skill-lock.json`,
  `~/.cursor/mcp.json`, `~/.cursor/skills`, `~/.cursor/skills-cursor`.
- Realm source: `packages/adapters/src/{types,claude/claude-adapter,codex/codex-adapter,acp/acp-adapter}.ts`,
  `apps/server/src/sessions/service.ts`, `apps/desktop/src/renderer/src/panes/session/Composer.tsx`,
  `docs/dev/{codex-app-server-protocol,acp-protocol}.md`,
  `docs/superpowers/specs/2026-08-17-realm-v1-design.md` §7.

No file under `~/.claude`, `~/.codex`, or `~/.cursor` was modified. Spawning `cursor-agent`
does cause Cursor to touch its own `~/.cursor/skills-cursor/.sync-manifest.json` — its
behavior, not a Realm write.
