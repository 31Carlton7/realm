import { agentBin } from "./cli/bins";
import { CliService } from "./cli/service";
import { CliInstaller } from "./cli/install";
import { openDatabase, type Db } from "./db/database";
import { dbPath } from "./paths";
import { ProfilesStore } from "./store/profiles";
import { SpacesStore } from "./store/spaces";
import { IconAssetsStore } from "./store/icon-assets";
import { AvatarStore } from "./store/avatar";
import { LibraryFilesStore } from "./store/library-files";
import { IconGenerationService } from "./icons/service";
import { ProjectsStore } from "./store/projects";
import { ItemsStore } from "./store/items";
import { SettingsStore } from "./store/settings";
import { ArtifactsStore } from "./store/artifacts";
import { TerminalHistoryStore, TerminalsStore } from "./store/terminals";
import { Drain } from "./daemon/drain";

/** How often the drain checks whether anything is still running. */
const DRAIN_TICK_MS = 1_000;
import { TerminalService } from "./terminals/service";
import { BrowsersStore } from "./store/browsers";
import { BrowserHistoryStore } from "./store/browser-history";
import { GraphifyService } from "./graphify/service";
import { DocumentsStore } from "./store/documents";
import { DocumentService } from "./documents/service";
import { DocumentPreviewServer } from "./documents/preview";
import { MachineService } from "./machines/service";
import { SimulatorService } from "./simulators/service";
import { GoalService } from "./goals/service";
import { EggService } from "./eggs/service";
import { createGoalProvider } from "./goals/agent-tools";
import { createWorkspaceProvider } from "./workspace/agent-tools";
import { createSessionOpenTools } from "./workspace/session-open";
import { createSpacesTools } from "./workspace/spaces";
import { createSettingsTools } from "./workspace/settings";
import { harnessFakeScript } from "./harness-fake-script";
import { GoalsStore } from "./store/goals";
import { MachineWsProxy } from "./machines/ws-proxy";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { MachinesStore } from "./store/machines";
import { SimulatorsStore } from "./store/simulators";
import { ImageStore } from "./machines/images";
import { DEFAULT_PERMISSION_MODE_KEY, GOAL_PROVIDER_NAME, GuestSpecSchema, goalToolWireName, type GuestSpec } from "@realm/contracts";
import { QemuManager } from "./machines/qemu-manager";
import { createDocsAgentProvider } from "./documents/agent-tools";
import { TextExtractor } from "./documents/text-extract";
import { namedInRoot } from "./documents/paths";
import { LectureService } from "./school/lectures";
import { PlynnService } from "./school/plynn";
import { BrowserService } from "./browsers/service";
import { BrowserHostBridge } from "./browsers/host-bridge";
import { BrowserPermissionBroker } from "./browsers/permissions";
import { createUiAgentProvider, listBranches } from "./ui/agent-tools";
import { createHubElicitation } from "./mcp/elicitation";
import { createBrowserAgentProvider } from "./browsers/agent-tools";
import { createComputerAgentProvider } from "./computer/agent-tools";
import { DecisionLog } from "./laya/log";
import { LayaService } from "./laya/service";
import { LayaShadow } from "./laya/shadow";
import { createLayaAssist, harnessEvalOverride, type LayaAssist } from "./laya/assist";
import { bundledLayaDir } from "./laya/benchmark";
import { machineState, readEval, trainCheckpoint } from "./laya/training";
import { LayaRecorder } from "./laya/recorder";
import type { LayaRuntime } from "./laya/runtime";
import { createTerminalAgentProvider } from "./terminals/agent-tools";
import { SignInTickets } from "./browsers/signin";
import { SignInFlow } from "./browsers/signin-flow";
import { AgentSignInService } from "./agents/signin-service";
import { createAppUiProvider } from "./app-ui/agent-tools";
import { createMachineAgentProvider } from "./machines/agent-tools";
import { createSimulatorAgentProvider } from "./simulators/agent-tools";
import { MachineAllowlist } from "./machines/allowlist";
import { ComputerAppAllowlist } from "./computer/allowlist";
import { ComputerSessionGrants } from "./computer/session-grants";
import { BrowserAgentService, createRealmAgentProvider, REALM_AGENT_PROVIDER_NAME } from "./browsers/browser-agent";
import { DelegationEngine } from "./delegation/engine";
import { announceDelegation } from "./delegation/announce";
import { AgentRunService } from "./delegation/agent-run";
import { DelegatedChildren } from "./delegation/children";
import { ReviewService } from "./delegation/review";
import { CodeReviewService } from "./code-review/service";
import { GhClient, ghRunner } from "./code-review/gh";
import { AskService } from "./delegation/ask";
import { SessionsStore, SessionEventsStore } from "./store/sessions";
import { EnvironmentsStore } from "./store/environments";
import { SessionService, resolveDefaultPermissionMode } from "./sessions/service";
import { RECAP_DEBOUNCE_MS, SessionSummaryService } from "./sessions/summary";
import { PlanLimitsService } from "./limits/service";
import type { ProbeResult } from "@realm/adapters";
import { SkillsService } from "./skills/service";
import { UserCommandsService } from "./commands/service";
import { ScriptService } from "./scripts/service";
import { KeybindingsService } from "./keybindings/service";
import { ThemesService } from "./themes/service";
import { FontsService } from "./fonts/service";
import { McpServersStore, McpCallLogStore } from "./store/mcp";
import { McpService, oauthStatusOf } from "./mcp/service";
import { McpHub, type HubElicit } from "./mcp/hub";
import { McpGateway } from "./mcp/gateway";
import { McpOauth } from "./mcp/oauth";
import type { AgentKind, McpServerStatus } from "@realm/contracts";
import { MemoryService } from "./memory/service";
import { MemoryRepoService, type RepoOwner } from "./memory/repo";
import { MEMORY_PROVIDER_NAME, createMemoryAgentProvider } from "./memory/agent-tools";
import { NotificationsStore } from "./store/notifications";
import { ShipsStore } from "./store/ships";
import { NotificationsService } from "./notifications/service";
import { NotificationRelay, realTransport } from "./notifications/relay";
import { RunsStore } from "./store/runs";
import { RunService } from "./runs/service";
import { ScheduleService } from "./schedules/service";
import { createScheduleAgentProvider } from "./schedules/agent-tools";
import { SchedulesStore } from "./store/schedules";
import { ClaudeAdapter, CodexAdapter, AcpAdapter, FakeAdapter, fakeStandIn, type AdapterRegistry } from "@realm/adapters";
import { FAKE_BLOCK_SCRIPT } from "./ui/fake-blocks";
import { GitInfoService } from "./workspace/git-info";
import { GitDiffService } from "./workspace/git-diff";
import { ProjectSearchService } from "./workspace/grep";
import { MentionFiles } from "./workspace/mention-files";
import { gitCapture } from "./workspace/git-exec";
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
import { AppViewsStore } from "./store/app-views";
import { SavedTurnsStore } from "./store/saved-turns";
import { AppViews } from "./apps/views";
import { AppViewServer } from "./apps/server";
import { AppViewService } from "./apps/service";
import { ExecutionSandboxService } from "./sandbox/service";
import { machineName } from "./machine-name";
import { userFirstName } from "./user-name";
import { TeamService } from "./team/service";
import { HandoffService } from "./team/handoffs/service";
import { HandoffStore } from "./team/handoffs/store";
import { createHandoffTools } from "./team/handoffs/agent-tools";
import { TeamStore } from "./team/store";
import { createTeamAgentProvider } from "./team/agent-tools";
import { VaultService } from "./team/vault/service";
import { VaultStore } from "./team/vault/store";
import { createVaultAgentProvider } from "./team/vault/agent-tools";
import { registerVaultMethods } from "./team/vault/rpc";
import { LabService } from "./lab/service";
import { LabDevicesStore } from "./lab/devices-store";
import { registerLabMethods } from "./lab/methods";
import { evaluate, macProbeDeps, probeFacts, runCommand } from "./lab/readiness";
import { ActService, type TicketPress } from "./team/acts/service";
import { ActStore } from "./team/acts/store";
import { FakeActAdapter, NotConnectedAdapter, type ActAdapter } from "./team/acts/adapters";
import { registerActMethods } from "./team/acts/rpc";

/** `gateway` is exposed for tests and live checks that must speak MCP AS a given session (the
 *  per-session toolset shapes are wired in this file's closures — only a real list/call through the
 *  gateway proves them). Production callers use it via sessions, never directly. */
export type App = { port: number; db: Db; terminals: TerminalService; sessions: SessionService; browserAgents: BrowserAgentService; agentRuns: AgentRunService; reviews: ReviewService; asks: AskService; runs: RunService; schedules: ScheduleService; team: TeamService; lab: LabService; acts: ActService; codeReview: CodeReviewService; gateway: McpGateway; close(): Promise<void> };
export const SERVER_VERSION = "0.0.1";

