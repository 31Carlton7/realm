import { readFile, stat } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import { query as sdkQuery, type Options, type PermissionResult, type PermissionUpdate, type SDKUserMessage, type SpawnOptions, type SpawnedProcess, type Query } from "@anthropic-ai/claude-agent-sdk";
import { ASK_PERMISSION_MODE, BROWSER_READ_ONLY_TOOLS, MAX_ATTACHMENT_BYTES, mergeWindows, newId, planWindowLabel, sessionEvent, type PlanAlert, type PlanWindow, type SessionEvent, type SessionEventPayload } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import { createSdkMapper, type ChainCursor } from "./map-sdk-message";
import { probeClaude } from "./probe";
import type { AgentAdapter, AgentHandle, McpServerConfig, PermissionDecision, ProbeResult, StartOptions, UserMessage } from "../types";

type QueryFn = typeof sdkQuery;

/**
 * The truncating half of a resume: put the model back where a checkpoint found it.
 *
 * `resumeAt` is a chain-entry uuid of the session named by `resume`, and `resumeDropsTurn` is the
 * prompt uuid of the one turn past it that the caller means to discard. They ride TOGETHER or not at
 * all: `resumeSessionAt` alone is the SDK's unvalidated truncation, which would silently discard a
 * queued message or a task notification the session absorbed mid-turn, and refusing to do that
 * silently is the entire point of the pair.
 *
 * Declared here rather than on `StartOptions` because these two fields are Claude's and no other
 * adapter has anything to map them onto (`AGENT_CONVERSATION_REWIND` says why). They reach `start` as
 * extra properties on the options object, which is structurally what `StartOptions` permits; promoting
 * them into `StartOptions` proper is a one-line change in `../types` whenever a second agent gains a
 * truncating resume, and this type then collapses into it.
 *
 * PRINT/HEADLESS LANE ONLY, and this adapter is on it: the pair is honoured by the print-mode CLI, the
 * Agent SDK and ProcessTransport. An interactive `claude --resume` accepts both and ignores them — no
 * truncation, no guard, no error — so nothing here may be reused to drive an interactive boot and go on
 * expecting the guard to be armed.
 */
export type ClaudeResumeFork = { resumeAt?: string | null; resumeDropsTurn?: string | null };

/** What `ClaudeAdapter.start` really returns: an `AgentHandle` that can also say where the provider's
 *  chain stood at the end of the last settled turn. Every other adapter returns a bare handle, because
 *  none of the other wires carries a chain entry to report. */
export type ClaudeHandle = AgentHandle & { chainCursor(): ChainCursor };

/**
 * `Options.mcpServers` for the SDK: a record keyed by name (`sdk.d.ts:1734`), whose members are the
 * three process transports — `{type:'stdio',command,args,env}` and `{type:'http'|'sse',url,headers}`.
 *
 * No filtering happens here: since Plan 9 W3 `servers` is always exactly the gateway's own `http` entry
 * (or empty), and Claude takes every transport anyway. Translation only.
 */
export function claudeMcpServers(servers: readonly McpServerConfig[]): Record<string, unknown> {
  return Object.fromEntries(servers.map((s) => [
    s.name,
    s.transport === "stdio"
      ? { type: "stdio" as const, command: s.command, args: s.args, env: s.env }
      : { type: s.transport, url: s.url, headers: s.headers },
  ]));
}

/**
 * W4's double-prompt fix, read-only half ONLY. The SDK asks `canUseTool` for every MCP tool — which
 * Realm bridges to an ApprovalCard — so before this, a `browser_snapshot` that Realm's own broker
 * deliberately lets run free still raised a card from Claude's side. Pre-allowing the READ-ONLY
 * `realm-browser` tools via `Options.allowedTools` makes reads promptless end to end.
 *
 * Tool naming, verified against the gateway (`apps/server/src/mcp/gateway.ts`): every session's one
 * MCP server is the gateway entry named `realm`, whose provider tools are re-exported as
 * `realm-browser__browser_*`; the SDK prefixes MCP tools as `mcp__<serverName>__<toolName>` — so
 * `mcp__realm__realm-browser__browser_snapshot` etc. Derived from `opts.mcpServers` rather than a
 * literal "realm" so a renamed gateway entry cannot silently orphan the allow-list.
 *
 * MUTATING tools are deliberately NOT here and must never be: they keep BOTH prompts (Claude's and
 * Realm's ApprovalCard) — one prompt too many beats one too few. `BROWSER_READ_ONLY_TOOLS` is the
 * same shared list the server's broker gates by, and the test pins its exact expansion.
 */
