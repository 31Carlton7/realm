import { z } from "zod";
import { AGENT_SKILL_SUPPORT, AgentKindSchema, AgentRunConstraintsSchema, type AgentKind, type Environment } from "@realm/contracts";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { fenceAgentOutput } from "../browsers/guards";
import { cleanupWorktree, errorMessage, resolveAgentKind, resolveEnvironment, resolveSkillSubset, type EnvironmentDeps } from "./dispatch";
import type { ProviderCallContext } from "../mcp/gateway";
import { clip, err, ok } from "../mcp/tool-result";
import type { RpcServer } from "../rpc/server";
import { titleFromMessage, type SessionService } from "../sessions/service";
import type { SkillsService } from "../skills/service";
import type { DelegationEngine, SettledRun } from "./engine";

export const AGENT_RUN_TOOL_NAME = "agent_run";

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

/** What `agentRun.child:<id>` stores. `skills: null` = no narrowing (the space's full enabled set). */
export type AgentChildRecord = {
  parentSessionId: string;
  goal: string;
  skills: string[] | null;
};

const RunArgs = z.object({
  goal: z.string().min(1).max(8000),
  constraints: AgentRunConstraintsSchema.optional(),
});

type SettingsLike = { get(key: string): unknown; set(key: string, value: unknown): void };

/** More restrictive = lower. Used only to CAP: the child never gets a laxer mode than the parent
 *  effectively has, and `bypassPermissions` is unreachable through this table because a requested
 *  bypass is degraded to `default` before ranking and a bypass PARENT is capped to `default` first
 *  (the browser agent's rule, verbatim). An unranked mode (an adapter-specific string) ranks as
 *  `default` — capping math over an unknown mode should fail toward asking, not toward access. */
