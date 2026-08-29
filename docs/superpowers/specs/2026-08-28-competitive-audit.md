# Realm — Competitive Feature Audit

**Date:** 2026-08-28
**Status:** Research
**Scope:** T3 Code, Synara, Universe, Ara (primary); Conductor, Cursor, Zed, Claude Code desktop, Warp, Amp, OpenCode (category context)

## 0. Confidence key

Every claim below is tagged:

- **[D]** Documented — stated in official docs, README, changelog, or release notes.
- **[C]** Code — read directly from the product's open source.
- **[M]** Marketing — a claim on a landing/pricing page, not corroborated by docs.
- **[I]** Inferred — deduced from PR titles, screenshots, or secondary coverage.

Where a product's public surface is thin, this document says so instead of guessing.

---

## 1. Per-product summaries

### 1.1 T3 Code (`pingdotgg/t3code`)

The most directly comparable product, and the one with the most legible internals: it is open source, so most of what follows is **[C]** or **[D]** rather than inference.

Self-description: *"an 'agent harness control surface'"* — explicitly a UI layer over agent CLIs, not an agent. **[D]** ([README](https://github.com/pingdotgg/t3code/blob/main/README.md))

**Core object.** `Project` → `Thread` → `Turn`, plus `Activity` (approvals, tool calls, failures). A project has a `workspaceRoot` and a title, and **does not contain threads** — projects and threads are separate arrays on the read model, so a project can have zero threads. **[C]** ([glossary](https://github.com/pingdotgg/t3code/blob/main/docs/internals/glossary.md))

**Architecture worth noting.** The server is the execution boundary: *"every provider process, terminal, git operation, and filesystem read happens there, never in the client."* Clients (web, desktop Electron, Expo mobile) talk over **one authenticated Effect RPC WebSocket**. Orchestration is **event-sourced**: clients dispatch typed commands, a single worker fiber serializes them, a pure `decider` produces events, and event-append + projection share one SQL transaction so *"the read model cannot durably disagree with the event log."* **[C]** ([overview](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md))

**Git.**
- Worktree per thread. A thread with a `worktreePath` runs there instead of the main working tree; git sits behind a `VcsDriver` contract. **[C]**
- *"pick worktree or current checkout per project"*, worktrees bootstrapped from `origin main` by default, submodule checkout in new worktrees, worktree recreated before a turn if missing, branch-drift following *"so PRs link to their thread"*. **[I]** (merged PR titles)
- Commit / push / PR from the toolbar, with T3 Code suggesting titles and bodies from commits. **[D]** ([source-control](https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md))
- **Four forges**: GitHub, GitLab (MRs), Bitbucket (API token), Azure DevOps. Clone from a forge or any git URL via ⌘K → Add Project; **Publish Repository** creates a remote for a local-only repo and wires origin in one flow. **[D]**
- PR *review inside the app*: open several PRs as tabs in the right panel, edit PR title/body in Markdown with preview, edit your own comments, check out a teammate's branch. **[D]**
- Sidebar thread rows carry PR state; **auto-settle merged threads** moves a thread to Settled when its PR merges. **[D]** ([thread-sidebar](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md))

**Checkpointing — the genuinely novel bit.** *"Each turn is bracketed by workspace checkpoints so diffs and reverts are exact."* Checkpoints are **hidden Git refs** written through `VcsCheckpointOps`; `CheckpointDiffQuery` answers per-turn and full-thread diff requests; `CheckpointReactor` reverts **both the workspace and the provider conversation** (`thread.checkpoint.revert` is a client-dispatchable command). **[C]** This is a per-turn undo that works across every provider, built without provider cooperation.

**Multi-agent / parallelism.** `mod+enter` from a new thread starts it **in the background** and immediately opens another new thread with the same workspace mode and base branch; with **New worktree** selected, *"each background thread creates its own worktree."* **[D]** ([composer](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md)) There is also a `t3-code` MCP server exposed *to* agents with **worktree handoff and status tools** **[I]**, and Codex sub-agent models are surfaced **[I]**. No documented planner→worker orchestration primitive.

**Model / provider UX.** Five built-in drivers — `codex`, `claudeAgent`, `cursor`, `grok`, `opencode` — registered in `builtInDrivers.ts`; *"Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No orchestration, contract, or client change is required."* **[C]** ([providers](https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md))
- A **model manifest** (`model-manifest.json`) classifies current vs legacy model slugs per driver and is *refreshed at runtime from `main` via raw.githubusercontent.com*, so **"moving a model in or out of the legacy section is a commit, not a release."** **[C]** That is the mechanism behind the "provider updates" the user noticed.
- Fallback order: remote fetch → on-disk copy of last successful fetch → bundled copy. TTL-gated, respects an `enableProviderUpdateChecks` setting, never fails a provider check. **[C]**
- Per-project default models; OpenCode models show their upstream provider (Anthropic, GitHub Copilot, OpenCode Zen) beneath the name and are searchable by it. **[D]/[I]**
- Multiple accounts per provider (Codex, Claude) are documented separately. **[D]**

**Permissions.** Four runtime modes — `approval-required` (Supervised), `auto-accept-edits`, `auto`, `full-access` — set **per thread** from the composer, inherited by threads created from inside a thread, otherwise defaulting to **Full access**. Plus an orthogonal `interaction mode` of `default` | `plan`. **[C]/[D]** ([permission-modes](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md)) Each provider maps the mode onto its own sandbox: Codex translates it into approval policy + sandbox level; Grok's Supervised starts in ask mode *even if the user's Grok CLI config says always-approve*; OpenCode has no equivalent and falls back to asking.

**Keyboard.** Fully user-rebindable via `~/.t3/userdata/keybindings.json`, a JSON array of `{key, command, when}` rules with VS Code-style `when` expressions over context keys (`terminalFocus`, `terminalOpen`, `previewFocus`, `previewOpen`, `modelPickerOpen`) and `!`/`&&`/`||`/parens. Last matching rule wins, **across commands**. Defaults are written into the file on first run and new defaults added on later startups unless a user rule already claims the command or the key. **[D]** ([keybindings](https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md))
- Project scripts are addressable as commands: **`script.{id}.run`**, e.g. `script.test.run`. This is the "Add action" the user saw — a project-defined shell command that becomes a bindable command, and per Better Stack coverage can **auto-run on worktree creation**. **[D]/[I]** ([Better Stack](https://betterstack.com/community/guides/ai/t3-code/))
- Named commands: `filePicker.toggle` (`mod+p`), `projectSearch.toggle` (`mod+shift+f`), `terminal.toggle`, `commandPalette.toggle`, `preview.refresh`, `chat.new`, `thread.settle` (`mod+shift+s`), `thread.pin` (`mod+shift+p`), `rightPanel.toggleMaximized`, `themeEditor.toggle` (`mod+alt+shift+t`). **[D]**
- The command palette searches *thread titles, projects, branches, user messages, and final agent responses* across connected environments, with labeled excerpts. **[D]**

**Browser / preview pane.** Exists, and agents can drive it: merged PRs include *"allow preview automation in agent-created threads"*, *"return valid preview action results"*, *"only show browser-ready local servers"*, *"oauth popups open from the browser preview"*, floating/PiP preview, throttling of hidden previews. **[I]** — the feature is real but its tool surface is not documented publicly.

**Remote / mobile — the biggest structural differentiator.** Because the server owns everything, the same backend serves an Electron desktop, a hosted web app (`app.t3.codes`), and native iOS/Android apps. **[D]**
- `npx t3 pair` mints a pairing token and prints a QR code; `npx t3 pair --tailscale` publishes over Tailscale Serve HTTPS. **[D]** ([remote-access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md))
- Desktop can also launch and supervise environments **over SSH** (`packages/ssh`), and there is a hosted **T3 Connect** relay for discovery and mobile notifications that is *"not in the hot path"* — after connect, traffic goes directly to the environment. **[C]**
- Pinned-thread ordering syncs across devices via the server. **[D]**

**Other.** Themes with a live theme editor including an **Inspect** mode that picks an element and reveals its color token **[D]**; attachments up to 50 MB including PDF/ZIP **[I]**; per-provider native attachment handling documented adapter-by-adapter **[C]**; Linux background service; winget/Homebrew/AUR packaging. **[D]**

**Velocity note.** Nightly releases ship several times per day with a large outside contributor base (merged PR numbers in the 8000s as of 2026-08-29). **[I]** ([releases](https://github.com/pingdotgg/t3code/releases)) A solo developer cannot win on breadth here.

---

### 1.2 Synara (`trysynara.com`, `Emanuele-web04/synara`)

**The closest competitor to Realm's actual spec** — same positioning almost word for word (*"a free, open-source, local-first workspace and control plane for coding agents"*), and it has already shipped most of what Realm's v1 spec left unbuilt.

**Core object.** `Workspace` → `Space` → `Project` → `Task` → `Turn`, with `Environment` (a local checkout **or** an isolated worktree) and `Provider Session` as attributes of the task, and an optional persistent `Goal`. A project is *"a local folder, preferably a Git repository"*; a task is *"one durable unit of work inside a project"* owning its conversation, provider session, environment, and git changes. Handoffs move the provider while preserving task context and environment. **[D]** ([core concepts](https://www.trysynara.com/docs/getting-started/core-concepts), [landing](https://www.trysynara.com/))

This is worth staring at next to Realm's model: Synara separates **task** (the unit of work) from **environment** (where it runs) from **provider session** (who does it), so any one can change without the others. Realm's `Session` conflates all three — `sessions.create` fixes agent, project, and cwd at once, which is exactly why `sessions.setAgent` has to refuse after the first event.

Note: **Synara ships "Spaces" too** — *"Organize projects into Spaces… Create named, icon-based Spaces"*, shipped in 0.6.0 (Jul 24), with the default space renameable from "Void". **[D]** ([changelog](https://www.trysynara.com/changelog)) Realm's sidebar concept is not unique.

**Providers.** Nine: Claude Code, Codex, OpenCode, Cursor, Antigravity, Grok Build, Kilo Code, Pi, Factory Droid — each keeping *"its own authentication, models, tools, and permissions."* **[D]** ACP-backed sessions are called out separately, so the adapter strategy mirrors Realm's.

**Git.**
- Managed worktrees per task, with an explicit base-ref choice (current HEAD, a local branch/commit, or **a pull-request ref**). Worktree setup progress is visible and cancellable before dispatch. **[D]** ([worktrees](https://www.trysynara.com/docs/workflows/worktrees))
- Task metadata *"follows branch, worktree, push, and pull-request changes as they happen."* **[D]** (0.7.1)
- The PR dialog *"can commit the intended changes, push the branch, and open the pull request as one guided action."* **[D]** (0.7.1)
- Full PR review in-app: browse, search, filter, **comment, merge, close, reopen, pin**. **[D]** (0.5.4)
- **PR stacks**: stack badges show where each PR sits, with an ordered navigator in the detail view. **[D]** (0.7.2)
- Diff panel with a review file tree (0.3.2); *"Pull before risky actions"* surfaced when a branch is behind upstream (0.6.4). **[D]**
- Clone a project straight from a GitHub URL or `owner/repo` (0.6.7). **[D]**

**Multi-agent / parallelism — the strongest in this set.** Four tiers, documented: provider-native subagents; separate top-level tasks; worktree-backed concurrent tasks; and **Agent Gateway orchestration where one task coordinates up to 20 child tasks**. **[D]** ([parallel-agents](https://www.trysynara.com/docs/workflows/parallel-agents))
- The **Synara Agent Gateway** is *"an internal, thread-scoped MCP control surface injected into supported provider sessions."* Tools: `synara_context`, `synara_capabilities`, `synara_list_projects`, `synara_list_threads`, `synara_read_thread`, `synara_wait_for_threads` (read); `synara_create_thread`, `synara_create_threads`, `synara_send_message`, `synara_interrupt_thread`, `synara_set_thread_title`, `synara_set_thread_archived` (write). **[D]** ([agent-gateway](https://www.trysynara.com/docs/workflows/agent-gateway))
- `synara_wait_for_threads` waits for child tasks to reach *"terminal or actionable states"* **without polling** — that is the primitive that makes planner→workers actually work.
- Claude's **native subagents** are surfaced as real Synara work (0.6.0). **[D]**
- **Thread forks** at message level, using native provider forks where available (0.7.2). **[D]**
- **Provider handoffs** mid-conversation, and `/side` side-chats that can *"target a different installed provider without moving the main conversation"* (0.7.3). **[D]**
- **Automations**: scheduled and heartbeat agent runs. Schedules are written in natural language in the composer (*"Every weekday at 9:00, inspect open pull requests in this project"*) and parsed into a scheduled draft. **Heartbeat** automations repeat until an AI-evaluated stop clause is satisfied, and the docs insist the clause be measurable — *"A test passes a defined number of consecutive runs"*, *"A pull request reaches a specific state"* — explicitly warning against *"stop when the feature is good."* Failure tolerance is configurable (1 / 3 default / 5 / never auto-disable), and a successful run resets the count. Runs carry a transcript label identifying automation-triggered turns, plus run history with scheduled vs actual time, status, output, and changes. **[D]** ([automations](https://www.trysynara.com/docs/workflows/automations), 0.3.0, 0.6.0, 0.7.2)

**Model / provider UX.** Live model switching without restarting a session; `alt+]` / `alt+[` cycles the active provider's models; `mod+shift+m` toggles the model picker; `mod+shift+e` toggles the reasoning/effort picker; `mod+shift+u` opens usage settings. Per-provider **usage meters** across Antigravity, Cursor, Grok, OpenCode and locally authenticated providers; Claude context-window tracking per thread. **[D]** ([shortcuts](https://www.trysynara.com/docs/reference/keyboard-shortcuts), changelog)

**Permissions.** Approval required / Auto / Full access, *"when the selected provider and model support it"*, plus **live turn steering** — sending guidance into a running Codex or Claude turn (0.6.4). **[D]**

**Panes and integrations.**
- **Browser**, floating over the chat or docked right, a task-scoped Chromium session sharing tabs/cookies/navigation with the agent. Agent tools: `browser_snapshot` (accessibility semantics + actionable refs + a `snapshotId`), `browser_screenshot`, `browser_logs` (console, exceptions, network metadata), `browser_evaluate`. Element actions are **snapshot-bound** — refs are paired with a snapshot id so a stale selector cannot silently hit a different element. Plus a user-facing annotation tool that sends compact, redacted element annotations to the agent. **[D]** ([browser-verification](https://www.trysynara.com/docs/workflows/browser-verification), 0.6.4/0.6.6)
- **iOS Simulator pane** (macOS): boot/attach, stream display, install and launch apps, tap/swipe/type/hardware buttons, Home (`Cmd+Shift+H`), rotate, save screenshot, record video. Agent tools cover listing/booting, install/launch, `openUrl` (approval-gated), tap/swipe/type/press, screenshots, **reading the accessibility tree**, and **scrolling to named interface elements**. **[D]** ([ios-simulator](https://www.trysynara.com/docs/features/ios-simulator), 0.7.2)
- **External MCP** (restricted) alongside the internal gateway; and Synara itself is exposable *as* an MCP server to Codex, Claude Code, or Claude Desktop (0.6.0). **[D]**
- **Claude plugin skills discovery** (0.6.6). **[D]**
- **Studio** — a focused space for long-running, agent-led work, with generated files/images surfaced in the Environment panel (0.4.1). **[D]**
- Terminals with directional splits, tabs, and a full-width terminal workspace; long-running process attachment (dev servers, test watchers, log tails). **[D]**
- **Headless server** with a versioned tarball and `synara server status` (0.7.3), plus a web client — so remote use is arriving. **[D]**
- **Debug mode**: guides the agent through observe → reproduce → investigate → fix → verify (0.7.2). **[D]**
- `/goal` sets a persistent objective carried through provider turns (0.7.2). **[D]**
- File undo: undoing an agent turn rolls back its files **without deleting the conversation**, with a rescue snapshot taken first (0.5.2, 0.6.3). **[D]**
- `/export` a thread to a portable archive (0.3.9); voice mic mode (0.6.6); AppSnap — press both Option keys to capture the window you are using (0.5.3). **[D]**
- **Activity inbox**: sidebar mode showing running work, input requests, and failures (0.6.5). **[D]**

**Keyboard.** Extensive and close to Realm's choices: `mod+k` search, `mod+b` sidebar, `mod+1…9` jump to Nth thread, `mod+shift+]`/`[` next/prev chat, `ctrl+tab` cycle, `mod+p` file search, `mod+shift+f` content search, `mod+n` new task, `mod+alt+c`/`x`/`r` new Claude/Codex/Cursor thread, `mod+\` split, `cmd+l` focus composer, `mod+j` terminal drawer, `mod+shift+j` full-width terminal, `mod+d` diff panel, `mod+shift+b` browser preview. **[D]**

**Privacy / business model.** Free, open source, no account required, no proxying of provider traffic; remote analytics removed entirely in 0.7.0 and any anonymous analytics opt-in and off by default. Windows x64, macOS Intel + Apple Silicon, Linux x64. 14,026+ downloads claimed. **[D]/[M]**

---

### 1.3 Universe (`universe.works`)

**Not a coding workstation.** Universe is a general knowledge-work agent app for Mac. It is a useful reference for *shape* (local-first, BYO-subscription, files land on disk) but it is not competing for the same daily driver.

- **Core object:** a session you hand work to, which comes back *"finished"*, producing spreadsheets, reports, decks, and working apps *"each one a file on your machine."* **[M]**
- **Local execution:** *"Everything happens on the computer in front of you. Link a spare laptop, or the machine under the desk, and the agents keep working after you close the lid."* Reads and writes **one folder you pick**. **[M]**
- **Multi-agent:** ad-hoc **crews** spawned per job — the landing page's example spawns six named roles (Chief of Staff, Market Scout, Copy Desk, Deck Builder, Inbox Triage, Repo Archaeologist) that *"finish and they are gone."* Skills propagate: *"Teach one once. All six have it, and so does the seventh you add."* **[M]**
- **Models:** BYO Claude (Pro/Max), ChatGPT (Plus/Pro/Business), Gemini, Grok (xAI key), or free local open models. *"That bill stays yours."* **[M]**
- **Integrations:** deliberately **no APIs** — *"It uses the sites and apps you already use, the way you use them — signed in as you, in a real browser"* (the user's own Chrome profile). **[M]**
- **Git / PRs / worktrees:** nothing documented. Treat as absent for coding work.
- **Pricing:** Free ($0, whole app, browser + schedules + cross-Mac, **three concurrent sessions**, one shared room up to five people); Pro $29/mo (unlimited sessions and crews); Team $49/member/mo min 4 (shared agent and skill library, one shared Gmail, role-based access); Enterprise custom (SSO, directory sync, custom model account boundaries). **[D]** ([pricing](https://universe.works/pricing))
- **Platform:** macOS only, Apple Silicon, macOS 13+. Version 0.4.5 observed. **[M]**

**Honest gap:** beyond the landing and pricing pages there is very little public technical documentation. Everything above is marketing copy; do not build a comparison table row on Universe's mechanics.

---

### 1.4 Ara (`ara.so`)

Ara's public material carries **two different positionings**, and it is worth naming that rather than smoothing it over:

1. *"The Multiplayer Coding Agent"* / *"The IDE for token-maxxers"* — a browser-based IDE with *"full visibility across chats, files, browsers, terminals, and review panes"*, self-improving memory, and reusable skills. **[M]**
2. *"The cloud coding agent — an autonomous software engineer for software teams"* — connect a GitHub repo, assign issues, get evidence-backed PRs. **[M]**

The **API is the most concrete artifact** and points firmly at (2). **[D]** ([llms.txt](https://ara.so/llms.txt))

- **Core object:** `session`. `POST /v3/organizations/:orgId/sessions` with a prompt, an optional repository, and an idempotency key; `GET .../sessions/:id`; `POST .../sessions/:id/messages` for follow-ups. Sessions report `running`, `exit`, `error`, `suspended`. Bearer-token auth, keys minted in Settings → Developers. Sessions can run **without** a repository, for scratch work.
- **Where it runs:** cloud. *"Ara reads the issue, reproduces it in an isolated workspace, writes the fix, and verifies it before asking for review."* Enterprise gets on-prem (*"in your cloud, under your controls"*) and a *"signed record on every run."* **[M]**
- **Git:** issue → isolated workspace → PR. Output is *"evidence-backed pull requests with screen recordings, logs, and review-ready diffs."* **[M]** No documented worktree model, branch-per-thread UX, or in-app diff review — the diff is the PR.
- **Multi-agent:** *"background agents"* and *"agentic research passes with citation tracking"* are claimed but not documented. **[M]** No composition primitive is described.
- **Models:** Ara **sells inference**, which is the sharpest contrast with everything else here. Free ($0, one-time $10 hosted-model balance); Individual $20/mo ($20 frontier + $60 Ara models); Pro+ $60/mo ($60 + $180, full catalog, priority execution); Ultra $200/mo ($200 + $600). BYO subscriptions (ChatGPT Codex, Claude, Grok, Kimi) and API keys supported on Pro+ and above. Teams of 10–20 stay on the $20 plan — *"capacity upgrades, not per-seat tax."* **[D]** ([pricing](https://ara.so/pricing))
- **Integrations:** GitHub and GitLab, remote MCP services, custom MCP servers, web browsing, file creation and code execution with change review. Clients: web, Mac, terminal, mobile. **[D]/[M]**
- **Company:** YC Spring 2026, 2 founders (Adi Singh, Sven Myhre), San Francisco. **[D]** ([YC](https://www.ycombinator.com/companies/ara))

**Honest gap:** feature-level docs are thin. The API reference is real; the IDE surface (browsers, terminals, review panes, memory, skills) is asserted on the landing page and not documented anywhere public that I could find.

---

### 1.5 The category around them (secondary set)

These were researched for context, not as head-to-head competitors — but two of them change the strategic picture more than the named four do.

**Conductor** (conductor.build, Melty Labs) — the most complete *git* story in the category. Core object is the **workspace**: *"a separate, git-backed copy of a project for one stream of work"* — one branch, one file tree, one terminal, one diff. Auto-creates a worktree and branch, then has the agent **rename its own branch** during the first chat. `⌘⇧N` new workspace (from a branch, an issue, **or a PR**) → `⌘⇧D` diff → `⌘⇧P` open PR → merge → archive, with a History pane that restores archived workspaces with chat intact. Two things stand out: **Checks**, a merge-readiness object aggregating git status + PR metadata + CI + deployments + GitHub comments + todos that will actively **block or discourage merge**; and **`CONDUCTOR_PORT`, a 10-port block injected per workspace** (`CONDUCTOR_PORT`…`+9`), which is the unglamorous fix for five parallel agents all wanting `:3000`. Config is TOML with a documented precedence ladder and `setup` / `run` / `archive` script hooks. **Conductor MCP** (0.82.0) inverts the control plane — the agent can drive Conductor: review its own workspace diff, leave inline comments, inspect a failed dev server, spawn extra workspaces to investigate. There is also a public REST API including **`POST /sql` for read-only SQL over your org's agent transcripts**. Cloud workspaces are Vercel sandboxes (8 vCPU / 16 GB). **[D]** ([docs](https://www.conductor.build/docs), [checks](https://www.conductor.build/docs/reference/checks), [scripts](https://www.conductor.build/docs/reference/scripts), [MCP changelog](https://www.conductor.build/changelog/0.82.0-conductor-mcp), [API](https://www.conductor.build/docs/api))

**Claude Code desktop** — **this is the one that should worry Realm most**, because it is Realm's v1 spec, shipped, by the vendor of Realm's primary agent. Sessions each get **their own worktree automatically**, at `<root>/.claude/worktrees/` with a configurable branch prefix and a `.worktreeinclude` that copies gitignored files like `.env` into each new worktree; **auto-archive after PR merge or close**. Diff view with per-line comments batch-submitted at `⌘↩`, a **"Review code"** button whose scope is explicitly narrow (compile errors, definite logic errors, security, obvious bugs — *"not style, formatting, pre-existing issues, or anything a linter would catch"*), and CI monitoring with **auto-fix** and **auto-merge** toggles. Panes: chat, diff, **browser**, terminal, file, plan, tasks, subagent, **iOS Simulator** — draggable and resizable, `⌘\` closes the focused one. `⌘⇧M` mode, `⌘⇧I` model, **`⌘⇧E` effort**, then `1`–`9` to pick within any open menu. `Ctrl+O` cycles transcript verbosity, with a **Summary mode** explicitly for *"when you're running multiple sessions and want to scan results quickly."* Environment picker is Local / Cloud / SSH / WSL. Cross-session orchestration in natural language (*"tell the payments session the schema changed"*) with real guardrails. `⌘;` side chat that reads the whole thread and writes nothing back. **[D]** ([desktop](https://code.claude.com/docs/en/desktop), [worktrees](https://code.claude.com/docs/en/worktrees))

**Cursor 3.x** — the deepest parallelism. An **Agents Window** separate from the IDE; four environments (local, worktree, cloud, remote SSH); worktrees configured by `.cursor/worktrees.json` with `setup-worktree` hooks and **`cursor.worktreeMaxCount`** (default 25) plus a cleanup interval. Three slash commands worth noting: **`/worktree`**, **`/apply-worktree`** (fold a worktree back into the main checkout), and **`/best-of-n`** — run the same task across multiple models in separate worktrees and compare. `/multitask` converts an existing message *queue* into parallel async subagents. Subagents can spawn subagents, and as of Aug 2026 get **isolated VM environments** with fresh project copies. `/goal` holds a standing objective; **event subscriptions** wake agents on PRs, Slack threads, or schedules; **non-interruptive steering** makes a follow-up wait for the next tool call instead of cutting the agent off. Sandboxing is the most rigorous documented model in the set (`sandbox.json` merged from home + repo, three network levels, SSRF blocks, un-weakenable enterprise layer). **[D]** ([3.0](https://cursor.com/changelog/3-0), [worktrees](https://cursor.com/docs/configuration/worktrees), [08-19-26](https://cursor.com/changelog/08-19-26), [sandbox](https://cursor.com/docs/reference/sandbox))

**Zed** — the best *model-selection ergonomics* anywhere in this research, and worth copying wholesale. Model selector at `Ctrl+Alt+/`; **mark models as favorites and cycle them with `Alt+Tab`**. Settings are per *function*, not per session: `agent.default_model`, `inline_assistant_model`, `commit_message_model`, `thread_summary_model`, `compaction_model`, `subagent_model`. A **worktree picker sits in the title bar** next to the project name, and threads running in linked worktrees nest under their parent project in the sidebar. **Terminal Threads** make any agent CLI a managed thread row with no integration work. Zed authored **ACP**, and its docs state the hosting boundary explicitly: for external agents, *"its own runtime, auth, model selection, tools, and native configuration"* are the agent's, not Zed's — a doc pattern Realm should copy given it hosts ACP agents too. Git is deliberately light: accept/reject per hunk in a multibuffer, then *"merge changes through your normal Git workflow."* No PR creation. **[D]** ([agent-panel](https://zed.dev/docs/ai/agent-panel), [agent-settings](https://zed.dev/docs/ai/agent-settings), [external-agents](https://zed.dev/docs/ai/external-agents))

**Warp** — core object is the **conversation**, bound to a tab/pane/cwd, not a worktree. Git handling is the weakest here: the docs tell you to type `git worktree add` yourself. But **Interactive Code Review** is excellent and strategically interesting — agent edits compile into a diff panel, you leave inline comments anchored to file+line, **batch them**, and send the whole batch in one pass — *and it works for third-party CLI agents* (Claude Code, Codex, OpenCode, Cursor CLI, Gemini CLI). Warp is positioning as the review surface for whatever agent you already use. Also: an **Agent Management Panel** across tabs with running/needs-input/done states, vertical tabs carrying agent + branch + dir + status, `/orchestrate` and `/plan` for parent→child fan-out, custom model **routers** that dispatch by task complexity, and automatic **local→cloud handoff when the machine sleeps**. **[D]** ([interactive code review](https://docs.warp.dev/agents/local-agents/interactive-code-review/), [agents](https://docs.warp.dev/agents/))

**Amp** (Sourcegraph) — the most opinionated model UX in the category, and a direct challenge to Realm's chip row. **The Dial** replaces named modes with **low / medium / high / ultra**: *"The dial asks one question: how hard is this task?"* Undershoot and you pay three times over in churn; overshoot and *"you're using Fable to fix a typo."* Amp deliberately de-emphasizes the model name. Also worth stealing: an **`Amp-Thread-ID` git trailer on commits**, so *"git log leads from a change back to the conversation that produced it"*; **Orbs** (ephemeral remote machines, one per thread, that **pause after five minutes of inactivity and cost nothing paused**); **Portals** (auto HTTPS URL for anything listening on a port inside an orb); and a generated `~/.config/amp/AGENTS.md` describing the *environment itself*, read alongside the repo's own. One thread URL opens identically in web, CLI, iOS, macOS, and Slack. **[D]** ([The Dial](https://ampcode.com/news/the-dial), [orbs](https://ampcode.com/docs/orbs), [threads](https://ampcode.com/docs/threads))

**OpenCode** — architecturally the cleanest answer to "where does my agent live": a **persistent background server plus a TUI client**, so sessions survive terminal disconnects, SSH drops, and machine sleep, with `opencode web` attachable to the *same live session* simultaneously. Two primary agents (Build / Plan, `Tab` to toggle) and three named subagents whose names carry the permission model: **general** (full access), **explore** (read-only codebase navigation), **scout** (read-only external docs research), invocable by `@mention`. Per-agent config includes a **`steps`** cap (max agentic iterations before forcing a text response) and **glob-scoped bash permissions** (`"git *": "ask"`). Keybinds merge with defaults — you declare only overrides. `/undo` and `/redo` revert *file changes* via git. No worktrees, no PR flow. `opencode acp` makes it embeddable in Zed and JetBrains — distribution as a strategy. **[D]** ([docs](https://opencode.ai/docs/), [agents](https://opencode.ai/docs/agents/))

#### What the category has converged on

As of August 2026 these are **table stakes**, not differentiators: worktree-per-unit-of-work; a sidebar of concurrent threads with status; inline line-level comments on a diff that feed back to the agent; a plan-vs-build toggle; MCP; cloud/remote execution as an environment picker; and hosting *other vendors'* agents.

Realm has one of those seven.

Where the design space is genuinely still open:

| Axis | The poles |
|---|---|
| Core object | workspace/worktree-first (Conductor) · thread-first (Amp, Zed, Claude Code) · conversation-in-a-tab (Warp) |
| Model choice | rich picker + favorites + per-function models (Zed) · collapse to one effort dial (Amp) |
| Isolation | worktree on your Mac (Conductor, Zed, Claude local) · microVM per thread (Amp orbs, Cursor cloud, Conductor Cloud) |
| Git depth | full loop to merge (Conductor, Claude Code) · review the diff then go use git (Zed, Warp, OpenCode) |
| Composition | explicit trees of async subagents (Cursor, Amp, OpenCode) · flat parallel threads a human orchestrates (Zed, Conductor, Warp) |

---

## 2. Capability matrix

Legend: ● shipped · ◐ partial · ○ absent · ? not publicly documented

| Capability | T3 Code | Synara | Universe | Ara | **Realm** |
|---|:--:|:--:|:--:|:--:|:--:|
| **Core object** | Project → Thread → Turn | Space → Project → Task | Session / crew | Session | Profile → Space → Item → Session |
| Open source | ● | ● | ○ | ○ | (private) |
| Local-first execution | ● | ● | ● | ○ (cloud) | ● |
| **Git** |
| Worktree per session | ● | ● | ○ | ? | ○ |
| Branch per thread | ● | ● | ○ | ◐ | ○ |
| Base-ref choice on create | ● | ● | ○ | ? | ○ |
| In-app diff viewer | ● | ● | ○ | ○ | ○ (chips only) |
| Commit from UI | ● | ● | ○ | ○ | ○ |
| Push from UI | ● | ● | ○ | ○ | ○ |
| PR creation from UI | ● | ● | ○ | ● | ○ |
| PR review in-app (comment/merge) | ● | ● | ○ | ○ | ○ |
| PR stacks | ○ | ● | ○ | ○ | ○ |
| Non-GitHub forges | ● (GitLab, Bitbucket, ADO) | ◐ | ○ | ◐ (GitLab) | ○ |
| Per-turn checkpoint + revert | ● | ● | ○ | ? | ○ |
| **Parallelism** |
| Many sessions at once | ● | ● | ● | ● | ● |
| Background/queued submit | ● (`mod+enter`) | ● | ● | ● | ○ |
| Agent-spawns-agent (planner→workers) | ◐ | ● (≤20 children) | ● (crews) | ? | ○ |
| Wait-for-children primitive | ○ | ● | ? | ? | ○ |
| Scheduled / recurring runs | ○ | ● | ● | ? | ○ |
| Thread fork at a message | ○ | ● | ○ | ? | ○ |
| Provider handoff mid-thread | ○ | ● | n/a | n/a | ◐ (pre-first-event only) |
| **Model / provider UX** |
| Providers supported | 5 | 9 | 5 model vendors | own + BYO | 3 kinds / 4 agents |
| Model picker w/ keyboard cycle | ◐ | ● (`alt+]`/`[`) | ? | ? | ◐ (chips) |
| Effort / reasoning control | ● | ● (`mod+shift+e`) | ? | ? | ● |
| Plan vs build mode | ● (`interaction mode`) | ● (+ debug mode) | ? | ? | ○ |
| Per-project default model | ● | ● | ? | ? | ○ |
| Usage / context meters | ● | ● | ? | ? | ○ |
| Out-of-band model catalog updates | ● (manifest on `main`) | ◐ | ? | n/a | ○ |
| **Permissions / sandboxing** |
| Per-session permission modes | ● (4) | ● (3) | ? | ? | ● |
| Maps modes onto provider sandbox | ● | ● | ? | n/a | ◐ |
| Steer a running turn | ○ | ● | ? | ? | ○ |
| Container / VM isolation | ○ | ○ | ○ | ● | ○ |
| **Panes / integrations** |
| Terminal pane | ● | ● | ○ | ● | ● |
| Split panes | ● | ● | ○ | ? | ● |
| Browser pane | ● | ● | ● (real Chrome) | ● | ○ |
| Agent drives the browser | ◐ | ● (`browser_*`) | ● | ● | ○ |
| iOS simulator pane | ○ | ● | ○ | ○ | ○ |
| Artifact / preview pane | ◐ | ● (Studio) | ● | ? | ○ |
| File search / content search | ● | ● | ? | ? | ○ |
| MCP server management | ◐ | ● | ? | ● | ○ |
| Exposes itself as MCP to agents | ● (`t3-code`) | ● (Agent Gateway) | ? | ? | ○ |
| Skills library | ● (`$` in composer) | ● (Claude plugin skills) | ● | ● | ○ |
| Context pool / personal grounding | ○ | ◐ (goals, memory) | ◐ | ◐ | ○ |
| **Reach** |
| Mobile client | ● (iOS + Android) | ○ | ○ | ● | ○ |
| Web client | ● | ● | ○ | ● | ○ |
| Remote / headless server | ● (pair, Tailscale, SSH) | ● (headless tarball) | ◐ (link a Mac) | n/a | ○ |
| Windows / Linux | ● | ● | ○ | n/a | ○ |
| **Craft** |
| Rebindable keymap w/ `when` | ● | ◐ | ? | ? | ○ |
| Command palette over messages | ● | ◐ | ? | ? | ◐ (items only) |
| Live theme editor | ● | ● | ? | ? | ○ |
| Arc-style spaces w/ tint + swipe | ○ | ◐ (spaces, no swipe) | ○ | ○ | ● |

### 2.1 Addendum — the seven table-stakes capabilities across the whole field

The four named competitors are not the field. This is the same question asked of all eleven products, restricted to what §1.5 identified as converged behaviour.

| | T3 Code | Synara | Conductor | Cursor | Zed | Claude Code | Warp | Amp | OpenCode | **Realm** |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Worktree per unit of work | ● | ● | ● | ● | ● | ● | ○ | ○ (orbs) | ○ | **○** |
| Concurrent thread list w/ status | ● | ● | ● | ● | ● | ● | ● | ● | ● | **●** |
| Inline diff comments → agent | ○ | ◐ | ● | ● | ◐ (hunks) | ● | ● | ? | ○ | **○** |
| Plan vs build mode | ● | ● | ● | ● | ● | ● | ● | ● (dial) | ● | **○** |
| MCP | ● | ● | ● | ● | ● | ● | ● | ● | ● | **○** |
| Cloud / remote environment | ● | ● | ● | ● | ◐ (SSH) | ● | ● | ● | ● | **○** |
| Hosts other vendors' agents | ● | ● | ● | ○ | ● | ○ | ● | ○ | ○ | **●** |

Realm scores 2 of 7. Both of the two are things it shares with nearly everyone — a thread list and multi-vendor hosting. It has none of the five that separate products from each other.

---

## 3. Where Realm is genuinely ahead

Short list, honestly. Realm is a v1 against products with 6–12 months of shipping behind them — and the secondary research sharpened that, because **Claude Code's own desktop app has now shipped most of Realm's v1 spec**: automatic worktree per session, browser pane, iOS Simulator pane, split/draggable panes, MCP via Connectors, plan mode, an effort menu, cross-session orchestration. Anthropic built the thing Realm's spec describes, for Realm's primary agent, and gave it away with the subscription. Any part of Realm's positioning that rests on "browser + simulator + artifacts as agent abilities" is now a parity argument, not a wedge.

1. **The spatial model.** Arc-style spaces as the swipe unit, per-space color tint driving both palettes, profile-as-an-attribute-of-a-space, pinned items as tiles, projects pushed out of the sidebar into the New Session sheet. Synara has Spaces (icon + name, 0.6.0) but not the tint, the swipe, or the profile scoping. Nobody else has anything like it. This is the one thing in Realm that is a *product idea*, not a feature.

2. **Profiles as a credential/identity boundary.** Per-profile browser session partitions, per-profile env (`GH_TOKEN` from the space's GitHub account), profile-scoped context. Universe gestures at "one shared Gmail account" per team; nobody in the eleven products researched scopes *identity* per workspace. Genuinely differentiated — but note it is currently a *design*, since the browser panes that would exercise it do not exist. This is the one spec idea that survives Claude Code desktop shipping the panes: Anthropic built the panes, not the identity boundary around them.

3. **Adapter cleanliness.** Three adapter kinds (native Claude, Codex app-server, ACP) covering four agents, with normalized `SessionEvent`s and a zod contract validated at the WebSocket boundary. T3 Code's Effect-based version is more sophisticated; Realm's is more legible and easier for one person to hold in their head. That is a real asset for a solo maintainer, even though users never see it.

4. **Session-scoped terminal drawer.** `sessions.openTerminal` is idempotent and lazily spawns the pty on first call — *"a session whose panel is never opened never has one."* Synara has terminal drawers; the per-session, lazily-created, cwd-inherited framing is cleaner.

5. **`sessions.setAgent` guardrail.** Re-pointing an untouched session at another agent, server-rejected once any event exists, with `model` cleared because a model id from the old kind means nothing to the new one. Correct instinct. Synara's mid-conversation handoff is strictly more capable, but Realm's is more honest about what a transcript belongs to.

Everything else on Realm's list — split panes, command palette, permission prompts, resume, instant session creation, a keyboard layer, git chips — is **table stakes that all three serious competitors already have**, usually in a more complete form.

One footnote on how much of the spec is actually load-bearing: `ItemKindSchema` already enumerates `browser`, `simulator`, `artifact`, and `context`. The contract anticipates all four panes; none of them exist. The design work is done and the surface area is reserved — which makes the abilities cheaper to add later than the roadmap's ordering implies, and makes their absence more conspicuous now.

---

## 4. Where Realm is behind

Ordered by how much it costs a single developer per day.

### Table stakes Realm lacks

1. **Worktrees.** There is no `worktree` anywhere in the codebase. T3 Code and Synara both make worktree-per-thread the default unit of isolation, and both let you choose the base ref. Without it, running two agents on the same repo means they fight over the working tree — which is the entire premise of a multi-agent workstation. This is the single biggest hole.

2. **Any git write path.** `workspace.gitInfo` returns `{branch, additions, deletions, dirty, ahead, behind}` and nothing else. No diff, no stage, no commit, no push, no PR. Every competitor ships commit → push → PR as one flow. This is the loop that makes an agent's output *land*, and Realm currently ends at "here is a number of changed lines."

3. **A diff viewer.** The "diff chips" are counts. Reviewing what an agent did means leaving Realm. T3 Code has unified and split views with turn-by-turn scoping; Synara has a diff panel with a review file tree on `mod+d`.

4. **Background / queued submission.** T3 Code's `mod+enter` — start this thread in the background, open another, keep the workspace mode and base branch, give each background thread its own worktree — is a small feature with an outsized effect on how many agents you can actually have in flight. Realm has "instant session creation" but no background dispatch.

5. **File and content search.** `mod+p` and `mod+shift+f` in both T3 Code and Synara. Realm's command palette searches items only.

6. **Plan mode.** T3 Code has an `interaction mode` (`default` | `plan`) orthogonal to permissions; Synara adds a debug mode with an observe→reproduce→investigate→fix→verify script. Realm has permission modes but no mode switch.

7. **Per-turn undo.** Both T3 Code (hidden git refs, reverts workspace *and* provider conversation) and Synara (file undo preserving the conversation, with a rescue snapshot) can roll back a bad turn. Realm cannot.

8. **Usage and context meters.** Knowing you are about to hit a Claude limit mid-task, or that a thread is at 800k of 1M context, is load-bearing daily information. Both competitors show it.

### Differentiators Realm lacks

9. **An agent gateway.** Synara's `synara_*` MCP tools — especially `synara_create_threads` (batch, ≤20) and `synara_wait_for_threads` (blocks until children reach terminal or actionable state, no polling) — turn "multi-agent" from a marketing word into a primitive. Realm's spec has `realm-mcp` designed but unbuilt; the roadmap defers multi-agent workflows to seventh place.

10. **Agent-driven browser.** Synara's snapshot-bound refs (`ref` + `snapshotId`, so a stale selector fails loudly instead of clicking the wrong thing) is a better design than Realm's spec'd `@e1` refs, which have no staleness guard. Realm's spec anticipated this pane; it does not exist.

11. **iOS simulator pane.** Synara shipped it in 0.7.2 (Aug 15) with agent tools including accessibility-tree reading and scroll-to-named-element. This was a Realm v1 spec item and a plausible wedge for an app developer; it is now a shipped competitor feature.

12. **Automations.** Scheduled and heartbeat runs with persistent memory, cooldowns, max runs, and AI-evaluated stop clauses. No one else in this set has this; Synara has had it since 0.3.0.

13. **Remote / mobile.** T3 Code's whole architecture exists to make this possible, and the payoff — approve a permission prompt from your phone, watch a long run from another machine, `npx t3 pair --tailscale` — is the feature people rave about. Realm's WebSocket boundary was designed for it; nothing is built.

14. **Rebindable keymap.** T3 Code's `keybindings.json` with `when` clauses and `script.{id}.run` bindings for project commands is a serious power-user surface. Realm's hotkeys are hardcoded in `hotkeys.ts`.

15. **Non-GitHub forges.** GitLab, Bitbucket, and Azure DevOps in T3 Code. Probably irrelevant for a personal daily driver — listed for completeness, not as a recommendation.

---

## 5. The gaps that actually matter, ranked

Filter applied: *what does a single developer, using Realm as their daily driver, hit every day?* Ranked by (daily pain × build cost).

### Tier 1 — fix or the product is not usable as a daily driver

**1. Worktree-per-session, with base-ref choice.**
Without this, "run several agents at once" is a lie — the second agent corrupts the first's working tree. Everything else on this list is a nice-to-have until this exists. Both competitors treat it as the foundational unit, not a feature.

The prerequisite is a data-model change worth making deliberately. Synara separates **task** (the unit of work) from **environment** (checkout or worktree) from **provider session** (who does it), so any one can change without the others. Realm's `Session` record carries `projectId`, `agentKind`, `model`, `effort`, `permissionMode`, `cwd`, and `providerSessionId` all at once — it *is* all three at the same time. `cwd` is a bare string with no lifecycle behind it: nothing creates, tracks, or reclaims a directory. That conflation is precisely why `sessions.setAgent` must refuse once a transcript exists. Splitting `Environment` out of `Session` is the one change that unblocks worktrees, mid-thread provider handoff, and forks together.

Scope after that: `sessions.create` gains `{worktree: bool, baseRef}`; a `VcsDriver`-shaped module owns `worktree add/remove`, submodule checkout, and cleanup on session delete. Two failure modes both competitors hit and fixed, worth stealing pre-emptively: recreate a thread's worktree before starting a turn if the directory vanished, and skip the origin fetch in repos with no origin remote.

**2. Diff → commit → push → PR as one flow.**
The agent finishing is not the work landing. Right now Realm ends the loop at a line count. This is also where the "Commit & push" the user noticed in T3 Code lives. Scope: a `workspace.diff` RPC returning per-file patches, a diff pane, and a PR dialog that commits, pushes, and opens the PR in one guided action (Synara's 0.7.1 framing is the right one — one action, not three buttons). `gh` shells out; do not build a GitHub client.

**3. Background dispatch (`⌘↩`).**
Cheapest high-leverage feature on this list. Start the session, immediately open a fresh composer with the same project/agent/mode, give the started one its own worktree. Turns Realm from a one-agent-at-a-time app into a fan-out app, and it is maybe a day of work once worktrees exist.

**3b. A port block per worktree, and a setup hook.**
Ships with worktrees or the worktrees are useless on any web project: three agents in three worktrees all run `pnpm dev` and two of them fail on `:3000`. Conductor's answer is exact and worth copying literally — inject **`CONDUCTOR_PORT` plus a reserved 10-port block** (`CONDUCTOR_PORT`…`+9`) into every workspace's environment, alongside `CONDUCTOR_WORKSPACE_PATH` / `CONDUCTOR_ROOT_PATH` / `CONDUCTOR_WORKSPACE_NAME`. Pair it with a `setup` script that runs after checkout (`pnpm install`) and an `archive` script that cleans up. Cursor's `.cursor/worktrees.json` has `setup-worktree` hooks for the same reason. This is maybe fifty lines and it is the difference between worktrees working and worktrees being a demo.

### Tier 2 — daily friction, moderate cost

**4. Per-turn checkpoint and revert.**
T3 Code's approach (hidden git refs bracketing each turn, revert restores workspace *and* provider conversation) is provider-agnostic and clean. This is the feature that makes Full-access mode psychologically safe, which in turn is what makes agents fast. High value per unit of code.

**5. File search + content search (`⌘P` / `⌘⇧F`).**
Both competitors, both bound the same way. Realm already has a command palette to hang it off.

**6. Plan mode.**
An `interactionMode` on the session, orthogonal to `permissionMode`, mapped per adapter. Small; used constantly.

**7. Usage / context meters.**
Claude context per thread and provider rate-limit state. Needs adapter plumbing but no new UI concepts — it belongs in the composer chip row next to the git chips.

**7b. Model favorites with keyboard cycling.**
The user flagged T3 Code's model selector as something they noticed. The best answer in eleven products is Zed's: mark models as favorites, cycle them with a single chord, and — separately — set models **per function** (`commit_message_model`, `thread_summary_model`, `subagent_model`) rather than one global choice. Synara's `alt+]`/`alt+[` cycle is the cheap version. Realm already has model and effort chips; adding a favorites set and a cycle key is small and disproportionately pleasant.

Worth holding in tension with it: Amp deleted the picker entirely and replaced it with **The Dial** (low/medium/high/ultra), arguing the model name is the wrong question and effort is the right one. Realm already has both a model chip *and* an effort chip. If the effort chip is doing the real work in daily use, the model chip may deserve to shrink into a favorites list rather than grow into a browser.

### Tier 3 — differentiators worth building, in this order

**8. `realm-mcp` + an agent gateway.**
Realm's spec already designs `realm-mcp` as the delivery mechanism for every ability. Build the gateway *first*, before any pane: `realm_create_sessions` / `realm_wait_for_sessions` / `realm_read_session` on top of worktrees gives planner→workers immediately, and it is the substrate every later ability plugs into. Synara has proven the ≤20-children batch and the no-polling wait are the two calls that matter.

**9. Browser pane with agent control.**
The most-cited ability in the category — every competitor has one. Copy Synara's snapshot-binding: return `{snapshotId, refs}` and reject an action whose `snapshotId` is stale rather than clicking blind. Realm's spec's `TAB_GONE`-never-retarget rule is the same instinct; extend it to refs.

**10. Remote access (Tailscale pairing → mobile).**
The highest-ceiling item on Realm's roadmap and the one T3 Code users talk about most. But it is only worth it *after* the core loop is good, because it multiplies whatever the desktop app already does. Start with the headless/pair story (Synara's 0.7.3 headless tarball, T3 Code's `t3 pair --tailscale`), not with a native mobile app.

**11. iOS simulator pane.**
Genuinely valuable for an app developer, and Realm's spec already has the `simctl` design. But **Synara shipped it two weeks ago and Claude Code's desktop app ships one too** — it is no longer a wedge, it is catch-up on a niche. Build it when you personally need it for your own iOS work, not to compete. Same reasoning applies, more weakly, to the browser pane at #9: build it because the agent gateway needs an ability to prove itself on, not because it differentiates.

### Explicitly deprioritize

- **Context pool / `context.search`.** The most interesting idea in the spec and the least defensible use of a solo developer's next quarter. It solves "write my scholarship essay from real facts", which is not the daily-driver loop, and it is expensive (chunking, embeddings, ranking, extraction, an approval UI). **None of the eleven products researched has it**, which is worth noticing — but "nobody has it" and "nobody wants it enough to switch apps for it" are hard to tell apart from outside. Keep it as the long bet; do not let it precede worktrees.
- **Skills library sync.** Everyone gets skills approximately free by discovering what the provider already has (T3 Code's `$` composer menu reading System/Personal/Project/App sources; Synara discovering installed Claude plugin skills; Cursor and Amp treating them as plugin payloads). Reading `~/.claude/skills` and surfacing it is an afternoon. Building a synced library with per-space enablement and symlinking into four agent locations is a week. Do the afternoon version.
- **Non-GitHub forges, Windows/Linux, plugin marketplace, artifact sharing.** Zero daily value for one developer on a Mac using GitHub.

---

## 6. Opinion on the roadmap ordering

Realm's §12 roadmap, as written:

> mobile companion → live connectors → Realm CLI → native-config escape hatch → Cursor/Grok/OpenCode polish → session forks + cross-space tags + global search → multi-agent workflows → computer use → voice → better extraction → artifact sharing + marketplace → Windows/Linux

**This ordering is wrong, and the reason is structural: it is a roadmap of things the v1 spec promised, ordered by enthusiasm, not a roadmap of the loop a user completes every day.** It also assumes v1 shipped the abilities (browser, simulator, artifacts, MCP, context) — and it did not. So the roadmap starts from a state that does not exist.

Worse, it puts **multi-agent workflows seventh** and **doesn't mention git at all**. Both competitors treat git-and-worktrees as the foundation and multi-agent as the near-term differentiator. Realm has the two inverted and the foundation missing.

### What I would do instead

**Phase 0 — close the loop (before anything on §12).**
Environment split out of `Session` → worktrees + per-worktree port block + setup hook → diff pane → commit/push/PR → `⌘↩` background dispatch → checkpoint/revert. Nothing else ships until an agent's work can land without leaving the app. **None of this appears anywhere on the current roadmap**, and it should be the whole of the next milestone.

**Phase 1 — the daily-friction batch.** `⌘P`/`⌘⇧F`, plan mode, usage and context meters, rebindable keymap. Individually small, collectively the difference between "a demo" and "the thing I open every morning."

**Phase 2 — `realm-mcp` gateway, then browser.** Promote **multi-agent workflows from #7 to here**, and build it as an agent-callable gateway rather than a UI feature. The gateway is the substrate; the browser pane is the first ability that plugs into it. This is where Realm stops being behind and starts being interesting.

**Phase 3 — remote/pairing, then mobile.** Keep mobile on the roadmap but move the *pairing and headless server* ahead of the native client. Tailscale pairing plus the existing web-capable renderer gets 80% of the value at 20% of the cost.

### Specific reorderings

| Item | §12 position | Recommended | Why |
|---|---|---|---|
| Git worktrees + port block + commit/push/PR | **absent** | **#1** | Table stakes in 6 of 9 competitors; blocks parallelism entirely |
| Checkpoint / per-turn revert | absent | #2 | Makes full-access mode safe; cheap given git already there |
| Background dispatch `⌘↩` | absent | #3 | Highest leverage per line of code |
| Multi-agent workflows | 7 | **#4** (as `realm-mcp` gateway) | The category's live differentiator; Synara has proven the primitives |
| Session forks + global search | 6 | #5 (split: search now, forks later) | Search is table stakes; forks are not |
| Mobile companion | 1 | **#6** (pairing first, native client later) | Multiplies the desktop app — so make the desktop app worth multiplying first |
| Better browser extraction | 10 | #7 (fold into building the browser pane) | Not a separate project |
| Cursor/Grok/OpenCode polish | 5 | #8 | Adapter breadth is not why anyone switches |
| Realm CLI | 3 | #9 | Solves a problem Realm doesn't have yet |
| Native-config escape hatch | 4 | #10 | Niche |
| Live connectors as context | 2 | **#11** | Depends on a context pool that isn't built; deep and speculative |
| Computer use | 8 | drop for now | Universe's territory, not a coding workstation's |
| Voice (Plynn) | 9 | keep late | Fun, personal, not competitive |
| Artifact sharing + marketplace | 11 | **drop** | Marketplace is a team/company feature; one developer sharing artifacts is a `gh gist` |
| Windows/Linux | 12 | **drop** | Both competitors ship it and it buys Realm nothing personally |

### The strategic point

Realm cannot out-feature T3 Code — it ships nightlies multiple times a day with dozens of outside contributors, and it is MIT licensed. It cannot out-scope Synara either, which has shipped nine providers, an agent gateway, a browser, a simulator, automations, and PR stacks in about ten weeks. And it cannot win the abilities argument at all now that **Claude Code's desktop app ships worktrees, a browser pane, a simulator pane, split panes, plan mode, and an effort menu**, free with the subscription, from the vendor of Realm's primary agent.

That last one is the finding that should actually change behaviour. Realm's v1 spec framed browser / simulator / artifacts as the differentiating abilities. As of August 2026 they are table stakes in three separate products. Building them now is catch-up, not positioning.

What Realm has that none of the eleven has is **a point of view about workspace as place** — spaces you swipe between, tinted by color, scoped by profile, with credentials and identity following the space. T3 Code's UI is a thread list; Synara's is a task list with spaces bolted above it; Zed's and Claude Code's are sidebars; Warp's is tabs. Nobody is trying to make the workstation feel like somewhere you *are*, and nobody has made identity a property of the room rather than of the app.

So: **match on the loop (worktree, diff, land, parallel), differentiate on the place and the identity boundary around it.** Anything that is neither — connectors, marketplace, computer use, Windows, artifact sharing — should come off the roadmap rather than sit on it generating ambient guilt.

One honest caveat on the whole exercise. Realm is a personal product by one developer. The correct question is not "how do I beat Synara" — it is "what would make me stop using anything else." Those give different answers, and where they diverge, the second one wins. The one place they clearly agree is Phase 0: no version of this app is your daily driver while an agent's work cannot land without leaving it.

---

## 7. Ideas worth stealing outright

1. **Checkpoints as hidden git refs.** (T3 Code) Provider-agnostic per-turn undo, reverting workspace *and* conversation. Elegant, and it reuses git rather than inventing a snapshot store.
2. **`synara_wait_for_threads`.** (Synara) A blocking wait on child tasks reaching terminal-or-actionable state, with no polling. This one call is what makes planner→workers real.
3. **Snapshot-bound element refs.** (Synara) Pair every actionable ref with a `snapshotId`; refuse actions bound to a stale snapshot. Turns the classic flaky-selector failure into a loud error.
4. **Model manifest fetched from `main`.** (T3 Code) Model catalog classification updates ship as commits, not releases. For a solo dev shipping infrequently, this is exactly the right mechanism for keeping a model picker current.
5. **`script.{id}.run` as a bindable command.** (T3 Code) Project scripts become first-class commands with keybindings, and can auto-run on worktree creation. The generalized form of the "Add action" button.
6. **Commit + push + PR as one guided action.** (Synara 0.7.1) Not three buttons. One dialog that does the whole thing and shows you what it will do.
7. **Activity inbox sidebar mode.** (Synara 0.6.5) Toggle the sidebar into a compact list of running work, input requests, and failures. Fits Realm's flat-sidebar design directly, and is the cross-space "something needs you" surface Realm's spec already wants (`sidebar item pulses so it's noticed from another space`).
8. **`when` clauses in the keymap.** (T3 Code) `terminalFocus`, `previewOpen`, `modelPickerOpen` as context keys with boolean expressions, last-match-wins across commands. Realm's hardcoded `hotkeys.ts` already checks focus ad hoc; formalizing it costs little.
9. **Auto-settle on PR merge.** (T3 Code) A thread whose PR merges leaves the active list on its own. Small, and it is the thing that keeps a sidebar from becoming a graveyard.
10. **BYO-subscription as the stated business model.** (Universe, Synara, T3 Code) *"That bill stays yours."* Every serious local-first entrant says this explicitly. Ara, which sells inference, is the outlier. Worth saying out loud on Realm's own site.

From the wider category:

11. **`CONDUCTOR_PORT` + a 10-port block per worktree.** (Conductor) Boring, tiny, and the thing that makes parallel dev servers actually work. Ship it with worktrees, not after.
12. **A Checks object that gates merge.** (Conductor) One verdict aggregating git status, PR metadata, CI, deployments, unresolved review comments, and open todos — and it discourages merging while any are outstanding. The strongest "close the loop" UI found anywhere in this research.
13. **`/best-of-n`.** (Cursor) Same task, N models, N worktrees, one comparison view. Once worktrees and background dispatch exist this is almost free, and nobody has commoditized it.
14. **Favorites + one-chord model cycling, and per-function model settings.** (Zed) `commit_message_model`, `thread_summary_model`, `subagent_model` as separate keys is a better decomposition than one global picker.
15. **An `Amp-Thread-ID`-style git trailer.** (Amp) A commit trailer carrying the session id, so `git log` leads from any change back to the conversation that produced it. Perhaps twenty lines, and it makes Realm's transcripts permanently useful.
16. **A worktree picker in the title bar, with worktree threads nesting under their parent project.** (Zed) Good UI hygiene for the sidebar Realm already has.
17. **Named read-only subagents.** (OpenCode) `explore` (codebase) and `scout` (external docs) as distinct read-only roles — the names carry the permission model, which is better than a generic "subagent."
18. **Non-interruptive steering.** (Cursor) A follow-up waits for the agent's next tool call instead of cutting it off mid-action. Synara's live turn steering is the same idea; this framing is better.
19. **Auto-archive / auto-settle on PR merge.** (Claude Code desktop, T3 Code) Independently arrived at by two products. That is a strong signal it is correct.
20. **A narrowly-scoped self-review button.** (Claude Code desktop) Have the agent review its own diff, with the scope stated as *compile errors, definite logic errors, security, obvious bugs* and explicitly **not** style, formatting, pre-existing issues, or anything a linter catches. The restraint is the feature.
21. **Batched inline diff comments sent in one pass.** (Warp, Conductor, Claude Code — all three) Not one comment at a time. Select lines, write comments, send the batch, get an updated diff.

---

## 8. Research notes and gaps

- **Universe** and **Ara** have thin public technical documentation. Universe is landing-page and pricing copy only; Ara has a real REST API reference but its IDE surface (browsers, terminals, review panes, memory, skills) is asserted and not documented. Neither should carry weight in a build decision.
- **Ara carries two inconsistent positionings** — a multiplayer browser IDE, and a cloud issue→PR agent for teams. The API points at the second. That is worth watching rather than resolving from outside.
- Conductor's full keyboard-shortcut table renders client-side and could not be extracted; only the shortcuts named in its workflow docs are cited here.
- Amp's Orbs sub-pages (customization, secrets, automations, event-driven, agent-to-agent) returned 404 on the URL patterns tried, so Amp's automation and PR/merge story is under-documented here rather than absent from the product.
- T3 Code's browser/preview pane and its agent-automation of that pane are corroborated only by merged-PR titles, not by user documentation. The feature is clearly real; its tool surface is not public.
- One mechanical note: the research pass on Claude Code's desktop docs tripped an automated content filter, because those docs list a permission mode literally named `bypassPermissions`. That is product documentation describing a setting, not an injected instruction, and it was treated as data.
