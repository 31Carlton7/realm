import { agentBin } from "./cli/bins";
import { CliService } from "./cli/service";
import { CliInstaller } from "./cli/install";
import { openDatabase, type Db } from "./db/database";
import { dbPath } from "./paths";
import { ProfilesStore } from "./store/profiles";
import { SpacesStore } from "./store/spaces";
import { IconAssetsStore } from "./store/icon-assets";
import { IconGenerationService } from "./icons/service";
import { ProjectsStore } from "./store/projects";
import { ItemsStore } from "./store/items";
import { SettingsStore } from "./store/settings";
import { ArtifactsStore } from "./store/artifacts";
import { TerminalsStore } from "./store/terminals";
import { TerminalService } from "./terminals/service";
import { BrowsersStore } from "./store/browsers";
import { GraphifyService } from "./graphify/service";
import { DocumentsStore } from "./store/documents";
import { DocumentService } from "./documents/service";
import { DocumentPreviewServer } from "./documents/preview";
import { MachineService } from "./machines/service";
import { MachineWsProxy } from "./machines/ws-proxy";
import { join } from "node:path";
import { MachinesStore } from "./store/machines";
import { ImageStore } from "./machines/images";
import { GuestSpecSchema, type GuestSpec } from "@realm/contracts";
import { QemuManager } from "./machines/qemu-manager";
import { createDocsAgentProvider } from "./documents/agent-tools";
import { TextExtractor } from "./documents/text-extract";
import { LectureService } from "./school/lectures";
import { PlynnService } from "./school/plynn";
import { BrowserService } from "./browsers/service";
import { BrowserHostBridge } from "./browsers/host-bridge";
import { BrowserPermissionBroker } from "./browsers/permissions";
import { createBrowserAgentProvider } from "./browsers/agent-tools";
import { createComputerAgentProvider } from "./computer/agent-tools";
import { createMachineAgentProvider } from "./machines/agent-tools";
import { MachineAllowlist } from "./machines/allowlist";
import { ComputerAppAllowlist } from "./computer/allowlist";
import { BrowserAgentService, createRealmAgentProvider, REALM_AGENT_PROVIDER_NAME } from "./browsers/browser-agent";
import { DelegationEngine } from "./delegation/engine";
import { announceDelegation } from "./delegation/announce";
import { AgentRunService } from "./delegation/agent-run";
import { ReviewService } from "./delegation/review";
import { AskService } from "./delegation/ask";
import { SessionsStore, SessionEventsStore } from "./store/sessions";
import { EnvironmentsStore } from "./store/environments";
import { SessionService } from "./sessions/service";
import { SessionSummaryService } from "./sessions/summary";
import { PlanLimitsService } from "./limits/service";
import type { ProbeResult } from "@realm/adapters";
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
import { NotificationRelay, realTransport } from "./notifications/relay";
import { RunsStore } from "./store/runs";
import { RunService } from "./runs/service";
import { ScheduleService } from "./schedules/service";
import { SchedulesStore } from "./store/schedules";
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
import { ModelCatalogService } from "./models/catalog";
import { UsageService } from "./usage/service";
import { ForkService } from "./sessions/fork";
import { FailoverService } from "./sessions/failover";
import { ImportService } from "./import/service";
import { RpcServer } from "./rpc/server";
import { registerMethods } from "./rpc/methods";
import { machineName } from "./machine-name";
import { userFirstName } from "./user-name";

/** `gateway` is exposed for tests and live checks that must speak MCP AS a given session (the
 *  per-session toolset shapes are wired in this file's closures — only a real list/call through the
 *  gateway proves them). Production callers use it via sessions, never directly. */
