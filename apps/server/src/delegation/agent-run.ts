import { z } from "zod";
import { AGENT_SKILL_SUPPORT, AgentKindSchema, AgentRunConstraintsSchema, MAX_DELEGATION_DEPTH, type AgentKind, type Environment } from "@realm/contracts";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { fenceAgentOutput } from "../browsers/guards";
import { cleanupWorktree, errorMessage, resolveAgentKind, resolveEnvironment, resolveSkillSubset, type EnvironmentDeps } from "./dispatch";
import type { ProviderCallContext } from "../mcp/gateway";
import { clip, err, ok } from "../mcp/tool-result";
import type { RpcServer } from "../rpc/server";
import { titleFromMessage, type SessionService } from "../sessions/service";
import type { SkillsService } from "../skills/service";
import { MAX_RUNS_PER_PARENT, type ActiveRun, type DelegationEngine, type SettledRun } from "./engine";

export const AGENT_RUN_TOOL_NAME = "agent_run";
export const AGENT_START_TOOL_NAME = "agent_start";
export const AGENT_WAIT_TOOL_NAME = "agent_wait";
export const AGENT_STATUS_TOOL_NAME = "agent_status";

/** The four names as one list — the provider's tool filter and the depth-budget refusals both need
 *  "is this one of the delegation tools", and two hand-written lists is how they drift apart. */
export const AGENT_RUN_FAMILY = [AGENT_RUN_TOOL_NAME, AGENT_START_TOOL_NAME, AGENT_WAIT_TOOL_NAME, AGENT_STATUS_TOOL_NAME] as const;

/** The persisted mark of an `agent_run` child session — same posture as `browserAgent.child:` (in
 *  the settings KV, Realm's own DB) so a child that survives a server restart is STILL excluded from
 *  delegation when resumed. Keyed by the child's session id; removed only when that session is
 *  deleted. */
const childKey = (sessionId: string): string => `agentRun.child:${sessionId}`;

/** Settle budget when `timeoutMs` is not given: a base for model latency plus a slice per allowed
 *  "turn" (`maxTurns` — a TIME scale, stated honestly: no adapter seam counts turns). The defaults
 *  give 60s + 20×30s = 11 minutes, roomier than the browser agent's because a general task edits
 *  files and runs commands rather than clicking one page. */
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_TIMEOUTS = { baseMs: 60_000, perTurnMs: 30_000, pollMs: 250 };

/** What `agentRun.child:<id>` stores. `skills: null` = no narrowing (the space's full enabled set).
 *
 *  `depth` is how far down the delegation tree this child sits (its parent's depth + 1, so a child of
 *  a root session is 1). It is PERSISTED rather than recomputed by walking `parentSessionId` upwards:
 *  a parent can be deleted while its child runs on, and a depth that silently resets to 1 when an
 *  ancestor disappears would hand a grandchild a fresh budget. Records written before this field
 *  existed parse as depth 1 — the depth every child had under the old flat rule. */
export type AgentChildRecord = {
  parentSessionId: string;
  goal: string;
  skills: string[] | null;
  depth: number;
};

const RunArgs = z.object({
  goal: z.string().min(1).max(8000),
  constraints: AgentRunConstraintsSchema.optional(),
});

/**
 * `agent_wait`'s arguments.
 *
 * `handles` omitted means "everything this session started" — an agent that lost track of its handles
 * is never stuck holding uncollectable children.
 *
 * `timeoutMs` bounds the LISTENING, not the children: it defaults generously (15 minutes) and giving
 * up on it leaves every child running under the budget its own `agent_start` set. That asymmetry is
 * stated in the tool description too, because "timed out" reading as "stopped" is the one
 * misunderstanding that would make a parent spawn a duplicate of a child still doing the work.
 */
const WaitArgs = z.object({
  handles: z.array(z.string().min(1)).min(1).max(MAX_RUNS_PER_PARENT).optional(),
  mode: z.enum(["all", "any"]).default("all"),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).default(900_000),
});

type SettingsLike = { get(key: string): unknown; set(key: string, value: unknown): void };

