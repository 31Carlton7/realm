import { openDatabase, type Db } from "./db/database";
import { dbPath } from "./paths";
import { ProfilesStore } from "./store/profiles";
import { SpacesStore } from "./store/spaces";
import { IconAssetsStore } from "./store/icon-assets";
import { IconGenerationService } from "./icons/service";
import { ProjectsStore } from "./store/projects";
import { ItemsStore } from "./store/items";
import { SettingsStore } from "./store/settings";
import { TerminalsStore } from "./store/terminals";
import { TerminalService } from "./terminals/service";
import { BrowsersStore } from "./store/browsers";
import { BrowserService } from "./browsers/service";
import { BrowserHostBridge } from "./browsers/host-bridge";
import { BrowserPermissionBroker } from "./browsers/permissions";
import { createBrowserAgentProvider } from "./browsers/agent-tools";
import { BrowserAgentService, createRealmAgentProvider, REALM_AGENT_PROVIDER_NAME } from "./browsers/browser-agent";
import { DelegationEngine } from "./delegation/engine";
import { AgentRunService } from "./delegation/agent-run";
import { ReviewService } from "./delegation/review";
import { AskService } from "./delegation/ask";
import { SessionsStore, SessionEventsStore } from "./store/sessions";
import { EnvironmentsStore } from "./store/environments";
import { SessionService } from "./sessions/service";
import { SkillsService } from "./skills/service";
import { McpServersStore, McpCallLogStore } from "./store/mcp";
import { McpService, oauthStatusOf } from "./mcp/service";
import { McpHub } from "./mcp/hub";
import { McpGateway } from "./mcp/gateway";
import { McpOauth } from "./mcp/oauth";
import type { McpServerStatus } from "@realm/contracts";
import { MemoryService } from "./memory/service";
import { NotificationsStore } from "./store/notifications";
import { ShipsStore } from "./store/ships";
import { NotificationsService } from "./notifications/service";
import { ClaudeAdapter, CodexAdapter, AcpAdapter, FakeAdapter, type AdapterRegistry } from "@realm/adapters";
import { GitInfoService } from "./workspace/git-info";
import { GitDiffService } from "./workspace/git-diff";
import { GitWriteService } from "./workspace/git-write";
import { PortAllocator } from "./workspace/ports";
import { WorktreeService } from "./workspace/worktrees";
import { EnvironmentService } from "./environments/service";
import { CheckpointsStore } from "./store/checkpoints";
import { CheckpointGit } from "./workspace/checkpoints";
import { CheckpointService } from "./checkpoints/service";
import { SearchService } from "./search/service";
import { ForkService } from "./sessions/fork";
import { RpcServer } from "./rpc/server";
import { registerMethods } from "./rpc/methods";
import { machineName } from "./machine-name";

/** `gateway` is exposed for tests and live checks that must speak MCP AS a given session (the
 *  per-session toolset shapes are wired in this file's closures — only a real list/call through the
 *  gateway proves them). Production callers use it via sessions, never directly. */
export type App = { port: number; db: Db; terminals: TerminalService; sessions: SessionService; browserAgents: BrowserAgentService; agentRuns: AgentRunService; reviews: ReviewService; asks: AskService; gateway: McpGateway; close(): Promise<void> };
export const SERVER_VERSION = "0.0.1";

/**
 * Claude, Codex and both ACP agents are always registered; availability is reported by `agents.probe` so the
 * New Session sheet can disable the ones that are not installed or not signed in. The scripted fake is only
 * registered when REALM_ENABLE_FAKE_AGENT=1 (offline dev).
 */
