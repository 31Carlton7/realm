import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import { query as sdkQuery, type EffortLevel, type Options, type PermissionResult, type PermissionUpdate, type SDKUserMessage, type Settings, type SpawnOptions, type SpawnedProcess, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ASK_PERMISSION_MODE, BROWSER_READ_ONLY_TOOLS, MAX_ATTACHMENT_BYTES, askCardFromAskUserQuestion, claudeAnswers, loggableAnswers, mergeWindows, newId, normalizeAnswers, planWindowLabel, sessionEvent, type AgentModel, type AskAnswers, type AskCard, type PlanAlert, type PlanWindow, type SessionEvent, type SessionEventPayload } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import { createSdkMapper, type ChainCursor } from "./map-sdk-message";
import { probeClaude } from "./probe";
import type { AgentAdapter, AgentHandle, McpServerConfig, PermissionDecision, ProbeResult, StartOptions, UserMessage } from "../types";

type QueryFn = typeof sdkQuery;
/** The keys `Settings` actually declares. The SDK's type ends in `[k: string]: unknown`, so a
 *  `satisfies Settings` passes any misspelling; this is the same type without that catch-all. */
type DeclaredSettings = { [K in keyof Settings as string extends K ? never : number extends K ? never : K]?: Settings[K] };
/** A model id without its bracketed variant: `claude-opus-5-5[1m]` is the 1M-context build of
 *  `claude-opus-5-5`, the same model to everything but the window. */
const modelBase = (id: string | undefined): string | undefined => id?.replace(/\[[^\]]*\]$/, "");

/**
 * The CLI's fast-mode answer for every model in its `supportedModels()` list, keyed the way a
 * prompter that has started nothing will ask: by the id a session would pin, or "" for the CLI's own
 * `default` row — what a session with no model runs.
 *
 * The same precedence `reportFastModeSupport` uses for one model, applied to all of them: an entry
 * naming the id itself outranks a context-window variant of it (`opus[1m]` → `claude-opus-5-5[1m]`),
 * and a variant only speaks for an id nothing else has named. Rows that state nothing are skipped —
 * silence is not a `no`.
 */
/** The levels the SDK's `effort` takes (`EffortLevel`). A session's level can come from another
 *  harness — Codex's `minimal`, kept across an agent switch — and that is one Claude has no word for. */
const CLAUDE_EFFORTS: ReadonlySet<string> = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);
const claudeEffort = (e: string | null | undefined): EffortLevel | undefined => (e && CLAUDE_EFFORTS.has(e) ? e as EffortLevel : undefined);

/**
 * The CLI's effort levels for every model in its `supportedModels()` list, keyed the way
 * `fastModeByModel` keys its answers. `supportsEffort: false` is an answer — no levels at all — and a
 * row that says nothing about effort is left out rather than filed as either.
 */
export function effortByModel(rows: readonly { value: string; resolvedModel?: string; supportsEffort?: boolean; supportedEffortLevels?: readonly string[] }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const levels = r.supportsEffort === false ? [] : Array.isArray(r.supportedEffortLevels) ? r.supportedEffortLevels.filter((l) => CLAUDE_EFFORTS.has(l)) : null;
    if (levels === null) continue;
    const isDefault = r.value === "default";
    if (isDefault) out[""] = levels;
    const base = modelBase(isDefault ? r.resolvedModel : r.resolvedModel ?? r.value);
    if (!base) continue;
    if (!isDefault && (r.value === base || r.resolvedModel === base)) out[base] = levels;
    else if (!(base in out)) out[base] = levels;
  }
  return out;
}

export function fastModeByModel(rows: readonly { value: string; resolvedModel?: string; supportsFastMode?: boolean }[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of rows) {
    if (typeof r.supportsFastMode !== "boolean") continue;
    const isDefault = r.value === "default";
    if (isDefault) out[""] = r.supportsFastMode;
    const base = modelBase(isDefault ? r.resolvedModel : r.resolvedModel ?? r.value);
    if (!base) continue;
    if (!isDefault && (r.value === base || r.resolvedModel === base)) out[base] = r.supportsFastMode;
    else if (!(base in out)) out[base] = r.supportsFastMode;
  }
  return out;
}

/**
 * The CLI's `supportedModels()` list as the rows a picker offers.
 *
 * The CLI lists a model under an alias where it has one (`sonnet`) and says which model that is
 * (`resolvedModel`). A row pins the resolved id, so a session stays on the model its row named after
 * the alias moves on to a newer one. The `default` row is not a model of its own: it names the model
 * a session that pinned nothing runs, and that model's row is marked rather than listed twice. A
 * default that no other row names still gets a row, under its id, so the mark always has one to land
 * on.
 *
 * The CLI prints a model's name without its vendor ("Opus 5.5"). The vendor goes back in front
 * because a model's identity across harnesses is its name (`canonicalModelKey`), and every other
 * source of that name — the curated list, the public catalog — says "Claude Opus 5.5".
 *
 * Effort and fast mode ride along only where a row states them. `supportsEffort: false` is a
 * statement, so it is an empty list rather than an absent one.
 */
export function claudeCatalog(rows: readonly { value: string; resolvedModel?: string; displayName?: string; supportsEffort?: boolean; supportedEffortLevels?: readonly string[]; supportsFastMode?: boolean }[]): AgentModel[] {
  const pinned = (r: { value: string; resolvedModel?: string }): string =>
    (typeof r.resolvedModel === "string" && r.resolvedModel.trim() !== "" ? r.resolvedModel : r.value);
  const listed = rows.filter((r) => typeof r?.value === "string" && r.value.trim() !== "");
  const unpinned = listed.find((r) => r.value === "default");
  const defaultId = unpinned && pinned(unpinned) !== "default" ? pinned(unpinned) : null;
  const named = listed.filter((r) => r.value !== "default");
  const ordered = unpinned && defaultId !== null && !named.some((r) => pinned(r) === defaultId)
    ? [{ ...unpinned, displayName: undefined }, ...named]
    : named;
  const out: AgentModel[] = [];
  const seen = new Set<string>();
  for (const r of ordered) {
    const id = pinned(r);
    if (seen.has(id)) continue;
    seen.add(id);
    const name = typeof r.displayName === "string" ? r.displayName.trim() : "";
    const label = name === "" ? id : /^claude\b/i.test(name) ? name : `Claude ${name}`;
    const efforts = r.supportsEffort === false ? [] : Array.isArray(r.supportedEffortLevels) ? r.supportedEffortLevels.filter((l) => CLAUDE_EFFORTS.has(l)) : null;
    out.push({
      id, label,
      ...(id === defaultId ? { isDefault: true } : {}),
      ...(efforts ? { efforts } : {}),
      ...(typeof r.supportsFastMode === "boolean" ? { fastMode: r.supportsFastMode } : {}),
    });
  }
  return out;
}

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