const MODE_RANK: Record<string, number> = { plan: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 };
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
    };
  }

  isChild(sessionId: string): boolean {
    return this.childRecord(sessionId) !== null;
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
    return [
      "# Delegated agent (Realm)",
      "",
      "This session was spawned by another Realm session to accomplish ONE goal:",
      "",
      child.goal,
      "",
      "Ground rules — restated for clarity; each is also enforced server-side:",
      "- You cannot delegate further: there is no agent_run and no browser_agent_run here (delegation is depth-1 only).",
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

  async run(ctx: ProviderCallContext, rawArgs: unknown): Promise<CallToolResult> {
    const parsed = RunArgs.safeParse(rawArgs ?? {});
    if (!parsed.success) return err(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const { goal, constraints } = parsed.data;
    // Recursion guard, innermost of three (gateway toolset shape, provider child check, here):
    // even a delegated child that somehow names this tool is refused server-side.
    if (this.isChild(ctx.sessionId) || this.d.otherDelegation?.isChild(ctx.sessionId))
      return err("refused: a delegated agent may not delegate further — delegation is depth-1 only.");
    if (this.d.engine.hasRun(ctx.sessionId)) return err("refused: this session already has a delegated run in flight; wait for that call's result.");

    let parent;
    try { parent = this.d.sessions.get(ctx.sessionId); } catch { return err("the calling session no longer exists."); }

    // THE SAFETY LINE, verbatim from browser_agent_run: bypassPermissions is never inherited nor
    // grantable. A bypass parent's EFFECTIVE mode is `default` (its child never rides the parent's
    // full access), a requested bypass degrades to `default` (stated in the result), and what is
    // granted is min(parent effective, requested) — a constraint can only ever tighten.
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
    const record: AgentChildRecord = { parentSessionId: ctx.sessionId, goal, skills: skillIds };
    this.d.settings.set(childKey(childId), record);
    // The `agentOpened` idiom, same as the browser agent: the renderer brings the child's pane into
    // the layout BESIDE the parent (the fixed openItemBeside path), never replacing it.
    this.d.rpc.broadcast("session.agentOpened", { spaceId: ctx.spaceId, sessionId: childId, itemId: created.itemId });

    const t = this.d.timeouts ?? DEFAULT_TIMEOUTS;
    const maxTurns = constraints?.maxTurns ?? DEFAULT_MAX_TURNS;
    const budgetMs = constraints?.timeoutMs ?? (t.baseMs + maxTurns * t.perTurnMs);
    const note = bypassDegraded ? "\n\nNote: bypassPermissions was requested but is never granted to a delegated agent — the child ran in \"default\" and its permission prompts surfaced on its own session." : "";
    const run = this.d.engine.begin(ctx.sessionId, childId);
    try {
      const fromSeq = created.session.lastEventSeq;
      await this.d.sessions.send(childId, { text: childMessage(goal), attachments: [] });
      const settled = await this.d.engine.drain(childId, fromSeq, run, Date.now() + budgetMs, t.pollMs);
      const identity = JSON.stringify({ sessionId: childId, title: created.session.title, status: statusOf(settled) });
      const trail = `\n\nChild session: ${identity} — its full trace, including every tool call and permission prompt, is in that session's pane.`;
      const output = settled.finalText
        ? fenceAgentOutput(settled.finalText, "the DELEGATED AGENT'S REPORT — a subagent's output")
        : "(the agent produced no output)";
      switch (settled.outcome) {
        case "done":
          return ok(`Delegated agent finished.${note}${trail}\n\n${output}`);
        case "interrupted":
          return err(`Delegated run cancelled: the delegating session was interrupted, so the delegated agent was stopped mid-run.${trail}\n\nPartial output: ${output}`);
        case "timeout":
          return err(`Delegated agent timed out (budget: ${Math.round(budgetMs / 1000)}s) and was interrupted.${trail}\n\nPartial output: ${output}`);
        case "failed":
          return err(`Delegated agent session ended with status "${settled.lastStatus}" before finishing.${trail}\n\nPartial output: ${output}`);
        case "gone":
          return err("Delegated agent session was deleted before it finished.");
      }
    } finally {
      this.d.engine.end(ctx.sessionId);
    }
  }
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
    "Delegate ONE self-contained task to a dedicated agent: a real, visible Realm session in this space with the space's normal toolset (its MCP servers and skills), running in a named environment, a fresh worktree, or the space's primary checkout. This call blocks until the agent finishes and returns its fenced final report plus the child session's identity (that session's pane holds the full trace). The agent never gets bypassPermissions — a requested bypass degrades to default — and its permission prompts surface on its own session. Depth-1 only: the delegated agent cannot delegate further.",
  inputSchema: {
    type: "object",
    properties: {
      goal: { type: "string", description: "The task, self-contained (the agent sees only this plus its space's normal context)." },
      constraints: {
        type: "object",
        properties: {
          agentKind: { type: "string", enum: [...AgentKindSchema.options], description: "Agent for the child. Omitted: the caller's own kind (with a claude fallback when that kind cannot take Realm's skills)." },
          environmentId: { type: "string", description: "Run in this EXISTING environment of the caller's space. Mutually exclusive with newWorktree." },
          newWorktree: { type: ["boolean", "string"], description: "Create a fresh git worktree for the child: true titles it from the goal, a string titles it verbatim. Mutually exclusive with environmentId." },
          permissionMode: { type: "string", enum: ["plan", "default", "acceptEdits", "bypassPermissions"], description: "Requested mode; granted = min(parent's, requested). bypassPermissions is NEVER granted (degrades to default)." },
          maxTurns: { type: "number", description: "Scales the child's time budget (default 20; there is no per-turn counter — this is a time scale)." },
          timeoutMs: { type: "number", description: "Absolute time budget in ms (5s–1h); overrides maxTurns scaling." },
          skills: { type: "array", items: { type: "string" }, description: "Narrow the child to this SUBSET of the space's enabled skills. An id not enabled in the space refuses the call." },
        },
        additionalProperties: false,
      },
    },
    required: ["goal"],
    additionalProperties: false,
  },
};

const message = errorMessage;