/** More restrictive = lower. Used only to CAP: the child never gets a laxer mode than the parent
 *  effectively has, and `bypassPermissions` is unreachable through this table because a requested
 *  bypass is degraded to `default` before ranking and a bypass PARENT is capped to `default` first
 *  (the browser agent's rule, verbatim). An unranked mode (an adapter-specific string) ranks as
 *  `default` — capping math over an unknown mode should fail toward asking, not toward access.
 *
 *  `ask` TIES with `plan` rather than sitting beside it. They are two different read-only modes, not
 *  two rungs of one ladder: neither lets the child change anything, so capping a child of one to the
 *  other is safe in both directions, and giving either a lower number would claim an ordering between
 *  them that does not exist. */
const MODE_RANK: Record<string, number> = { plan: 0, ask: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 };
const rank = (mode: string): number => MODE_RANK[mode] ?? 1;

/**
 * Plan 13 W1: `agent_run` — general task delegation, `browser_agent_run`'s proven shape opened up to
 * ANY task. Same bones (a delegated child is a REAL, visible Realm session in the caller's space;
 * the shared `DelegationEngine` owns the settle/drain and the one-run-per-parent registry), with the
 * two deliberate differences the plan names:
 *
 *   - **Full toolset.** An `agent_run` child gets its space's NORMAL session surface — the space's
 *     effective MCP servers and skills (Plan 12 scoping), its own environment — via the gateway's
 *     exclude-mode toolset (`{ exclude: ["realm-agent"] }`): everything minus the delegation
 *     provider itself, which is the gateway half of depth-1. `constraints.skills` NARROWS the skill
 *     set (subset of enabled; unknown ids refuse the whole call loudly) through
 *     `SkillsService.injectionFor`'s `narrow` seam — per-session staged, never touching the space's
 *     shared stage.
 *   - **An environment of its own.** `constraints.environmentId` runs the child in an existing
 *     environment (same-space, guarded here AND in `SessionsStore.create`); `newWorktree` creates
 *     one through Plan 7's `EnvironmentService.createWorktree`; neither means the space primary.
 *     The child session is BORN with it (`sessions.create`'s `environmentId`) — no rebind dance.
 *
 * **The safety lines, carried over verbatim and non-negotiable:** `bypassPermissions` is never
 * inherited NOR grantable — a bypass parent's child caps at `default`, and a requested bypass
 * degrades to `default` with the degradation stated in the result. Every granted mode is
 * min(parent's effective mode, requested). Depth-1: a delegated child (of EITHER tool) sees neither
 * `agent_run` nor `browser_agent_run` — enforced by the gateway toolset shape, by the provider's
 * child check, and re-checked here. Parent interrupt cancels (the engine's cancelled-wins drain).
 */
export class AgentRunService {
  constructor(private readonly d: {
    settings: SettingsLike;
    sessions: Pick<SessionService, "create" | "send" | "get" | "events" | "interrupt">;
    rpc: Pick<RpcServer, "broadcast">;
    /** The shared settle/drain + run registry — the SAME instance `BrowserAgentService` uses. */
    engine: DelegationEngine;
    environments: EnvironmentDeps;
    skills: Pick<SkillsService, "list" | "discardStage">;
    /** The OTHER delegation registry (browser-agent children) — the depth-1 refusal must cover a
     *  browser child that somehow names this tool, not only agent_run's own children. */
    otherDelegation?: { isChild(sessionId: string): boolean };
    /** Child agent kind when the parent's kind has no skills-injection route — claude in
     *  production; tests override to keep the whole run on the fake. */
    fallbackKind?: AgentKind;
    timeouts?: { baseMs: number; perTurnMs: number; pollMs: number };
    /** Tests lower this to 1 to prove the budget refuses, and raise it to prove a grandchild spawns.
     *  Production takes `MAX_DELEGATION_DEPTH`. */
    maxDepth?: number;
  }) {}

  /* ------------------------------ the seams other code consults ------------------------------ */