/** Who asks when Claude's own `AskUserQuestion` reaches the card. */
const CLAUDE_ASKER = { kind: "agent", name: "Claude", agent: "claude" } as const;

const STDERR_TAIL_LINES = 50;
const DISPOSE_TIMEOUT_MS = 3000;
/** How long the catalog handshake may run before the probe answers without a catalog. */
const CATALOG_TIMEOUT_MS = 10_000;

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

/** A session status, as this adapter says it. */
type ClaudeStatus = SessionEventPayload<"status">;

/** Everything a Claude session's status is decided from: three facts, and three marks on them. */
export type ClaudeTurnFacts = {
  /** Requests open: cards put to the person and not yet answered. */
  requests: number;
  /** A turn is in flight: sent, or opened by its own first output, and not yet closed by a `result`. */
  turn: boolean;
  /** A `result` closed a turn while a request was open, so that turn's settle waits for the card. */
  settleOwed: boolean;
  /** Stop was pressed on what the next `idle` ends: the turn it settles, or the cards it closes. */
  stopped: boolean;
  /**
   * Every turn the owed settle is for was the harness's own: Claude Code started it by itself, to
   * report on a background run, and no `result` since the last settle answered a message this
   * handle sent (`answeredBy`). The settle says so, because a reader that sends something at
   * every settle would otherwise send for a turn nobody asked for: a goal took its step when the
   * launching turn settled, and the report's settle bought a second one. One sent turn among
   * several that ended under one card leaves the settle unmarked, since that settle is also the
   * sent turn's.
   */
  unprompted: boolean;
  /** The handle was disposed with a settle still owed. Nothing more is said: `ended` is the last word. */
  abandoned: boolean;
};

/**
 * The one place a Claude session's status is decided. Every site that changes a fact asks here (a
 * send, a turn opening on its own output, a `result`, a request opening or closing, an `init`), and
 * the answer is null when it would only repeat `said`, the last status this handle gave:
 *
 *   | Requests open | Turn in flight           | Says                                           |
 *   |---------------|--------------------------|------------------------------------------------|
 *   | yes           | yes, or a settle is owed | `waiting_permission`                           |
 *   | yes           | no, and none owed        | `waiting_permission` with `betweenTurns`       |
 *   | no            | yes                      | `running`                                      |
 *   | no            | no, a settle is owed     | `idle`, the settle, with that turn's two marks |
 *   | no            | no, none owed            | `idle` with `betweenTurns`, only after a wait  |
 *
 * So a session with a card open says `waiting_permission` and nothing else, whatever happens
 * meanwhile, and a turn that ends under the card settles when the card is answered. The sites used
 * to push a status each by its own lights: a `result` said `idle` over an open card, which took the
 * card off the screen with its agent still waiting, and a card answered between turns said an `idle`
 * that every reader of a settle took for a turn ending.
 *
 * Two answers sit outside the table. `firstInit` is the start-of-life `idle`: a process whose
 * handshake arrives before anything was said is at rest, and says so once. And an `abandoned` settle
 * is never paid: the handle is going away, and an `idle` now would have the server send a queued
 * message, or a goal's next turn, into a process that is closing.
 */
export function claudeStatus(facts: ClaudeTurnFacts, said: ClaudeStatus | null, firstInit = false): ClaudeStatus | null {
  if (facts.abandoned) return null;
  const stopped = facts.stopped ? { interrupted: true } : {};
  const next: ClaudeStatus | null =
    facts.requests > 0 ? { status: "waiting_permission", ...(facts.turn || facts.settleOwed ? {} : { betweenTurns: true }) }
    : facts.turn ? { status: "running" }
    : facts.settleOwed ? { status: "idle", ...stopped, ...(facts.unprompted ? { unprompted: true as const } : {}) }
    : said?.status === "waiting_permission" ? { status: "idle", betweenTurns: true, ...stopped }
    : said === null && firstInit ? { status: "idle" }
    : null;
  if (!next) return null;
  const repeats = said !== null && said.status === next.status && said.betweenTurns === next.betweenTurns && said.interrupted === next.interrupted && said.unprompted === next.unprompted;
  return repeats ? null : next;
}

/**
 * What a Stop marks, from where the session stands when it is pressed.
 *
 * `latch` is the `interrupted` latch, which hides the cancelled turn's own diagnostic and marks its
 * settle as stopped. It is armed only when a `result` is coming to read it and clear it: a turn is
 * in flight, or Claude Code has begun one (an `init` since the last `result`) that has said nothing
 * yet. Armed with neither, it waited for a `result` that never came, since an interrupt between
 * turns produces none, and it marked the NEXT turn as stopped and hid that turn's real error.
 *
 * `cards` is the other thing a Stop can end: no turn is in flight but requests are open, so the
 * `idle` that closes them is what the person stopped. Marked `interrupted`, it keeps the queue
 * parked, because a queued message that started a turn a moment after Stop would read as the button
 * not working.
 */
export function stopMarks(at: { turn: boolean; begun: boolean; requests: number }): { latch: boolean; cards: boolean } {
  return { latch: at.turn || at.begun, cards: !at.turn && at.requests > 0 };
}