export function defaultAdapters(): AdapterRegistry {
  const reg: AdapterRegistry = {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
    "acp:cursor": new AcpAdapter({
      kind: "acp:cursor",
      bin: process.env.REALM_CURSOR_BIN ?? "cursor-agent",
      args: ["acp"],
      label: "Cursor",
      loginHint: "Run `cursor-agent login`.",
      // Cursor's session/new reports availableModels (verified live); Gemini's does not get asked.
      modelCatalog: true,
    }),
    "acp:gemini": new AcpAdapter({
      kind: "acp:gemini",
      bin: process.env.REALM_GEMINI_BIN ?? "gemini",
      args: ["--acp"],
      label: "Gemini",
      // Measured 2026-09-01 (gemini-cli 0.56.0): `initialize` advertises oauth-personal, gemini-api-key,
      // vertex-ai and a custom AI gateway. Only the first is dead — `session/new` under it fails
      // IneligibleTierError — so the hint names the three that work.
      loginHint: "Gemini's free personal tier was discontinued — sign in with a Gemini API key, Vertex AI credentials, or a custom AI gateway.",
    }),
    // ── Plan 18: agents that speak ACP natively ────────────────────────────────────────────────
    // Every `args` below was confirmed by a live `initialize` on 2026-09-01. None sets `modelCatalog`:
    // opencode and Copilot report their catalogs through `configOptions` (which the probe now reads
    // via acpSessionConfig, so a catalog arrives without the flag), and Grok puts its models in
    // `initialize._meta.modelState` — a place `session/new` never carries, so a probe-time session
    // spawn would cost a real round trip to learn nothing.
    "acp:opencode": new AcpAdapter({
      kind: "acp:opencode",
      bin: process.env.REALM_OPENCODE_BIN ?? "opencode",
      args: ["acp"],
      label: "OpenCode",
      loginHint: "Run `opencode auth login`.",
    }),
    "acp:copilot": new AcpAdapter({
      kind: "acp:copilot",
      bin: process.env.REALM_COPILOT_BIN ?? "copilot",
      args: ["--acp"],
      label: "GitHub Copilot",
      loginHint: "Run `copilot login`.",
    }),
    "acp:goose": new AcpAdapter({
      kind: "acp:goose",
      bin: process.env.REALM_GOOSE_BIN ?? "goose",
      args: ["acp"],
      label: "goose",
      loginHint: "Run `goose configure` to pick a provider and set its API key.",
    }),
    "acp:qwen": new AcpAdapter({
      kind: "acp:qwen",
      bin: process.env.REALM_QWEN_BIN ?? "qwen",
      args: ["--acp"],
      label: "Qwen Code",
      loginHint: "Run `qwen` once to sign in with your Qwen account, or set OPENAI_API_KEY.",
    }),
    "acp:grok": new AcpAdapter({
      kind: "acp:grok",
      bin: process.env.REALM_GROK_BIN ?? "grok",
      args: ["agent", "stdio"],
      label: "Grok",
      loginHint: "Run `grok login` (browser sign-in, needs SuperGrok or X Premium), or set XAI_API_KEY.",
    }),
    "acp:fx": new AcpAdapter({
      kind: "acp:fx",
      bin: process.env.REALM_FX_BIN ?? "fx",
      args: ["acp"],
      label: "fx",
      // fx gates `initialize` ITSELF on being signed in (measured: -32600 with this exact text), so a
      // signed-out fx fails on the boot branch with no `authMethods` to list. This hint is the only
      // thing that tells the user what to run.
      loginHint: "Run `fx login` to sign in with Vercel, `fx setup` for an AI Gateway API key, or set AI_GATEWAY_API_KEY.",
    }),
  };
  if (process.env.REALM_ENABLE_FAKE_AGENT === "1") reg.fake = new FakeAdapter({ script: [], delayMs: 15 });
  return reg;
}

/** `claudeDir` overrides where MemoryService reads user-level Claude files (`~/.claude` otherwise) —
 *  for tests and live checks, which must never depend on (or expose) the real user's memory files. */