/** The Vite dev server's origin, when Electron told us about it by inheriting it into our env. */
function devRendererOrigin(): string | null {
  const url = process.env.ELECTRON_RENDERER_URL;
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

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
  if (process.env.REALM_ENABLE_FAKE_AGENT === "1") reg.fake = new FakeAdapter({ delayMs: 15, script: [...harnessFakeScript(), {
    // Code Review's "Review with…" (code-review/reviewer.ts) on the live checks' fixture request
    // (scripts/fixtures/code-review): a summary and three findings in the reply shape the page reads —
    // two on lines the fixture's diff shows, one off it, so anchored and unanchored both appear.
    // FIRST, because the prompt carries the whole diff, and a word in it must not match a later entry.
    on: "Review pull request acme/widgets#42", emit: [
      { kind: "text", paceMs: 30, text: "I read the tokenizer and parser changes against the new tests.\n\n```realm-review\n" + JSON.stringify({
        summary: "Streaming the tokenizer drops the 64 KB read buffer and keeps the parser's API as it was. Two risks stand out: a token that ends on a chunk boundary is split in two, and the parser no longer reports an unterminated string.",
        comments: [
          { path: "src/tokenizer.ts", line: 14, side: "RIGHT", body: "A token that ends exactly at a chunk boundary is pushed before the next chunk arrives, so `ab|cd` comes out as two tokens. Carry the partial token into the next `feed`." },
          { path: "src/parser.ts", line: 31, side: "LEFT", body: "This removes the `UnterminatedString` error and nothing replaces it, so a missing quote now reads to the end of the file without a word." },
          { path: "README.md", line: 400, side: "RIGHT", body: "The README still says the tokenizer buffers its whole input." },
        ],
      }) + "\n```" },
    ],
  }, {
    // …and the docked prompter's first question about it, answered the way an agent that read the
    // attached request would.
    on: "About pull request acme/widgets#42", emit: [
      { kind: "text", paceMs: 25, text: "It replaces the tokenizer's 64 KB read buffer with a stream: `Tokenizer.feed` takes chunks as they arrive and yields each token as soon as it is complete. The parser's public API is unchanged, so no caller has to move. The one change in behaviour is error reporting — an unterminated string used to throw `UnterminatedString`, and that check is gone." },
    ],
  }, {
    // Work handed to other models: the Agents tab's "Build with…" message, played the way an
    // orchestrating agent plays it — a word on the split, a real `agent_start` per model through
    // this session's own gateway, one `agent_wait`, and the report. FIRST, because a message that
    // hands over a plan also says "plan", and the first entry to match is the one that plays.
    on: "Build this with", emit: [
      { kind: "text", paceMs: 40, text: "I'll split this: the toggle and its tests go to GPT-6 Luna, and the migration to Fable." },
      { kind: "call", tool: "realm-agent__agent_start", input: { title: "Dark-mode toggle", goal: "Build the dark-mode toggle in Settings ▸ App, with its tests", constraints: { model: "GPT-6 Luna" } } },
      { kind: "call", tool: "realm-agent__agent_start", input: { title: "Theme migration", goal: "Write the migration that stores the theme choice", constraints: { model: "Fable" } } },
      { kind: "call", tool: "realm-agent__agent_wait", input: {} },
      { kind: "text", paceMs: 30, text: "Both sub-agents are done. GPT-6 Luna added the toggle and four tests for it; Fable wrote the migration and tested it against the previous schema. Everything passes." },
    ],
  }, {
    // …and the two sub-agents it starts, each a turn long enough to be watched working, one of them
    // stopping on a permission so the tab has a "Needs you" to show.
    on: "Build the dark-mode toggle", emit: [
      { kind: "text", paceMs: 260, text: "Reading the settings page first, then the theme hook the toggle should call." },
      { kind: "tool", name: "Read", input: { file_path: "apps/desktop/src/renderer/src/panes/settings/AppSettings.tsx" }, result: "export function AppSettings() { … }" },
      { kind: "tool", name: "Edit", input: { file_path: "apps/desktop/src/renderer/src/panes/settings/AppSettings.tsx", old_string: "<ThemePicker />", new_string: "<ThemePicker />\n<DarkModeToggle />" }, result: "Edited" },
      { kind: "tool", name: "Bash", needsPermission: true, input: { command: "pnpm vitest run settings" }, result: "Tests  4 passed (4)" },
      { kind: "text", paceMs: 90, text: "Added the dark-mode toggle to Settings ▸ App, wired to the theme hook, with four tests. All four pass." },
    ],
  }, {
    on: "Write the migration that stores", emit: [
      { kind: "text", paceMs: 320, text: "The choice needs a column of its own, so this is an append-only migration with a fixture test." },
      { kind: "tool", name: "Write", input: { file_path: "apps/server/src/db/migrations.ts", content: "ALTER TABLE spaces ADD COLUMN theme TEXT;" }, result: "Written" },
      { kind: "tool", name: "Bash", input: { command: "pnpm vitest run migrations" }, result: "Tests  12 passed (12)" },
      { kind: "text", paceMs: 110, text: "Wrote the migration and tested it against a fixture of the previous schema. All twelve migration tests pass." },
    ],
  }, {
    // Only the main session orchestrates: a lead hands one task to a sub-agent whose script tries to
    // start a sub-agent of its own, through its own gateway, and is refused there.
    on: "Nest a sub-agent", emit: [
      { kind: "call", tool: "realm-agent__agent_start", input: { goal: "Try to start another agent for the copy pass" } },
      { kind: "call", tool: "realm-agent__agent_wait", input: {} },
      { kind: "text", text: "The sub-agent did the copy pass itself." },
    ],
  }, {
    on: "Try to start another agent", emit: [
      { kind: "call", tool: "realm-agent__agent_start", input: { goal: "Do the copy pass" } },
      { kind: "text", text: "I can't start a sub-agent from here, so I did the copy pass myself." },
    ],
  }, {
    // The Agents tab as an orchestrator: four sub-agents at once, in every state it draws — one asks
    // for a permission, one asks a question, one works for a while, one is done in seconds.
    on: "Orchestrate the theme work", emit: [
      { kind: "text", paceMs: 40, text: "Four parts that do not depend on each other, so four sub-agents." },
      { kind: "call", tool: "realm-agent__agent_start", input: { goal: "Run the settings test suite and report what fails", constraints: { model: "GPT-6 Luna" } } },
      { kind: "call", tool: "realm-agent__agent_start", input: { goal: "Choose the default theme for new users" } },
      { kind: "call", tool: "realm-agent__agent_start", input: { goal: "Survey every theme hook across the renderer", constraints: { model: "Fable" } } },
      { kind: "call", tool: "realm-agent__agent_start", input: { goal: "Tidy the Settings copy for the theme row" } },
      { kind: "call", tool: "realm-agent__agent_wait", input: {} },
      { kind: "text", paceMs: 30, text: "All four sub-agents reported back." },
    ],
  }, {
    on: "Run the settings test suite", emit: [
      { kind: "tool", name: "Bash", needsPermission: true, input: { command: "pnpm vitest run settings" }, result: "Tests  18 passed (18)" },
      { kind: "text", text: "All eighteen settings tests pass." },
    ],
  }, {
    on: "Choose the default theme", emit: [
      { kind: "tool", name: "AskUserQuestion", needsPermission: true, result: "Answered", input: { questions: [{ question: "Which theme should new users start in?", header: "Theme",
        multiSelect: false, options: [{ label: "System", description: "Follow the Mac" }, { label: "Dark" }, { label: "Light" }] }] } },
      { kind: "text", text: "New users start in the theme you picked." },
    ],
  }, {
    on: "Survey every theme hook", emit: [
      { kind: "tool", name: "Read", input: { file_path: "apps/desktop/src/renderer/src/theme/use-theme.ts" }, result: "export function useTheme() { … }" },
      { kind: "text", paceMs: 900, text: "Reading each pane that reads the theme: the session pane, the browser pane, the documents pane, the settings page, the sidebar, the composer, the terminal, the simulator frame, the code review page, the media viewer, and the quick chat window, noting which ones read the token directly and which go through the hook, so the switch can reach all of them in one place without a reload." },
      { kind: "text", text: "Eleven surfaces read the theme; three bypass the hook." },
    ],
  }, {
    on: "Tidy the Settings copy", emit: [
      { kind: "tool", name: "Edit", input: { file_path: "apps/desktop/src/renderer/src/panes/settings/AppSettings.tsx", old_string: "Colour scheme", new_string: "Theme" }, result: "Edited" },
      { kind: "text", text: "Renamed the row to Theme and shortened its note." },
    ],
  }, {
    // A lead that names nothing, opening its goal with a role the way leads do: the child is named
    // by its task read out of the goal (`taskName`), never by the role.
    on: "Hand it over unnamed", emit: [
      { kind: "call", tool: "realm-agent__agent_start", input: { goal: "You are implementing a feature in the settings page. Add the font-size picker; keep it beside the theme in Settings ▸ App." } },
      { kind: "call", tool: "realm-agent__agent_wait", input: {} },
      { kind: "text", text: "The font-size picker is in." },
    ],
  }, {
    on: "Add the font-size picker", emit: [{ kind: "text", paceMs: 40, text: "Added the font-size picker beside the theme." }],
  }, {
    // An app mention gives the session computer use for that app alone. The scripted agent reaches
    // for it as a real one would — a real call through its gateway, so the scoped grant is the
    // production path — and only to LIST what is running: it clicks nothing, ever.
    on: "what is open in", emit: [
      { kind: "text", text: "Checking what is running, through the computer use that mention gave this session." },
      { kind: "call", tool: "realm-computer__computer_list_apps", input: {} },
    ],
  }, { on: "plan", emit: [
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
    // The question card, for the same reason as the plan card: it renders for one tool only, and the
    // three shapes a question can take are not reachable from a real agent on demand. One card,
    // paged: options with free text, options without it, and a free-text answer meant to stay unread.
    on: "ask me", emit: [{ kind: "tool", name: "AskUserQuestion", needsPermission: true, result: "Answered", input: { questions: [
      { question: "Which database should this use?", header: "Database", multiSelect: false,
        options: [{ label: "Postgres", description: "Relational, boring, correct" }, { label: "SQLite", description: "Local, zero-ops" }] },
      { question: "Which region should it deploy to?", header: "Region", multiSelect: false, allowOther: false,
        options: [{ label: "us-east-1" }, { label: "eu-west-1" }] },
      { question: "Paste the deploy token.", header: "Token", multiSelect: false, secret: true, options: [] },
    ] } }],
  }, {
    // `realm-ui`'s card, called for real through this session's gateway the way an agent calls it. The
    // fields only Realm can fill have nothing else to pose for: pictures resolved in the workspace (the
    // live check writes `mockups/*.png` into the space's folder), a model per plan step from the
    // catalog, and a file, a branch, a time and a masked token in one card.
    on: "ask with pictures", emit: [{ kind: "call", tool: "realm-ui__ui_ask", input: { questions: [
      { id: "look", prompt: "Which look should the settings page take?", header: "Design", kind: "choice", options: [
        { label: "Calm", description: "Hairlines and quiet ink", image: "mockups/calm.png" },
        { label: "Bold", description: "Big type, strong contrast", image: "mockups/bold.png" },
        { label: "Dense", description: "Everything on one screen", image: "mockups/dense.png" }] },
      { id: "extras", prompt: "What should ship with it?", header: "Scope", kind: "multi", options: [
        { label: "Keyboard shortcuts" }, { label: "A preview of the dark face" }, { label: "Export settings" }] },
    ] } }],
  }, {
    on: "ask who builds", emit: [
      { kind: "text", text: "The plan has three steps. Pick who builds each one, and I'll start the sub-agents on those models." },
      { kind: "call", tool: "realm-ui__ui_ask", input: { questions: [{ id: "builders", prompt: "Who builds each step?", header: "Plan", kind: "model",
        rows: ["Write the migration that stores the theme", "Add the toggle to Settings ▸ App", "Write the tests for both"] }] } },
    ],
  }, {
    on: "ask about the release", emit: [{ kind: "call", tool: "realm-ui__ui_ask", input: { message: "A few things before I cut the release.", questions: [
      { id: "changelog", prompt: "Which file holds the changelog?", kind: "file" },
      { id: "base", prompt: "Which branch should the release go on?", kind: "branch" },
      { id: "when", prompt: "When should it go out?", kind: "time" },
      { id: "token", prompt: "Paste the deploy token.", header: "Token", kind: "text", secret: true },
    ] } }],
  }, {
    // An MCP server's own questions, asked mid-call through the hub: the live check connects
    // `mcp/fixtures/elicit-stdio.mjs` as a Connection named "Linear", whose tools ask with a form, a
    // page to open, and a form asking for a key that Realm must decline.
    on: "file the Linear issue", emit: [{ kind: "call", tool: "Linear__create_issue", input: { title: "Dark mode toggle" } }],
  }, {
    on: "connect Linear", emit: [{ kind: "call", tool: "Linear__connect_workspace", input: {} }],
  }, {
    on: "set the Linear key", emit: [{ kind: "call", tool: "Linear__set_api_key", input: {} }],
  }, {
    // MCP Apps: the views fixture (`mcp/fixtures/apps-stdio.mjs`) connected as "Charts". A chart the
    // server draws in a view of its own, a view that tries its own sandbox, and a tool with no view.
    on: "chart the bundle sizes", emit: [
      { kind: "text", text: "Here are the bundle sizes for the last six releases." },
      { kind: "call", tool: "Charts__show_chart", input: { title: "Bundle size by release", unit: "KB", labels: ["1.2", "1.3", "1.4", "1.5", "1.6", "2.0"], values: [412, 438, 451, 497, 523, 488] } },
      { kind: "text", text: "2.0 is the first release in a year to come in smaller than the one before it." },
    ],
  }, {
    on: "probe the view sandbox", emit: [{ kind: "call", tool: "Charts__probe_sandbox", input: {} }],
  }, {
    on: "add the numbers", emit: [{ kind: "call", tool: "Charts__plain_sum", input: { values: [412, 438, 451] } }],
  }, {
    // The fallback, which is the half of the gate worth being able to see: a question offering
    // neither an option nor free text cannot be answered, so it must arrive as an ordinary
    // permission rather than as a card with no row on it.
    on: "unanswerable", emit: [{ kind: "tool", name: "AskUserQuestion", needsPermission: true, result: "Answered",
      input: { questions: [{ question: "Unanswerable?", header: "None", multiSelect: false, allowOther: false, options: [] }] } }],
  }, {
    // Its milder sibling, for the retry line: a dropped socket, which never moves the session.
    on: "drop the socket", emit: [{ kind: "throw", message: "read ECONNRESET" }],
  }, {
    // A permission the agent HOLDS open. `needsPermission` blocks the adapter until a decision
    // arrives, which makes this the only state a fake session can be parked in and looked at:
    // everything else this agent reaches settles in milliseconds, and a failed spawn ends the
    // session rather than failing it. The surfaces that need a session stopped mid-air — the
    // permission card, the sidebar's blocked mark, Needs you — have nothing else to pose for.
    on: "ask me", emit: [{ kind: "tool", name: "Bash", input: { command: "rm -rf build" }, needsPermission: true, result: "removed" }],
  }, {
    // A question on the permission channel, held open the same way. Claude asks through
    // `AskUserQuestion`, which Realm draws as the question it is — options and a field for an answer
    // of your own — rather than as Allow / Deny, and nothing else this agent says can pose one.
    on: "ask a question", emit: [{ kind: "tool", name: "AskUserQuestion", needsPermission: true, result: "answered", input: { questions: [{
      question: "Which branch should this go on?", header: "Base", multiSelect: false,
      options: [{ label: "main", description: "What ships next" }, { label: "integration/v0.6", description: "The release line" }] }] } }],
  }, {
    // An answer that streams at a real agent's pace, a word at a time. Everything above lands in one
    // burst, and the prose's arrival fade has nothing to show on a message that arrives all at once.
    on: "stream slowly", emit: [{ kind: "text", paceMs: 45, text: "The mapper reads each **SDK message** once and hands back Realm's own events, so nothing downstream ever sees the wire.\n\n"
      + "Three things change in this pass:\n\n1. Plans travel as their own event.\n2. A revision replaces the card in place.\n3. `apps/server/src/sessions/service.ts` persists both.\n\n"
      + "Nothing else moves, and the transcript you already have reads exactly as it did." }],
  },
  // The chart, diagram and comparison blocks an agent writes, which nothing else here can draw.
  ...FAKE_BLOCK_SCRIPT, {
    // A turn held mid-flight for well over a minute, a word every two seconds. Everything above
    // settles in a burst or a few seconds, and the surfaces that show a session WORKING — its row's
    // mark, here or in another room — have nothing else to pose for long enough to be measured.
    on: "keep working", emit: [{ kind: "text", paceMs: 2000, text: "Reading the mapper first, then the reducer that folds its events, then every place the "
      + "sidebar draws a session, so the marks agree wherever a session is shown. After that the tests for each, one "
      + "at a time, and the live check last, because it is the only one that can see the paint." }],
  }, {
    // A turn that really edits a checkout, so the surfaces that exist only for one — the turn's
    // checkpoint and its measurement, the "Edited N files" card, Review, Undo, a file named in the
    // prose — have something true to show. The edits land in the session's own directory and expect
    // the two files `transcript-live.mjs` seeds there; anywhere else they fail, as a real edit would.
    on: "fix the org access", emit: [
      { kind: "tool", name: "Read", input: { file_path: "web/lib/orgs.ts" }, result: "export async function getOrgMembership(…)" },
      { kind: "tool", name: "Edit", apply: true, result: "The file web/lib/orgs.ts has been updated.", input: { file_path: "web/lib/orgs.ts",
        old_string: "  const rows = await db.select().from(organizationMember)\n    .where(and(eq(organizationMember.organizationId, orgId), eq(organizationMember.userId, userId)));\n",
        new_string: "  // Only the stable columns access checks read. The invite metadata beside them\n"
          + "  // drifts between environments, and selecting it is what crashed the layout.\n"
          + "  const rows = await db\n    .select({\n      id: organizationMember.id,\n      organizationId: organizationMember.organizationId,\n"
          + "      userId: organizationMember.userId,\n      role: organizationMember.role,\n    })\n    .from(organizationMember)\n"
          + "    .where(and(\n      eq(organizationMember.organizationId, orgId),\n      eq(organizationMember.userId, userId),\n    ));\n"
          + "  // The invite fields are filled in memory, where an older row cannot crash the read.\n"
          + "  for (const row of rows) withInviteDefaults(row);\n  if (rows.length === 0) return null;\n" } },
      { kind: "tool", name: "Edit", apply: true, result: "The file has been updated.", input: { file_path: "web/lib/agent/chat-runtime/compaction/auto-compact.ts",
        old_string: "export function shouldCompact(tokens: number, limit: number) {\n",
        new_string: "export function shouldCompact(tokens: number, limit: number): boolean {\n  // Kept total for the tests that pass a zero limit.\n  if (limit <= 0) return false;\n" } },
      { kind: "tool", name: "Bash", input: { command: "npx tsc --noEmit --pretty false" }, result: "" },
      { kind: "text", paceMs: 20, text: "Fixed the org access crash path.\n\n"
        + "The important change is in web/lib/orgs.ts (line 83): `getOrgMembership()` now selects only the stable fields it actually needs for access checks: `id`, `organizationId`, `userId`, and `role`. "
        + "It then normalizes the unused invite metadata fields in memory. That avoids the layout crashing on environments where `organization_member` invite columns are out of sync or otherwise fragile.\n\n"
        + "I also kept the earlier compaction helper type-compatible with its tests in `auto-compact.ts:67`, since full TypeScript caught that while verifying.\n\n"
        + "Verified:\n\n- Reproduced `getOrgMembership()` / `canAccessProject()` with the exact org, user, and project IDs from your error: passes\n"
        + "- `npx eslint lib/orgs.ts lib/agent/chat-runtime/compaction/auto-compact.ts --max-warnings=0`: passes\n"
        + "- `npx tsc --noEmit --pretty false`: passes\n- `npm run build`: passes" },
    ],
  }, {
    // A task scheduled from a conversation, through `realm-schedule` and the gateway the way a real
    // agent reaches it. Nothing else this agent says calls a Realm tool, and a task that only ever
    // came from the modal would never show whether the two paths land as one row.
    on: "schedule the weekly review", emit: [
      { kind: "call", tool: "realm-schedule__schedule_create", input: { title: "Weekly review", cron: "0 16 * * 5",
        goal: "Look back over this week in this space: list its sessions with agent_peers and its commits with git log, then write a short status update — what shipped, what is in progress, what is blocked." } },
      { kind: "text", text: "Done — \"Weekly review\" runs every Friday at 4:00 PM, starting this week." },
    ],
  }, {
    // A fact saved to the profile's memory repo through `realm-memory`, as an agent in any engine
    // saves one — so the memory row's last commit and its Recent memories have a real one to show.
    on: "remember I prefer tabs", emit: [
      { kind: "call", tool: "realm-memory__memory_save", input: { entry: "Prefers tabs over spaces" } },
      { kind: "text", text: "Saved to your memory repo: you prefer tabs over spaces." },
    ],
  }, {
    // A turn that leaves files behind — a note and a script written, the README edited — so the
    // documents pane beside the session has its own files to list. The tool calls are what the
    // Library's index records; the paths are relative, as an agent names files in its own checkout.
    on: "Draft the launch notes", emit: [
      { kind: "text", paceMs: 30, text: "I'll put the launch plan in a note, and sketch the greeting as a script." },
      { kind: "tool", name: "Write", input: { file_path: "notes/launch-plan.md", content: "# Launch plan\n\n- Friday: pricing page goes live\n- Monday: the announcement\n" }, result: "File created successfully at: notes/launch-plan.md" },
      { kind: "tool", name: "Write", input: { file_path: "scripts/greet.ts", content: "export function greet(name: string): string {\n  return `Welcome to the launch, ${name}.`;\n}\n" }, result: "File created successfully at: scripts/greet.ts" },
      { kind: "tool", name: "Edit", input: { file_path: "README.md", old_string: "# yooo\n", new_string: "# yooo\n\nLaunching on Friday.\n" }, result: "The file README.md has been updated." },
      { kind: "text", paceMs: 30, text: "Wrote the launch plan and the greeting script, and put the launch date in the README." },
    ],
  }, {
    // A change asked for from the media viewer's prompter: a command that writes the new version — a
    // Bash call, which the Library's index cannot see — and an answer naming it, which is what the
    // viewer finds and puts on its stage. The fake runs nothing, so a live check puts the file there.
    on: "Make the sky warmer", emit: [
      { kind: "tool", name: "Bash", input: { command: "magick hero.png -modulate 100,112,94 hero-warm.png", description: "Warm the sky" }, result: "" },
      { kind: "text", paceMs: 30, text: "Warmed the sky and left the ridge as it was. The new version is `hero-warm.png`, beside the original." },
    ],
  }, {
    // A deck composed into ANOTHER space's folder by a shell command, the way the Versed slideshow was
    // made: no write tool names a slide, so only the settle's sweep (sessions/turn-media.ts) finds it.
    // Held on its permission, so a live check can put the slide on disk while the turn is open.
    on: "Compose the deck", emit: [
      { kind: "tool", name: "Bash", input: { command: "cd ../versed/content/decks && node compose.mjs deck v1", description: "Compose the slides" }, needsPermission: true, result: "deck/v1/01.png 1080x1920" },
      { kind: "text", paceMs: 30, text: "Composed the first slide of the deck." },
    ],
  }] });
  /* The fake behind real agents' NAMES, for a live check that has to show work handed across
     harnesses — a sub-agent on the real Codex would be a billed turn. Named kinds only, and only with
     the fake on: each probes as that harness with a scripted catalog and runs the script above. */
  if (process.env.REALM_ENABLE_FAKE_AGENT === "1" && reg.fake) {
    const catalogs: Partial<Record<AgentKind, { id: string; label: string }[] | null>> = {
      claude: null,
      codex: [{ id: "gpt-6-luna", label: "GPT-6 Luna" }, { id: "gpt-6-astra", label: "GPT-6 Astra" }, { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
    };
    for (const kind of (process.env.REALM_FAKE_STANDS_IN ?? "").split(",").map((k) => k.trim()) as AgentKind[]) {
      if (kind in catalogs) reg[kind] = fakeStandIn(reg.fake as FakeAdapter, kind, catalogs[kind] ?? null);
    }
  }
  return reg;
}

/** `claudeDir` overrides where MemoryService reads user-level Claude files (`~/.claude` otherwise) —
 *  for tests and live checks, which must never depend on (or expose) the real user's memory files.
 *  `userHome` and `codexHome` are the same seam for SkillsService's user-level skill directories.
 *  Both default to `home`, so a test or live check that does not name them scans its own scratch
 *  home and never the machine's — `main.ts` is the only caller that passes the real one. */
export async function createApp(opts: { home: string; port: number; adapters?: AdapterRegistry; claudeDir?: string; userHome?: string; codexHome?: string;
  /** Called when a drain is accepted, so the caller can record it outside this process — `main.ts`
   *  rewrites the state file, which is what makes a mid-drain launcher wait rather than adopt. */
  onDraining?: () => void;
  /** Where a memory repo goes when Realm's home is inside a space's folder. Unset, it is the app's
   *  Application Support folder under `userHome` — and nowhere at all when no `userHome` is named. */
  memoryFallbackRoot?: string;
  /** Teams Phase 3 test knobs: the platform every channel acts on, and main's answer about a press.
   *  Production passes neither — the platform is the fake only under REALM_FAKE_ACT_ADAPTER=1 (live
   *  checks), not connected otherwise, and a press is asked of Electron main over the bridge. */
  acts?: { adapter?: ActAdapter; presses?: { consume(ticketId: string, contentHash: string): Promise<TicketPress> } };
  /** The RPC token every client must offer as its `realm.<token>` subprotocol. Undefined leaves the
   *  socket open to anything on loopback, which is what the suite's several hundred `createApp` calls
   *  want — production mints one in `main.ts` and writes it to the 0600 state file. */
  token?: string;
  /** W5 test/live-check knobs for the browser-agent registry: `fallbackKind` (default claude) is the
   *  child agent when the parent's kind has no skills-injection route; `timeouts` shrinks the settle
   *  budget so suites don't wait minutes. Production callers pass neither. */
  browserAgent?: { fallbackKind?: import("@realm/contracts").AgentKind; timeouts?: { baseMs: number; perActMs: number; pollMs: number } };
  /** The lab's probes of this Mac, replaced in tests so a suite never reads the machine it runs on. */
  lab?: { probe?: () => Promise<import("@realm/contracts").LabCheck[]>; hostName?: () => Promise<string | null>; now?: () => number };
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
  /** The Code Review page's `gh`: the command to run, and the reviewer's settle budget. Only
   *  `main.ts` names the real one; left out, the page reads "not installed" and nothing is spawned —
   *  which is what keeps every suite that builds an app away from GitHub. A live check passes a fake. */
  codeReview?: { gh?: string; timeouts?: { budgetMs: number; pollMs: number } };
  /** CLI manager knobs, injected for the same reason `titleGenerator` is omitted: a suite must never
   *  reach a package registry, and it must read a PATH the test built rather than the developer's own
   *  machine. Production callers pass neither and get the process environment and real fetch. */
  cli?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; spawnImpl?: typeof import("node:child_process").spawn };
  /** The simulator service's CLI seams, for a suite whose simulator tools must reach a device list or
   *  a stream without the developer's own Xcode — and the input socket, so a tap in a suite is
   *  recorded rather than sent to whatever serve-sim this Mac is running. Production callers pass
   *  none and get the real `xcrun simctl`, `serve-sim`, adb and socket. */
  simulator?: Pick<import("./simulators/service").SimulatorServiceDeps, "simctl" | "serveSim" | "android" | "inputChannel" | "physical">;
  /** Real iPhones and iPads — devicectl, usbmuxd and Realm's test runner (`simulators/physical.ts`).
   *  Only `main.ts` passes it: every other `createApp` is a test or a script, and nothing but the real
   *  server may list a phone, build for one or run anything on it. `onExit` is how a runner that
   *  stopped by itself reaches the panes showing it; `onPicture`, how a phone's picture turning into
   *  live video or back into screenshots does. */
  physicalDevices?: (
    onExit: (udid: string, error: import("./simulators/device-runner").RunnerError) => void,
    onPicture: (udid: string, stills: import("./simulators/phone-video").VideoStop | null) => void,
  ) => import("./simulators/service").SimulatorServiceDeps["physical"];
  /** Whether this Mac can run a simulator — the answer behind the simulator tools, the preamble's
   *  paragraph about them and their settings row. `main.ts` passes the real probe
   *  (`toolchainAvailable`); left out, nothing is probed and the answer stays "not known", so a suite
   *  of apps spawns no `xcrun` and behaves the same with or without Xcode. A test that needs an
   *  answer passes one. */
  simulatorToolchain?: () => Promise<boolean>;
  /** Upgrades a session's heuristic first-line title to a short model-written summary in the
   *  background (`SessionService.upgradeTitle`). A real, billed LLM call per session — omitted here
   *  on purpose so tests and live-check scripts never make one; the real server process (`main.ts`)
   *  passes `generateSessionTitle`. */
  titleGenerator?: (text: string) => Promise<string>;
  /** Writes the model's account of a session when a turn settles. A real, billed LLM call per settled
   *  turn — omitted here on purpose so tests and live-check scripts never make one; the real server
   *  process (`main.ts`) passes `generateSessionSummary`. Without it the panes show the derived line,
   *  which is exactly what they showed before this existed. */
  /** One call answering BOTH of a settle's model-written fields — the summary and the prompter's
   *  hint. Omitted on any build that must not make a billed call: without it the panes show the
   *  derived line and the prompter keeps its deterministic ladder. */
  summaryGenerator?: (input: { asked: string; transcript: string; facts: string })
    => Promise<{ summary: string; hint: string | null }>;
  /** Plan 22: where Plynn's meeting exports are read from. Tests point this at a fixture; production
   *  leaves it unset for `~/Library/Application Support/Plynn/Meetings`. */
  plynnMeetingsDir?: string;
  /** The machine half of Laya — interpreter search, the venv and its install, the `laya-serve`
   *  process. `main.ts` passes the real one (`realLayaRuntime`); left out, the service reports Laya
   *  unavailable and nothing is ever looked for, installed or spawned — so no app a test builds runs
   *  Python. A test that needs a runtime hands in a fake. */
  laya?: LayaRuntime;
  /** The Mac's memory pressure and free disk as a training run reads them (`machineState`); left
   *  out, the real ones. A test hands in a Mac short of memory. */
  layaMachine?: () => Promise<import("./laya/training").MachineState>;
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
  sessionsStore.catchUpReadMarksOnce(settings);
  /* The Seatbelt policy an agent CLI or a shell is spawned under — one instance, shared by the two
     spawn sites (TerminalService and SessionService) so they can never resolve a space differently.
     `realmHome` is passed rather than derived: this process's REALM_HOME and `opts.home` are the same
     directory in production, and a test on a scratch home must protect ITS database, not the real one. */
  const sandbox = new ExecutionSandboxService({ settings, environments, realmHome: opts.home });
  // The notifications feed (Plan 12 W5): the ONE writer of notification rows. Every producer below —
  // SessionService's event hook, the hub's onStatus callback, the two stale-ack refusal sites — hands
  // its events here rather than writing rows of its own, so the dedup rule and the category toggles
  // have exactly one home.
  // The relay reads its destinations from settings at send time; wired with the real transport
  // here and nowhere else, so every test and live-check script sends nothing off the machine.
  const notifications = new NotificationsService({ store: new NotificationsStore(db), settings, rpc,
    // Space names for the relay line: with no window anywhere, that line is all a person gets, and a
    // session title alone does not say which space to open.
    spaces: { get: (id: string) => spaces.get(id) },
    sessions: { get: (id: string) => sessionsStore.get(id) ?? null },
    relay: new NotificationRelay({ settings, transport: realTransport, log: (line) => console.error(line) }) });
  // `isEnvironmentBusy` is a late-bound closure rather than a constructor argument because the two
  // services genuinely need each other: SessionService checkpoints every turn, and CheckpointService
  // must refuse to restore under a live agent. One direction is the dependency; the other is this.
  let sessionService: SessionService | null = null;
  const checkpointGit = new CheckpointGit();
  const checkpoints = new CheckpointService({
    checkpoints: new CheckpointsStore(db), environments, sessions: sessionsStore, git: checkpointGit,
    isEnvironmentBusy: (id) => sessionService?.isEnvironmentBusy(id) ?? false,
    // The conversation half of a restore. The same late-bound closure as above, and the same knot:
    // SessionService owns the transcript, the live handles and the arm the next start reads.
    rewindSession: (input) => sessionService?.rewindConversation(input) ?? false,
    // …and the stop a rewind needs first: the fork is honoured when the agent next starts.
    releaseSession: async (id) => { await sessionService?.stopAgent(id); },
    notifications,
  });
  const envService = new EnvironmentService({ environments, spaces, worktrees, ports, checkpoints, notifications });
  // Hoisted out of the service's argument list: the `realm-terminal` provider lists a space's
  // terminals from the same store the service writes them to, and two stores over one table would
  // be two answers to "what terminals are there".
  const terminalsStore = new TerminalsStore(db);
  const terminals = new TerminalService({ db, rpc, spaces, items, terminals: terminalsStore, environments, history: new TerminalHistoryStore(db), settings, sandbox });
  // A space's named shell commands. Runs go through TerminalService, which is also where each run
  // picks up its environment's port block (envFor → portEnv) — nothing here duplicates that.
  const scripts = new ScriptService({
    settings, terminals, items,
    spaces: { folderPathOf: (spaceId: string): string | null => spaces.get(spaceId)?.folderPath ?? null },
  });
  const browsersStore = new BrowsersStore(db);
  const browsers = new BrowserService({ db, rpc, spaces, items, browsers: browsersStore, history: new BrowserHistoryStore(db) });

  /* Machines (Plan 25 W3). The proxy and the service are mutually late-bound: the proxy asks the
     service for an address at CONNECT time — never a cached one, so an edited machine cannot be
     reconnected to at its old address — and the service is where the proxy's callbacks land. */
  const machinesStore = new MachinesStore(db);
  const simulatorsStore = new SimulatorsStore(db);
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
  /* An Apple Simulator in a pane. Nothing is constructed for it beyond this: the pixels come from
     `serve-sim` over loopback and the renderer reads them itself, so there is no proxy, no port and
     no driver — the three things `MachineService` above needs a page of wiring for. */
  let simulatorsLate: SimulatorService | null = null;
  const physicalDevices = opts.physicalDevices?.(
    (udid, error) => simulatorsLate?.runnerStopped(udid, error),
    (udid, stills) => simulatorsLate?.pictureChanged(udid, stills),
  ) ?? opts.simulator?.physical;
  const simulators = new SimulatorService({ rpc, spaces, items, simulators: simulatorsStore, ...opts.simulator, physical: physicalDevices });
  simulatorsLate = simulators;
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
    home: opts.home, userHome: opts.userHome, codexHome: opts.codexHome, settings, scopes: scopeSeam,
    // The space's own folder, for its project-level skill directories. A space whose folder is gone
    // reads as project-less rather than failing the scan — the rest of the roots are still valid.
    spaces: { folderPathOf: (spaceId: string): string | null => spaces.get(spaceId)?.folderPath ?? null },
  });
  // User-defined slash commands: `<space folder>/commands`, `<REALM_HOME>/commands`, and (read-only)
  // `~/.claude/commands`. Same `spaces` seam and same `claudeDir` override the skills and memory
  // services take, so a test can point all three at one fixture.
  const userCommands = new UserCommandsService({
    home: opts.home, claudeDir: opts.claudeDir,
    spaces: { folderPathOf: (spaceId: string): string | null => spaces.get(spaceId)?.folderPath ?? null },
  });
  // The user's keymap, as a file under ~/Realm. Seeded and merged on read; see the service for why a
  // malformed file is reported rather than thrown and never rewritten.
  const keybindings = new KeybindingsService({ home: opts.home, onLog: (line) => console.error(line) });
  // Imported VS Code themes, as files under ~/Realm/themes.
  const themes = new ThemesService({ home: opts.home });
  // Google Fonts, downloaded once into ~/Realm/fonts.
  const fonts = new FontsService({ home: opts.home });

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
  // A server's question mid-call goes to the broker's card, which is built further down; nothing asks
  // before a session has made a call, by which point it exists.
  let hubElicit: HubElicit | null = null;
  const mcpHub = new McpHub({
    servers: mcpServersStore,
    elicit: (r) => (hubElicit ? hubElicit(r) : Promise.resolve({ action: "decline" as const })),
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
  let codeReview: CodeReviewService | null = null;
  // Declared here and built after `modelCatalog` (which it prices with), then read back through the
  // session-event hook below — the same forward-reference `runs` takes, for the same reason.
  let usage: UsageService | null = null;
  let runs: RunService | null = null;
  // Declared alongside `runs` and for the same reason: `close()` below runs on a boot that may have
  // failed before this was constructed, so the handle has to exist as null from the top.
  let schedules: ScheduleService | null = null;
  // Teams: read back through the session-event hook and the run seams below, like `runs`.
  let team: TeamService | null = null;
  let acts: ActService | null = null;
  /* The team vault (team/vault/service.ts): made beside the team below, and read lazily by the browser
     tools — a role's sign-in fill passes its grant check — which are registered before either exists. */
  let vault: VaultService | null = null;
  // Teams, Phase 4: handoffs, mentions, role goals and the back-off — read through the same hooks.
  let handoffs: HandoffService | null = null;
  // The lab's update window holds team runs while an update waits to install (lab/service.ts).
  let lab: LabService | null = null;
  // Plan 16 W3: forked sessions carry ancestor context through the same extraSystemContext seam the
  // delegation children use. Late-bound for the same knot: ForkService needs SessionService.create.
  let forks: ForkService | null = null;
  // Failover (fallbacks + forks): built after `sessions`, because it drives it — so the session
  // service takes it as a late-bound hook object, the same knot `notifications` and `browserAgents`
  // are tied with.
  let failover: FailoverService | null = null;
  // MCP Apps: the views servers draw for tool calls. The gateway reports a call that drew one, the
  // session service pairs it with the agent's own record of the call, and the views listener frames
  // it — each mounted view on an origin of its own.
  const appViews = new AppViews({ store: new AppViewsStore(db) });
  const appViewServer = new AppViewServer();
  const mcpGateway = new McpGateway({ hub: mcpHub, mcp, sessions: sessionsStore, calls: mcpCalls, rpc, servers: mcpServersStore, onOauthCallback: (url) => oauth.handleCallback(url), views: appViews,
    // The live check shortens the heartbeat to watch several go by in one scripted wait; nothing
    // else sets it.
    heartbeatMs: heartbeatOverride(),
    // A browser-agent child is only-mode (realm-browser and nothing else); an agent_run child — and
    // a reviewer child (W3) — is exclude-mode (the space's FULL surface minus the delegation
    // provider — the gateway half of depth-1: a reviewer sees neither agent tool nor agent_review).
    // A session cannot be two kinds of child: each tool's child record is written by exactly one run.
    sessionToolset: (sessionId) => {
      const only = browserAgents?.sessionToolset(sessionId);
      if (only) return only;
      // A reviewer child, and an agent_run child that has SPENT its depth budget, lose the whole
      // realm-agent provider here. With the production depth of one that is every agent_run child:
      // only the main session orchestrates. One that still has budget (a `maxDepth` override) keeps it and is narrowed
      // to the agent_run family by the provider's own `tools()` — the coarse gateway hammer cannot
      // express "this provider, but only four of its tools", and inventing a shape that could would
      // put per-tool delegation policy in the gateway, which is exactly where it does not belong.
      const spentChild = agentRuns?.isChild(sessionId) && !agentRuns.canDelegate(sessionId);
      return spentChild || reviews?.isChild(sessionId) || codeReview?.isReviewer(sessionId) ? { exclude: [REALM_AGENT_PROVIDER_NAME] } : null;
    },
    // Activity keeps no masked answer: what a session was told in secret is scrubbed from its calls.
    redact: (sessionId, text) => sessionService?.scrubSecrets(sessionId, text) ?? text });
  gateway = mcpGateway;
  /* The profile's memory repo (Agent Memory Repo): what agents write. The memory documents stay the
     user's standing instructions; this is the memory agents save into and read back, through the
     `realm-memory` tools registered further down. A repo may never sit inside a space's checkout, an
     agent's own config folder or Realm's install — the spec's first rule, and W3's read-only one. */
  const userHome = opts.userHome ?? homedir();
  const memoryRepos = new MemoryRepoService({
    home: opts.home, settings, scopes: scopeSeam,
    forbiddenRoots: () => [
      ...spaces.listAll().flatMap((sp) => [sp.folderPath, ...environments.list(sp.id).map((e) => e.path)]).filter((p): p is string => typeof p === "string" && p !== ""),
      ...[".claude", ".codex", ".cursor", ".agents"].map((d) => join(userHome, d)),
      ...((process as { resourcesPath?: string }).resourcesPath ? [(process as { resourcesPath?: string }).resourcesPath!] : []),
    ],
    // Realm's home kept inside a project folder that is also a space (a preview build's, say) would
    // forbid every repo made under it; the app's own Application Support folder is the second place.
    // Only a caller that names the machine's home gets a default there: a test never writes outside its own.
    fallbackRoot: opts.memoryFallbackRoot ?? (opts.userHome ? join(opts.userHome, "Library", "Application Support", "Realm", "memory-repos") : undefined),
    toolsEnabled: (spaceId) => mcp.providerEnabled(spaceId, MEMORY_PROVIDER_NAME),
    committerName: userFirstName,
    // Asked only whether a GitHub remote is private, before sync is turned on; never a test's network.
    gh: ghRunner(opts.codeReview?.gh ?? "gh"),
    // A pull or push settles in the background, after the save that started it has answered.
    onSynced: (o) => memoryRepoChanged(o),
  });
  /** Every space that shows a repo is told it changed: all of a profile's spaces, or the one space. */
  const memoryRepoChanged = (o: RepoOwner): void => {
    for (const spaceId of o.scope === "space" ? [o.id] : spaces.list(o.id).map((sp) => sp.id)) rpc.broadcast("memory.changed", { spaceId });
  };
  const memory = new MemoryService({ home: opts.home, settings, environments, claudeDir: opts.claudeDir, scopes: scopeSeam, repos: memoryRepos });
  // The browser agent surface (Plan 11 W3): the main↔server op bridge, the permission broker, and the
  // `realm-browser` provider on the gateway. The broker's callbacks are late-bound to `sessionService`
  // (the checkpoints knot again): nothing in it runs before a session exists to run it for.
  const computerAllowlist = new ComputerAppAllowlist({ settings });
  /* Computer use a mention gave one session (`@Messages`), for that app and no other. Written by the
     session service when the message is delivered, read by the computer provider on every list and
     call, and gone with the session or the process. */
  const computerGrants = new ComputerSessionGrants();
  /* Laya in shadow: asked about every computer, device and page step, heard by nobody,
     and logged beside what actually happened (docs/superpowers/specs/2026-09-29-laya-local-decisions.md).
     The service owns the runtime and the log; the shadow is the observer the acting tools report to. */
  const layaLog = new DecisionLog({ path: opts.laya?.logPath ?? join(opts.home, "laya", "decisions.jsonl") });
  /* Assist's availability moves without anyone touching the simulator tools — the mode switched, the
     server came up, a checkpoint was evaluated — and it decides whether their `target` field is
     listed, so every change of it is a re-list. */
  let layaAssist: LayaAssist | null = null;
  let assistListed = false;
  /* What Realm ships for Laya (`resources/laya`): the benchmark, the training script and its lexicon,
     and the download's own evaluation — read when no checkpoint trained here is active. */
  const layaResources = bundledLayaDir();
  const layaRuntime = opts.laya ?? null;
  /* Screens kept while a person uses an app on a device — read, never tapped — for Laya to learn
     from (`laya/recorder.ts`). They stay in the home, under laya/recordings. */
  const layaRecorder = new LayaRecorder({
    dir: join(opts.home, "laya", "recordings"),
    read: (simulatorId) => simulators.ax(simulatorId, { patient: true }),
    deviceName: (simulatorId) => simulators.get(simulatorId).name,
    onChange: () => laya.recordingChanged(),
  });
  const laya = new LayaService({
    runtime: layaRuntime, settings, log: layaLog, recorder: layaRecorder,
    publish: (status) => {
      rpc.broadcast("laya.changed", status);
      const listed = layaAssist?.gate().available ?? false;
      if (listed !== assistListed) { assistListed = listed; mcpGateway.notifyToolsChanged(); }
    },
    activeEval: harnessEvalOverride(),
    baseEval: () => (layaRuntime ? readEval(join(layaRuntime.dir, "evals", "convaiinnovations-laya.json")) : null)
      ?? (layaResources ? readEval(join(layaResources, "evals", "convaiinnovations-laya.json")) : null),
    ...(layaRuntime && layaResources
      ? { train: (o: Parameters<typeof trainCheckpoint>[1]) => trainCheckpoint({ runtime: layaRuntime, resources: layaResources, logFiles: () => layaLog.files(), recorded: () => layaRecorder.screens(), machine: opts.layaMachine ?? (() => machineState(layaRuntime.dir)) }, o) }
      : {}),
  });
  layaAssist = createLayaAssist({ laya });
  const layaShadow = new LayaShadow({ laya, log: layaLog, onLogged: () => laya.logged() });
  const browserBridge = new BrowserHostBridge({ rpc });
  /* The consent-page gate for ACTS, and the provenance that can lift it for a sign-in Realm is
     running itself. Off per space by default — see `signin.ts`. */
  const signInTickets = new SignInTickets({ settings });
  const browserBroker = new BrowserPermissionBroker({
    // A missing row degrades to "plan" — the refuse-mutations mode — never to a prompt on a ghost.
    permissionMode: (sessionId) => sessionsStore.get(sessionId)?.permissionMode ?? "plan",
    emit: (sessionId, ev) => {
      sessionService?.emitExternal(sessionId, ev);
      // The shadow reads a card's answer as the `user` label for the step it was raised for.
      layaShadow.permissionEvent(sessionId, ev);
    },
  });
  hubElicit = createHubElicitation({ broker: browserBroker, serverName: (id) => mcpServersStore.get(id)?.name ?? null });
  const artifacts = new ArtifactsStore(db, settings);
  const libraryFiles = new LibraryFilesStore(db, opts.home);
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
        // Wait for the session to actually go quiet. A rapid exchange otherwise pays for a recap per
        // turn, each superseded by the next before anybody reads it.
        debounceMs: RECAP_DEBOUNCE_MS,
        isIdle: (id) => sessionsStore.get(id)?.status === "idle",
      })
    : undefined;
  /* The friend packs. Restored at boot from the words this Realm was given — the packs themselves
     ship sealed, so a Realm nobody has told a word to has nothing to show. */
  const eggs = new EggService({ settings });
  { const opened = eggs.restore(); if (opened > 0) console.log(`[eggs] ${opened} friend pack(s) unlocked`); }
  const planLimits = new PlanLimitsService({ rpc });
  /* Goal mode. Declared before the session service so that service can hold it, and given its own
     seam back — `deliver` goes through `sessions.send`, which is the same door a person's message
     comes through. Late-bound for the reason the machine proxy above is: the two need each other,
     and a goal cannot deliver anything until there is a session service to deliver it. */
  const goals: GoalService = new GoalService({
    rpc, goals: new GoalsStore(db),
    deliver: (sessionId, text, tag) =>
      sessions.send(sessionId, { text, attachments: [], ...(tag === "goal-start" ? {} : { goal: tag === "goal-budget" ? "budget" as const : "continuation" as const }) }),
    queued: (sessionId) => sessions.queuedFor(sessionId).length > 0,
    dropQueued: (sessionId) => sessions.dropGoalTurns(sessionId),
    // A goal started or resumed on a session whose agent connected before it: say the list changed,
    // so the turn that follows is planned against the goal tools' current descriptions.
    notifyTools: (sessionId) => mcpGateway.refreshTools(sessionId),
    // The continuation names `update_goal` as THIS agent lists it, or teaches the `GOAL COMPLETE:`
    // line when the session cannot reach the tool at all (its space switched `realm-goal` off).
    closeWith: (sessionId) => {
      const s = sessionsStore.get(sessionId);
      return s && mcpGateway.realmProvidersFor(sessionId, s.spaceId).includes(GOAL_PROVIDER_NAME) ? goalToolWireName(s.agentKind) : null;
    },
    log: (line) => console.log(line),
    // A team role's goal run settles when its goal stops, not after its first turn.
    onChanged: (sessionId, goal) => handoffs?.goalChanged(sessionId, goal),
  });
  const sessions = new SessionService({ db, rpc, sessions: sessionsStore, events: sessionEvents, items, spaces, projects, environments, settings, worktrees, ports, terminals, adapters: adapterRegistry, skills, gateway: mcpGateway, memory, checkpoints, sandbox, browserPermissions: browserBroker, computerGrants, titleGenerator: opts.titleGenerator, userHome: opts.userHome, summaries, planLimits, documents, goals, views: appViews,
    // The session-event rail, fanned out: the notifications feed AND the durable-run supervisor read
    // the SAME event off the same hook, so a run settles off exactly the status transition the feed
    // reports rather than off a poll of its own (runs/service.ts).
    notifications: {
      handleSessionEvent: (session, ev) => { notifications.handleSessionEvent(session, ev); runs?.handleSessionEvent(session, ev); usage?.handleSessionEvent(session, ev); team?.handleSessionEvent(session, ev); handoffs?.handleSessionEvent(session, ev); },
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
      release: (id) => { browserAgents?.release(id); agentRuns?.release(id); reviews?.release(id); asks?.release(id); forks?.release(id); runs?.release(id); codeReview?.release(id); },
      extraSystemContext: (id) => browserAgents?.extraSystemContext(id) ?? agentRuns?.extraSystemContext(id) ?? reviews?.extraSystemContext(id) ?? forks?.extraSystemContext(id) ?? runs?.extraSystemContext(id) ?? codeReview?.extraSystemContext(id),
      skillsFilter: (id) => agentRuns?.skillsFilter(id) ?? runs?.skillsFilter(id) ?? null,
      modeSet: async (id, mode) => { await agentRuns?.cascadeMode(id, mode); },
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
    fallbackKind: opts.agentRun?.fallbackKind ?? opts.browserAgent?.fallbackKind, timeouts: opts.agentRun?.timeouts, maxDepth: opts.agentRun?.maxDepth,
    // A model named by a delegating agent resolves against the same probe rows the model picker
    // draws, so "GPT-6 Luna" in a tool call and "GPT-6 Luna" in the picker are the same model.
    models: { known: () => sessions.probeCached(), refresh: () => sessions.probe(), kinds: Object.keys(adapterRegistry) as AgentKind[] } });
  // Children named before they were named by their task wear "Agent: <first line>"; renamed once,
  // here, wherever that string is still exactly what both rows say.
  agentRuns.retitleLegacyChildren();
  browserAgents.retitleLegacyChildren();
  // The reviewer recipe (W3): same engine, read-only cap, review-origin children. `otherDelegation`
  // fans across BOTH sibling registries — no delegated child of any kind may mint a reviewer.
  const agentRunsFinal = agentRuns, browserAgentsFinal = browserAgents;
  reviews = new ReviewService({ settings, sessions, rpc, engine: delegationEngine, environments, notifications,
    otherDelegation: { isChild: (id) => agentRunsFinal.isChild(id) || browserAgentsFinal.isChild(id) },
    fallbackKind: opts.review?.fallbackKind ?? opts.agentRun?.fallbackKind ?? opts.browserAgent?.fallbackKind, timeouts: opts.review?.timeouts });
  /* `realm-simulator`: the simulator pane, as tools. Built here, ahead of the browser provider, because
     the browser tools ask it one question before opening a URL — is this serve-sim's stream of a
     simulator? — and a refusal naming `simulator_open` needs the thing that answers for it. Registered
     further down, beside `realm-vm`, so the settings list keeps the panes that show a screen together. */
  const simulatorTools = createSimulatorAgentProvider({
    mcp, simulators, items, broker: browserBroker, rpc, probe: opts.simulatorToolchain,
    // Laya's shadow hears every tap, swipe, key and keystroke the input tools send, as it hears
    // realm-computer's acts: asked off the step's path, answered to nobody, logged beside what the
    // agent actually did.
    observe: layaShadow.observe,
    assist: layaAssist,
    // A toolchain that turns up (or goes) changes what sessions may list, and what the provider's
    // settings row has to say — both are told rather than left to find out on their next fetch.
    onOfferedChange: () => { mcpGateway.notifyToolsChanged(); rpc.broadcast("mcp.changed", {}); },
  });
  mcpGateway.registerProvider(createBrowserAgentProvider({
    browsers: browsersStore, projects, spaces, browserService: browsers, mcp, bridge: browserBridge, broker: browserBroker, rpc,
    constraints: browserAgents, signIn: signInTickets, simulatorStreams: simulatorTools,
    // Laya's shadow hears every act on a page as it hears the computer's and the simulator's, and a
    // walk asks its Assist for a label nothing matches while — only while — that is open.
    observe: layaShadow.observe, assist: layaAssist,
    // The space folder, for `browser_upload`'s default readable root. Same resolver the documents
    // tools use, so "inside this space" means one thing across the app.
    documents: { rootForSpace: (spaceId) => { try { return documents.rootForSpace(spaceId); } catch { return null; } } },
    // Saved sign-ins are a profile's own: the credential tools name the session's profile to main.
    profileOf: (spaceId) => spaces.get(spaceId)?.profileId ?? null,
    // A team's role fills a sign-in only under a grant, and without its card only under an allow.
    vault: {
      check: (ctx, secret, host) => vault ? vault.check(ctx, secret, host) : Promise.resolve({ unattended: false, roleId: null, runId: null, hosts: null }),
      note: (ctx, use, who) => vault?.note(ctx, use, who),
      grantedSignins: (sessionId) => {
        const owner = vault?.roleOf(sessionId);
        return owner ? vault!.grantsForRole(owner.role.id).filter((g) => g.kind === "signin").map((g) => g.secretId) : null;
      },
    },
  }));
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
  /* The Code Review page's server side: `gh` behind a cache, and the reviewer a person runs from the
     page on the same engine as every other delegated run — read-only, depth-1 (the toolset closure
     above takes the delegation tools off it), and with no path from its findings to a posted review. */
  codeReview = new CodeReviewService({
    gh: opts.codeReview?.gh ? new GhClient(ghRunner(opts.codeReview.gh)) : null,
    settings, rpc, sessions, engine: delegationEngine, spaces, projects, profiles, git: gitCapture, home: opts.home,
    timeouts: opts.codeReview?.timeouts,
  });
  /* `realm-ui`: questions asked on Realm's own card, with fields only Realm can fill. On by default and
     in every mode — it can only ask, and an answer is the user's click. The model field offers what a
     sub-agent can be put on, from the same catalog `delegation.models` answers with. */
  const agentRunsForUi = agentRuns;
  mcpGateway.registerProvider(createUiAgentProvider({
    mcp, broker: browserBroker, session: (id) => sessions.get(id), models: (id) => agentRunsForUi.catalogFor(id), branches: listBranches,
  }));
  // The one provider a space has to switch ON: it reaches every app on the Mac.
  mcpGateway.registerProvider(createComputerAgentProvider({ mcp, bridge: browserBridge, broker: browserBroker, allowlist: computerAllowlist, grants: computerGrants, observe: layaShadow.observe, assist: layaAssist }));
  /* The `realm-terminal` provider: a pty an agent can type into and read back. On by default, and
     the reasoning is the blast radius — every harness already has a shell tool, so this adds no
     ability to run commands that was not there. What it adds is a terminal that TALKS BACK, which is
     the only way to reach an interactive login, and a visible pane instead of a hidden subprocess.
     The narrowings that matter are inside the provider: a password prompt is refused in every mode,
     and a terminal this session did not open prompts even under bypassPermissions. */
  /* The sign-in flow rides on both: a terminal that talks back and a pane to put the consent page
     in. It is handed to the terminal provider rather than the browser one because the terminal is
     where it starts and where the code is typed back. */
  const signInFlow = new SignInFlow({ terminals, browsers, tickets: signInTickets });
  mcpGateway.registerProvider(createTerminalAgentProvider({
    terminals, rows: terminalsStore, items, mcp, broker: browserBroker, rpc, signIn: signInFlow,
  }));
  /* `realm-app`: Realm's own interface, read and pressed. Off until a space asks, on
     `realm-computer`'s reasoning — that one reaches every app on the Mac, this one reaches the
     window the user answers questions in. The refusal that makes it survivable lives in main, where
     the live DOM is (`app-drive.ts`). */
  mcpGateway.registerProvider(createAppUiProvider({ mcp, bridge: browserBridge, broker: browserBroker }));
  // Plan 22 W2: the `realm-docs` provider — search/list/open/progress over the space's own folder.
  // One extractor for the process: PDF text is memoized across every session's searches.
  const extractor = new TextExtractor();
  mcpGateway.registerProvider(createDocsAgentProvider({
    mcp, extractor,
    rootForSpace: (spaceId) => { try { return documents.rootForSpace(spaceId); } catch { return null; } },
    listForSpace: (spaceId, dir) => documents.list(documents.open({ spaceId }).documentsId, dir),
    openPath: (p) => documents.openPath(p),
    progressForSpace: (spaceId, path) => documents.progressRead(documents.open({ spaceId }).documentsId, path),
    readForSpace: async (spaceId, path) => {
      const { rel, abs } = namedInRoot(documents.rootForSpace(spaceId), path);
      const st = await stat(abs).catch(() => null);
      if (!st) throw new Error(`no such file: ${rel}`);
      if (!st.isFile()) throw new Error(`${rel} is not a file`);
      return { path: rel, text: await extractor.text(abs) };
    },
    panesForSpace: (spaceId) => items.list(spaceId).filter((i) => i.kind === "documents" && !i.archived).flatMap((i) => {
      try {
        const ws = documents.get(i.refId);
        return [{ title: i.title, root: documents.rootOfWorkspace(i.refId), openPaths: ws.openPaths, activePath: ws.activePath }];
      } catch { return []; }
    }),
  }));
  // Plan 25 W4, on the same terms: off until a space asks for it, a card per MACHINE rather than per
  // tool, and the card kept in bypassPermissions. Registered here and not conditionally — the
  // gateway's own per-space enablement is what decides whether a session sees the tools.
  const machineAllowlist = new MachineAllowlist({ settings });
  mcpGateway.registerProvider(createMachineAgentProvider({ mcp, machines, broker: browserBroker, allowlist: machineAllowlist, rpc }));
  /* On by default, unlike `realm-vm` above it: a simulator is a device on THIS Mac that the agent's
     own shell can already boot and install onto with `xcrun simctl`, so the tools add no reach — they
     add the pane, which is the point. Whether a session sees them at all is the toolchain's answer
     (`offered`) and the space's switch, like every other provider. */
  mcpGateway.registerProvider(simulatorTools);
  /* Goal mode's two tools, listed on every session and refused on one with no goal running — see
     the provider. Registered after the session service exists because the goal service it wraps
     delivers through it. */
  mcpGateway.registerProvider(createGoalProvider({ goals, mcp }));
  /* `realm-workspace`: what is in the space, what is on screen, what the other sessions here said, and
     the one tool that brings a closed pane back. Read from the stores and the saved view rather than
     the DOM — the app-ui provider's own argument for why clicking is the fragile route. */
  mcpGateway.registerProvider(createWorkspaceProvider({
    mcp, sessions: sessionsStore, events: sessionEvents, items, spaces, profiles, settings, documents, bridge: browserBridge, rpc,
  }, [
    createSessionOpenTools({
      sessions, items, spaces, settings, broker: browserBroker, rpc,
      defaultMode: (kind) => resolveDefaultPermissionMode(kind, settings.get(DEFAULT_PERMISSION_MODE_KEY)),
      placeModel: (caller, model) => agentRunsFinal.placeModel(caller, model),
      delegated: { isChild: (id) => browserAgentsFinal.isChild(id) || agentRunsFinal.isChild(id) || reviewsFinal.isChild(id) },
      turnOf: (id) => sessionEvents.listOfTypes(id, ["user_message"], { limit: 1 })[0]?.seq ?? null,
    }),
    createSpacesTools({ spaces, settings, broker: browserBroker, rpc }),
    createSettingsTools({ settings, broker: browserBroker, rpc }),
  ]));
  /* Any goal that was running when Realm last closed is parked rather than resumed. A desktop app is
     relaunched by someone opening it, sometimes days later and usually to do something else — see
     `parkOnBoot`. */
  { const parked = goals.parkOnBoot(); if (parked > 0) console.log(`[goal] parked ${parked} goal(s) that were running at shutdown`); }
  // The graphify CLI seam (probe + `graphify update`). Only the space's checkout path crosses into
  // it — it never learns what a space or a database is.
  const graphify = new GraphifyService({ rootForSpace: (id) => documents.rootForSpace(id) });
  const lectures = new LectureService({ spaces, documents });
  const plynn = new PlynnService({ spaces, settings, documents, meetingsDir: opts.plynnMeetingsDir });
  // Durable runs: a goal that owns a session across attempts and survives restarts. Not on the
  // delegation engine on purpose — nobody is blocked on a run, so its state is a row and its settle
  // rides the session-event hook above (runs/service.ts).
  runs = new RunService({ store: new RunsStore(db), settings, sessions, rpc, environments: envService, skills, notifications,
    // A run a schedule fired may owe its schedule something once it is over (archiving a success).
    // Read through the variable, which is assigned on the next statement and before any run settles.
    onSettled: (run) => { schedules?.runSettled(run); team?.runSettled(run); },
    // A team role's run waits for a slot, wears its role's preamble, and arms its minutes cap when it
    // starts — all decided by the team service, read through the variable assigned below.
    admit: (run) => !(lab?.holding ?? false) && (team?.admit(run) ?? true),
    rolePreamble: (run) => {
      const base = team?.rolePreamble(run) ?? null;
      const more = handoffs?.preamble(run) ?? null;
      return base && more ? `${base}\n${more}` : base;
    },
    onChanged: (run) => { team?.runChanged(run); handoffs?.runChanged(run); },
    holdSettle: (run) => handoffs?.holdSettle(run) ?? false,
    fallbackKind: opts.agentRun?.fallbackKind ?? opts.browserAgent?.fallbackKind });
  // Scheduled tasks: the clock in front of the runs above. It owns a timer and they deliberately do
  // not — every fact this one acts on is a column, so a restart replays from the row rather than
  // from anything the process was holding (schedules/service.ts). Started after boot recovery below,
  // not here, so a catch-up firing lands in a world whose live runs have already been reconciled.
  schedules = new ScheduleService({
    store: new SchedulesStore(db), runs, rpc,
    spaceExists: (id) => Boolean(spaces.get(id)),
    refuse: (schedule) => team?.refuseSchedule(schedule) ?? handoffs?.refuseSchedule(schedule) ?? null,
    // The session's sidebar row: an item, archived the way the row's own Archive does it.
    archiveSession: (sessionId, archived) => {
      const item = items.findByRefId(sessionId);
      if (!item || item.kind !== "session" || item.archived === archived) return;
      items.update({ id: item.id, archived });
      rpc.broadcast("items.changed", { spaceId: item.spaceId });
    },
  });
  /* The `realm-schedule` provider — how a session puts work on the clock from inside a conversation,
     rather than only from the Schedules page. Registered HERE and not up with the other providers
     because it wraps the service declared on the line above; the gateway's per-space enablement is
     what decides whether a session actually sees the tools. */
  mcpGateway.registerProvider(createScheduleAgentProvider({ schedules, mcp, sessions }));
  /* Teams: roles whose work is the runs above, Review, records in the space's memory repo, and the
     activity log (team/service.ts). `realm-team` is listed only in a space that is a team. */
  const teamStore = new TeamStore(db);
  /* Approve → act (team/acts): a yes issues one paced ticket per outward act, and each acts only on
     the person's press on its sheet, which main holds and the bridge asks about. The platform is
     never real in a check: REALM_FAKE_ACT_ADAPTER=1 posts nowhere and logs each act to the home. */
  const actAdapter: ActAdapter = opts.acts?.adapter
    ?? (process.env.REALM_FAKE_ACT_ADAPTER === "1" ? new FakeActAdapter(join(opts.home, "fake-acts.jsonl")) : new NotConnectedAdapter());
  acts = new ActService({
    store: new ActStore(db), team: teamStore,
    rootForSpace: (id) => { try { return documents.rootForSpace(id); } catch { return null; } },
    record: (spaceId, path) => team?.recordFor(spaceId, path) ?? null,
    presses: opts.acts?.presses ?? {
      consume: async (ticketId, contentHash) => {
        if (!browserBridge.connected) return { pressed: false, label: false, slotAt: null };
        return (await browserBridge.call("teamTicketPress", { ticketId, contentHash })) as TicketPress;
      },
    },
    adapter: () => actAdapter,
    proofDir: join(opts.home, "team-proof"),
    rpc,
  });
  team = new TeamService({
    store: teamStore, runs, schedules, sessions, repos: memoryRepos, acts: acts,
    rootForSpace: (id) => { try { return documents.rootForSpace(id); } catch { return null; } },
    spaceExists: (id) => Boolean(spaces.get(id)),
    enabledSkills: (id) => skills.list(id).skills.filter((s) => s.enabled && s.valid).map((s) => s.id),
    settings, rpc,
    defaultKind: opts.agentRun?.fallbackKind ?? opts.browserAgent?.fallbackKind,
    preambleExtra: (roleId) => vault?.preambleLines(roleId) ?? [],
  });
  handoffs = new HandoffService({
    store: new HandoffStore(db), teamStore, team, runs, goals: { get: (id) => goals.get(id), adopt: (id, o, b) => goals.adopt(id, o, b), set: (id, st, note) => goals.set(id, st, note) },
    agentRuns, sessions, settings, rpc,
    rootForSpace: (id) => { try { return documents.rootForSpace(id); } catch { return null; } },
  });
  team.attach(handoffs);
  mcpGateway.registerProvider(createTeamAgentProvider({ team, mcp, more: createHandoffTools({ handoffs, teamStore }) }));
  const teamFinal = team;
  vault = new VaultService({
    store: new VaultStore(db), team: teamStore, runs, bridge: browserBridge,
    profileOf: (id) => spaces.get(id)?.profileId ?? null, isTeam: (id) => teamFinal.isTeam(id), rpc,
  });
  mcpGateway.registerProvider(createVaultAgentProvider({
    vault, bridge: browserBridge, broker: browserBroker, mcp,
    profileOf: (id) => spaces.get(id)?.profileId ?? null, isTeam: (id) => teamFinal.isTeam(id),
  }));
  /* The lab: this Mac's readiness, the devices on its cables, and the update window that holds team
     runs while an update waits to install. Realm-wide — one Mac serves every team on it. */
  lab = new LabService({
    store: new LabDevicesStore(db), settings, rpc,
    spaceName: (id) => spaces.get(id)?.name ?? null,
    devices: () => simulators.devices(),
    probe: opts.lab?.probe ?? (async () => evaluate(await probeFacts(macProbeDeps(opts.home)))),
    hostName: opts.lab?.hostName ?? (async () => {
      const r = await runCommand("/usr/sbin/scutil", ["--get", "LocalHostName"], 3_000);
      return r.code === 0 && r.stdout.trim() ? `${r.stdout.trim()}.local` : null;
    }),
    // Work the window waits for: runs that are running, and turns in sessions no run owns.
    busy: () => {
      const running = runs!.listLive().filter((r) => r.state === "running");
      const workers = new Set(running.map((r) => r.sessionId).filter(Boolean));
      const sessionsWorking = sessionsStore.listAll().filter((s) => s.status === "running" && !workers.has(s.id) && !runs!.isWorker(s.id)).length;
      return { runs: running.length, sessions: sessionsWorking };
    },
    pump: () => runs?.pump(),
    ...(opts.lab?.now ? { now: opts.lab.now } : {}),
  });
  /* `realm-memory`: the memory repo's tools, on by default and listed only where the space's profile
     has a repo — attaching one is the opt-in. The only memory that reaches Cursor and the other ACP
     agents, which take no per-session context. A save repaints every open memory row of the profile. */
  mcpGateway.registerProvider(createMemoryAgentProvider({ repos: memoryRepos, mcp, onChanged: memoryRepoChanged }));
  // The durable ship log (Plan 14 W1): GitWriteService stays a pure git service — the recorder is the
  // one seam through which a settled ship becomes a row, and the broadcast rides the same write so a
  // History tab already open sees the ship land.
  // Global search (Plan 16 W1). The service reads; the index writes live in the stores' own choke
  // points (SessionEventsStore.append, ItemsStore) so no producer can skip them.
  const search = new SearchService({ db, settings, profiles, spaces, skills, memory, memoryRepos });
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
  /* The first run's sign-in (`agentSignIn.*`): the CLI's own login, in a pty with no space around it.
     A clean exit is confirmed by a fresh probe of that one agent. The CLI manager's env too,
     for the reason the installer takes it: a suite's PATH must be the one the test built, so no
     `createApp` in a suite can find — let alone start — the developer's real `codex login`. */
  const agentSignIn = new AgentSignInService({ rpc, probe: (kind) => sessions.probeAgent(kind), env: opts.cli?.env });
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
    probe: (opts) => sessions.probe(opts),
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
  // One searcher for ⌘P and the `@` list's Files, so the two read a checkout the same way.
  const projectSearch = new ProjectSearchService();
  registerMethods({
    rpc, home: opts.home, version: SERVER_VERSION, machineName: machine, userName: user,
    profiles, spaces, projects, environments, envService, items, settings, skills, themes, fonts, mcp, hub: mcpHub, gateway: mcpGateway, oauth, calls: mcpCalls, memory, memoryRepos, terminals, browsers, machines, simulators, goals, eggs, browserBridge, documents, sessions, gitInfo: new GitInfoService(), gitDiff: new GitDiffService(), projectSearch, mentionFiles: new MentionFiles({ search: projectSearch, git: gitCapture }), gitWrite, ships, ports, checkpoints, notifications, runs, reviews, search, artifacts, savedTurns: new SavedTurnsStore(db), forks, failover, imports, lectures, plynn, modelCatalog, usage, graphify, schedules, team, handoffs, delegation: delegationEngine, computerAllowlist, signIn: signInFlow, browserPermissions: browserBroker, cli, cliInstaller,
    children: new DelegatedChildren({ sessions: sessionsStore, events: sessionEvents, items, rpc, agentRuns, browserAgents }), agentRuns,
    iconAssets, iconGeneration, avatar: new AvatarStore(opts.home, settings), planLimits, userCommands, scripts, keybindings, sandbox, laya, agentSignIn,
    libraryFiles,
    appViews: new AppViewService({ views: appViews, hub: mcpHub, mcp, servers: mcpServersStore, sessions: sessionsStore, server: appViewServer, gateway: mcpGateway, log: (line) => console.log(line) }),
    codeReview,
    /* A drain was accepted: watch for quiescence and close once it holds. The watcher owns the clock
       and the close; `methods.ts` owns the refusals that make quiescence reachable at all. Unref'd —
       a daemon with nothing to do must not be held open by its own timer. */
    onDrain: () => {
      opts.onDraining?.();
      const drain = new Drain({
        counts: () => ({ working: sessions.statusCounts().working, activeRuns: runs.activeCount() }),
        now: () => Date.now(),
        close: () => { clearInterval(timer); void closeApp(); },
        log: (line) => console.error(line),
      });
      const timer = setInterval(() => drain.tick(), DRAIN_TICK_MS);
      timer.unref?.();
      drain.tick();
    },
  });
  registerVaultMethods(rpc, vault, (id) => Boolean(spaces.get(id)));
  registerLabMethods(rpc, lab);
  registerActMethods(rpc, acts!, (id) => Boolean(spaces.get(id)));
  sessions.markStaleOnBoot();
  // AFTER markStaleOnBoot, which is what turns a session that was mid-turn back into a resumable
  // row — recovery reconciles each live run against that reconciled world, not the pre-boot one.
  runs.recoverOnBoot();
  // …and only then does the clock start. A schedule that came due while the app was closed fires on
  // this first tick, and it must not race the recovery that decides which runs are still alive.
  schedules.start();
  team.start();
  handoffs.start();
  lab.start();
  acts!.start();
  // The pre-v15 event history reaches the search index here: chunked, yielding, resumable across
  // boots (SearchService.runBackfill's doc comment states the design). Fire-and-forget — search over
  // the not-yet-covered range is merely incomplete while it runs, and a failure only pauses it.
  void search.runBackfill();
  /* Saves made while the network was down are pushed now, and what other machines pushed is pulled:
     every synced repo, in the background, never holding up the boot. */
  for (const p of profiles.list()) void memoryRepos.queueSync({ scope: "profile", id: p.id });
  for (const sp of spaces.listAll()) void memoryRepos.queueSync({ scope: "space", id: sp.id });
  // The pre-v25 history reaches the Library's file index the same way, on the same terms: chunked,
  // yielding, resumable, and merely incomplete rather than wrong while it runs.
  void artifacts.runBackfill(() => false);
  // …and the pictures the last fortnight's turns made, which no write tool named: once per home, in
  // the background (`SessionService.backfillTurnMedia`).
  void sessions.backfillTurnMedia().catch((e) => console.error(`[sessions] media catch-up failed: ${e instanceof Error ? e.message : String(e)}`));
  // Copies removed from the Library while the last run was up, whose Undo went with it.
  void libraryFiles.sweep();
  terminals.restoreAll();
  // Brings laya-serve back only if the user left Laya on and an install is on disk.
  laya.boot();
  // Starts nothing, and clears every recorded ws port: a port held against last run's listener is a
  // lie, and the UNIQUE index would refuse to reissue it to the machine it belonged to.
  machines.restoreAll();
  // The gateway must be accepting connections before any session can start (its listener mints the URL
  // every `sessions.create` → send hands an adapter), and well before the RPC socket opens to clients.
  await mcpGateway.listen();
  await preview.listen();
  await appViewServer.listen();
  await machineProxy.listen();
  const port = await rpc.listen(opts.port, "127.0.0.1", {
    token: opts.token,
    /* The origins Realm loads its own renderer from, measured rather than assumed: a packaged window
       is a `file://` document and Chromium stamps `Origin: file://` on its WebSocket handshake; under
       `pnpm dev` the window is the Vite server and stamps that origin instead. Everything else that
       dials this socket (main's bridge, the CLI, the live checks) is `ws` from Node and sends no
       Origin at all. */
    allowedOrigins: ["file://", ...(devRendererOrigin() ? [devRendererOrigin()!] : [])],
  });
  /**
   * Shut this app down.
   *
   * Named so the drain watcher can call the very same sequence the RPC `close` does. A second path
   * through shutdown is exactly how the two drift, and the drain is the one thing in this file that
   * closes the app without a caller asking it to.
   */
  const closeApp = async (): Promise<void> => {
    search.stop(); // before db.close: the backfill loop must not start a chunk on a closing handle
    team?.close();
    handoffs?.close();
    lab?.close();
    acts?.close();
    schedules?.close(); // before runs: a tick must not create a run on a service that is stopping
    runs?.close(); // likewise: an in-flight dispatch must not write to a closing handle
    codeReview?.close(); // and a reviewer settling now must not write its findings to one
    summaries?.close(); // a debounced recap must not fire onto a closing handle, or outlive the process
    terminals.closeAll();
    cliInstaller.disposeAll();
    // While the socket is still open, so a window that outlives this daemon hears the sign-in end.
    agentSignIn.disposeAll();
    // The last steps' rows go down first, then laya-serve — which must not outlive the app holding
    // a gigabyte of weights — and any install in flight.
    await layaShadow.close();
    await laya.close();
    await sessions.closeAll();
    // Gateway before hub: stop accepting new proxied calls before the upstream clients they'd need go
    // away, so a request racing shutdown fails cleanly (connection refused) rather than mid-call.
    documents.dispose();
    // Awaited, and before `db.close()`: an un-awaited close leaves live sockets to somebody else's
    // Mac open past the process, and the service writes a ws port back to the row as each drops.
    await machines.closeAll();
    // Realm's test runner comes off every phone it is on: a phone is its owner's once Realm is gone.
    await simulators.closeAll();
    await preview.close();
    await appViewServer.close();
    await mcpGateway.close();
    await mcpHub.close();
    await rpc.close();
    db.close();
  };

  return {
    port, db, terminals, sessions, browserAgents, agentRuns, reviews, asks, runs, schedules, team, lab, acts: acts!, codeReview, gateway: mcpGateway,
    close: closeApp,
  };
}

/** `REALM_MCP_HEARTBEAT_MS`, for live checks only: a positive whole number of milliseconds, or the
 *  gateway's own default. */
function heartbeatOverride(): number | undefined {
  const ms = Number(process.env.REALM_MCP_HEARTBEAT_MS);
  return Number.isInteger(ms) && ms > 0 ? ms : undefined;
}