/**
 * Whether a message is a turn's own output: an `assistant` or a `stream_event` at the top level.
 *
 * It is what opens a turn nobody sent. Claude Code starts one by itself when a background run ends,
 * to report on it, and nothing but that turn's output says so, because `send` was never called. Not
 * the `system/init` before it: two runs that end together produce an `init` and a `result` with no
 * output between them, and a turn opened there would settle for nothing. And not a frame with a
 * parent: a background agent's own messages arrive while the session is at rest, and they belong
 * to its call.
 */
function isTurnOutput(msg: SDKMessage): boolean {
  return (msg.type === "assistant" || msg.type === "stream_event") && (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id === null;
}

/**
 * What a `result` does to the messages this handle has sent and not yet seen answered: which of
 * them it leaves, and whether it answered any.
 *
 * `sent` holds the uuid `send` gave each of those messages, oldest first. Claude Code names on a
 * `result` every sent message its turn consumed (`user_message_uuids`, or `user_message_uuid`
 * alone where there is no list), so whose turn a result closes is read off the result:
 *
 *   | The result                                            | Leaves                             | Answered |
 *   |-------------------------------------------------------|------------------------------------|----------|
 *   | names a message in `sent`                             | what was sent after the last named | yes      |
 *   | names none, and its origin is not `task-notification` | nothing                            | yes      |
 *   | names none, and its origin is `task-notification`     | all of `sent`                      | no       |
 *
 * The first row takes every message up to the last one named, named or not. Messages are consumed
 * in the order they were sent, so an earlier one that no result names was lost, and a session held
 * to it would wait for good. The second row is a turn somebody sent, closed by a producer that
 * names nothing, and everything sent is taken for answered, as it was for every result once. The
 * third is a turn the harness started by itself, to report on a background run or to note that it
 * took one's notification in and called the model for nothing. It consumed nothing of ours.
 *
 * This used to be guessed. Any result closed the turn in flight, so a report's result settled a
 * message that was answered in a turn of its own after it. And a settle was called the harness's
 * own by its result's origin alone, so a message folded into a report turn, whose one result has
 * that origin, settled as a turn nobody sent, and a goal that was not waiting for a report ignored
 * it and stalled.
 */
export function answeredBy(result: { user_message_uuids?: string[]; user_message_uuid?: string; origin?: { kind?: string } }, sent: readonly string[]): { left: string[]; answered: boolean } {
  const named = Array.isArray(result.user_message_uuids) ? result.user_message_uuids : typeof result.user_message_uuid === "string" ? [result.user_message_uuid] : [];
  const last = Math.max(-1, ...named.map((uuid) => sent.indexOf(uuid)));
  if (last >= 0) return { left: sent.slice(last + 1), answered: true };
  return result.origin?.kind === "task-notification" ? { left: [...sent], answered: false } : { left: [], answered: true };
}

/**
 * An event mapped from a `result`, with the `unprompted` mark taken off an error when that result
 * answered a message this handle sent.
 *
 * The mapper marks a failure by its result's origin, and a message folded into a report turn fails
 * with the report's origin. Left marked, the failure of a message somebody sent was kept from
 * failover as if nobody had sent it.
 */
function ownFailure(e: SessionEvent, answered: boolean): SessionEvent {
  if (e.type !== "error" || !answered || !e.payload.unprompted) return e;
  const { unprompted: _harness, ...payload } = e.payload;
  return { ...e, payload };
}

/**
 * Whether a Stop that is armed ends, at this `result`, whatever was sent and is still unanswered.
 *
 * Stop ends what was sent with the turn it stops. At that turn's result nothing sent is waited for
 * any longer, whichever messages the result names: with Stop pressed no later result may ever name
 * the rest, and a session held to them would read Running with nothing in flight.
 *
 * One result is not that turn's, and the Stop passes over it: Claude Code's note that it took in a
 * background task's notification and called the model for nothing. The note answers nothing of
 * ours, counts no turns (`num_turns` 0) and reports no failure. The result of the turn a Stop was
 * pressed on differs in at least one of the three: it names a message, counts the turns it ran, or
 * reports the cancellation as its failure.
 *
 * The note comes ahead of the turn a message started when a conversation resumes after a process
 * that died with a run still working, and when two runs end together. Spent on it, the latch was
 * gone when the stopped turn's own result arrived, and that turn settled unmarked with its cancel
 * diagnostic in the log as an error.
 */
function stopsAt(result: { num_turns?: unknown; subtype?: unknown; is_error?: unknown }, answered: boolean): boolean {
  const note = !answered && result.num_turns === 0 && result.subtype === "success" && result.is_error !== true;
  return !note;
}

/**
 * The mark on the failure this adapter writes itself, when the harness's stream ends or throws:
 * `unprompted` when a turn was in flight with no sent message unanswered (`sent` is whether one
 * is), in a session that has had a run in the background.
 *
 * Such a turn is the harness's report on that run. Unmarked, its failure went to failover, which
 * still held the last message a person sent and sent it again, and for a message that launched a
 * workflow that launched the workflow a second time. Only a turn in flight counts: `send` reads its
 * attachments before the turn is in flight, and a process that dies in that gap has failed a
 * message somebody did send. And only where a run was announced: with none there is nothing to
 * report on, and a turn that output opens is a second message the harness took in a turn of its
 * own. A message is unanswered until a result answers it (`answeredBy`), so one sent just before a
 * report, or into one, leaves the failure unmarked through the report and through its own turn
 * after it, and failover sends it again.
 */
export function streamEndMarks(at: { turn: boolean; sent: boolean; ranInBackground: boolean }): { unprompted?: true } {
  return at.turn && !at.sent && at.ranInBackground ? { unprompted: true } : {};
}

/**
 * Stop one background run, by the harness's own id for it (`AgentHandle.stopTask`).
 *
 * With no id there is nothing to send: the handle never announced that run, or has already seen it
 * stop, and asking the harness anyway would turn a press that came a moment late into a refusal.
 * `Query.stopTask` works as Realm runs, with no `perTaskStopAffordance` declared, and the option
 * must stay undeclared: with it an interrupt spares the session's background runs, and a run that
 * outlived Stop would start a turn by itself minutes after the button was pressed.
 *
 * A refusal is rethrown in Realm's words. The harness's own are about its task table, and this
 * message is what the person who pressed the control reads.
 */
async function stopRun(q: Query | null, taskId: string | undefined): Promise<void> {
  if (!q || !taskId) return;
  try { await q.stopTask(taskId); }
  catch { throw new Error("Claude Code could not stop that run."); }
}

/**
 * A message's text, split into the person's own words and what Realm appended to them.
 *
 * Claude Code takes a turn's prompt from the LAST content block alone, and only when that block is
 * text: a slash command is dispatched from there, and a keyword is read from there. So `send` puts
 * the person's words last, the images ahead of them, and Realm's context first, as a block of its
 * own. The context used to follow the words inside one block, with the images after it. A skill
 * called with a picture attached then never ran, because the last block was the picture and the
 * model was handed the literal `/realm:name`. And whatever a web page said sat in the block a
 * keyword is read from.
 *
 * `context` is that block: the appended tail, trimmed, or null where there is none. `words` is the
 * rest, which still takes the skill's prefix in front. The list of attached files follows it only
 * behind a slash command, as that command's argument. Ahead of any other words the list is a block
 * of its own, so that the last block holds nothing but what the person wrote (`send`).
 * `held` is false for a message that names a context its text does not end with. Nothing then says
 * where the person's words stop, so the text goes whole, in one block, as it always did.
 */
export function splitContext(m: Pick<UserMessage, "text" | "context">): { words: string; context: string | null; held: boolean } {
  const tail = m.context ?? "";
  if (!m.text.endsWith(tail)) return { words: m.text, context: null, held: false };
  return { words: m.text.slice(0, m.text.length - tail.length), context: tail.trim() || null, held: true };
}

/**
 * The mark that tells Claude Code a person sent a message as their own input, or nothing.
 *
 * Claude Code acts on some of what a message holds only when the host says a person gave it: the
 * `ultracode` keyword is read from the last block of a marked message, and from no other message.
 * So the mark vouches for that block, and three things must hold for it. The server says a person
 * sent the message (`human`). The person's own words are not empty: without them the last block is
 * a picture, or the list of attached files, which Realm wrote. And the split held (`splitContext`):
 * a context still inside the last block is Realm's text too, with a web page's words in it.
 *
 * With words, the last block is theirs alone, unless they are a slash command. `send` puts the
 * list of attached files ahead of them, because a file's name can be somebody else's words, and
 * Claude Code read the keyword out of one that stood in that block. Behind a slash command the
 * list still follows the words, and Claude Code reads no keyword from a block that starts with a
 * slash.
 *
 * The mark says who sent the message and nothing about what the session may do, so it is the same
 * in every permission mode. No `priority` goes with it: what Claude Code does with a marked
 * message that names one has not been seen, and has to be before one is added.
 */
function humanOrigin(m: Pick<UserMessage, "human">, own: { words: string; held: boolean }): { origin?: { kind: "human" } } {
  return m.human && own.held && own.words.trim() !== "" ? { origin: { kind: "human" } } : {};
}

/**
 * Whether Ultracode is in force for a session: asked for, and not in Ask.
 *
 * Ultracode has Claude plan every substantive task as a workflow of sub-agents, and an Ask session
 * refuses the `Workflow` call, which is no tool of reading or searching (`CLAUDE_ASK_BUILTINS`).
 * Told that Ultracode is on, Claude would write a workflow's script for each question and have its
 * launch refused. So Realm holds its request back while the session is in Ask, and makes it again
 * when the session leaves. The session keeps its switch throughout.
 */
function ultracodeEffective(requested: boolean, permissionMode: string): boolean {
  return requested && permissionMode !== ASK_PERMISSION_MODE;
}

/**
 * The flag layer a session starts with, or null where nothing is asked of it: fast mode, and
 * Ultracode where it is in force (`ultracodeEffective`).
 *
 * Null means no `settings` option at all. The layer sits above the person's own Claude Code
 * settings, so a key nobody asked for would lay a default of Realm's over a choice of theirs. Each
 * answer is written out as a literal, because a literal is what gets checked against the keys
 * `Settings` declares.
 */
function claudeStartSettings(asked: { fastMode: boolean; ultracode: boolean }): DeclaredSettings | null {
  if (asked.fastMode && asked.ultracode) return { fastMode: true, ultracode: true };
  if (asked.fastMode) return { fastMode: true };
  return asked.ultracode ? { ultracode: true } : null;
}

/** What one `setOptions` call writes to the flag layer. */
type ClaudeFlagSettings = { fastMode?: boolean; effortLevel?: EffortLevel | null; ultracode?: boolean };

/**
 * The one write a `setOptions` call makes to the flag layer, or null where it moves nothing there.
 *
 * One write for each call, holding every key the call moves: fast mode as given, and the level,
 * where `null` is the SDK's own "back to the model's default" and a level Claude has no word for is
 * left out. Ultracode goes with them by three rules. `effective` is whether it is in force once the
 * call has been taken in (`ultracodeEffective`), and `told` is whether the layer holds a `true`
 * that Realm wrote:
 *
 *   - `true`, whenever it is in force and the call presses the switch, moves the level, or finds
 *     the layer not yet told, as a session leaving Ask does. Beside the level every time, a reset
 *     included, because Claude Code switches Ultracode off when a level arrives without the key.
 *   - `false`, when it is not in force and the layer was told `true`: the switch pressed off, or a
 *     session going into Ask.
 *   - nothing otherwise. Realm writes `false` only over a `true` of its own. The layer cannot hand
 *     the key back to the person's settings file, so a `false` for a session whose switch was
 *     never on would switch off what they had set for themselves.
 *
 * `setOptions` works this write out once the model is set, in the step that sends it, and records
 * what it says of Ultracode before the write is made (`ultracodeRecord`). Two calls that overlap
 * then record in the order they write, each from the newest record, and a call whose model the
 * harness refuses records nothing. Worked out before the wait on the model, the record would say
 * what no write had said yet, and a press that landed during the wait would be measured against it.
 *
 * A call that names a permission mode asks the harness for it first, in the tick that moves Realm's
 * own record of the mode. The model and this write come after. With the switch on, a move into Ask
 * or out of it changes whether Ultracode is in force, so the same call can make this write. If the
 * mode request came after that write, a refused write would skip it and a slow one would delay it.
 * A later call's request could then overtake it. Because the request goes first, nothing in the
 * call can hold it back or fail before it. Two calls ask in the order they were made, so the mode
 * the harness was last asked for is the one Realm holds. If the harness refuses the mode request,
 * the call fails before it tries its model or its write.
 */
function claudeFlagSettings(o: { fastMode?: boolean; effort?: string | null; ultracode?: boolean }, ultracode: { effective: boolean; told: boolean }): ClaudeFlagSettings | null {
  const level = o.effort === undefined ? undefined : o.effort === null ? null : claudeEffort(o.effort);
  const on = ultracode.effective && (o.ultracode !== undefined || level !== undefined || !ultracode.told);
  const off = !ultracode.effective && ultracode.told;
  const flags: ClaudeFlagSettings = {
    ...(o.fastMode === undefined ? {} : { fastMode: o.fastMode }),
    ...(level === undefined ? {} : { effortLevel: level }),
    ...(on ? { ultracode: true } : off ? { ultracode: false } : {}),
  };
  return Object.keys(flags).length > 0 ? flags : null;
}

/**
 * What Realm believes the flag layer holds for Ultracode, kept right through writes that overlap
 * and writes the harness refuses.
 *
 * `held` is what the last write the harness took left there, or what the session started with.
 * `sent` are the writes that carry the key and still wait for their answer, in the order they
 * went. The harness applies writes in that order, so the layer will hold what the last of them
 * says unless that one is refused, and `told` answers with that.
 *
 * A write the harness takes becomes `held`, unless one sent after it was taken first. The writes
 * sent before it drop out whatever their answers turn out to be, because it was applied after them.
 * A write the harness refuses drops out alone. If it was the last one sent, the answer falls back
 * to the write before it, or to `held`. One value that a refused call puts back is not enough for
 * this. Once a second write is sent before the first is answered, the second call's "before" is the
 * first call's unanswered write.
 */
function ultracodeRecord(start: boolean): { told(): boolean; write(value: boolean): { taken(): void; refused(): void } } {
  let held = start;
  const sent: { value: boolean }[] = [];
  return {
    told: () => (sent.length > 0 ? sent[sent.length - 1]!.value : held),
    write(value) {
      const entry = { value };
      sent.push(entry);
      return {
        taken() {
          const at = sent.indexOf(entry);
          if (at < 0) return;
          held = value;
          sent.splice(0, at + 1);
        },
        refused() {
          const at = sent.indexOf(entry);
          if (at >= 0) sent.splice(at, 1);
        },
      };
    },
  };
}

/**
 * What the harness says about Ultracode in this session, or null where it gives no answer: whether
 * the session can run it (`ultracodeAvailable`), and whether the harness reads the keyword
 * `ultracode` in a message a person sent (`ultracodeKeyword`).
 *
 * `getSettings` answers with the settings Claude Code has merged (`effective`) and with what it has
 * applied (`applied`), so the one call answers both. `applied.ultracodeAvailable` is false where
 * workflows are switched off, or where the session's model cannot run it. An answer that does not
 * say so as a boolean leaves that fact out, and the switch stays a request, with no claim either way.
 *
 * The keyword is read where workflows are enabled and the keyword's own trigger is not switched
 * off, whatever the model. `effective.workflowKeywordTriggerEnabled` is there only where some
 * settings layer sets it, so anything but `false` is the trigger left on. No field of the answer
 * says that workflows are enabled without also asking about the model, so that half is read off
 * `tools`, the handshake's own list: the harness lists its `Workflow` tool exactly when workflows
 * are enabled. An answer therefore always settles the keyword.
 *
 * The SDK's types do not declare the call, so it is reached the way `readPlanLimits` reaches its
 * own: looked for first, and every failure read as silence. A build without the call, a CLI that
 * declines it and an answer that is no object all say nothing of either fact.
 *
 * Asked after every `init`, since the harness sends one for each turn and a reader keeps the newest,
 * and never from `setOptions`, where a CLI slow to answer would hold up the press behind it. An
 * answer restates `init` once, with whichever of the two facts it holds, in an event of its own,
 * apart from the one that carries the fast-mode facts, so that a `getSettings` which never answers
 * holds nothing else back. An answer that lands after a newer `init` restates nothing. It would put
 * the older handshake's session id and model over the newer one's.
 */
async function ultracodeFacts(q: Query | null, tools: readonly string[]): Promise<{ ultracodeAvailable?: boolean; ultracodeKeyword: boolean } | null> {
  const ask = (q as { getSettings?: () => Promise<unknown> } | null)?.getSettings;
  if (typeof ask !== "function") return null;
  try {
    const answer = await ask.call(q) as { effective?: { workflowKeywordTriggerEnabled?: unknown } | null; applied?: { ultracodeAvailable?: unknown } | null } | null;
    if (typeof answer !== "object" || answer === null) return null;
    const can = answer.applied?.ultracodeAvailable;
    return {
      ...(typeof can === "boolean" ? { ultracodeAvailable: can } : {}),
      ultracodeKeyword: answer.effective?.workflowKeywordTriggerEnabled !== false && tools.includes("Workflow"),
    };
  } catch {
    return null;
  }
}

/** Claude adapter on the Agent SDK in streaming-input mode. `canUseTool` is bridged to permission_request/response events. */
export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  private queryFn: QueryFn;
  private probeCli: () => ReturnType<typeof probeClaude>;
  private catalogTimeoutMs: number;
  /** `probe` and `catalogTimeoutMs` are seams for the suite; production passes neither. */
  constructor(deps: { query?: QueryFn; probe?: () => ReturnType<typeof probeClaude>; catalogTimeoutMs?: number } = {}) {
    this.queryFn = deps.query ?? sdkQuery;
    this.probeCli = deps.probe ?? (() => probeClaude());
    this.catalogTimeoutMs = deps.catalogTimeoutMs ?? CATALOG_TIMEOUT_MS;
  }

  /**
   * Whether `claude` runs and is signed in, and the models it offers.
   *
   * A CLI that says it is signed out is not asked for its catalog: no session can start on it, and
   * the sign-in card is what the prompter shows instead of a picker.
   */
  async probe(): Promise<ProbeResult> {
    const p = await this.probeCli();
    const models = p.available && p.loggedIn !== false ? await this.listModels() : null;
    return { kind: this.kind, ...p, models };
  }

  /**
   * The live model catalog, read off the handshake a query makes before any prompt is sent.
   *
   * No turn runs and nothing is billed: the prompt stream stays empty, and it is closed once the list
   * is in hand. The query is isolated from the user's own settings (`settingSources: []`), so no
   * hook, plugin or MCP server of theirs starts for a probe, and it leaves no transcript behind
   * (`persistSession: false`). It runs the binary every session runs — the SDK's own unless
   * REALM_CLAUDE_BIN names another — so the list is what that binary can run, which is the one thing
   * a curated list could never promise.
   *
   * `null` on ANY failure — a spawn that died, a CLI that declined the request, an empty list, a
   * handshake that outlasted its timeout — because the picker has the curated list to fall back on
   * and a failed enumeration must never fail the probe that carries availability.
   */
  private async listModels(): Promise<AgentModel[] | null> {
    const input = new AsyncQueue<SDKUserMessage>();
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const q = this.queryFn({ prompt: input, options: {
        cwd: tmpdir(), settingSources: [], persistSession: false, abortController: abort,
        stderr: () => {}, pathToClaudeCodeExecutable: process.env.REALM_CLAUDE_BIN,
      } });
      const rows = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("the catalog handshake timed out")), this.catalogTimeoutMs); }),
      ]);
      const models = claudeCatalog(rows);
      return models.length > 0 ? models : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      input.close();
      abort.abort();
    }
  }

  start(opts: StartOptions & ClaudeResumeFork): ClaudeHandle {
    const events = new AsyncQueue<SessionEvent>();
    const input = new AsyncQueue<SDKUserMessage>();
    const pending = new Map<string, { resolve: (r: PermissionResult) => void; suggestions: PermissionUpdate[]; input: Record<string, unknown>; ask: AskCard | null; once: boolean }>();
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
    let settleOwed = false;
    let stopped = false;
    let abandoned = false;
    let prompted = false;
    let turnBegun = false;
    let sent: string[] = [];
    let ranInBackground = false;
    let said: ClaudeStatus | null = null;
    /* Fast mode as ASKED: what the session wants right now, and what the turn in flight was sent
       under. Two, because a switch flipped mid-turn is about the NEXT turn — the report this turn
       ends with describes the old request, and has to say so or a stale refusal reads as a fresh
       one. */
    let fastRequested = opts.fastMode === true;
    let turnFast = fastRequested;
    let ultracodeRequested = opts.ultracode === true;
    const startSettings = claudeStartSettings({ fastMode: opts.fastMode === true, ultracode: ultracodeEffective(ultracodeRequested, permissionMode) });
    const ultracodeLayer = ultracodeRecord(startSettings?.ultracode === true);
    let handshakes = 0;

    const onStderr = (data: string) => {
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        opts.onLog?.(line);
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    };
    const withStderr = (message: string) => (stderrTail.length ? `${message}\n--- stderr (last ${stderrTail.length} lines) ---\n${stderrTail.join("\n")}` : message);

    const tellStatus = (firstInit = false) => {
      const next = claudeStatus({ requests: pending.size, turn: running, settleOwed, stopped, abandoned, unprompted: !prompted }, said, firstInit);
      if (!next) return;
      said = next;
      if (next.status === "idle") { settleOwed = false; stopped = false; prompted = false; }
      events.push(sessionEvent("status", next));
    };

    // `answers` (AskUserQuestion) rides back as `updatedInput`: the SDK reads the user's choices off the
    // tool's own arguments, so answering a question IS allowing the call with the answers filled in.
    // They are held to the card first, and the log keeps a mark where a masked one was: the answer goes
    // to Claude, who asked for it, but `permission_response` is persisted and broadcast to every window.
    const resolvePermission = (requestId: string, d: PermissionDecision, answers?: AskAnswers) => {
      const p = pending.get(requestId); if (!p) return;
      pending.delete(requestId);
      const decision: PermissionDecision = d === "allow_always" && p.once ? "allow" : d;
      const given = p.ask && answers ? normalizeAnswers(p.ask, answers) : undefined;
      events.push(sessionEvent("permission_response", { requestId, decision, ...(p.ask && given ? { answers: loggableAnswers(p.ask, given) } : {}) }));
      if (decision === "deny") p.resolve({ behavior: "deny", message: "User denied" });
      else if (decision === "allow_always") p.resolve({ behavior: "allow", updatedPermissions: p.suggestions });
      else p.resolve({ behavior: "allow", ...(given ? { updatedInput: { ...p.input, answers: claudeAnswers(given) } } : {}) });
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
      const once = suggestions.length === 0 || o.suppressAlwaysAllowRule === true;
      // A question travels on this channel too, and is marked as one HERE — from the SDK's own tool
      // name, never from anything in its arguments — so the card that draws it is the question card.
      const ask = toolName === "AskUserQuestion" ? askCardFromAskUserQuestion(toolInput, CLAUDE_ASKER) : null;
      let resolve!: (r: PermissionResult) => void;
      const answered = new Promise<PermissionResult>((res) => { resolve = res; });
      pending.set(requestId, { resolve, suggestions, input: toolInput as Record<string, unknown>, ask, once });
      tellStatus();
      events.push(sessionEvent("permission_request", { requestId, toolName, input: toolInput, title: o.title ?? `Allow ${toolName}?`, suggestions: suggestions as unknown[], ...(ask ? { ask } : {}), ...(once ? { once: true as const } : {}) }));
      o.signal.addEventListener("abort", () => {
        if (!pending.delete(requestId)) return;
        events.push(sessionEvent("permission_response", { requestId, decision: "deny" }));
        resolve({ behavior: "deny", message: "aborted" });
      }, { once: true });
      const result = await answered;
      tellStatus();
      return result;
    };

    const options: Options = {
      cwd: opts.cwd,
      model: opts.model ?? undefined,
      effort: claudeEffort(opts.effort),
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
      //
      // Inside `settings`, which is the flag layer, and NOT as a top-level option. `fastMode` is a
      // Settings key; `Options` has no field of that name, so the top-level spread this used to be
      // was dropped without a word and no session ever started fast. The CLI's own gate is the
      // reason it has to be this layer: running under the SDK, fast mode is offered only when
      // `flagSettings.fastMode === true`, and otherwise every turn reports `sdk_opt_in_required`.
      // Checked against the keys `Settings` declares, because nothing else would check it: a spread
      // is never checked for excess keys (the old line compiled), and `Settings` takes any key.
      ...(startSettings ? { settings: startSettings } : {}),
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
        // Exact first, then the same model under another context window. The CLI lists some models
        // ONLY as a variant — Opus 5.5 appears as `default` and `opus[1m]`, both resolving to
        // `claude-opus-5-5[1m]` — so a session that picked plain `claude-opus-5-5` was never found,
        // and its Speed control never appeared at all. The CLI serves fast mode on the plain id
        // (checked live: `fast_mode_state: "on"`). An entry naming this very id still wins over a
        // variant of it.
        const base = modelBase(init.model);
        const hit = rows.find((r) => r.value === init.model || r.resolvedModel === init.model)
          ?? rows.find((r) => modelBase(r.value) === base || modelBase(r.resolvedModel) === base);
        const all = fastModeByModel(rows);
        const efforts = effortByModel(rows);
        if (hit?.supportsFastMode === undefined && Object.keys(all).length === 0 && Object.keys(efforts).length === 0) return;
        events.push(sessionEvent("init", { ...init,
          ...(hit?.supportsFastMode === undefined ? {} : { supportsFastMode: hit.supportsFastMode }),
          ...(Object.keys(all).length > 0 ? { fastModeModels: all } : {}),
          ...(Object.keys(efforts).length > 0 ? { effortModels: efforts } : {}) }));
      } catch { /* the CLI declined; the capability stays unstated */ }
    };

    /** A utilization percentage, or null for anything that is not a finite number — the SDK types
     *  these as nullable and a `null` drawn as 0% would read as an empty window. */
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    /** The control request's `resets_at`, an ISO-8601 string ("ISO 8601 timestamp when the window
     *  resets" in the CLI's own schema), as epoch ms. */
    const millis = (v: unknown): number | null => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v !== "string") return null;
      const t = Date.parse(v);
      return Number.isNaN(t) ? null : t;
    };

    /**
     * The stream's `rate_limit_info` is the API's rate-limit headers, in their units, which are not the
     * control request's: `utilization` is a FRACTION (the CLI draws it as `Math.floor(utilization *
     * 100)`) and `resetsAt` is epoch SECONDS (it waits until `resetsAt * 1000`). The control request
     * answers in percent and ISO strings. Read as if they matched, an 86% week showed as "at 1%" and
     * its reset as a day in January 1970 — so the stream's reading is put in the panel's units here,
     * before the two are merged into one window.
     */
    const streamPercent = (v: unknown): number | null => { const n = num(v); return n === null ? null : n * 100; };
    const streamMillis = (v: unknown): number | null => { const n = num(v); return n === null ? null : n * 1000; };

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

    /** Set by `interrupt` when a turn is there to stop, read and cleared by the result it produces.
     *  Declared ahead of `pump` so the loop's closure can never read it in its temporal dead zone. */
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
            const handshake = {
              providerSessionId: String(i.session_id ?? ""), model: String(i.model ?? ""),
              tools: Array.isArray(i.tools) ? i.tools.map(String) : [], cwd: String(i.cwd ?? opts.cwd),
            };
            const turn = ++handshakes;
            void reportFastModeSupport(handshake);
            void ultracodeFacts(q, handshake.tools).then((said) => { if (said !== null && !disposed && turn === handshakes) events.push(sessionEvent("init", { ...handshake, ...said })); });
            // The plan panel should be answerable before any limit moves, so it is read once here
            // rather than waiting for the first `rate_limit_event` — which on a quiet account may
            // never come. Off the message loop, like the fast-mode probe above it.
            void readPlanLimits().then((p) => { if (p && !disposed) events.push(sessionEvent("rate_limit", p)); }).catch(() => {});
            turnBegun = true;
            tellStatus(true);
            continue;
          }
          if (msg.type === "result") {
            // A cancelled turn still reports its usage — the tokens were spent — but its error is
            // the cancellation, and that is what the settle below says instead.
            let usage: SessionEventPayload<"usage"> | null = null;
            const named = answeredBy(msg, sent);
            for (const mapped of mapper.map(msg)) {
              if (interrupted && mapped.type === "error") continue;
              let e = ownFailure(mapped, named.answered);
              if (e.type === "usage") {
                // Stamped here rather than in the mapper, which sees only the SDK's message and not
                // what this session asked for. Carried on the persisted event, so a transcript read
                // back after a restart still knows which request a refusal was about.
                e = sessionEvent("usage", { ...e.payload, fastModeRequested: turnFast });
                usage = e.payload;
              }
              events.push(e);
            }
            // Off the message loop: the meter is worth a beat of lateness and nothing else on this
            // wire is worth holding up for it. The restated event lands whenever the CLI answers.
            if (usage) void reportContextUsage(usage);
            sent = interrupted && stopsAt(msg, named.answered) ? [] : named.left;
            const kept = running && sent.length > 0;
            const closed = running && !kept;
            if (running && named.answered) prompted = true;
            if (!kept) running = false;
            sawResult = true; turnBegun = false;
            if (closed) settleOwed = true;
            if (closed && interrupted) stopped = true;
            tellStatus();
            // Cleared on the SAME result that read it, so the latch cannot outlive the turn it was
            // armed for and silence a genuine failure on the next one.
            if (!kept) interrupted = false;
            continue;
          }
          if (msg.type === "rate_limit_event") {
            const info = (msg as { rate_limit_info?: Record<string, unknown> }).rate_limit_info ?? {};
            const status = info.status;
            const alert: PlanAlert = status === "rejected" ? "exceeded" : status === "allowed_warning" ? "approaching" : "none";
            const id = typeof info.rateLimitType === "string" ? info.rateLimitType : null;
            const window: PlanWindow[] = id
              ? [{ id, label: planWindowLabel(id), utilization: streamPercent(info.utilization), resetsAt: streamMillis(info.resetsAt) }]
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
          if (!running && isTurnOutput(msg)) {
            running = true;
            turnFast = fastRequested;
            tellStatus();
          }
          for (const e of mapper.map(msg)) {
            if (e.type === "background_task" && e.payload.status === "running") ranInBackground = true;
            events.push(e);
          }
        }
        // Generator ended on its own: abnormal unless we asked for it or it ended cleanly between turns.
        if (!disposed && (running || !sawResult)) failure = "agent process ended unexpectedly";
      } catch (e) {
        // The SDK rejects iteration with "Claude Code process aborted by user" when our abortController fires in dispose(); not an error.
        if (!disposed && !abort.signal.aborted) failure = (e as Error).message ?? String(e);
      } finally {
        denyAllPending();
        if (failure !== null) {
          events.push(sessionEvent("error", { message: withStderr(failure), ...streamEndMarks({ turn: running, sent: sent.length > 0, ranInBackground }) }));
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
        turnFast = fastRequested;
        tellStatus();
        const own = splitContext(m);
        // A resolved @-mention (W4) becomes `/realm:<name>` at POSITION 0 — the only place the SDK
        // dispatches a slash command; mid-text it is literal characters. The person's own words ride
        // as the command's argument. `name` is the frontmatter name, which is how the plugin registers
        // the skill (a prepend built from the directory id would target nothing when the two differ).
        const prompt = m.skill ? `/realm:${m.skill.name} ${own.words}` : own.words;
        /* The file list rides at the END of the text only behind a slash command. A `/realm:name`
           only dispatches from position 0, and the list is the command's argument as much as the
           prose is. Behind any other words it would put a file's name in the block Claude Code reads
           a keyword from, and the person never typed that name. There it goes ahead of the pictures,
           as a block of its own. Claude Code reads no keyword from a block that starts with a slash. */
        const fileList = fileListFor(m);
        const command = prompt.startsWith("/");
        const text = command && fileList ? `${prompt}\n\n${fileList}` : prompt;
        const ahead = [...(own.context ? [{ type: "text", text: own.context }] : []), ...(fileList && !command ? [{ type: "text", text: fileList }] : []), ...images];
        // Attachment-only messages (Plan 14 W5): the Messages API rejects a text block that is empty
        // or only blank space, so the words are only included when they are more than that. Words of
        // blank space that are all a message has still go as they always did. With the file list a
        // block of its own, an attachment-only send of ordinary files still HAS text. The stub
        // survives for the one case left that would otherwise be literally empty content (which the
        // API also rejects): a send with neither words nor attachments the adapter can carry. The
        // prompter's send-gate refuses that up front, so this is the wire-level net.
        const content: Array<Record<string, unknown>> = [...ahead, ...(text.trim() !== "" || (text !== "" && ahead.length === 0) ? [{ type: "text", text }] : [])];
        if (content.length === 0) content.push({ type: "text", text: "(attached files)" });
        const uuid = randomUUID();
        sent.push(uuid);
        input.push({ type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null, session_id: "", uuid, ...humanOrigin(m, own) } as SDKUserMessage);
      },
      respondPermission: resolvePermission,
      interrupt: async () => {
        // Remembered until the result it produces arrives. The SDK reports a cancelled turn as an
        // ERROR result carrying its own diagnostic (`[ede_diagnostic] result_type=user …`), which is
        // true of the API call and useless to the person who pressed the button: they know why it
        // stopped. The flag is what lets the result branch tell "you cancelled this" apart from
        // "this failed", which nothing in the message itself can.
        const marks = stopMarks({ turn: running, begun: turnBegun, requests: pending.size });
        if (marks.latch) interrupted = true;
        if (marks.cards) stopped = true;
        denyAllPending();
        try { await q?.interrupt(); } catch { /* process may already be gone; result/ended will report */ }
      },
      stopTask: (toolUseId: string) => stopRun(q, mapper.taskIdOf(toolUseId)),
      setOptions: async (o) => {
        // Realm's own record moves FIRST: it is what the gate above reads, and it must hold even
        // if the SDK call throws.
        if (o.permissionMode) permissionMode = o.permissionMode;
        if (o.ultracode !== undefined) ultracodeRequested = o.ultracode;
        if (o.permissionMode) await q?.setPermissionMode(claudeSdkPermissionMode(o.permissionMode) as never);
        if (o.model) await q?.setModel(o.model);
        // `fastMode` is a settings key, so the flag layer is how it moves mid-session — the same
        // layer `query()`'s inline `settings` writes, above user and project settings and below
        // managed policy. There is no `setFastMode`, and there does not need to be.
        if (o.fastMode !== undefined) fastRequested = o.fastMode;
        const flags = claudeFlagSettings(o, { effective: ultracodeEffective(ultracodeRequested, permissionMode), told: ultracodeLayer.told() });
        const write = flags?.ultracode === undefined ? null : ultracodeLayer.write(flags.ultracode);
        try {
          // The level moves the same way. `effortLevel: null` is the SDK's own "back to the model's
          // default effort" (`applyFlagSettings`), which is what a reset in the picker means; a level the
          // SDK has no word for is not sent at all.
          if (flags) await q?.applyFlagSettings(flags);
        } catch (e) {
          write?.refused();
          throw e;
        }
        write?.taken();
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        abandoned = settleOwed;
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