export function claudeAllowedTools(servers: readonly McpServerConfig[]): string[] {
  return servers.flatMap((s) => BROWSER_READ_ONLY_TOOLS.map((t) => `mcp__${s.name}__realm-browser__${t}`));
}

/**
 * The BUILT-IN tools an Ask session may run — read and search, and nothing that changes anything.
 *
 * An allow-list, never a deny-list. Ask's whole value is that it is enforced, and a deny-list fails
 * open: the next tool the CLI ships, and every tool of every MCP server a space adds, would be
 * allowed by default until somebody remembered to name it.
 *
 * `Bash` is absent and that is the point. Nothing can decide from a command string whether it
 * mutates — `git log` and `git reset --hard` are the same shape, and a shell can write a file
 * through a hundred spellings. Guessing is exactly the lie this mode exists to avoid, and Cursor's
 * own `ask` mode draws the line in the same place: "no edits or command execution".
 *
 * `Task` is absent for the same fail-closed reason: whether the SDK routes a subagent's tool calls
 * back through this `canUseTool` is not something Realm can assert from the published types, and a
 * subagent that edits is an edit.
 *
 * `TodoWrite` and `AskUserQuestion` are in: one writes the agent's own checklist and the other asks
 * the user a question. Neither touches the repo.
 */
const CLAUDE_ASK_BUILTINS = ["Read", "Glob", "Grep", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "AskUserQuestion"] as const;

/**
 * Every tool name an Ask session may run, for a session with these MCP servers.
 *
 * The MCP half is `claudeAllowedTools` itself rather than a second list: those are the read-only
 * `realm-browser` tools, they are already pre-allowed for every session, and deriving them here
 * means Ask can never disagree with what the rest of the adapter calls read-only.
 */
export function claudeAskTools(servers: readonly McpServerConfig[]): Set<string> {
  return new Set<string>([...CLAUDE_ASK_BUILTINS, ...claudeAllowedTools(servers)]);
}

/**
 * Realm's mode onto the SDK's `PermissionMode`, whose union is
 * `default | acceptEdits | bypassPermissions | plan | dontAsk | auto` and has no "ask".
 *
 * Ask becomes `default` because that is the mode under which `canUseTool` is consulted for every
 * call, and `canUseTool` is where Ask is enforced. `acceptEdits` and `bypassPermissions` let calls
 * through without asking, so sending either would hand the mode's one gate its own bypass.
 */
export function claudeSdkPermissionMode(mode: string | null | undefined): string {
  return mode === ASK_PERMISSION_MODE || !mode ? "default" : mode;
}

const STDERR_TAIL_LINES = 50;
const DISPOSE_TIMEOUT_MS = 3000;

/**
 * The CLI subprocess, started through Realm's execution sandbox instead of plainly.
 *
 * Installed as `Options.spawnClaudeCodeProcess` and ONLY when a wrap was supplied — see the option
 * for why standing aside matters for everyone else.
 *
 * `wrap` is called outside any `try`: it throws when Seatbelt cannot be applied, and that throw has
 * to travel — the SDK reports it as a process that would not start, which is exactly the outcome a
 * session in a sandboxed space must have. There is no branch here that spawns `o.command` unchanged.
 *
 * Two details the SDK's own `spawnLocalProcess` does that a bare `spawn` would not:
 *
 *  - **stderr is drained.** `SpawnedProcess` has no stderr field, so once a custom spawner is in
 *    play the SDK never reads the child's stderr. A piped-and-unread stderr fills at the OS buffer
 *    (~64KB) and then BLOCKS the CLI mid-write. Draining it into `onStderr` both prevents that and
 *    keeps the diagnostic tail this adapter already builds from `Options.stderr`.
 *  - **`signal` is passed through.** It is the SDK's forwarded abort, which fires only after its
 *    stdin-EOF + grace window (`sdk.d.ts`), so hanging Node's kill on it does not race the CLI's own
 *    graceful shutdown.
 */