  private childRecord(sessionId: string): AgentChildRecord | null {
    const v = this.d.settings.get(childKey(sessionId));
    if (!v || typeof v !== "object") return null;
    const r = v as Partial<AgentChildRecord>;
    if (typeof r.parentSessionId !== "string" || typeof r.goal !== "string") return null;
    return {
      parentSessionId: r.parentSessionId,
      goal: r.goal,
      skills: Array.isArray(r.skills) ? r.skills.filter((x): x is string => typeof x === "string") : null,
      // A pre-depth record (written by a build before the budget existed) reads as 1. Never 0: 0 is
      // "not a child at all", and a child that claims to be a root gets the full budget again.
      depth: typeof r.depth === "number" && Number.isFinite(r.depth) && r.depth >= 1 ? Math.floor(r.depth) : 1,
    };
  }

  isChild(sessionId: string): boolean {
    return this.childRecord(sessionId) !== null;
  }

  /** How deep this session sits in the delegation tree: 0 for a session nobody delegated, its
   *  parent's depth + 1 for a child. The one place depth is read from. */
  depthOf(sessionId: string): number {
    return this.childRecord(sessionId)?.depth ?? 0;
  }

  /** Whether this session has delegation budget left. The gateway consults it to decide whether to
   *  hide the `realm-agent` provider from a child entirely, the provider consults it to decide which
   *  tools to list, and `run`/`start` re-check it before spawning — the same three-guard shape the
   *  flat depth-1 rule had, now asking a budget question instead of a boolean one. */
  canDelegate(sessionId: string): boolean {
    return this.depthOf(sessionId) < this.maxDepth;
  }

  private get maxDepth(): number {
    return this.d.maxDepth ?? MAX_DELEGATION_DEPTH;
  }

  /** `SessionService.ensureLive`'s narrowing seam: the subset of the space's enabled skills this
   *  child is staged, or null for "no narrowing" (every non-child, and a child whose run named no
   *  `skills` constraint). */
  skillsFilter(sessionId: string): string[] | null {
    return this.childRecord(sessionId)?.skills ?? null;
  }

  /** `SessionService.ensureLive`'s seam: the delegation preamble an agent_run child starts with,
   *  appended to the space's normal systemContext. Undefined for every non-child session. */
  extraSystemContext(sessionId: string): string | undefined {
    const child = this.childRecord(sessionId);
    if (!child) return undefined;
    // The delegation line is the one rule that is no longer the same sentence for every child: with a
    // budget, what a child may do depends on where it sits. Saying "you cannot delegate" to a child
    // that CAN is the more expensive error of the two — it costs the whole point of the budget — so
    // the preamble states the remaining depth rather than a fixed prohibition.
    const remaining = this.maxDepth - child.depth;
    const delegationRule = remaining > 0
      ? `- You may delegate further, but only ${remaining} level${remaining === 1 ? "" : "s"} deeper (you are at depth ${child.depth} of ${this.maxDepth}). Prefer doing the work yourself: every extra level is another agent the human has to follow.`
      : `- You cannot delegate further: you are at the maximum delegation depth (${this.maxDepth}), so there is no agent_run, agent_start or browser_agent_run here.`;
    return [
      "# Delegated agent (Realm)",
      "",
      "This session was spawned by another Realm session to accomplish ONE goal:",
      "",
      child.goal,
      "",
      "Ground rules — restated for clarity; each is also enforced server-side:",
      delegationRule,
      "- Work in THIS session's own checkout (your working directory) — that is where your changes belong.",
      "- Finish with a concise final message reporting the outcome — that message is the ONLY thing the delegating session receives.",
    ].join("\n");
  }

  /** A session was deleted. As a parent: cancel its run. As a child: forget its persisted record and
   *  its per-session skill stage — the restriction dies with the session, never leaks to a future id. */
  release(sessionId: string): void {
    this.d.engine.parentInterrupted(sessionId);
    this.d.engine.end(sessionId);
    if (this.childRecord(sessionId)) {
      this.d.settings.set(childKey(sessionId), null);
      this.d.skills.discardStage(sessionId);
    }
  }

  /* ------------------------------------- the tool itself ------------------------------------- */

