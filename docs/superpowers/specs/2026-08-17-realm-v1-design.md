# Realm v1 — Design Spec

**Date:** 2026-08-17
**Status:** Approved (brainstorm complete)
**Domain:** realm.engineering

## 1. What Realm is

Realm is a local-first **agent control plane** for macOS: one desktop app where Claude Code, Codex, Gemini, Cursor and other coding agents run side by side, organized into Arc-style **profiles → spaces**, with **browser, terminal, iOS simulator, and artifact panes** that both the user and the agents can use, and a **context pool** that lets agents write about the user from real facts instead of inventing them.

Reference points:
- **T3 Code** (MIT, Electron, TS): multi-agent control plane driving agents via CLIs. Realm uses its provider layer as a *reference implementation*, not a fork.
- **Universe** (native Mac, Claude-only): "work off your hands", files land in Finder. Realm borrows the per-space workspace folder idea.
- **Claude Desktop**: browser/simulator/artifacts as abilities an agent can use.

### Decisions locked during brainstorm

| Topic | Decision |
|---|---|
| Wedge | Agent control plane first; browser/simulator/artifacts are *abilities*; context pool is a *driver* underneath |
| Platform | Electron + React + TypeScript (cross-platform, forkable); macOS is the only tested target in v1 |
| Codebase | Greenfield, plain TypeScript. T3 Code used as reference; not adopting Effect |
| Agents in v1 | Claude (native), Codex (app-server), ACP adapter (Gemini, Cursor, Grok, OpenCode) — three adapter kinds, all four named agents |
| Navigation | Profile strip (Work / School / Personal) → spaces → items (Arc-style); one profile's spaces visible at a time |
| Space contents | Space has linked **Projects** (repos) *and* always has its own **workspace folder** on disk |
| Layout | Tabs + free split tree with grid presets; any pane type in any leaf; persisted per space |
| Agent abilities | Realm ships `realm-mcp`, auto-attached to every session; browser tools implemented on **agent-browser** over CDP |
| Context pool | Curated docs + approved session memories (v1); live connectors are roadmap |
| MCP | Realm is a **gateway**: one endpoint per session, per-space enablement, creds held by Realm, calls logged |
| Skills | Skills library synced per space into every agent's skill location |
| Mobile | Not in v1; architecture keeps UI ↔ server over WebSocket so a mobile client is a later client |
| Icons | Hugeicons (Pro, license key via env / `.npmrc`, never committed) |

### Amendment 2026-08-17 (after Plan 1): Arc-style spaces, adaptive theme

Supersedes the "Navigation" row above and the ProfileStrip UI from Plan 1:

- **Space is the swipe unit.** The sidebar shows exactly one space at a time. Spaces are icons in a bottom strip (+ "new space"); a two-finger horizontal swipe on the sidebar (or clicking a strip icon) slides to the previous/next space. Each space has an `icon` and a `color`; the color drives the sidebar tint (light and dark palettes derived from it).
- **Profile is an attribute of a space** (Arc's per-space profile), shown as a small account pill next to the space name and changeable in space settings. There is no profile strip. Credentials, accounts, and context pool still scope by profile; profiles are managed in Settings.
- **Flat sidebar, no trees.** Top: window controls + ⌘K "Ask or search" field. Then pinned items as icon tiles (Arc favorites). Then the space's items (sessions/terminals/tabs/artifacts/context) as a flat list with status dots (session running/waiting). Divider, then "New session · terminal · tab".
- **Projects leave the sidebar.** Linked repos appear in the New Session sheet (agent + project picker) and as a chip on a session header.
- **Adaptive theme.** Follows macOS appearance with an in-app override; both palettes derive from the active space color; content renders as a floating rounded card on the tinted sidebar (Arc), transcript/composer/panel styled after T3 Code (dark) and Universe/Claude Desktop (light).

Data-model impact: `Space` gains `color`; `Item.pinned` items render as tiles; the `Profile` table stays but `Profile.icon/color/sortOrder` become secondary. `spaces.list` becomes global (all spaces, ordered) rather than per-profile.

## 2. Architecture

Four kinds of process on the user's Mac.

```
┌──────────────────────────────────────────────────────────────┐
│ 1. Electron                                                   │
│   renderer (apps/desktop, React) — profile strip, spaces,     │
│     tab bar, split-tree panes                                 │
│   main — windows, one WebContentsView per BrowserTab,         │
│     --remote-debugging-port (CDP), spawns/supervises server   │
└──────────────▲───────────────────────────────────────────────┘
               │ WebSocket: typed events + RPC (packages/contracts)
┌──────────────▼───────────────────────────────────────────────┐
│ 2. realm-server (Node, plain TS)                              │
│   core: profiles/spaces/projects/items/layouts, session mgr,  │
│     append-only event log, SQLite (~/Realm/realm.db)          │
│   adapters: Claude · Codex · ACP → normalized SessionEvent    │
│   abilities: terminals (node-pty), browser (agent-browser/CDP)│
│     simulator (simctl), artifacts (files)                     │
│   context pool: docs + memories, FTS5 + local embeddings      │
└──────────────▲───────────────────────────────────────────────┘
               │ stdio JSON-RPC
┌──────────────▼───────────────────────────────────────────────┐
│ 3. realm-mcp (one per session)                                │
│   Realm tools: browser.* simulator.* artifact.* context.*     │
│     terminal.*  — scoped to the session's space               │
│   gateway: proxies enabled third-party MCP servers            │
└──────────────▲───────────────────────────────────────────────┘
               │ MCP (stdio)
┌──────────────▼───────────────────────────────────────────────┐
│ 4. agent CLIs (one per session, cwd = project or space folder)│
│   claude · codex app-server · gemini --acp · cursor-agent …   │
└──────────────────────────────────────────────────────────────┘
```

**Hard rule:** the renderer talks only to realm-server over WebSocket. It never spawns processes, reads disk, or talks to agents. This is what keeps a future mobile client cheap.

**On disk**
```
~/Realm/
  realm.db                       all state (SQLite)
  skills/                        skills library
  <profile>/
    context/                     curated context docs (watched)
    <space>/                     space workspace folder
      artifacts/                 agent-published outputs
      .claude/skills/ …          synced skills (symlinks) — see §7
```
Repos stay wherever they live and are linked into spaces as Projects.

## 3. Data model

SQLite via better-sqlite3. IDs are ULIDs. All rows have `createdAt`, `updatedAt`.

```
Profile        id, name, icon, color, sortOrder
Account        id, profileId, kind (email|github|calendar|slack|notion|…),
               identity, authRef (Keychain key)

Space          id, profileId, name, icon, sortOrder, folderPath,
               layoutJson, activeItemId
Project        id, spaceId, name, rootPath, defaultBranch
Item           id, spaceId, kind (session|terminal|browser|simulator|artifact|context),
               title, sortOrder, pinned, refId

Session        id, spaceId, projectId?, agentKind (claude|codex|acp:<agent>),
               model?, cwd, status (idle|running|waiting_permission|error|ended),
               providerSessionId, mcpConfigJson, lastEventSeq
SessionEvent   seq (pk), sessionId, ts, type, payloadJson
               types: user_message | assistant_text | tool_call | tool_result |
                      permission_request | permission_response | status | error | artifact

Terminal       id, spaceId, cwd, shell
BrowserTab     id, spaceId, url, title, faviconUrl, partition (per-profile Electron session)
Artifact       id, spaceId, sessionId?, path, mime, title

ContextEntry   id, profileId, kind (doc|memory), source, title, body, tags[],
               approved (bool), embedding (blob) ; FTS5 virtual table over body

McpServer      id, name, transport (stdio|http), commandJson|url, envRef, scope
McpEnablement  spaceId, mcpServerId, enabled, allowedTools[]
McpCallLog     id, sessionId, server, tool, argsJson, resultSummary, ts, durationMs

Skill          id, name, sourcePath, enabledProfiles[]
SkillSync      spaceId, skillId

Setting        key, valueJson
```

**Layout tree** (`Space.layoutJson`):
```ts
type Layout =
  | { type: 'split'; dir: 'row' | 'col'; sizes: number[]; children: Layout[] }
  | { type: 'leaf'; tabs: ItemId[]; activeTab: ItemId }
```
Grid presets (1-up, 2-up, 3-col, 2×2, 3×3) are generator functions from a space's items to a `Layout`.

Two invariants:
1. **Profiles own accounts and context; spaces own everything else.** Switching profile is a hard boundary for credentials and memory.
2. **`SessionEvent` is the source of truth for the transcript UI.** Adapters translate vendor formats into it; four agents render identically; a later client can replay a session from `lastEventSeq`.

## 4. Agent adapters

```ts
interface AgentAdapter {
  kind: 'claude' | 'codex' | `acp:${string}`
  probe(): Promise<{ available: boolean; version?: string; loggedIn?: boolean; models?: string[] }>
  start(opts: {
    cwd: string; model?: string; mcpServers: McpConfig[];
    systemContext?: string; resume?: string /* providerSessionId */
  }): AgentHandle
}
interface AgentHandle {
  send(message: UserMessage): void
  respondPermission(requestId: string, decision: PermissionDecision): void
  interrupt(): void
  events: AsyncIterable<SessionEvent>
  dispose(): Promise<void>
}
```

- **Claude** — `@anthropic-ai/claude-agent-sdk` primary; fallback spawns `claude -p --output-format stream-json --input-format stream-json`. Uses the user's existing Claude Code login (no API key). `mcpServers` → realm-mcp; `systemContext` → system-prompt append. Permission requests → `permission_request` events. Resume via session id.
- **Codex** — spawn `codex app-server`; JSON-RPC over stdio (thread/turn/item model). `item/*` notifications → SessionEvents; approvals → permission events. MCP via config overrides.
- **ACP** — `@zed-industries/agent-client-protocol` client over stdio. One adapter, a launch table (`gemini --acp`, `cursor-agent acp`, `grok`, `opencode acp`). Vendor quirks live in small per-agent extension files (login probes, extra capabilities), not the core adapter.

Common behaviors live in realm-server, not adapters: event persistence, `waiting_permission` status, per-space MCP config assembly, cwd resolution (project root vs space folder), single auto-restart-with-resume on crash, and a Settings probe panel showing which CLIs are installed / logged in.

## 5. Abilities

Each ability is a **pane** (any split leaf) and a **tool set** in realm-mcp scoped to the current space. Every tool invocation lands in `SessionEvent` (`tool_call`/`tool_result`) and `McpCallLog`.

### Browser
- Pane: `WebContentsView` per `BrowserTab`; per-profile `session` partition (separate cookies per profile). URL bar, back/forward, favicon; tabs are sidebar items.
- Tools: `browser.tabs`, `browser.open(url)`, `browser.snapshot(tabId)` (accessibility tree with `@e1` refs), `browser.click/fill/type/press(tabId, ref)`, `browser.screenshot`, `browser.readText`, `browser.eval` (permission-gated).
- Implementation: realm-server runs an **agent-browser** daemon attached to Electron's CDP port and targets the tab's `webContents` target ID. Agent-controlled tabs show a visible badge; user interaction pauses agent input until it re-snapshots. If the tab is closed the tool returns `TAB_GONE`, never retargets.

### Terminal
- Pane: xterm.js; node-pty in realm-server; cwd = project or space folder; per-profile env (e.g. `GH_TOKEN` from the space's GitHub account).
- Tool: `terminal.run(cmd, {cwd, timeout})` streaming output. Mainly for agents whose CLI lacks a good shell tool.

### Simulator (macOS + Xcode only)
- Pane: pick a booted iOS simulator; live view from periodic `xcrun simctl io <udid> screenshot` frames (~5–10 fps); tap/type forwarded via `simctl`; falls back to screenshot-only when input isn't available.
- Tools: `simulator.list/boot/launch(bundleId|appPath)/screenshot/tap/swipe/type/openUrl`.

### Artifacts
- Pane: renders Markdown, HTML (sandboxed iframe), images, PDF, CSV/table, highlighted code; live-reloads on change.
- Tools: `artifact.publish(path|content, title)` → `<space>/artifacts/`, opens/refreshes pane; `artifact.list/read`.

### Context
- Pane for browsing, searching, approving pool entries (see §6).

## 6. Context pool

**Purpose:** any agent in Realm can answer a personal prompt (scholarship essay, application question) from real facts, cite them, and say "I don't have that" otherwise.

**Sources (v1)**
1. **Curated docs** — files in `~/Realm/<profile>/context/` (resume, transcripts, essays, project write-ups, bios). Watched folder; PDF/DOCX/MD/TXT → text → chunks → index. Also an "Add to context" action on any artifact or browser page (cleaned text + source URL).
2. **Session memories** — after each turn realm-server runs an extraction pass over new SessionEvents (small model via the user's login) proposing durable facts. Proposals are `ContextEntry(kind=memory, approved=false)`; the Context pane badges them for approve/edit/reject. **Unapproved entries are never injected.** Profile-scoped.

**Storage/retrieval** — SQLite FTS5 + local embeddings (small in-process ONNX model, e.g. bge-small), hybrid ranking. No cloud calls for indexing. Embedding failure degrades to FTS-only with a warning.

**Delivery to agents**
- **System context:** short profile card (name, role, key facts, writing-voice pointer) prepended via the adapter's system-prompt hook, plus: *use `context.search` before answering personal questions; never invent biographical facts; if the pool lacks it, say so and ask.*
- **Tools:** `context.search(query, {kinds, limit})` → ranked chunks with source + date; `context.get(id)`; `context.remember(fact, tags)` → pending memory (still needs approval).

**Grounding rule:** context-derived claims in artifacts carry a citation footnote to the entry; the Artifact pane can highlight them.

## 7. MCP gateway and skills

**Gateway**
- One `realm-mcp` process per session (stdio). Registers Realm tools; for each `McpServer` enabled for the space, connects as an MCP client and re-exports its tools namespaced (`slack__send_message`), filtered by `allowedTools`. Third-party servers start lazily and are shared across sessions in the same profile.
- Credentials: `McpServer.envRef` → Keychain; realm-mcp injects env at spawn. Agents never see tokens.
- Every proxied call → `McpCallLog` + `tool_call` SessionEvent; Settings → Activity shows them.
- OAuth redirects are handled in a Realm browser tab; API-key servers get a form.
- Settings → MCP: add server (command / npx / uvx / URL, or from a small built-in catalog), test, then per-space toggles in the space settings sheet. Realm's own tools are also toggleable per space.

**Skills**
- Library at `~/Realm/skills/` (optional import from `~/.claude/skills`), each a folder with `SKILL.md`. Enable per profile; `SkillSync` picks per space. On session start realm-server symlinks selected skills into `<cwd>/.claude/skills/` (Claude) and `.agents/skills/` + an `AGENTS.md` pointer (Codex / ACP agents).
- **Plugin (v1)** = an MCP server + skills + a manifest, installable from a folder or git URL. No custom UI extension points.

## 8. Error handling

| Failure | Behavior |
|---|---|
| Agent process dies | Session → `error` with last stderr; UI offers Resume (`providerSessionId`) or New-with-same-context. One silent auto-restart if no user turn was in flight. |
| CLI missing / logged out | Probe surfaces it in Settings and greys the agent out in the New Session picker with reason + fix link. |
| realm-server dies | Electron main restarts it; renderer reconnects with `lastEventSeq` per open session and replays. Layouts/items persisted on every change. |
| realm-mcp / third-party server fails | Structured error to the agent, toast in UI, other servers unaffected; circuit-breaker after 3 consecutive failures. |
| Browser tab closed under agent | `TAB_GONE`; no silent retarget. |
| Bad memory extraction | Only ever a proposal; cannot reach a prompt without approval. |
| Permission request | Blocks session with visible prompt; sidebar item pulses so it's noticed from another space. |

## 9. Testing

- `packages/contracts` (zod) is the UI↔server contract; validated at the WebSocket boundary in dev.
- Adapters: unit tests over recorded fixtures of each wire format (stream-json, app-server, ACP) → assert normalized SessionEvents. Fake agent binaries under `fixtures/` for login-free integration tests.
- realm-mcp: in-process MCP client tests; gateway tested against a stub third-party server.
- Context: golden tests for chunking/ranking; extraction tests over fixed transcripts.
- Desktop: Vitest + React Testing Library for split-tree ops and presets; Playwright-driven Electron smoke test (boot → create space → open browser tab → start fake session).

## 10. Repository layout

pnpm workspaces, TypeScript, Vite.
```
realm/
  apps/desktop        Electron + React (renderer, main, preload)
  apps/server         realm-server
  packages/contracts  zod schemas + event types
  packages/adapters   claude / codex / acp
  packages/mcp        realm-mcp server + gateway
  packages/context    context pool (index, search, extraction)
  packages/ui         shared components; Hugeicons wired here
  docs/               specs, plans, roadmap
```

## 11. v1 definition of done

1. Create profiles, spaces, link repos as projects; every space has a folder.
2. Run Claude, Codex, and Gemini (ACP) sessions with normalized transcripts, permission prompts, resume.
3. Split/grid any mix of agent, terminal, browser, simulator, artifact panes; layout persists per space.
4. An agent drives a browser tab the user is watching, publishes an artifact the user can read, and controls a booted simulator.
5. Drop docs into context, approve session memories, and get a grounded, cited answer to a personal-question prompt from a School-profile session that has no Work facts.
6. Add an MCP server once, enable it per space, see calls logged; skills library synced into all agents.

## 12. Roadmap (post-v1, rough order)

- **Mobile companion** — watch sessions, approve permissions, send follow-ups; relay via Tailscale first.
- **Live connectors as context sources** — Gmail / Calendar / Notion queried through `context.search`, per profile (not ingested).
- **Realm CLI** (`realm browser open …`) mirroring realm-mcp tools for agents that handle MCP poorly.
- **Native-config escape hatch** — write MCP servers/skills into `~/.claude.json`, Codex/Gemini configs for agents launched outside Realm.
- **Cursor / Grok / OpenCode polish** beyond baseline ACP.
- **Session forks/threads, cross-space tags, global search** across sessions and context.
- **Multi-agent workflows** — planner → workers, scheduled/recurring sessions, deep-research recipe.
- **Computer use** — desktop-level control beyond the browser.
- **Voice** — Plynn as an input path into any session.
- **Better extraction** — browser-use-style page extraction heuristics in `browser.readText`.
- **Sharing/publishing artifacts** externally; plugin marketplace and richer manifests.
- **Windows/Linux** builds (simulator ability stays Mac-only).