function spawnWrapped(o: SpawnOptions, wrap: NonNullable<StartOptions["wrap"]>, onStderr: (data: string) => void): SpawnedProcess {
  const { command, args } = wrap(o.command, o.args);
  const child = nodeSpawn(command, args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (data: string) => onStderr(data));
  // Unhandled, a stream 'error' takes the whole server down with an uncaughtException. The child
  // dying is reported by 'exit'; a stderr read that failed is only a lost diagnostic.
  child.stderr?.on("error", () => {});
  // `sdk.d.ts`: "ChildProcess already satisfies this interface." The only difference TypeScript can
  // see is that `stdin`/`stdout` are nullable on ChildProcess and not on SpawnedProcess — and
  // `stdio: ["pipe","pipe","pipe"]` three lines up is what makes them non-null here.
  return child as unknown as SpawnedProcess;
}

/** Claude adapter on the Agent SDK in streaming-input mode. `canUseTool` is bridged to permission_request/response events. */
export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  private queryFn: QueryFn;
  constructor(deps: { query?: QueryFn } = {}) { this.queryFn = deps.query ?? sdkQuery; }

  async probe(): Promise<ProbeResult> { const p = await probeClaude(); return { kind: this.kind, ...p }; }

  start(opts: StartOptions & ClaudeResumeFork): ClaudeHandle {
    const events = new AsyncQueue<SessionEvent>();
    const input = new AsyncQueue<SDKUserMessage>();
    const pending = new Map<string, { resolve: (r: PermissionResult) => void; suggestions: PermissionUpdate[]; input: Record<string, unknown> }>();
    const abort = new AbortController();
    const mapper = createSdkMapper({ resumed: Boolean(opts.resume) });
    const stderrTail: string[] = [];
    let q: Query | null = null;
    // Tracked rather than read off `options`, because Ask has to hold on a LIVE session: the mode can
    // change mid-turn and `Options` is only ever read at start.
    let permissionMode = opts.permissionMode ?? "default";
    const askTools = claudeAskTools(opts.mcpServers);
    let running = false;
    let sawResult = false;
    let disposed = false;

    const onStderr = (data: string) => {
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        opts.onLog?.(line);
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    };
    const withStderr = (message: string) => (stderrTail.length ? `${message}\n--- stderr (last ${stderrTail.length} lines) ---\n${stderrTail.join("\n")}` : message);

    // `answers` (AskUserQuestion) rides back as `updatedInput`: the SDK reads the user's choices off the
    // tool's own arguments, so answering a question IS allowing the call with the answers filled in.
    const resolvePermission = (requestId: string, d: PermissionDecision, answers?: Record<string, string>) => {
      const p = pending.get(requestId); if (!p) return;
      pending.delete(requestId);
      events.push(sessionEvent("permission_response", { requestId, decision: d, ...(answers ? { answers } : {}) }));
      if (d === "deny") p.resolve({ behavior: "deny", message: "User denied" });
      else if (d === "allow_always") p.resolve({ behavior: "allow", updatedPermissions: p.suggestions });
      else p.resolve({ behavior: "allow", ...(answers ? { updatedInput: { ...p.input, answers } } : {}) });
    };
    const denyAllPending = () => { for (const id of [...pending.keys()]) resolvePermission(id, "deny"); };

    // Several tools may ask at once (parallel tool calls): status flips to waiting_permission on the first open request
    // and back only when the last one is answered.
    const canUseTool: NonNullable<Options["canUseTool"]> = async (toolName, toolInput, o) => {
      // Ask, enforced: refused here, before the tool runs, and never put to the user — a prompt the
      // user could answer "allow" to would make the mode advisory. The message names what IS
      // available, so the model re-plans within the mode instead of retrying the same call.
      if (permissionMode === ASK_PERMISSION_MODE && !askTools.has(toolName)) {
        return { behavior: "deny", message: `This session is in Ask mode: read-only. ${toolName} cannot run. Reading, searching (Grep, Glob) and web lookups are available; to change files or run commands, the user has to leave Ask.` };
      }
      const requestId = newId();
      const suggestions = o.suggestions ?? [];
      if (pending.size === 0) events.push(sessionEvent("status", { status: "waiting_permission" }));
      events.push(sessionEvent("permission_request", { requestId, toolName, input: toolInput, title: o.title ?? `Allow ${toolName}?`, suggestions: suggestions as unknown[] }));
      const result = await new Promise<PermissionResult>((resolve) => {
        pending.set(requestId, { resolve, suggestions, input: toolInput as Record<string, unknown> });
        o.signal.addEventListener("abort", () => {
          if (!pending.delete(requestId)) return;
          events.push(sessionEvent("permission_response", { requestId, decision: "deny" }));
          resolve({ behavior: "deny", message: "aborted" });
        }, { once: true });
      });
      if (pending.size === 0) events.push(sessionEvent("status", { status: running ? "running" : "idle" }));
      return result;
    };

    const options: Options = {
      cwd: opts.cwd,
      model: opts.model ?? undefined,
      effort: (opts.effort ?? undefined) as Options["effort"],
      permissionMode: claudeSdkPermissionMode(opts.permissionMode) as Options["permissionMode"],
      canUseTool,
      includePartialMessages: true,
      abortController: abort,
      // The SDK FORKS to a new session id on resume rather than continuing the old one, which is why
      // the init event below can only claim the request was accepted — see `resumeOutcome` in the
      // contract. There is no rejection to catch: an unusable id surfaces as an ordinary boot error.
      resume: opts.resume ?? undefined,
      // …and, when a checkpoint restore armed one, the truncating form of that resume: keep the
      // conversation up to `resumeSessionAt` and drop the single turn `resumeDropsTurn` names.
      //
      // All three or none. Without `resume` there is no session to truncate, and without
      // `resumeDropsTurn` the SDK performs an UNVALIDATED truncation — which would quietly discard
      // anything else that landed past the fork point (a queued user message, a task notification)
      // rather than refusing. The refusal is the feature; the unguarded form is not one Realm wants.
      //
      // This IS the rejection to catch that plain `resume` has none of: the guard answers with an
      // `error_during_execution` result whose message starts `Resume rejected by --resume-drops-turn:`.
      // It is deterministic, so `SessionService` maps it to a recovery path and never retries it.
      ...(opts.resume && opts.resumeAt && opts.resumeDropsTurn
        ? { resumeSessionAt: opts.resumeAt, resumeDropsTurn: opts.resumeDropsTurn }
        : {}),
      systemPrompt: opts.systemContext ? { type: "preset", preset: "claude_code", append: opts.systemContext } : undefined,
      // A RECORD keyed by name, not an array: `sdk.d.ts` `mcpServers?: Record<string, McpServerConfig>`.
      // Some documentation shows an array; disk wins.
      mcpServers: claudeMcpServers(opts.mcpServers) as Options["mcpServers"],
      // Read-only realm-browser tools run without the SDK's own prompt (see claudeAllowedTools —
      // mutating tools stay double-gated on purpose).
      allowedTools: claudeAllowedTools(opts.mcpServers),
      // Realm's skills library as a local plugin, and `settingSources: []` so it is the ONLY library
      // this session has. The two go together and neither works alone for what Realm wants:
      //
      //   - without `plugins`, there is no way to add a skills directory at all;
      //   - without `settingSources: []`, the user's own `~/.claude/skills` (29 of them here) load
      //     alongside Realm's, so the library the UI lists is not the library the agent has.
      //
      // Proven live in scripts/live-skills-check.ts: this shape surfaces `realm:<id>` and leaks nothing;
      // dropping `settingSources` takes the command count from 53 to 147.
      //
      // The cost is real and deliberate: `settingSources: []` also drops the user's `~/.claude/CLAUDE.md`
      // and the repo's `.claude/` settings. That is why the option is only present when the space
      // actually has enabled skills — a space that manages none is left exactly as it was.
      ...(opts.skills ? { settingSources: [], plugins: [{ type: "local" as const, path: opts.skills.pluginPath, skipMcpDiscovery: true }] } : {}),
      env: { ...process.env, ...opts.env },
      stderr: onStderr,
      pathToClaudeCodeExecutable: process.env.REALM_CLAUDE_BIN,
      // Realm's execution sandbox. The SDK owns the argv — which node, which cli.js, which flags —
      // so there is nowhere else to stand: `spawnClaudeCodeProcess` is the SDK's own documented seam
      // for running the CLI somewhere other than plainly here (`sdk.d.ts`: "Use this to run Claude
      // Code in VMs, containers, or remote environments"), and it is handed the exact command and
      // args it was about to spawn.
      //
      // Present ONLY when the server passed a wrap — i.e. only for a space that is actually
      // sandboxed. Installing it unconditionally would put Realm's spawn in front of the SDK's for
      // everybody, including the users this release ships `off` for, and the SDK's own
      // `spawnLocalProcess` does more than `spawn` (windowsHide, a stderr tail, an exit it delays
      // until stderr closes). Standing aside is the only way to promise them an unchanged process.
      ...(opts.wrap ? { spawnClaudeCodeProcess: (so) => spawnWrapped(so, opts.wrap!, onStderr) } : {}),
      // Asked for at start AND re-assertable mid-session (see setOptions). Passing it here rather
      // than only through `applyFlagSettings` is what makes the FIRST turn of a session that was
      // switched on before it started run fast — the flag layer can only be written once a query
      // exists, and by then the first prompt is already on its way.
      ...(opts.fastMode ? { fastMode: true } : {}),
    };

    /**
     * Ask the CLI whether the model this session landed on can run fast mode, and say so once.
     *
     * The `init` event is emitted a second time, carrying the SAME four facts plus this one. Not a
     * partial: the first event is pushed from the message the CLI sent, this answer needs a round
     * trip that has not happened yet, and a second event whose `tools` was an empty array to satisfy
     * the schema would be a false statement in a persisted log. So the whole record is restated —
     * `reduceTranscript` replaces its `init` with the newer one, and the transcript ends holding the
     * more complete of the two.
     *
     * Everything here fails quietly. `supportedModels` is a control request a CLI may decline, the
     * model may be missing from the list, and the field is optional in the SDK's own type — all
     * three mean "not stated", and a prompter that offered the switch on a guess would be offering a
     * control whose only outcome is a `model_not_allowed`.
     */
    const reportFastModeSupport = async (init: { providerSessionId: string; model: string; tools: string[]; cwd: string }) => {
      try {
        const rows = await q?.supportedModels();
        if (!rows || disposed) return;
        const hit = rows.find((r) => r.value === init.model || r.resolvedModel === init.model);
        if (hit?.supportsFastMode === undefined) return;
        events.push(sessionEvent("init", { ...init, supportsFastMode: hit.supportsFastMode }));
      } catch { /* the CLI declined; the capability stays unstated */ }
    };

    /** A utilization percentage, or null for anything that is not a finite number — the SDK types
     *  these as nullable and a `null` drawn as 0% would read as an empty window. */
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    /** An ISO-8601 reset time as epoch ms. The stream reports `resetsAt` in ms already; this control
     *  request reports `resets_at` as a string, and the two must land in one unit. */
    const millis = (v: unknown): number | null => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v !== "string") return null;
      const t = Date.parse(v);
      return Number.isNaN(t) ? null : t;
    };

    /**
     * Ask the CLI for the whole plan picture — every rate-limit window, plus the subscription tier.
     *
     * The stream's `rate_limit_event` names ONE window (the one that just moved) and the account's
     * status; this control request answers the rest, which is what a panel showing "5-hour, weekly,
     * and the per-model windows" needs. Called once after the handshake and again whenever the
     * stream says something changed, so the panel is populated before the first limit moves.
     *
     * Two properties of the SDK shape the code has to respect:
     *
     *  - Fable (and every future model bucket) arrives in `rate_limits.model_scoped[]` under a
     *    server-supplied `display_name`, NOT under a fixed key like `seven_day_opus`. So the array is
     *    read generically and the label is the server's word, never one written here.
     *  - `rate_limits_available: false` is a real answer, not an error: an API key, Bedrock or Vertex
     *    session has no plan quota. It becomes `not-on-a-plan` so the panel says that instead of
     *    drawing empty bars.
     *
     * The method is named `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, and this is
     * the whole of Realm's exposure to it: every failure mode — renamed, removed, throwing — lands in
     * the catch and leaves the last stream-reported window standing on its own.
     */
    const readPlanLimits = async (): Promise<SessionEventPayload<"rate_limit"> | null> => {
      const ask = (q as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown> } | undefined)
        ?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof ask !== "function") return null;
      try {
        const res = await ask.call(q) as {
          subscription_type?: unknown; rate_limits_available?: unknown;
          rate_limits?: Record<string, unknown> | null;
        };
        if (disposed) return null;
        const subscriptionType = typeof res.subscription_type === "string" ? res.subscription_type : null;
        if (res.rate_limits_available === false) {
          return { subscriptionType, organization: null, windows: [], alert: "none", alertWindow: null, unavailable: "not-on-a-plan", detail: null };
        }
        const limits = res.rate_limits;
        if (!limits || typeof limits !== "object") return null;
        const windows: PlanWindow[] = [];
        for (const [id, value] of Object.entries(limits)) {
          if (id === "model_scoped") {
            // The server's own label is the id here, because there is no key to use instead.
            for (const bucket of Array.isArray(value) ? value : []) {
              const b = bucket as { display_name?: unknown; utilization?: unknown; resets_at?: unknown };
              if (typeof b?.display_name !== "string") continue;
              windows.push({ id: `model:${b.display_name}`, label: planWindowLabel(`model:${b.display_name}`), utilization: num(b.utilization), resetsAt: millis(b.resets_at) });
            }
            continue;
          }
          const w = value as { utilization?: unknown; resets_at?: unknown } | null;
          if (!w || typeof w !== "object" || !("utilization" in w || "resets_at" in w)) continue;
          windows.push({ id, label: planWindowLabel(id), utilization: num(w.utilization), resetsAt: millis(w.resets_at) });
        }
        return { subscriptionType, organization: null, windows, alert: "none", alertWindow: null, unavailable: null, detail: null };
      } catch {
        return null; // experimental and allowed to vanish; the stream still reports one window
      }
    };

    /**
     * Ask the CLI how full the window actually is, and restate the turn's usage with the answer.
     *
     * `getContextUsage` is the only thing on this wire that measures OCCUPANCY — what the model is
     * carrying right now. The result's own `usage` counts tokens READ across every request the turn
     * made, which climbs past the window on any long turn and can never fall (map-sdk-message.ts
     * says the rest). `detail: "summary"` answers from the last response's usage and local estimates
     * and makes none of the per-category token-count calls `full` does, so this is one control
     * request and no model call.
     *
     * The whole `usage` event is restated rather than a partial one sent, the same way
     * `reportFastModeSupport` restates `init`: the four numbers are already known here, and an event
     * carrying the context alone would have to invent zeroes for them.
     *
     * Fails quietly in both directions. A CLI that declines, or a build with no such control request,
     * leaves the meter reading the last measurement that did land — which is still the last true
     * thing anyone knew about this window, since occupancy does not reset between turns.
     */
    const reportContextUsage = async (usage: SessionEventPayload<"usage">) => {
      try {
        const cu = await q?.getContextUsage({ detail: "summary" });
        if (!cu || disposed) return;
        // `rawMaxTokens` is the window the CLI's own percentage is figured against — the model's
        // limit, or the smaller compaction window it is really being held to. `maxTokens` is that
        // less the compaction reserve, which would report a session as full while it still had room.
        const window = cu.rawMaxTokens > 0 ? cu.rawMaxTokens : cu.maxTokens;
        if (!(cu.totalTokens > 0) || !(window > 0)) return;
        events.push(sessionEvent("usage", { ...usage, contextTokens: cu.totalTokens, contextWindow: window }));
      } catch { /* the CLI declined; the last measurement stands */ }
    };

    /** Set by `interrupt`, read and cleared by the result it produces. Declared ahead of `pump` so
     *  the loop's closure can never read it in its temporal dead zone. */
    let interrupted = false;

    const pump = async () => {
      let failure: string | null = null;
      try {
        q = this.queryFn({ prompt: input, options });
        for await (const msg of q) {
          if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
            for (const e of mapper.map(msg)) events.push(e);
            // Whether fast mode is even offerable is the HARNESS's answer, not a table here: model
            // lists go stale, and a switch offered on a model that cannot run it is a control whose
            // only outcome is a disabled_reason. Asked once per session, after the handshake that
            // makes `supportedModels` answerable, and never awaited on the message loop — a CLI that
            // declines leaves the capability unstated and the prompter offers nothing.
            const i = msg as { session_id?: unknown; model?: unknown; tools?: unknown; cwd?: unknown };
            void reportFastModeSupport({
              providerSessionId: String(i.session_id ?? ""), model: String(i.model ?? ""),
              tools: Array.isArray(i.tools) ? i.tools.map(String) : [], cwd: String(i.cwd ?? opts.cwd),
            });
            // The plan panel should be answerable before any limit moves, so it is read once here
            // rather than waiting for the first `rate_limit_event` — which on a quiet account may
            // never come. Off the message loop, like the fast-mode probe above it.
            void readPlanLimits().then((p) => { if (p && !disposed) events.push(sessionEvent("rate_limit", p)); }).catch(() => {});
            if (!running) events.push(sessionEvent("status", { status: "idle" })); // init arrives after the first send in streaming mode
            continue;
          }
          if (msg.type === "result") {
            // A cancelled turn still reports its usage — the tokens were spent — but its error is
            // the cancellation, and that is what the settle below says instead.
            let usage: SessionEventPayload<"usage"> | null = null;
            for (const e of mapper.map(msg)) {
              if (interrupted && e.type === "error") continue;
              if (e.type === "usage") usage = e.payload;
              events.push(e);
            }
            // Off the message loop: the meter is worth a beat of lateness and nothing else on this
            // wire is worth holding up for it. The restated event lands whenever the CLI answers.
            if (usage) void reportContextUsage(usage);
            running = false; sawResult = true;
            events.push(sessionEvent("status", { status: "idle", ...(interrupted ? { interrupted: true } : {}) }));
            // Cleared on the SAME result that read it, so the latch cannot outlive the turn it was
            // armed for and silence a genuine failure on the next one. (The fake `query` in the
            // suite yields its fixture once per session, so a second turn cannot be driven through
            // it — this line is the reason that mutant is not reachable there, not an oversight.)
            interrupted = false;
            continue;
          }
          if (msg.type === "rate_limit_event") {
            const info = (msg as { rate_limit_info?: Record<string, unknown> }).rate_limit_info ?? {};
            const status = info.status;
            const alert: PlanAlert = status === "rejected" ? "exceeded" : status === "allowed_warning" ? "approaching" : "none";
            const id = typeof info.rateLimitType === "string" ? info.rateLimitType : null;
            const window: PlanWindow[] = id
              ? [{ id, label: planWindowLabel(id), utilization: num(info.utilization), resetsAt: millis(info.resetsAt) }]
              : [];
            // The full picture first, so a panel opened on this event shows every window rather than
            // only the one that moved. Its `alert` is always "none" — the control request reports
            // quotas, not status — so the stream's verdict is laid over it here.
            const full = await readPlanLimits();
            const merged = full
              ? { ...full, windows: mergeWindows(full.windows, window), alert, alertWindow: id }
              : { subscriptionType: null, organization: null, windows: window, alert, alertWindow: id,
                  unavailable: null, detail: typeof info.overageDisabledReason === "string" ? info.overageDisabledReason : null };
            events.push(sessionEvent("rate_limit", merged));
            continue;
          }
          for (const e of mapper.map(msg)) events.push(e);
        }
        // Generator ended on its own: abnormal unless we asked for it or it ended cleanly between turns.
        if (!disposed && (running || !sawResult)) failure = "agent process ended unexpectedly";
      } catch (e) {
        // The SDK rejects iteration with "Claude Code process aborted by user" when our abortController fires in dispose(); not an error.
        if (!disposed && !abort.signal.aborted) failure = (e as Error).message ?? String(e);
      } finally {
        denyAllPending();
        if (failure !== null) {
          events.push(sessionEvent("error", { message: withStderr(failure) }));
          events.push(sessionEvent("status", { status: "error" }));
        }
        running = false;
        events.push(sessionEvent("status", { status: "ended" }));
        events.close();
      }
    };
    const pumpDone = pump();

    /** Images become base64 blocks — the one path whose bytes genuinely have to fit in the request. */
    const readAttachments = async (m: UserMessage): Promise<Array<Record<string, unknown>>> => {
      const blocks: Array<Record<string, unknown>> = [];
      for (const a of m.attachments) {
        if (!a.mime.startsWith("image/")) continue;
        const { size } = await stat(a.path);
        if (size > MAX_ATTACHMENT_BYTES) throw new Error(`attachment too large (${size} bytes > ${MAX_ATTACHMENT_BYTES}): ${a.path}`);
        const data = (await readFile(a.path)).toString("base64");
        blocks.push({ type: "image", source: { type: "base64", media_type: a.mime, data } });
      }
      return blocks;
    };

    /**
     * Non-image attachments, named in the message text for the agent to open itself — the same
     * handoff `codex-adapter.ts` performs, in the same words, so a PDF dropped on either engine
     * reaches it the same way.
     *
     * These used to hit a bare `continue` and vanish: the user attached a file, the prompter warned
     * that it would be dropped, and the agent was told nothing at all. Inlining them instead was
     * never the answer — `claude` runs ON this machine with Read, Grep and Bash already pointed at
     * the filesystem, so a path is strictly more useful than a base64 blob would be, and it costs
     * the request nothing. The agent decides whether the file is worth opening.
     */
    const fileListFor = (m: UserMessage): string | null => {
      const files = m.attachments.filter((a) => !a.mime.startsWith("image/"));
      return files.length === 0 ? null : `Attached files:\n${files.map((a) => `- ${a.path}`).join("\n")}`;
    };

    return {
      events,
      /** Where the provider's chain stood at the end of the last SETTLED turn. Read by the server on
       *  the settle, which is the only moment the answer is both complete and not yet overwritten by
       *  the next turn — see the mapper's freeze. */
      chainCursor: () => mapper.chain(),
      send: async (m: UserMessage) => {
        if (disposed || input.isClosed) { events.push(sessionEvent("error", { message: "session ended" })); return; }
        let images: Array<Record<string, unknown>>;
        try { images = await readAttachments(m); }
        catch (e) { events.push(sessionEvent("error", { message: `attachment error: ${(e as Error).message ?? String(e)}` })); return; }
        if (disposed || input.isClosed) { events.push(sessionEvent("error", { message: "session ended" })); return; }
        running = true;
        events.push(sessionEvent("status", { status: "running" }));
        // A resolved @-mention (W4) becomes `/realm:<name>` at POSITION 0 — the only place the SDK
        // dispatches a slash command; mid-text it is literal characters. The rest of the message rides
        // as the command's argument. `name` is the frontmatter name, which is how the plugin registers
        // the skill (a prepend built from the directory id would target nothing when the two differ).
        const prompt = m.skill ? `/realm:${m.skill.name} ${m.text}` : m.text;
        /* The file list rides at the END of the text, after the user's own words and after the slash
           command's argument — a `/realm:name` only dispatches from position 0, and the list is the
           command's argument as much as the prose is. With no text at all it stands alone rather than
           being preceded by blank lines. */
        const fileList = fileListFor(m);
        const text = fileList ? (prompt ? `${prompt}\n\n${fileList}` : fileList) : prompt;
        // Attachment-only messages (Plan 14 W5): the Messages API rejects an empty text block, so one
        // is only included when there is text — and with the file list folded in above, an
        // attachment-only send of ordinary files now HAS text. The stub survives for the one case
        // left that would otherwise be literally empty content (which the API also rejects): a send
        // with neither words nor attachments the adapter can carry. The prompter's send-gate refuses
        // that up front, so this is the wire-level net.
        const content: Array<Record<string, unknown>> = [...(text ? [{ type: "text", text }] : []), ...images];
        if (content.length === 0) content.push({ type: "text", text: "(attached files)" });
        input.push({ type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage);
      },
      respondPermission: resolvePermission,
      interrupt: async () => {
        // Remembered until the result it produces arrives. The SDK reports a cancelled turn as an
        // ERROR result carrying its own diagnostic (`[ede_diagnostic] result_type=user …`), which is
        // true of the API call and useless to the person who pressed the button: they know why it
        // stopped. The flag is what lets the result branch tell "you cancelled this" apart from
        // "this failed", which nothing in the message itself can.
        interrupted = true;
        denyAllPending();
        try { await q?.interrupt(); } catch { /* process may already be gone; result/ended will report */ }
      },
      setOptions: async (o) => {
        if (o.model) await q?.setModel(o.model);
        // `fastMode` is a settings key, so the flag layer is how it moves mid-session — the same
        // layer `query()`'s inline `settings` writes, above user and project settings and below
        // managed policy. There is no `setFastMode`, and there does not need to be.
        if (o.fastMode !== undefined) await q?.applyFlagSettings({ fastMode: o.fastMode });
        if (o.permissionMode) {
          // Realm's own record moves FIRST: it is what the gate above reads, and it must hold even
          // if the SDK call throws.
          permissionMode = o.permissionMode;
          await q?.setPermissionMode(claudeSdkPermissionMode(o.permissionMode) as never);
        }
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        denyAllPending();
        input.close();
        abort.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([pumpDone.then(() => false), new Promise<boolean>((res) => { timer = setTimeout(() => res(true), DISPOSE_TIMEOUT_MS); })]);
        clearTimeout(timer);
        if (timedOut && !events.isClosed) { events.push(sessionEvent("status", { status: "ended" })); events.close(); }
      },
    };
  }
}