  /**
   * Spawn a child and register its run — everything `agent_run` and `agent_start` share, which is
   * all of it except who waits. Extracted rather than forked for the reason the engine and the
   * dispatch recipe were: the bypass cap, the depth check and the worktree cleanup are three places
   * a second copy would drift, and two of those three are safety lines.
   *
   * Returns the registered run on success, or the caller's refusal already worded.
   */
  private async spawn(ctx: ProviderCallContext, rawArgs: unknown, detached: boolean): Promise<Spawned | CallToolResult> {
    const parsed = RunArgs.safeParse(rawArgs ?? {});
    if (!parsed.success) return err(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const { goal, constraints } = parsed.data;
    // Recursion guard, innermost of three (gateway toolset shape, provider child check, here): even a
    // child that somehow names this tool is checked server-side. A browser-agent or reviewer child is
    // refused outright — those two shapes stay depth-1 — while an agent_run child is refused only
    // once its depth budget is spent.
    if (this.d.otherDelegation?.isChild(ctx.sessionId))
      return err("refused: a delegated agent may not delegate further — delegation is depth-1 only.");
    if (!this.canDelegate(ctx.sessionId))
      return err(`refused: this session is at the maximum delegation depth (${this.maxDepth}) — it may not spawn another agent. Do the work here, or report back so the session that delegated to you can decide.`);
    const full = this.d.engine.atCapacity(ctx.sessionId);
    if (full) {
      return err(full.scope === "parent"
        ? `refused: this session already has ${full.limit} delegated agents running (the per-session cap). Collect one with ${AGENT_WAIT_TOOL_NAME} before starting another — ${AGENT_STATUS_TOOL_NAME} lists them.`
        : `refused: ${full.limit} delegated agents are already running across this Realm (the machine-wide cap). Wait for one to finish; ${AGENT_STATUS_TOOL_NAME} shows yours.`);
    }

    let parent;
    try { parent = this.d.sessions.get(ctx.sessionId); } catch { return err("the calling session no longer exists."); }

    // THE SAFETY LINE, verbatim from browser_agent_run: bypassPermissions is never inherited nor
    // grantable. A bypass parent's EFFECTIVE mode is `default` (its child never rides the parent's
    // full access), a requested bypass degrades to `default` (stated in the result), and what is
    // granted is min(parent effective, requested) — a constraint can only ever tighten. Applied at
    // EVERY level: a depth-2 grandchild is capped against its depth-1 parent's already-capped mode,
    // so the budget can never launder access down the tree.
    const parentCap = parent.permissionMode === "bypassPermissions" ? "default" : parent.permissionMode;
    let requested = constraints?.permissionMode;
    let bypassDegraded = false;
    if (requested === "bypassPermissions") { requested = "default"; bypassDegraded = true; }
    const permissionMode = requested === undefined ? parentCap : rank(requested) < rank(parentCap) ? requested : parentCap;

    // The child keeps the caller's agent kind when that kind can take Realm's skills injection
    // (same rule as the browser agent); a `constraints.agentKind` overrides. Shared recipe — see
    // dispatch.ts for why these three resolutions are extracted rather than inlined here.
    const agentKind = resolveAgentKind(constraints?.agentKind, parent.agentKind, this.d.fallbackKind);

    const skills = resolveSkillSubset(ctx.spaceId, constraints?.skills, this.d.skills);
    if (!skills.ok) return err(skills.message);
    const skillIds = skills.value;

    // Where the child runs: an existing environment (same-space, checked in the shared resolver so
    // the refusal names the real reason, and again in SessionsStore.create — two write-path guards,
    // one invariant), a fresh Plan 7 worktree, or (neither) the space's primary.
    const env = await resolveEnvironment(
      ctx.spaceId,
      { environmentId: constraints?.environmentId, newWorktree: constraints?.newWorktree, worktreeTitle: titleFromMessage(goal) || null },
      this.d.environments,
      { what: "the delegated agent", ownership: "a delegated agent runs only in its caller's own space" },
    );
    if (!env.ok) return err(env.message);
    const { environmentId, created: createdWorktree } = env.value;

    let created;
    try {
      created = this.d.sessions.create({
        spaceId: ctx.spaceId, agentKind, projectId: null, environmentId, model: null, effort: null, permissionMode,
        title: clip(`Agent: ${goal.split("\n")[0]}`, 40),
        dispatchedBy: { sessionId: ctx.sessionId, kind: "agent_run" },
      });
    } catch (e) {
      await cleanupWorktree(createdWorktree, this.d.environments);
      return err(`could not create the delegated session: ${message(e)}`);
    }
    const childId = created.session.id;
    // Persisted BEFORE the first send: `ensureLive` reads the skill narrowing and the preamble off
    // this record when it starts the adapter, and the gateway reads the exclusion off it on the
    // child's first tools/list — the record must exist first.
    const record: AgentChildRecord = { parentSessionId: ctx.sessionId, goal, skills: skillIds, depth: this.depthOf(ctx.sessionId) + 1 };
    this.d.settings.set(childKey(childId), record);
    // The `agentOpened` idiom, same as the browser agent: the renderer brings the child's pane into
    // the layout BESIDE the parent (the fixed openItemBeside path), never replacing it.
    this.d.rpc.broadcast("session.agentOpened", { spaceId: ctx.spaceId, sessionId: childId, itemId: created.itemId });

    const t = this.d.timeouts ?? DEFAULT_TIMEOUTS;
    const maxTurns = constraints?.maxTurns ?? DEFAULT_MAX_TURNS;
    const budgetMs = constraints?.timeoutMs ?? (t.baseMs + maxTurns * t.perTurnMs);
    const run = this.d.engine.begin(ctx.sessionId, childId, { detached });
    const fromSeq = created.session.lastEventSeq;
    // The watcher is started BEFORE the first send and owns the execution deadline whether or not
    // anyone ever waits — that is what keeps a forgotten detached child from running forever.
    this.d.engine.watch(run, childId, fromSeq, Date.now() + budgetMs, t.pollMs);
    try {
      await this.d.sessions.send(childId, { text: childMessage(goal), attachments: [] });
    } catch (e) {
      this.d.engine.end(ctx.sessionId, run);
      return err(`could not send the goal to the delegated session: ${message(e)}`);
    }
    return { spawned: true, run, childId, title: created.session.title, budgetMs, bypassDegraded };
  }

  /* ---------------------------------------- agent_run ---------------------------------------- */

  /** Spawn one child and block until it settles — the original shape, now expressed as `spawn` plus
   *  an await of the same background watcher `agent_start` leaves running. One settle path, so a
   *  detached run can never finish by rules the blocking one does not have. */
  async run(ctx: ProviderCallContext, rawArgs: unknown): Promise<CallToolResult> {
    const spawned = await this.spawn(ctx, rawArgs, false);
    if (!isSpawned(spawned)) return spawned;
    try {
      const settled = await spawned.run.settled!;
      return reportOne(settled, spawned);
    } finally {
      this.d.engine.end(ctx.sessionId, spawned.run);
    }
  }

  /* --------------------------------------- agent_start --------------------------------------- */

  /** Spawn one child and return its handle immediately. The run stays in the registry, settling in
   *  the background, until `agent_wait` claims it or the parent is interrupted or deleted. */
  async start(ctx: ProviderCallContext, rawArgs: unknown): Promise<CallToolResult> {
    const spawned = await this.spawn(ctx, rawArgs, true);
    if (!isSpawned(spawned)) return spawned;
    const running = this.d.engine.running(ctx.sessionId).length;
    const note = spawned.bypassDegraded ? ` ${BYPASS_NOTE}` : "";
    return ok([
      `Started delegated agent ${spawned.childId} ("${spawned.title}"). It is running now; this call did not wait for it.${note}`,
      `Its time budget is ${Math.round(spawned.budgetMs / 1000)}s, enforced whether or not you wait.`,
      `You have ${running} delegated agent${running === 1 ? "" : "s"} running. Collect with ${AGENT_WAIT_TOOL_NAME} (handle: ${spawned.childId}); ${AGENT_STATUS_TOOL_NAME} lists them.`,
      "",
      `Start the others you need NOW, before waiting — that is the whole point of ${AGENT_START_TOOL_NAME}. Waiting on each one as you start it is just ${AGENT_RUN_TOOL_NAME} with extra steps.`,
    ].join("\n"));
  }

  /* --------------------------------------- agent_wait ---------------------------------------- */

  /** Collect the reports of runs started with `agent_start`. Claims them: a handle reported here is
   *  removed from the registry, so its slot returns and a second wait on it says so plainly. */
  async wait(ctx: ProviderCallContext, rawArgs: unknown): Promise<CallToolResult> {
    const parsed = WaitArgs.safeParse(rawArgs ?? {});
    if (!parsed.success) return err(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const { handles, mode, timeoutMs } = parsed.data;

    const mine = new Map(this.d.engine.runsOf(ctx.sessionId).map((r) => [r.childSessionId, r]));
    // No handles named = wait for everything this session started. The common shape, and it means an
    // agent that lost track of its handles is never stuck.
    const wanted = handles ?? [...mine.keys()];
    if (wanted.length === 0) return err(`nothing to wait for: this session has no delegated agents in flight. ${AGENT_START_TOOL_NAME} starts one.`);
    const unknown = wanted.filter((h) => !mine.has(h));
    if (unknown.length > 0)
      return err(`unknown handle${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. A handle belongs to the session that started it, and is spent once ${AGENT_WAIT_TOOL_NAME} has reported it. ${AGENT_STATUS_TOOL_NAME} lists what is outstanding.`);
    const runs = wanted.map((h) => mine.get(h)!);

    const outcome = await this.d.engine.awaitRuns(runs, mode, Date.now() + timeoutMs, (this.d.timeouts ?? DEFAULT_TIMEOUTS).pollMs);
    const settledRuns = runs.filter((r) => r.done !== null);
    // Claimed — and ONLY the ones that settled. A run still executing stays in the registry with its
    // watcher intact, so a wait that timed out has cost the caller nothing but the wait.
    for (const r of settledRuns) this.d.engine.end(ctx.sessionId, r);

    const sections = settledRuns.map((r) => reportSection(r.done!, r.childSessionId));
    const stillRunning = runs.filter((r) => r.done === null).map((r) => r.childSessionId);
    const head = outcome === "timeout"
      ? `Waited ${Math.round(timeoutMs / 1000)}s; ${settledRuns.length} of ${runs.length} delegated agent${runs.length === 1 ? "" : "s"} finished. The rest are STILL RUNNING under their own budgets — this timeout gave up on listening, it did not stop them. Wait again to collect: ${stillRunning.join(", ")}.`
      : mode === "any"
        ? `${settledRuns.length} of ${runs.length} delegated agents finished${stillRunning.length > 0 ? `; still running: ${stillRunning.join(", ")}` : ""}.`
        : `All ${runs.length} delegated agent${runs.length === 1 ? "" : "s"} finished.`;
    const body = sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
    // A wait that collected nothing is an error result so the agent cannot mistake an empty report
    // for "they all came back with nothing to say".
    return settledRuns.length === 0 ? err(`${head}${body}`) : ok(`${head}${body}`);
  }

  /* -------------------------------------- agent_status --------------------------------------- */

  /** What this session has in flight, and what is waiting to be collected. Read-only. */
  status(ctx: ProviderCallContext): CallToolResult {
    const runs = this.d.engine.runsOf(ctx.sessionId);
    if (runs.length === 0)
      return ok(`No delegated agents. This session may start up to ${MAX_RUNS_PER_PARENT} at once with ${AGENT_START_TOOL_NAME}, or run one to completion with ${AGENT_RUN_TOOL_NAME}.`);
    const lines = runs.map((r) => {
      const state = r.done === null ? (r.cancelled ? "cancelling" : "running") : `finished (${statusOf(r.done)}) — uncollected`;
      return `- ${r.childSessionId}: ${state}`;
    });
    const collectable = runs.filter((r) => r.done !== null).length;
    const running = runs.length - collectable;
    return ok([
      `${running} running, ${collectable} finished and uncollected.`,
      ...lines,
      "",
      collectable > 0 ? `Collect the finished ones with ${AGENT_WAIT_TOOL_NAME} — their reports are held until you do.` : `Collect with ${AGENT_WAIT_TOOL_NAME} when you are ready to block.`,
    ].join("\n"));
  }
}

/** `spawn`'s success arm. `run.settled` is non-null by the time this is returned — `watch` set it. */
type Spawned = { spawned: true; run: ActiveRun; childId: string; title: string; budgetMs: number; bypassDegraded: boolean };
const isSpawned = (v: Spawned | CallToolResult): v is Spawned => (v as Spawned).spawned === true;

const BYPASS_NOTE = "bypassPermissions was requested but is never granted to a delegated agent — the child runs in \"default\" and its permission prompts surface on its own session.";

/** The blocking tool's whole result: the outcome sentence, the structured trail, and the fenced
 *  report. `agent_wait` builds the same thing per handle through `reportSection`. */
function reportOne(settled: SettledRun, spawned: Spawned): CallToolResult {
  const note = spawned.bypassDegraded ? `\n\nNote: ${BYPASS_NOTE}` : "";
  const trail = trailFor(settled, spawned.childId, spawned.title);
  const output = fenced(settled);
  switch (settled.outcome) {
    case "done":
      return ok(`Delegated agent finished.${note}${trail}\n\n${output}`);
    case "interrupted":
      return err(`Delegated run cancelled: the delegating session was interrupted, so the delegated agent was stopped mid-run.${trail}\n\nPartial output: ${output}`);
    case "timeout":
      return err(`Delegated agent timed out (budget: ${Math.round(spawned.budgetMs / 1000)}s) and was interrupted.${trail}\n\nPartial output: ${output}`);
    case "failed":
      return err(`Delegated agent session ended with status "${settled.lastStatus}" before finishing.${trail}\n\nPartial output: ${output}`);
    case "gone":
      return err("Delegated agent session was deleted before it finished.");
  }
}

/** One collected handle's block inside an `agent_wait` result. Deliberately the same vocabulary as
 *  `reportOne` — an agent that learned to read one should not have to learn the other. */
function reportSection(settled: SettledRun, childId: string): string {
  const verdict = settled.outcome === "done" ? "finished" : `did NOT finish (${statusOf(settled)})`;
  return `## Agent ${childId} — ${verdict}\n\n${fenced(settled)}`;
}

function fenced(settled: SettledRun): string {
  return settled.finalText
    ? fenceAgentOutput(settled.finalText, "the DELEGATED AGENT'S REPORT — a subagent's output")
    : "(the agent produced no output)";
}

function trailFor(settled: SettledRun, childId: string, title: string): string {
  const identity = JSON.stringify({ sessionId: childId, title, status: statusOf(settled) });
  return `\n\nChild session: ${identity} — its full trace, including every tool call and permission prompt, is in that session's pane.`;
}

/** The child-session status word the structured trail reports — the run OUTCOME's vocabulary, not
 *  the session-status enum (a cancelled child usually sits at `idle` by the time anyone reads this). */
function statusOf(settled: SettledRun): string {
  switch (settled.outcome) {
    case "done": return "done";
    case "interrupted": return "cancelled";
    case "timeout": return "timeout";
    case "failed": return "failed";
    case "gone": return "gone";
  }
}

/** The one message the child receives. Deliberately thin — the delegation preamble in systemContext
 *  carries the rules; this carries the task. */
function childMessage(goal: string): string {
  return [
    "You are a delegated agent. Accomplish this goal:",
    "",
    goal,
    "",
    "When done — or when you cannot proceed — reply with a concise final report. That report is returned verbatim to the session that delegated this goal.",
  ].join("\n");
}

export const AGENT_RUN_TOOL: Tool = {
  name: AGENT_RUN_TOOL_NAME,
  description:
    `Delegate ONE self-contained task to a dedicated agent and BLOCK until it finishes: a real, visible Realm session in this space with the space's normal toolset (its MCP servers and skills), running in a named environment, a fresh worktree, or the space's primary checkout. Returns the agent's fenced final report plus the child session's identity (that session's pane holds the full trace). The agent never gets bypassPermissions — a requested bypass degrades to default — and its permission prompts surface on its own session. Delegation nests up to ${MAX_DELEGATION_DEPTH} levels deep. Use ${AGENT_START_TOOL_NAME} instead when you have SEVERAL independent tasks — running them one blocking call at a time wastes the parallelism.`,
  inputSchema: spawnInputSchema(),
};

/** `agent_run` and `agent_start` take byte-identical arguments — they differ only in who waits — so
 *  the schema is built once. Two hand-maintained copies is how one of them quietly stops accepting
 *  `skills`. */
function spawnInputSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      goal: { type: "string", description: "The task, self-contained (the agent sees only this plus its space's normal context)." },
      constraints: {
        type: "object",
        properties: {
          agentKind: { type: "string", enum: [...AgentKindSchema.options], description: "Agent for the child. Omitted: the caller's own kind (with a claude fallback when that kind cannot take Realm's skills)." },
          environmentId: { type: "string", description: "Run in this EXISTING environment of the caller's space. Mutually exclusive with newWorktree." },
          newWorktree: { type: ["boolean", "string"], description: "Create a fresh git worktree for the child: true titles it from the goal, a string titles it verbatim. Mutually exclusive with environmentId. Give PARALLEL agents separate worktrees — several agents editing one checkout will clobber each other." },
          permissionMode: { type: "string", enum: ["plan", "ask", "default", "acceptEdits", "bypassPermissions"], description: "Requested mode; granted = min(parent's, requested). `plan` and `ask` are both read-only. bypassPermissions is NEVER granted (degrades to default)." },
          maxTurns: { type: "number", description: "Scales the child's time budget (default 20; there is no per-turn counter — this is a time scale)." },
          timeoutMs: { type: "number", description: "Absolute time budget in ms (5s–1h); overrides maxTurns scaling." },
          skills: { type: "array", items: { type: "string" }, description: "Narrow the child to this SUBSET of the space's enabled skills. An id not enabled in the space refuses the call." },
        },
        additionalProperties: false,
      },
    },
    required: ["goal"],
    additionalProperties: false,
  };
}