export async function createApp(opts: { home: string; port: number; adapters?: AdapterRegistry; claudeDir?: string;
  /** W5 test/live-check knobs for the browser-agent registry: `fallbackKind` (default claude) is the
   *  child agent when the parent's kind has no skills-injection route; `timeouts` shrinks the settle
   *  budget so suites don't wait minutes. Production callers pass neither. */
  browserAgent?: { fallbackKind?: import("@realm/contracts").AgentKind; timeouts?: { baseMs: number; perActMs: number; pollMs: number } };
  /** Plan 13 W1: the same knobs for `agent_run`. `fallbackKind` falls back to `browserAgent`'s when
   *  unset (test harnesses configure the fake once); `timeouts` shrinks the settle budget. */
  agentRun?: { fallbackKind?: import("@realm/contracts").AgentKind; timeouts?: { baseMs: number; perTurnMs: number; pollMs: number } };
  /** Plan 13 W3: the same knobs for the reviewer recipe. `fallbackKind` (the reviewer's kind when the
   *  requester's has no read-only plan mode, or the user clicked) falls back to `agentRun`'s, then
   *  `browserAgent`'s. */
  review?: { fallbackKind?: import("@realm/contracts").AgentKind; timeouts?: { budgetMs: number; pollMs: number } };
  /** Plan 20's interjection: only timeouts, because an ask spawns nothing and so has no kind to fall
   *  back to. The behaviour suite needs sub-second budgets to exercise the timeout path. */
  ask?: { timeouts?: { budgetMs: number; pollMs: number } };
  /** Upgrades a session's heuristic first-line title to a short model-written summary in the
   *  background (`SessionService.upgradeTitle`). A real, billed LLM call per session — omitted here
   *  on purpose so tests and live-check scripts never make one; the real server process (`main.ts`)
   *  passes `generateSessionTitle`. */
  titleGenerator?: (text: string) => Promise<string>;
}): Promise<App> {
  const db = openDatabase(dbPath(opts.home));
  const profiles = new ProfilesStore(db);
  // First boot: without a profile the New Space sheet is a dead end (spaces require one), so seed a
  // default. Only when the table is empty — reboots and user-created profiles are left alone.
  if (profiles.list().length === 0) profiles.create({ name: "Personal", icon: "user", color: "#6b7280" });
  const rpc = new RpcServer();
  const spaces = new SpacesStore(db, opts.home);
  const iconAssets = new IconAssetsStore(db);
  const iconGeneration = new IconGenerationService(iconAssets);
  const items = new ItemsStore(db);
  const projects = new ProjectsStore(db);
  const environments = new EnvironmentsStore(db);
  const ports = new PortAllocator(db);
  // Worktrees live under the Realm home, which is also the boundary WorktreeService refuses to
  // remove outside of — so it is given the home rather than deriving one.
  const worktrees = new WorktreeService(opts.home);
  const sessionsStore = new SessionsStore(db);
  const settings = new SettingsStore(db);
  // The notifications feed (Plan 12 W5): the ONE writer of notification rows. Every producer below —
  // SessionService's event hook, the hub's onStatus callback, the two stale-ack refusal sites — hands
  // its events here rather than writing rows of its own, so the dedup rule and the category toggles
  // have exactly one home.
  const notifications = new NotificationsService({ store: new NotificationsStore(db), settings, rpc });
  // `isEnvironmentBusy` is a late-bound closure rather than a constructor argument because the two
  // services genuinely need each other: SessionService checkpoints every turn, and CheckpointService
  // must refuse to restore under a live agent. One direction is the dependency; the other is this.
  let sessionService: SessionService | null = null;
  const checkpointGit = new CheckpointGit();
  const checkpoints = new CheckpointService({
    checkpoints: new CheckpointsStore(db), environments, sessions: sessionsStore, git: checkpointGit,
    isEnvironmentBusy: (id) => sessionService?.isEnvironmentBusy(id) ?? false,
    notifications,
  });
  const envService = new EnvironmentService({ environments, spaces, worktrees, ports, checkpoints, notifications });
  const terminals = new TerminalService({ db, rpc, spaces, items, terminals: new TerminalsStore(db), environments });
  const browsersStore = new BrowsersStore(db);
  const browsers = new BrowserService({ db, rpc, spaces, items, browsers: browsersStore });
  // W2: the one slice of the spaces/profiles world the scoped services (skills, MCP, memory) may see.
  // A seam rather than the store so each service declares exactly the questions it asks.
  const scopeSeam = {
    profileIdOf: (spaceId: string): string | null => spaces.get(spaceId)?.profileId ?? null,
    spaceIdsOf: (profileId: string): string[] => spaces.list(profileId).map((sp) => sp.id),
    allSpaceIds: (): string[] => spaces.listAll().map((sp) => sp.id),
  };
  // Repo-shipped skills reach the user's library here, once each, before any session can be started.
  const skills = new SkillsService({ home: opts.home, settings, scopes: scopeSeam });
  const installed = skills.installBundled();
  if (installed.length) console.error(`[skills] installed bundled skill(s): ${installed.join(", ")}`);
  const mcpServersStore = new McpServersStore(db);
  const mcpCalls = new McpCallLogStore(db);
  // The hub's live connection state per server row, read by `McpService.list` (via `statusOf`) so
  // `mcp.list` can report `connected`/`error`/`circuit_open` without asking the hub directly — the same
  // "inject rather than import" split `McpService`'s constructor doc comment explains.
  const mcpStatus = new Map<string, McpServerStatus>();
  const mcp = new McpService({ servers: mcpServersStore, settings, statusOf: (id) => mcpStatus.get(id) ?? "idle", scopes: scopeSeam });
  // `gateway` is assigned after construction below (it needs `hub`, which needs THIS callback) — the
  // same late-bound-closure pattern `sessionService` above uses for the same reason: two things that
  // genuinely need each other, with one direction as the constructor dependency and the other as this.
  let gateway: McpGateway | null = null;
  // Constructed BEFORE the hub (whose `authHeaders` seam calls into it) but referring back to both the
  // hub and the gateway from its callbacks — the same knot `gateway` above is tied with, and untied the
  // same way: nothing in here runs during construction, only later from a live flow. `boundPort` is null
  // until `listen()`, and `oauth.start` refuses rather than minting a redirect URI nothing answers.
  const oauth = new McpOauth({
    servers: mcpServersStore,
    gatewayPort: () => gateway?.boundPort ?? null,
    // A row's OAuth state changed: connected after a callback, `reconnect_needed` after a failed silent
    // refresh, unconfigured after a disconnect.
    onStatus: (id) => {
      // FIRST, before anything else: a hub client built with the OLD credentials must not keep serving.
      // This is the whole reason the callback exists — a disconnected server whose live client still
      // holds a working Bearer would go on making authenticated calls after the user revoked it. (A
      // failed refresh is the one case where there is no live client to drop: `headers()` only ever runs
      // while the hub is BUILDING a transport. Invalidating is a cheap no-op there, and the cases where
      // it matters are exactly the two where it isn't.)
      mcpHub.invalidate(id);
      const row = mcpServersStore.get(id);
      // Same single derivation site the hub's own `onStatus` uses below.
      rpc.broadcast("mcp.serverStatus", { id, status: mcpStatus.get(id) ?? "idle", oauthStatus: row ? oauthStatusOf(row) : "unconfigured" });
      // Both directions warrant it: a server that just connected can contribute tools it could not
      // before, and one that just disconnected can no longer contribute the ones it was. `invalidate`
      // above may already have emitted an equivalent notification — status events can repeat (see
      // `hub.ts`) and `notifyToolsChanged` tolerates that.
      gateway?.notifyToolsChanged();
    },
  });
  const mcpHub = new McpHub({
    servers: mcpServersStore,
    // The OAuth seam. `McpOauth` sanitizes its own errors — the hub cannot redact a token that only ever
    // existed inside an error thrown in here (see the seam's own doc comment in `hub.ts`).
    authHeaders: (row) => oauth.headers(row),
    onStatus: (id, status) => {
      mcpStatus.set(id, status);
      // `oauthStatusOf` is the ONE place `oauthJson` → `oauthStatus` derivation lives (see its own doc
      // comment) — this callback and `McpService.list`'s `toContract` both call it rather than keeping a
      // second copy, so W5's `reconnect_needed` only has one call site to teach it to.
      const row = mcpServersStore.get(id);
      const oauthStatus = row ? oauthStatusOf(row) : "unconfigured";
      rpc.broadcast("mcp.serverStatus", { id, status, oauthStatus });
      // The feed's mcp_health hook (Plan 12 W5), on the same status flow the UI's dots ride — repeated
      // errors collapse into one open row server-side, so the loop-termination story above is unchanged.
      notifications.mcpServerStatus(id, row?.name ?? null, status);
      // A hub status change is the gateway's only signal that a cached tool list may have changed
      // (`connected` after a reconnect, or `onToolsChanged`'s `list_changed`-triggered relist) — so every
      // status event, not just the interesting ones, tells every registered session to re-list. Status
      // events can repeat (see `hub.ts`), and `notifyToolsChanged` tolerates that.
      //
      // That repetition is also what keeps a broken upstream from looping forever: a re-list triggered by
      // THIS notification can itself fail, which calls `onStatus` again, which calls `notifyToolsChanged`
      // again, which could trigger another re-list... `hub.ts`'s `CIRCUIT_THRESHOLD` is why that chain
      // terminates rather than spinning agent + gateway + hub in a feedback loop: two failed relists emit
      // `"error"` here, the third emits `"circuit_open"`, and every attempt AFTER that fails fast inside
      // `ensureClient` — before `recordFailure` ever runs — so it emits no status event at all. A future
      // change to that fast-fail path must preserve "no event on an already-open circuit," or this loop
      // stops self-extinguishing.
      gateway?.notifyToolsChanged();
    },
  });
  // Late-bound like `sessionService`/`gateway` above: the gateway consults the delegation
  // registries for per-session toolset shapes (Plan 11 W5 + Plan 13 W1), and those registries need
  // SessionService, which needs the gateway. Nothing reads the seam before a session makes a request.
  let browserAgents: BrowserAgentService | null = null;
  let agentRuns: AgentRunService | null = null;
  let reviews: ReviewService | null = null;
  let asks: AskService | null = null;
  // Plan 16 W3: forked sessions carry ancestor context through the same extraSystemContext seam the
  // delegation children use. Late-bound for the same knot: ForkService needs SessionService.create.
  let forks: ForkService | null = null;
  const mcpGateway = new McpGateway({ hub: mcpHub, mcp, sessions: sessionsStore, calls: mcpCalls, rpc, servers: mcpServersStore, onOauthCallback: (url) => oauth.handleCallback(url),
    // A browser-agent child is only-mode (realm-browser and nothing else); an agent_run child — and
    // a reviewer child (W3) — is exclude-mode (the space's FULL surface minus the delegation
    // provider — the gateway half of depth-1: a reviewer sees neither agent tool nor agent_review).
    // A session cannot be two kinds of child: each tool's child record is written by exactly one run.
    sessionToolset: (sessionId) => {
      const only = browserAgents?.sessionToolset(sessionId);
      if (only) return only;
      return agentRuns?.isChild(sessionId) || reviews?.isChild(sessionId) ? { exclude: [REALM_AGENT_PROVIDER_NAME] } : null;
    } });
  gateway = mcpGateway;
  const memory = new MemoryService({ home: opts.home, settings, environments, claudeDir: opts.claudeDir, scopes: scopeSeam });
  // The browser agent surface (Plan 11 W3): the main↔server op bridge, the permission broker, and the
  // `realm-browser` provider on the gateway. The broker's callbacks are late-bound to `sessionService`
  // (the checkpoints knot again): nothing in it runs before a session exists to run it for.
  const browserBridge = new BrowserHostBridge({ rpc });
  const browserBroker = new BrowserPermissionBroker({
    // A missing row degrades to "plan" — the refuse-mutations mode — never to a prompt on a ghost.
    permissionMode: (sessionId) => sessionsStore.get(sessionId)?.permissionMode ?? "plan",
    emit: (sessionId, ev) => sessionService?.emitExternal(sessionId, ev),
  });
  const sessionEvents = new SessionEventsStore(db);
  const sessions = new SessionService({ db, rpc, sessions: sessionsStore, events: sessionEvents, items, spaces, projects, environments, settings, worktrees, ports, terminals, adapters: opts.adapters ?? defaultAdapters(), skills, gateway: mcpGateway, memory, checkpoints, browserPermissions: browserBroker, notifications, titleGenerator: opts.titleGenerator,
    // One hook fanning out to BOTH delegation registries. `parentInterrupted` goes to either service
    // (they share the one engine, which owns the registry); the per-child seams try each registry —
    // a session is a child of at most one.
    browserAgents: {
      parentInterrupted: (id) => browserAgents?.parentInterrupted(id),
      release: (id) => { browserAgents?.release(id); agentRuns?.release(id); reviews?.release(id); asks?.release(id); forks?.release(id); },
      extraSystemContext: (id) => browserAgents?.extraSystemContext(id) ?? agentRuns?.extraSystemContext(id) ?? reviews?.extraSystemContext(id) ?? forks?.extraSystemContext(id),
      skillsFilter: (id) => agentRuns?.skillsFilter(id) ?? null,
    } });
  sessionService = sessions;
  // The delegation stack (Plan 11 W5 + Plan 13 W1): ONE engine (settle/drain + one-run-per-parent,
  // shared across both tools), the browser-agent registry, the agent_run registry, and the
  // `realm-agent` provider serving `browser_agent_run` + `agent_run`. A delegated child is a REAL
  // session whose specialization all rides existing seams — see each service's class doc comment,
  // including the bypass-is-never-inherited rule both tools carry.
  const delegationEngine = new DelegationEngine({ sessions });
  browserAgents = new BrowserAgentService({ settings, sessions, rpc, engine: delegationEngine, skillsRoot: skills.root, fallbackKind: opts.browserAgent?.fallbackKind, timeouts: opts.browserAgent?.timeouts });
  agentRuns = new AgentRunService({ settings, sessions, rpc, engine: delegationEngine, environments: envService, skills, otherDelegation: browserAgents,
    fallbackKind: opts.agentRun?.fallbackKind ?? opts.browserAgent?.fallbackKind, timeouts: opts.agentRun?.timeouts });
  // The reviewer recipe (W3): same engine, read-only cap, review-origin children. `otherDelegation`
  // fans across BOTH sibling registries — no delegated child of any kind may mint a reviewer.
  const agentRunsFinal = agentRuns, browserAgentsFinal = browserAgents;
  reviews = new ReviewService({ settings, sessions, rpc, engine: delegationEngine, environments, notifications,
    otherDelegation: { isChild: (id) => agentRunsFinal.isChild(id) || browserAgentsFinal.isChild(id) },
    fallbackKind: opts.review?.fallbackKind ?? opts.agentRun?.fallbackKind ?? opts.browserAgent?.fallbackKind, timeouts: opts.review?.timeouts });
  mcpGateway.registerProvider(createBrowserAgentProvider({ browsers: browsersStore, browserService: browsers, mcp, bridge: browserBridge, broker: browserBroker, rpc, constraints: browserAgents }));
  // Plan 20's interjection. `delegated` fans across all THREE registries: a delegated child of any
  // kind is neither a valid asker nor a valid target, because its own parent is already blocked inside
  // an MCP call waiting for it. `permissions` is the SAME broker the browser tools gate on — the card
  // appears on the asker, which is where the blocked call is.
  const reviewsFinal = reviews;
  asks = new AskService({
    sessions, engine: delegationEngine,
    delegated: { isChild: (id) => browserAgentsFinal.isChild(id) || agentRunsFinal.isChild(id) || reviewsFinal.isChild(id) },
    permissions: browserBroker,
    timeouts: opts.ask?.timeouts,
  });
  mcpGateway.registerProvider(createRealmAgentProvider(browserAgents, mcp, agentRuns, reviews, asks));
  // The durable ship log (Plan 14 W1): GitWriteService stays a pure git service — the recorder is the
  // one seam through which a settled ship becomes a row, and the broadcast rides the same write so a
  // History tab already open sees the ship land.
  // Global search (Plan 16 W1). The service reads; the index writes live in the stores' own choke
  // points (SessionEventsStore.append, ItemsStore) so no producer can skip them.
  const search = new SearchService({ db, settings, profiles, spaces, skills, memory });
  // Session forks (Plan 16 W3). `createSession` is SessionService's own create — the fork's session
  // is a session like any other (item, broadcast, adapter check), just dispatched by "fork".
  forks = new ForkService({ checkpoints: new CheckpointsStore(db), environments, envService, worktrees,
    sessionsStore, events: sessionEvents, settings, git: checkpointGit, rpc,
    createSession: (input) => sessions.create(input) });
  const ships = new ShipsStore(db);
  const gitWrite = new GitWriteService({ shipLog: (entry) => {
    ships.record(entry);
    rpc.broadcast("ships.changed", { spaceId: entry.spaceId });
  } });
  registerMethods({
    rpc, home: opts.home, version: SERVER_VERSION, machineName: await machineName(),
    profiles, spaces, projects, environments, envService, items, settings, skills, mcp, hub: mcpHub, gateway: mcpGateway, oauth, calls: mcpCalls, memory, terminals, browsers, browserBridge, sessions, gitInfo: new GitInfoService(), gitDiff: new GitDiffService(), gitWrite, ships, ports, checkpoints, notifications, reviews, search, forks,
    iconAssets, iconGeneration,
  });
  sessions.markStaleOnBoot();
  // The pre-v15 event history reaches the search index here: chunked, yielding, resumable across
  // boots (SearchService.runBackfill's doc comment states the design). Fire-and-forget — search over
  // the not-yet-covered range is merely incomplete while it runs, and a failure only pauses it.
  void search.runBackfill();
  terminals.restoreAll();
  // The gateway must be accepting connections before any session can start (its listener mints the URL
  // every `sessions.create` → send hands an adapter), and well before the RPC socket opens to clients.
  await mcpGateway.listen();
  const port = await rpc.listen(opts.port);
  return {
    port, db, terminals, sessions, browserAgents, agentRuns, reviews, asks, gateway: mcpGateway,
    close: async () => {
      search.stop(); // before db.close: the backfill loop must not start a chunk on a closing handle
      terminals.closeAll();
      await sessions.closeAll();
      // Gateway before hub: stop accepting new proxied calls before the upstream clients they'd need go
      // away, so a request racing shutdown fails cleanly (connection refused) rather than mid-call.
      await mcpGateway.close();
      await mcpHub.close();
      await rpc.close();
      db.close();
    },
  };
}