export type App = { port: number; db: Db; terminals: TerminalService; sessions: SessionService; browserAgents: BrowserAgentService; agentRuns: AgentRunService; reviews: ReviewService; asks: AskService; runs: RunService; gateway: McpGateway; close(): Promise<void> };
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
      bin: agentBin("acp:cursor"),
      args: ["acp"],
      label: "Cursor",
      loginHint: "Run `cursor-agent login`.",
      // Cursor's session/new reports availableModels (verified live); Gemini's does not get asked.
      modelCatalog: true,
    }),
    "acp:gemini": new AcpAdapter({
      kind: "acp:gemini",
      bin: agentBin("acp:gemini"),
      args: ["--acp"],
      label: "Gemini",
      // Measured 2026-09-01 (gemini-cli 0.56.0): `initialize` advertises oauth-personal, gemini-api-key,
      // vertex-ai and a custom AI gateway. Only the first is dead — `session/new` under it fails
      // IneligibleTierError — so the hint names the three that work.
      loginHint: "Gemini's free personal tier was discontinued — sign in with a Gemini API key, Vertex AI credentials, or a custom AI gateway.",
    }),
    // ── Plan 18: agents that speak ACP natively ────────────────────────────────────────────────
    // Every `args` below was confirmed by a live `initialize` on 2026-09-01.
    //
    // `modelCatalog` is what OPENS the probe's throwaway session (`AcpAdapter.probe`); teaching
    // `fetchAcpModels` to read `configOptions` did not, and the note that used to stand here said it
    // did — so opencode and Copilot, whose catalogs that reader was written for, went on showing a
    // single Default row. The flag is now set wherever the agent is known to answer with one:
    // fx (a `model` option carrying 165 rows, measured 2026-09-09) and opencode and Copilot (a
    // `model` category each, measured 2026-09-01 — see Plan 18 §2 and §4). Grok is still off
    // because it puts its models in `initialize._meta.modelState`, a place `session/new` never
    // carries, so the round trip would learn nothing; goose and qwen are off because that sweep
    // recorded no model option for them, which is a reason to ask nothing rather than a finding.
    "acp:opencode": new AcpAdapter({
      kind: "acp:opencode",
      bin: agentBin("acp:opencode"),
      args: ["acp"],
      label: "OpenCode",
      loginHint: "Run `opencode auth login`.",
      modelCatalog: true,
    }),
    "acp:copilot": new AcpAdapter({
      kind: "acp:copilot",
      bin: agentBin("acp:copilot"),
      args: ["--acp"],
      label: "GitHub Copilot",
      loginHint: "Run `copilot login`.",
      modelCatalog: true,
    }),
    "acp:goose": new AcpAdapter({
      kind: "acp:goose",
      bin: agentBin("acp:goose"),
      args: ["acp"],
      label: "goose",
      loginHint: "Run `goose configure` to pick a provider and set its API key.",
    }),
    "acp:qwen": new AcpAdapter({
      kind: "acp:qwen",
      bin: agentBin("acp:qwen"),
      args: ["--acp"],
      label: "Qwen Code",
      loginHint: "Run `qwen` once to sign in with your Qwen account, or set OPENAI_API_KEY.",
    }),
    "acp:grok": new AcpAdapter({
      kind: "acp:grok",
      bin: agentBin("acp:grok"),
      args: ["agent", "stdio"],
      label: "Grok",
      loginHint: "Run `grok login` (browser sign-in, needs SuperGrok or X Premium), or set XAI_API_KEY.",
    }),
    // DeepSeek Harness (`dsh`), added 2026-09-03. NOT from the ACP registry — DeepSeek publishes its
    // own ACP bundle, `@deepseek-ai/dsh-acp`, whose runnable composition is `dsh-acp-demo`.
    //
    // Registered like any other ACP kind and expected to report as MISSING for now: measured
    // 2026-09-03, `@deepseek-ai/dsh-acp-demo@0.0.1-rc.1` cannot be installed at all — two of its
    // required peers (`dsh-workspace-context`, `dsh-bash-env`) are unpublished, so npm aborts on peer
    // resolution and pnpm on the 404. The spec is written now so that the day those packages land,
    // the harness works with no code change; until then the probe says "not installed" and the picker
    // says why (AGENT_LOGIN_HINTS), which is a better answer than pretending the kind does not exist.
    //
    // No `modelCatalog`: dsh-acp takes its provider and model as BOOT CONFIG and exposes neither a
    // `models` field nor a config option, so a probe-time `session/new` would spend a round trip to
    // learn nothing. `AGENT_MODELS["acp:deepseek"]` carries the two models instead.
    "acp:deepseek": new AcpAdapter({
      kind: "acp:deepseek",
      bin: agentBin("acp:deepseek"),
      args: [],
      label: "DeepSeek",
      loginHint: "Set DEEPSEEK_API_KEY — the DeepSeek Harness has no login command of its own.",
    }),
    // OpenHands, added 2026-09-08. Everything below was measured against openhands 1.16.0 rather
    // than read off a docs page:
    //   - `openhands acp` answers `initialize` with protocolVersion 1, `loadSession: true` and
    //     `mcpCapabilities {http: true, sse: true}` — the gateway's entry goes over unfiltered.
    //   - `session/new` refuses with ACP's own -32000 until `~/.openhands/agent_settings.json`
    //     exists, so a signed-out session lands on `acpBootFailureMessage`'s auth branch and the
    //     loginHint below is what the user is told to do about it.
    // No `modelCatalog`: the model lives in that settings file and is never on the wire, so a
    // probe-time session would spend a round trip to learn nothing.
    "acp:openhands": new AcpAdapter({
      kind: "acp:openhands",
      bin: agentBin("acp:openhands"),
      args: ["acp"],
      label: "OpenHands",
      // Its stdout is clean JSON-RPC either way (verified) — this is for `--version`, which prints a
      // seven-line ASCII banner ahead of the number unless the variable is set.
      env: { OPENHANDS_SUPPRESS_BANNER: "1" },
      loginHint: "Run `openhands` once and pick a model with `/settings`; `openhands login` signs in to OpenHands Cloud instead.",
    }),
    "acp:fx": new AcpAdapter({
      kind: "acp:fx",
      bin: agentBin("acp:fx"),
      args: ["acp"],
      label: "fx",
      // fx gates `initialize` ITSELF on being signed in (measured: -32600 with this exact text), so a
      // signed-out fx fails on the boot branch with no `authMethods` to list. This hint is the only
      // thing that tells the user what to run.
      loginHint: "Run `fx login` to sign in with Vercel, `fx setup` for an AI Gateway API key, or set AI_GATEWAY_API_KEY.",
      // Measured 2026-09-09 against fx 0.0.7: `session/new` answers a `configOptions` array whose
      // `model` option carries 165 rows (`openai/gpt-5.2`, `zai/glm-5.3-flash`, …) beside a
      // `provider` and a `mode` option. The blanket "none of Plan 18's agents sets this" above was
      // true of the shapes measured on 2026-09-01 and is not true of fx now — without the flag the
      // probe never opens the throwaway session, so `AGENT_MODELS["acp:fx"]` (empty, on purpose)
      // was the whole catalog and the picker showed one dead Default row.
      modelCatalog: true,
    }),
    // Hermes Agent (Nous Research), added 2026-09-09. Everything here is off the vendor's own docs
    // rather than off a handshake — the CLI is not on this machine (see AgentKindSchema for why
    // that is stated rather than quietly fixed by running its installer):
    //   - `hermes acp` is the documented ACP entry point ("Any of the following starts Hermes in
    //     ACP mode"), with `hermes-acp` and `python -m acp_adapter` as equivalents.
    //   - It logs to stderr "so stdout remains reserved for ACP JSON-RPC traffic" — which is the
    //     one property the stdio transport actually needs of a server.
    //   - Servers passed on `session/new` "are still registered", so the gateway entry goes over.
    //   - `modelCatalog` is on its word too: its ACP page describes a live model menu over the
    //     wire ("The list comes from Hermes itself over ACP") and says model-discovery probes
    //     leave no empty session behind, which is Realm's throwaway probe session described from
    //     the other side. If that turns out to be wrong, `fetchAcpModels` answers null and the
    //     picker falls back to the Default row — the cost of being wrong here is one round trip.
    // The loginHint leads with the ACP extra because a Hermes that is installed but built without
    // it has no `hermes acp` to spawn at all, which reads as "the agent is broken" rather than as
    // "one more install step".
    "acp:hermes": new AcpAdapter({
      kind: "acp:hermes",
      bin: agentBin("acp:hermes"),
      args: ["acp"],
      label: "Hermes",
      modelCatalog: true,
      loginHint: "Run `cd ~/.hermes/hermes-agent && uv pip install -e '.[acp]'` to add its ACP mode, then `hermes setup` (or `hermes model`) to pick a provider and sign in.",
    }),
  };
  // The offline-dev script: enough to reach the surfaces that only exist for one event type. A plan
  // is here because it is drawn by a card of its own, and without a scripted one the fake agent —
  // whose whole purpose is UI development — can never produce it. Revised in place, since a plan that
  // updates is the behaviour worth looking at. A to-do list is here for the same reason, in two
  // triggers rather than one run: the strip above the prompter shuts itself once every item is done,
  // and both sides of that have to be reachable and holdable long enough to look at.
  if (process.env.REALM_ENABLE_FAKE_AGENT === "1") reg.fake = new FakeAdapter({ delayMs: 15, script: [{ on: "plan", emit: [
    { kind: "text", text: "Here is how I would go about it." },
    { kind: "plan", planId: "fake-plan", text: "## Rework the mapper\n\n1. Carry the plan as its own event.\n2. Draw it as a plan.", steps: [
      { text: "Carry the plan as its own event", status: "in_progress" }, { text: "Draw it as a plan", status: "pending" }] },
    { kind: "plan", planId: "fake-plan", text: "## Rework the mapper\n\n1. Carry the plan as its own event.\n2. Draw it as a plan.", steps: [
      { text: "Carry the plan as its own event", status: "completed" }, { text: "Draw it as a plan", status: "in_progress" }] },
  ] }, {
    on: "todos", emit: [{ kind: "tool", name: "TodoWrite", result: "Todos have been modified successfully", input: { todos: [
      { content: "Carry the plan as its own event", status: "completed", activeForm: "Carrying the plan as its own event" },
      { content: "Draw it as a plan", status: "in_progress", activeForm: "Drawing it as a plan" },
      { content: "Test it", status: "pending", activeForm: "Testing it" }] } }],
  }, {
    on: "all done", emit: [{ kind: "tool", name: "TodoWrite", result: "Todos have been modified successfully", input: { todos: [
      { content: "Carry the plan as its own event", status: "completed", activeForm: "Carrying the plan as its own event" },
      { content: "Draw it as a plan", status: "completed", activeForm: "Drawing it as a plan" },
      { content: "Test it", status: "completed", activeForm: "Testing it" }] } }],
  }, {
    // Failover's surfaces are the same kind of thing as the plan card above: they exist for one
    // event type each, and without a scripted failure the fake agent can never reach them. The
    // message is the real Claude wording, so what this drives is the real classifier and not a
    // special case — a space with a chain hands over, one without says why it could not.
    on: "hit the limit", emit: [{ kind: "throw", message: "Claude AI usage limit reached|1788555903" }],
  }, {
    // Its milder sibling, for the retry line: a dropped socket, which never moves the session.
    on: "drop the socket", emit: [{ kind: "throw", message: "read ECONNRESET" }],
  }] });
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
  agentRun?: { fallbackKind?: import("@realm/contracts").AgentKind; timeouts?: { baseMs: number; perTurnMs: number; pollMs: number }; maxDepth?: number; caps?: { perParent?: number; total?: number } };
  /** Plan 13 W3: the same knobs for the reviewer recipe. `fallbackKind` (the reviewer's kind when the
   *  requester's has no read-only plan mode, or the user clicked) falls back to `agentRun`'s, then
   *  `browserAgent`'s. */
  review?: { fallbackKind?: import("@realm/contracts").AgentKind; timeouts?: { budgetMs: number; pollMs: number } };
  /** Plan 20's interjection: only timeouts, because an ask spawns nothing and so has no kind to fall
   *  back to. The behaviour suite needs sub-second budgets to exercise the timeout path. */
  ask?: { timeouts?: { budgetMs: number; pollMs: number } };
  /** CLI manager knobs, injected for the same reason `titleGenerator` is omitted: a suite must never
   *  reach a package registry, and it must read a PATH the test built rather than the developer's own
   *  machine. Production callers pass neither and get the process environment and real fetch. */
  cli?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; spawnImpl?: typeof import("node:child_process").spawn };
  /** Upgrades a session's heuristic first-line title to a short model-written summary in the
   *  background (`SessionService.upgradeTitle`). A real, billed LLM call per session — omitted here
   *  on purpose so tests and live-check scripts never make one; the real server process (`main.ts`)
   *  passes `generateSessionTitle`. */
  titleGenerator?: (text: string) => Promise<string>;
  /** Writes the model's account of a session when a turn settles. A real, billed LLM call per settled
   *  turn — omitted here on purpose so tests and live-check scripts never make one; the real server
   *  process (`main.ts`) passes `generateSessionSummary`. Without it the panes show the derived line,
   *  which is exactly what they showed before this existed. */
  summaryGenerator?: (input: { asked: string; transcript: string; facts: string }) => Promise<string>;
  /** Plan 22: where Plynn's meeting exports are read from. Tests point this at a fixture; production
   *  leaves it unset for `~/Library/Application Support/Plynn/Meetings`. */
  plynnMeetingsDir?: string;
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
  // The relay reads its destinations from settings at send time; wired with the real transport
  // here and nowhere else, so every test and live-check script sends nothing off the machine.
  const notifications = new NotificationsService({ store: new NotificationsStore(db), settings, rpc,
    relay: new NotificationRelay({ settings, transport: realTransport, log: (line) => console.error(line) }) });
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

  /* Machines (Plan 25 W3). The proxy and the service are mutually late-bound: the proxy asks the
     service for an address at CONNECT time — never a cached one, so an edited machine cannot be
     reconnected to at its old address — and the service is where the proxy's callbacks land. */
  const machinesStore = new MachinesStore(db);
  const machineProxy: MachineWsProxy = new MachineWsProxy({
    targetFor: (id) => machines.targetFor(id),
    onConnected: (id, size) => machines.onConnected(id, size),
    onFailed: (id, error, detail) => machines.onFailed(id, error, detail),
    onClosed: (id) => machines.onClosed(id),
    log: (line) => console.log(line),
  });
  /* Guests live under `<realmHome>/machines`, never in a space's project folder — the deliberate
     opposite of `DOWNLOAD_DIRNAME`, because a download is the user's file and belongs where they see
     it while a 20GB disk image is Realm's infrastructure and inside a git checkout is a hazard. */
  const machinesDir = join(opts.home, "machines");
  const machineImages = new ImageStore({ dir: join(machinesDir, "images") });
  const qemuManager = new QemuManager({ log: (line) => console.log(line) });
  const machines: MachineService = new MachineService({
    db, rpc, spaces, items, machines: machinesStore, proxy: machineProxy,
    machinesDir, images: machineImages, qemu: qemuManager,
    // Late-bound like the proxy above it: `browserBridge` is built further down, and a `mac`
    // machine's driver is only ever reached long after everything here has been constructed.
    bridge: { call: (op, params) => browserBridge.call(op, params) },
  });
  // Guest shapes survive a restart through `settings`, keyed by machine id — Realm's own
  // configuration rather than a secret or an address, so it needs no column and no migration.
  machines.hydrateGuests(machinesStore.all()
    .map((m) => [m.id, GuestSpecSchema.safeParse(settings.get(`machine.guest:${m.id}`))] as const)
    .filter((e): e is [string, { success: true; data: GuestSpec }] => e[1].success)
    .map(([id, parsed]) => [id, parsed.data] as [string, GuestSpec]));
  // Plan 22: the preview listener guides and PDFs are framed from. Its root lookup is late-bound to
  // the service below (a workspace id → its checkout), which is the only thing it needs to know.
  const preview = new DocumentPreviewServer({ rootOf: (id) => documents.rootOfWorkspace(id) });
  const documents: DocumentService = new DocumentService({ db, rpc, spaces, items, environments, documents: new DocumentsStore(db), preview });
  // W2: the one slice of the spaces/profiles world the scoped services (skills, MCP, memory) may see.
  // A seam rather than the store so each service declares exactly the questions it asks.
  const scopeSeam = {
    profileIdOf: (spaceId: string): string | null => spaces.get(spaceId)?.profileId ?? null,
    spaceIdsOf: (profileId: string): string[] => spaces.list(profileId).map((sp) => sp.id),
    allSpaceIds: (): string[] => spaces.listAll().map((sp) => sp.id),
  };
  // Repo-shipped skills reach the user's library here, once each, before any session can be started.
  const skills = new SkillsService({
    home: opts.home, settings, scopes: scopeSeam,
    // The space's own folder, for its project-level skill directories. A space whose folder is gone
    // reads as project-less rather than failing the scan — the rest of the roots are still valid.
    spaces: { folderPathOf: (spaceId: string): string | null => spaces.get(spaceId)?.folderPath ?? null },
  });
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
  // Declared here and built after `modelCatalog` (which it prices with), then read back through the
  // session-event hook below — the same forward-reference `runs` takes, for the same reason.
  let usage: UsageService | null = null;
  let runs: RunService | null = null;
  // Declared alongside `runs` and for the same reason: `close()` below runs on a boot that may have
  // failed before this was constructed, so the handle has to exist as null from the top.
  let schedules: ScheduleService | null = null;
  // Plan 16 W3: forked sessions carry ancestor context through the same extraSystemContext seam the
  // delegation children use. Late-bound for the same knot: ForkService needs SessionService.create.
  let forks: ForkService | null = null;
  // Failover (fallbacks + forks): built after `sessions`, because it drives it — so the session
  // service takes it as a late-bound hook object, the same knot `notifications` and `browserAgents`
  // are tied with.
  let failover: FailoverService | null = null;
  const mcpGateway = new McpGateway({ hub: mcpHub, mcp, sessions: sessionsStore, calls: mcpCalls, rpc, servers: mcpServersStore, onOauthCallback: (url) => oauth.handleCallback(url),
    // A browser-agent child is only-mode (realm-browser and nothing else); an agent_run child — and
    // a reviewer child (W3) — is exclude-mode (the space's FULL surface minus the delegation
    // provider — the gateway half of depth-1: a reviewer sees neither agent tool nor agent_review).
    // A session cannot be two kinds of child: each tool's child record is written by exactly one run.
    sessionToolset: (sessionId) => {
      const only = browserAgents?.sessionToolset(sessionId);
      if (only) return only;
      // A reviewer child, and an agent_run child that has SPENT its depth budget, lose the whole
      // realm-agent provider here. An agent_run child that still has budget keeps it and is narrowed
      // to the agent_run family by the provider's own `tools()` — the coarse gateway hammer cannot
      // express "this provider, but only four of its tools", and inventing a shape that could would
      // put per-tool delegation policy in the gateway, which is exactly where it does not belong.
      const spentChild = agentRuns?.isChild(sessionId) && !agentRuns.canDelegate(sessionId);
      return spentChild || reviews?.isChild(sessionId) ? { exclude: [REALM_AGENT_PROVIDER_NAME] } : null;
    } });
  gateway = mcpGateway;
  const memory = new MemoryService({ home: opts.home, settings, environments, claudeDir: opts.claudeDir, scopes: scopeSeam });
  // The browser agent surface (Plan 11 W3): the main↔server op bridge, the permission broker, and the
  // `realm-browser` provider on the gateway. The broker's callbacks are late-bound to `sessionService`
  // (the checkpoints knot again): nothing in it runs before a session exists to run it for.
  const computerAllowlist = new ComputerAppAllowlist({ settings });
  const browserBridge = new BrowserHostBridge({ rpc });
  const browserBroker = new BrowserPermissionBroker({
    // A missing row degrades to "plan" — the refuse-mutations mode — never to a prompt on a ghost.
    permissionMode: (sessionId) => sessionsStore.get(sessionId)?.permissionMode ?? "plan",
    emit: (sessionId, ev) => sessionService?.emitExternal(sessionId, ev),
  });
  const artifacts = new ArtifactsStore(db, settings);
  const sessionEvents = new SessionEventsStore(db, artifacts);
  // Hoisted: `defaultAdapters()` builds live adapter instances, and failover must check membership
  // against the SAME registry the session service starts agents from — two registries would let a
  // chain accept an agent the sessions could not run.
  const adapterRegistry = opts.adapters ?? defaultAdapters();
  /* The session summary writer (one cheap model for every harness, once per settled turn).
     Built BEFORE the service it is handed to, and reaching back into it through closures: the
     service needs the summarizer on construction, and the summarizer needs the service's probe and
     its event rail. Both are only ever called long after this line, so the cycle is a reference and
     not an order. */
  // Annotated, not inferred: the two hold references to each other, and inference would have to
  // resolve one through the other.
  const summaries: SessionSummaryService | undefined = opts.summaryGenerator
    ? new SessionSummaryService({
        // 20k events is far past any real session and far short of a memory problem; a transcript
        // longer than that is clipped from the END by the generator anyway.
        listEvents: (id) => sessionEvents.listAfter(id, 0, 20_000),
        lastSummary: (id) => sessionEvents.lastOfType(id, "summary"),
        publish: (id, ev) => sessions.publishServerEvent(id, ev),
        generate: opts.summaryGenerator,
        // "Is the model installed on this machine" — asked of the same cached probe the prompter
        // uses, so it costs nothing extra, and asked BEFORE the call so a machine with no Claude CLI
        // never pays for a refusal. `loggedIn === false` is a real no; null is "the CLI did not say",
        // which is not grounds for withholding the feature.
        available: async (): Promise<boolean> => (await sessions.probe()).some((p: ProbeResult) => p.kind === "claude" && p.available && p.loggedIn !== false),
        onError: (line) => console.error(line),
      })
    : undefined;
  const planLimits = new PlanLimitsService({ rpc });
  const sessions = new SessionService({ db, rpc, sessions: sessionsStore, events: sessionEvents, items, spaces, projects, environments, settings, worktrees, ports, terminals, adapters: adapterRegistry, skills, gateway: mcpGateway, memory, checkpoints, browserPermissions: browserBroker, titleGenerator: opts.titleGenerator, summaries, planLimits, documents,
    // The session-event rail, fanned out: the notifications feed AND the durable-run supervisor read
    // the SAME event off the same hook, so a run settles off exactly the status transition the feed
    // reports rather than off a poll of its own (runs/service.ts).
    notifications: {
      handleSessionEvent: (session, ev) => { notifications.handleSessionEvent(session, ev); runs?.handleSessionEvent(session, ev); usage?.handleSessionEvent(session, ev); },
      probeResults: (results) => notifications.probeResults(results),
    },
    // One hook fanning out to BOTH delegation registries. `parentInterrupted` goes to either service
    // (they share the one engine, which owns the registry); the per-child seams try each registry —
    // a session is a child of at most one.
    failover: {
      turnStarted: (id, msg) => failover?.turnStarted(id, msg),
      cancel: (id) => failover?.cancel(id),
      release: (id) => failover?.release(id),
      close: () => failover?.close(),
      onError: (session, message) => { failover?.onError(session, message); },
      extraSystemContext: (id) => failover?.extraSystemContext(id),
    },
    browserAgents: {
      parentInterrupted: (id) => browserAgents?.parentInterrupted(id),
      release: (id) => { browserAgents?.release(id); agentRuns?.release(id); reviews?.release(id); asks?.release(id); forks?.release(id); runs?.release(id); },
      extraSystemContext: (id) => browserAgents?.extraSystemContext(id) ?? agentRuns?.extraSystemContext(id) ?? reviews?.extraSystemContext(id) ?? forks?.extraSystemContext(id) ?? runs?.extraSystemContext(id),
      skillsFilter: (id) => agentRuns?.skillsFilter(id) ?? runs?.skillsFilter(id) ?? null,
    } });
  sessionService = sessions;
  // The delegation stack (Plan 11 W5 + Plan 13 W1): ONE engine (settle/drain + one-run-per-parent,
  // shared across both tools), the browser-agent registry, the agent_run registry, and the
  // `realm-agent` provider serving `browser_agent_run` + `agent_run`. A delegated child is a REAL
  // session whose specialization all rides existing seams — see each service's class doc comment,
  // including the bypass-is-never-inherited rule both tools carry.
  const delegationEngine: DelegationEngine = new DelegationEngine({
    sessions, caps: opts.agentRun?.caps,
    onChange: (parentSessionId) => announceDelegation(rpc, delegationEngine, parentSessionId),
  });
  browserAgents = new BrowserAgentService({ settings, sessions, rpc, engine: delegationEngine, skillsRoot: skills.root, fallbackKind: opts.browserAgent?.fallbackKind, timeouts: opts.browserAgent?.timeouts });
  agentRuns = new AgentRunService({ settings, sessions, rpc, engine: delegationEngine, environments: envService, skills, otherDelegation: browserAgents,
    fallbackKind: opts.agentRun?.fallbackKind ?? opts.browserAgent?.fallbackKind, timeouts: opts.agentRun?.timeouts, maxDepth: opts.agentRun?.maxDepth });
  // The reviewer recipe (W3): same engine, read-only cap, review-origin children. `otherDelegation`
  // fans across BOTH sibling registries — no delegated child of any kind may mint a reviewer.
  const agentRunsFinal = agentRuns, browserAgentsFinal = browserAgents;
  reviews = new ReviewService({ settings, sessions, rpc, engine: delegationEngine, environments, notifications,
    otherDelegation: { isChild: (id) => agentRunsFinal.isChild(id) || browserAgentsFinal.isChild(id) },
    fallbackKind: opts.review?.fallbackKind ?? opts.agentRun?.fallbackKind ?? opts.browserAgent?.fallbackKind, timeouts: opts.review?.timeouts });
  mcpGateway.registerProvider(createBrowserAgentProvider({ browsers: browsersStore, projects, browserService: browsers, mcp, bridge: browserBridge, broker: browserBroker, rpc, constraints: browserAgents }));
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
  // The one provider a space has to switch ON: it reaches every app on the Mac.
  mcpGateway.registerProvider(createComputerAgentProvider({ mcp, bridge: browserBridge, broker: browserBroker, allowlist: computerAllowlist }));
  // Plan 22 W2: the `realm-docs` provider — search/list/open/progress over the space's own folder.
  // One extractor for the process: PDF text is memoized across every session's searches.
  const extractor = new TextExtractor();
  mcpGateway.registerProvider(createDocsAgentProvider({
    mcp, extractor,
    rootForSpace: (spaceId) => { try { return documents.rootForSpace(spaceId); } catch { return null; } },
    listForSpace: (spaceId, dir) => documents.list(documents.open({ spaceId }).documentsId, dir),
    openPath: (p) => documents.openPath(p),
    progressForSpace: (spaceId, path) => documents.progressRead(documents.open({ spaceId }).documentsId, path),
  }));
  // Plan 25 W4, on the same terms: off until a space asks for it, a card per MACHINE rather than per
  // tool, and the card kept in bypassPermissions. Registered here and not conditionally — the
  // gateway's own per-space enablement is what decides whether a session sees the tools.
  const machineAllowlist = new MachineAllowlist({ settings });
  mcpGateway.registerProvider(createMachineAgentProvider({ mcp, machines, broker: browserBroker, allowlist: machineAllowlist, rpc }));
  // The graphify CLI seam (probe + `graphify update`). Only the space's checkout path crosses into
  // it — it never learns what a space or a database is.
  const graphify = new GraphifyService({ rootForSpace: (id) => documents.rootForSpace(id) });
  const lectures = new LectureService({ spaces, documents });
  const plynn = new PlynnService({ spaces, settings, documents, meetingsDir: opts.plynnMeetingsDir });
  // Durable runs: a goal that owns a session across attempts and survives restarts. Not on the
  // delegation engine on purpose — nobody is blocked on a run, so its state is a row and its settle
  // rides the session-event hook above (runs/service.ts).
  runs = new RunService({ store: new RunsStore(db), settings, sessions, rpc, environments: envService, skills, notifications,
    fallbackKind: opts.agentRun?.fallbackKind ?? opts.browserAgent?.fallbackKind });
  // Scheduled tasks: the clock in front of the runs above. It owns a timer and they deliberately do
  // not — every fact this one acts on is a column, so a restart replays from the row rather than
  // from anything the process was holding (schedules/service.ts). Started after boot recovery below,
  // not here, so a catch-up firing lands in a world whose live runs have already been reconciled.
  schedules = new ScheduleService({ store: new SchedulesStore(db), runs, rpc });
  // The durable ship log (Plan 14 W1): GitWriteService stays a pure git service — the recorder is the
  // one seam through which a settled ship becomes a row, and the broadcast rides the same write so a
  // History tab already open sees the ship land.
  // Global search (Plan 16 W1). The service reads; the index writes live in the stores' own choke
  // points (SessionEventsStore.append, ItemsStore) so no producer can skip them.
  const search = new SearchService({ db, settings, profiles, spaces, skills, memory });
  // Model prices and context windows for the picker (public catalog, cached in `settings`). Nothing
  // depends on it: every method returns rows, and an unreachable catalog returns the stale ones.
  const modelCatalog = new ModelCatalogService({ settings });

  // The CLI manager reads the same probe every other caller does, so an install card and this service
  // never disagree about whether an agent is there. The installer's afterRun is what makes a finished
  // install visible: it bypasses both caches before the `cli.done` event goes out.
  const cli = new CliService({ probe: (o) => sessions.probe(o), ...opts.cli });
  const cliInstaller = new CliInstaller({
    onOutput: (e) => rpc.broadcast("cli.output", e),
    onDone: (e) => rpc.broadcast("cli.done", e),
    afterRun: () => cli.refresh(),
    // The same injection the version check gets, and for the same reason one step further along: a
    // suite must not reach a registry, and it must not RUN a package manager or a vendor updater on
    // the developer's machine either. Production passes neither and gets the real spawn and env.
    env: opts.cli?.env,
    spawnImpl: opts.cli?.spawnImpl,
  });
  // Spend and activity for Settings → Usage, and the budget watcher behind it. Reads only; the one
  // thing it writes is the budget row, and the one thing it emits is a threshold notification.
  usage = new UsageService({ db, settings, catalog: modelCatalog, notifications });
  // Session forks (Plan 16 W3). `createSession` is SessionService's own create — the fork's session
  // is a session like any other (item, broadcast, adapter check), just dispatched by "fork".
  forks = new ForkService({ adapters: adapterRegistry, checkpoints: new CheckpointsStore(db), environments, envService, worktrees,
    sessionsStore, events: sessionEvents, settings, git: checkpointGit, rpc,
    // A fork is a session like any other, so it takes the LISTED overload and gets an item.
    createSession: (input) => sessions.create({ ...input, unlisted: false }) });
  // Failover. Its three effects all land back on the session service — put an event on the
  // transcript, replay the turn, tear the adapter down — which is why it is built here rather than
  // beside the stores it reads.
  failover = new FailoverService({
    sessions: sessionsStore, events: sessionEvents, settings, adapters: adapterRegistry,
    emit: (id, ev) => sessions.emitExternal(id, ev),
    resend: (id, msg) => sessions.resendTurn(id, msg),
    stop: (id) => sessions.stopAgent(id),
  });
  // Importing the agent CLIs' own history (transcripts, memory folders, skills). Reads ~/.claude,
  // ~/.codex and ~/.cursor and never writes them; everything it produces lands in this database or
  // under Realm's home. `roots` is left at its default here and overridden only by tests.
  const imports = new ImportService({ home: opts.home, db, rpc, spaces, profiles, projects, environments,
    sessions: sessionsStore, events: sessionEvents, items, settings, memory });
  const ships = new ShipsStore(db);
  const gitWrite = new GitWriteService({ shipLog: (entry) => {
    ships.record(entry);
    rpc.broadcast("ships.changed", { spaceId: entry.spaceId });
  } });
  // Two shell-outs for two labels: asked for together so boot waits once, not twice.
  const [machine, user] = await Promise.all([machineName(), userFirstName()]);
  registerMethods({
    rpc, home: opts.home, version: SERVER_VERSION, machineName: machine, userName: user,
    profiles, spaces, projects, environments, envService, items, settings, skills, mcp, hub: mcpHub, gateway: mcpGateway, oauth, calls: mcpCalls, memory, terminals, browsers, machines, browserBridge, documents, sessions, gitInfo: new GitInfoService(), gitDiff: new GitDiffService(), gitWrite, ships, ports, checkpoints, notifications, runs, reviews, search, artifacts, forks, failover, imports, lectures, plynn, modelCatalog, usage, graphify, schedules, delegation: delegationEngine, computerAllowlist, browserPermissions: browserBroker, cli, cliInstaller,
    iconAssets, iconGeneration, planLimits,
  });
  sessions.markStaleOnBoot();
  // AFTER markStaleOnBoot, which is what turns a session that was mid-turn back into a resumable
  // row — recovery reconciles each live run against that reconciled world, not the pre-boot one.
  runs.recoverOnBoot();
  // …and only then does the clock start. A schedule that came due while the app was closed fires on
  // this first tick, and it must not race the recovery that decides which runs are still alive.
  schedules.start();
  // The pre-v15 event history reaches the search index here: chunked, yielding, resumable across
  // boots (SearchService.runBackfill's doc comment states the design). Fire-and-forget — search over
  // the not-yet-covered range is merely incomplete while it runs, and a failure only pauses it.
  void search.runBackfill();
  // The pre-v25 history reaches the Library's file index the same way, on the same terms: chunked,
  // yielding, resumable, and merely incomplete rather than wrong while it runs.
  void artifacts.runBackfill(() => false);
  terminals.restoreAll();
  // Starts nothing, and clears every recorded ws port: a port held against last run's listener is a
  // lie, and the UNIQUE index would refuse to reissue it to the machine it belonged to.
  machines.restoreAll();
  // The gateway must be accepting connections before any session can start (its listener mints the URL
  // every `sessions.create` → send hands an adapter), and well before the RPC socket opens to clients.
  await mcpGateway.listen();
  await preview.listen();
  await machineProxy.listen();
  const port = await rpc.listen(opts.port);
  return {
    port, db, terminals, sessions, browserAgents, agentRuns, reviews, asks, runs, gateway: mcpGateway,
    close: async () => {
      search.stop(); // before db.close: the backfill loop must not start a chunk on a closing handle
      schedules?.close(); // before runs: a tick must not create a run on a service that is stopping
      runs?.close(); // likewise: an in-flight dispatch must not write to a closing handle
      terminals.closeAll();
      cliInstaller.disposeAll();
      await sessions.closeAll();
      // Gateway before hub: stop accepting new proxied calls before the upstream clients they'd need go
      // away, so a request racing shutdown fails cleanly (connection refused) rather than mid-call.
      documents.dispose();
      // Awaited, and before `db.close()`: an un-awaited close leaves live sockets to somebody else's
      // Mac open past the process, and the service writes a ws port back to the row as each drops.
      await machines.closeAll();
      await preview.close();
      await mcpGateway.close();
      await mcpHub.close();
      await rpc.close();
      db.close();
    },
  };
}