export const AGENT_START_TOOL: Tool = {
  name: AGENT_START_TOOL_NAME,
  description:
    `Start a delegated agent WITHOUT waiting for it, and get back a handle (the child's session id). Same agent, same constraints and same safety rules as ${AGENT_RUN_TOOL_NAME} — the only difference is that this returns immediately, so you can start up to ${MAX_RUNS_PER_PARENT} independent tasks and have them run at the same time. Collect the reports with ${AGENT_WAIT_TOOL_NAME}; ${AGENT_STATUS_TOOL_NAME} lists what is outstanding. Start every agent you need BEFORE you wait on any of them — starting one and immediately waiting is just ${AGENT_RUN_TOOL_NAME} with extra steps. Each child gets its own time budget, enforced whether or not you ever wait. Give parallel agents separate worktrees (constraints.newWorktree) unless they genuinely need the same checkout.`,
  inputSchema: spawnInputSchema(),
};

export const AGENT_WAIT_TOOL: Tool = {
  name: AGENT_WAIT_TOOL_NAME,
  description:
    `Block until agents started with ${AGENT_START_TOOL_NAME} finish, and return their reports. Reporting a handle SPENDS it: that agent's report is returned once, and the handle is then unknown. Agents that have already finished return instantly. This tool's timeout bounds how long YOU wait, not how long the agents run — timing out here leaves them running under their own budgets, so wait again rather than starting a replacement.`,
  inputSchema: {
    type: "object",
    properties: {
      handles: { type: "array", items: { type: "string" }, description: `Handles from ${AGENT_START_TOOL_NAME}. Omitted: every agent this session has in flight.` },
      mode: { type: "string", enum: ["all", "any"], description: "all (default) waits for every named handle; any returns as soon as one finishes, leaving the rest running and collectable later." },
      timeoutMs: { type: "number", description: "How long to wait, in ms (1s–1h; default 15min). Bounds the WAIT, never the agents." },
    },
    additionalProperties: false,
  },
};

export const AGENT_STATUS_TOOL: Tool = {
  name: AGENT_STATUS_TOOL_NAME,
  description:
    `List this session's delegated agents: which are still running, and which have finished with a report waiting to be collected by ${AGENT_WAIT_TOOL_NAME}. Read-only — it never blocks and never starts or stops anything.`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const message = errorMessage;
