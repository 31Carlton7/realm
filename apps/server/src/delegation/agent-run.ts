import { z } from "zod";
import { AGENT_META, AGENT_SKILL_SUPPORT, AgentKindSchema, AgentRunConstraintsSchema, DEFAULT_MODEL_LABEL, MAX_DELEGATION_DEPTH, type AgentKind, type AgentRunConstraints, type DelegableModel, type DelegationOutcome, type Environment, type Session } from "@realm/contracts";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { fenceAgentOutput } from "@realm/contracts";
import { cleanupWorktree, errorMessage, resolveAgentKind, resolveEnvironment, resolveSkillSubset, type EnvironmentDeps } from "./dispatch";
import type { ProviderCallContext } from "../mcp/gateway";
import { clip, err, ok } from "../mcp/tool-result";
import type { RpcServer } from "../rpc/server";
import { titleFromMessage, type SessionService } from "../sessions/service";
import type { SkillsService } from "../skills/service";
import { MAX_RUNS_PER_PARENT, type ActiveRun, type DelegationEngine, type SettledRun } from "./engine";
import { delegableModels, modelMenu, resolveModelName, type ModelChoice, type ModelResolution, type ProbedAgent } from "./models";

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

/** How old a model list may be and still be trusted to say a name does not exist. The probe's own
 *  TTL is thirty seconds because it answers "is this agent signed in"; a catalog answers a slower
 *  question, and ten minutes is far inside how often a vendor ships a model. */
const CATALOG_MAX_AGE_MS = 10 * 60_000;

/** What `agentRun.child:<id>` stores. `skills: null` = no narrowing (the space's full enabled set).
 *
 *  `depth` is how far down the delegation tree this child sits (its parent's depth + 1, so a child of
 *  a root session is 1). It is PERSISTED rather than recomputed by walking `parentSessionId` upwards:
 *  a parent can be deleted while its child runs on, and a depth that silently resets to 1 when an
 *  ancestor disappears would hand a grandchild a fresh budget. Records written before this field
 *  existed parse as depth 1 — the depth every child had under the old flat rule.
 *
 *  `startedAt`, `settledAt` and `outcome` are what the lead's Agents tab reads after the engine has
 *  forgotten the run: the registry is in memory and a run leaves it once collected, but "this one
 *  timed out" is still the thing a person coming back wants to know. Absent on records from before
 *  they existed, and `settledAt`/`outcome` absent until the run settles. */
export type AgentChildRecord = {
  parentSessionId: string;
  goal: string;
  skills: string[] | null;
  depth: number;
  startedAt?: number;
  settledAt?: number;
  outcome?: DelegationOutcome;
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
    sessions: Pick<SessionService, "create" | "send" | "get" | "events" | "interrupt" | "defaultModel">;
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
    /**
     * What `constraints.model` is resolved against: the agents' last-known probe rows (the model
     * picker's own source) and the kinds this Realm can run. `known` costs nothing — it is the probe
     * cache, however old; `refresh` spends a probe of every agent and is only asked when a name did
     * not resolve against a cache that was missing or stale. Absent, a named model is refused: there
     * is nothing to resolve it against.
     */
    models?: { known(): { rows: readonly ProbedAgent[]; at: number } | null; refresh(): Promise<readonly ProbedAgent[]>; kinds: readonly AgentKind[] };
  }) {}

  /* ------------------------------ the seams other code consults ------------------------------ */

  private childRecord(sessionId: string): AgentChildRecord | null {
    const v = this.d.settings.get(childKey(sessionId));
    if (!v || typeof v !== "object") return null;
    const r = v as Partial<AgentChildRecord>;
    if (typeof r.parentSessionId !== "string" || typeof r.goal !== "string") return null;
    const time = (t: unknown): number | undefined => (typeof t === "number" && Number.isFinite(t) ? t : undefined);
    const startedAt = time(r.startedAt), settledAt = time(r.settledAt);
    const outcome = typeof r.outcome === "string" && OUTCOMES.has(r.outcome) ? r.outcome : undefined;
    return {
      parentSessionId: r.parentSessionId,
      goal: r.goal,
      skills: Array.isArray(r.skills) ? r.skills.filter((x): x is string => typeof x === "string") : null,
      // A pre-depth record (written by a build before the budget existed) reads as 1. Never 0: 0 is
      // "not a child at all", and a child that claims to be a root gets the full budget again.
      depth: typeof r.depth === "number" && Number.isFinite(r.depth) && r.depth >= 1 ? Math.floor(r.depth) : 1,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(settledAt !== undefined ? { settledAt } : {}),
      ...(outcome ? { outcome } : {}),
    };
  }

  /** This child's record, for the lead's list of its sub-agents — null for a session nobody
   *  delegated with `agent_run`. */
  record(sessionId: string): AgentChildRecord | null {
    return this.childRecord(sessionId);
  }

  /** A run settled: write down how, so the lead's Agents tab can still say it once the engine has
   *  let the run go. A child deleted mid-run has had its record released, and writing one back would
   *  resurrect it — so only a record that still exists is touched, and `gone` never is.
   *
   *  It runs in the background, off the watcher, so it may land as the server shuts down: a store
   *  that has closed under it means there is nothing left to write to, and a throw here would be an
   *  unobserved rejection rather than anybody's error. */
  private noteSettled(childId: string, outcome: DelegationOutcome): void {
    if (outcome === "gone") return;
    try {
      const record = this.childRecord(childId);
      if (record) this.d.settings.set(childKey(childId), { ...record, settledAt: Date.now(), outcome } satisfies AgentChildRecord);
    } catch { /* the store closed under a settle at shutdown */ }
  }

  /**
   * The harness and model a child runs on.
   *
   * A NAMED model (`constraints.model`) resolves against what the agents on this Mac reported — the
   * cache first, for free. One fresh probe is spent only on a name nobody has heard of, and only when
   * the list is missing or older than `CATALOG_MAX_AGE_MS`: a model released this morning should not
   * be refused on the strength of yesterday's list, but a probe of every agent takes half a minute on
   * a real Mac, and an ambiguous "GPT-6" is no less ambiguous for asking again.
   *
   * No model named: the harness `resolveAgentKind` picks, and on the LEAD'S harness the lead's own
   * model, that harness's own default included. A person who put their session on Opus 5.5 and
   * asked it to hand work out means Opus 5.5 unless they said otherwise. On a harness the lead is
   * not on, the lead's model id would mean nothing, so the child starts as any session made there
   * with no model named does (`unnamedOn`).
   *
   * A harness named on its own ("Codex") names an agent and no model too, and `unnamedOn` answers
   * it whichever harness the lead is on: the lead's own harness, named alone, does not take the
   * lead's model. The resolver answers the name with a null model, and no other name resolves to
   * null. `place` does not pass that null on as the harness's own default. Passed on, "Codex" in
   * `constraints.model` and `codex` in `constraints.agentKind` would start two children of a lead
   * on another harness on two models.
   */
  private async place(constraints: AgentRunConstraints | undefined, parent: Session): Promise<ModelResolution> {
    if (constraints?.model === undefined) {
      const kind = resolveAgentKind(constraints?.agentKind, parent.agentKind, this.d.fallbackKind);
      if (kind !== parent.agentKind) return { ok: true, choice: this.unnamedOn(kind) };
      const model = parent.model;
      return { ok: true, choice: { kind, model, label: model === null ? DEFAULT_MODEL_LABEL[kind] : this.labelOf(kind, model) } };
    }
    const m = this.d.models;
    if (!m) return { ok: false, reason: "unknown", message: "refused: this Realm has no list of models to resolve constraints.model against — leave it out, or name constraints.agentKind." };
    const name = constraints.model;
    const attempt = (rows: readonly ProbedAgent[]): ModelResolution => {
      const named = resolveModelName(name, delegableModels(rows, m.kinds), { kind: constraints.agentKind, kinds: m.kinds, probes: rows });
      return named.ok && named.choice.model === null ? { ok: true, choice: this.unnamedOn(named.choice.kind) } : named;
    };
    const known = m.known();
    const first = attempt(known?.rows ?? []);
    if (first.ok || first.reason !== "unknown" || (known && Date.now() - known.at < CATALOG_MAX_AGE_MS)) return first;
    return attempt(await m.refresh());
  }

  /**
   * What a child runs on where no model is named and its harness is not the lead's, or is named on
   * its own. That is the model a session made on that harness with no model named starts on
   * (`SessionService.defaultModel`): the one the person chose for it, else the harness's own
   * default. The label is the name the report gives it. Leaving the model out of the create would
   * start the same session, but the report names the child's model before its session exists, so
   * this asks for the model and the create names it.
   */
  private unnamedOn(kind: AgentKind): ModelChoice {
    const model = this.d.sessions.defaultModel(kind);
    return { kind, model, label: model === null ? DEFAULT_MODEL_LABEL[kind] : this.labelOf(kind, model) };
  }

  /** A model id's name, from the catalog when it is in it — the report should say "Claude Opus 5.5",
   *  not "claude-opus-5-5". */
  private labelOf(kind: AgentKind, id: string): string {
    const rows = this.d.models?.known()?.rows ?? [];
    return delegableModels(rows, [kind]).find((x) => x.routes.some((r) => r.kind === kind && r.id === id))?.label ?? id;
  }

  /** What the Agents tab's composer offers — the models a sub-agent can be put on — and what this
   *  session itself runs, which is the one choice that needs no name. The probe the picker last made
   *  answers it, or one made now when there has never been one: a composer with no models to offer
   *  has nothing to compose. */
  async catalogFor(sessionId: string): Promise<{ models: DelegableModel[]; own: { kind: AgentKind; label: string } }> {
    const session = this.d.sessions.get(sessionId);
    const m = this.d.models;
    const rows = m ? (m.known()?.rows ?? await m.refresh()) : [];
    const models = m ? delegableModels(rows, m.kinds).map(({ key, label, kind, id, ready }) => ({ key, label, kind, id, ready })) : [];
    const label = session.model === null ? DEFAULT_MODEL_LABEL[session.agentKind] : this.labelOf(session.agentKind, session.model);
    return { models, own: { kind: session.agentKind, label } };
  }

  /** `agent_run` and `agent_start` as this Realm can describe them right now — with the models a
   *  caller can name, so an agent reading the tool list knows GPT-6 Luna is on offer before it has
   *  to be refused to find out. The list is the cache's: free to read, and at worst a probe old. */
  spawnTools(): Tool[] {
    const m = this.d.models;
    const menu = m ? modelMenu(delegableModels(m.known()?.rows ?? [], m.kinds), { perHarness: 8, readyOnly: true }) : [];
    return [agentRunTool(menu), agentStartTool(menu)];
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

    // Which harness and model. Unnamed, the child keeps the caller's agent kind when that kind can
    // take Realm's skills injection (same rule as the browser agent), and its model with it; a
    // `constraints.agentKind` overrides the kind, and a `constraints.model` names the model the way a
    // person would — see `place`. The kind's half is the shared recipe — see dispatch.ts for why
    // these resolutions are extracted rather than inlined here.
    const placed = await this.place(constraints, parent);
    if (!placed.ok) return err(placed.message);
    const { kind: agentKind, model, label: modelLabel } = placed.choice;

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
        spaceId: ctx.spaceId, agentKind, projectId: null, environmentId, model, effort: null, permissionMode,
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
    const record: AgentChildRecord = { parentSessionId: ctx.sessionId, goal, skills: skillIds, depth: this.depthOf(ctx.sessionId) + 1, startedAt: Date.now() };
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
    // The settle half of the `agentOpened` idiom, hung off the WATCHER rather than anyone's await:
    // an `agent_start` child settles with nobody waiting on it, and a fan-out of those is exactly
    // the layout this announcement exists to clear. Once per run, because `run.settled` resolves
    // once. The rejection arm is there only because an unobserved rejection takes the process down —
    // drain resolves for every outcome (see `watch`).
    void run.settled!.then(
      (s) => {
        // Written before it is announced, so anything that re-reads on the announcement reads it.
        this.noteSettled(childId, s.outcome);
        this.d.rpc.broadcast("session.agentSettled", { spaceId: ctx.spaceId, sessionId: childId, itemId: created.itemId, outcome: s.outcome });
      },
      () => { /* surfaced through run.done / the awaiting tool */ },
    );
    try {
      await this.d.sessions.send(childId, { text: childMessage(goal), attachments: [] });
    } catch (e) {
      this.d.engine.end(ctx.sessionId, run);
      return err(`could not send the goal to the delegated session: ${message(e)}`);
    }
    return { spawned: true, run, childId, title: created.session.title, budgetMs, bypassDegraded, on: `${AGENT_META[agentKind].label} · ${modelLabel}` };
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
      `Started delegated agent ${spawned.childId} ("${spawned.title}") on ${spawned.on}. It is running now; this call did not wait for it.${note}`,
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
type Spawned = { spawned: true; run: ActiveRun; childId: string; title: string; budgetMs: number; bypassDegraded: boolean;
  /** The harness and model it runs on, as the report says them: "Codex · GPT-6 Luna". */
  on: string };
const isSpawned = (v: Spawned | CallToolResult): v is Spawned => (v as Spawned).spawned === true;

const OUTCOMES: ReadonlySet<string> = new Set<DelegationOutcome>(["done", "stopped", "interrupted", "timeout", "failed", "gone"]);

const BYPASS_NOTE = "bypassPermissions was requested but is never granted to a delegated agent — the child runs in \"default\" and its permission prompts surface on its own session.";

/** The blocking tool's whole result: the outcome sentence, the structured trail, and the fenced
 *  report. `agent_wait` builds the same thing per handle through `reportSection`. */
function reportOne(settled: SettledRun, spawned: Spawned): CallToolResult {
  const note = spawned.bypassDegraded ? `\n\nNote: ${BYPASS_NOTE}` : "";
  const trail = trailFor(settled, spawned.childId, spawned.title, spawned.on);
  const output = fenced(settled);
  switch (settled.outcome) {
    case "done":
      return ok(`Delegated agent finished.${note}${trail}\n\n${output}`);
    case "stopped":
      // Not a failure of the child's, and not the delegating session's cancel either: a person looked
      // at this child and stopped it. Saying so is what keeps a lead from re-running what someone
      // deliberately halted.
      return err(`Delegated agent was stopped by the user before it finished.${trail}\n\nPartial output: ${output}`);
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

function trailFor(settled: SettledRun, childId: string, title: string, on: string): string {
  const identity = JSON.stringify({ sessionId: childId, title, on, status: statusOf(settled) });
  return `\n\nChild session: ${identity} — its full trace, including every tool call and permission prompt, is in that session's pane.`;
}

/** The child-session status word the structured trail reports — the run OUTCOME's vocabulary, not
 *  the session-status enum (a cancelled child usually sits at `idle` by the time anyone reads this). */
function statusOf(settled: SettledRun): string {
  switch (settled.outcome) {
    case "done": return "done";
    case "stopped": return "stopped";
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

/**
 * How a calling model learns it can hand work to OTHER models — said in the description, because the
 * description is the only thing every harness reads before deciding how to do the work. Two things it
 * must get across, and has to get across to any model reading it, not just the one that wrote it:
 * that a model is named the way a person names it, and that a person naming models IS the
 * instruction. "Can Fable use GPT-6 Luna to implement this" should end in an agent_start with
 * `model: "GPT-6 Luna"`, not in an apology about not being GPT-6 Luna.
 */
const MODELS_BY_NAME =
  "A sub-agent can run on a DIFFERENT model from yours: name it in constraints.model the way a person would — \"GPT-6 Luna\", \"Fable\", \"Opus 5.5\", \"Sonnet\" — or by id (\"gpt-6-luna\", \"claude-opus-5-5\"), and Realm runs it on the agent that has that model (Codex for GPT, Claude for Claude), so constraints.agentKind is not needed. A family name means its newest model (\"Fable\" is the newest Fable); a harness alone (\"Codex\") runs the model chosen for that agent's new sessions, else its default. Leave model out and the sub-agent runs on your own model. When the user names models for the work — \"have GPT-6 Luna write the tests\", \"implement this plan with Fable and Sonnet sub-agents\" — do exactly that: one sub-agent per named model, each given its part.";

/** The models line a description ends on, when there is a catalog to list — ready harnesses only,
 *  because naming a model the caller would then be refused is worse than naming nothing. */
const availableNow = (menu: readonly string[]): string =>
  menu.length > 0 ? ` Models you can name right now: ${menu.join("; ")}.` : "";

export function agentRunTool(menu: readonly string[] = []): Tool {
  return {
    name: AGENT_RUN_TOOL_NAME,
    description:
      `Hand ONE self-contained task to a sub-agent and BLOCK until it reports back: a real, visible Realm session in this space with the space's normal toolset (its MCP servers and skills), running in a named environment, a fresh worktree, or the space's primary checkout. ${MODELS_BY_NAME} Returns the sub-agent's fenced final report plus the child session's identity (that session's pane holds the full trace). The sub-agent never gets bypassPermissions — a requested bypass degrades to default — and its permission prompts surface on its own session. Delegation nests up to ${MAX_DELEGATION_DEPTH} levels deep. Use ${AGENT_START_TOOL_NAME} instead when you have SEVERAL independent tasks — running them one blocking call at a time wastes the parallelism.${availableNow(menu)}`,
    inputSchema: spawnInputSchema(menu),
  };
}

/** `agent_run` and `agent_start` take byte-identical arguments — they differ only in who waits — so
 *  the schema is built once. Two hand-maintained copies is how one of them quietly stops accepting
 *  `skills`. */
function spawnInputSchema(menu: readonly string[]): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      goal: { type: "string", description: "The task, self-contained (the agent sees only this plus its space's normal context)." },
      constraints: {
        type: "object",
        properties: {
          model: { type: "string", description: `The model to run the sub-agent on, by name: "GPT-6 Luna", "Fable" (its newest), "Opus 5.5", "Sonnet", or an id like "gpt-6-luna". Realm picks the agent that runs it. A harness name alone ("Codex", "Cursor") runs the model chosen for that agent's new sessions, else its default model. Omitted: your own model. A name Realm cannot place, or one that could mean two models, is refused with the names it knows.${availableNow(menu)}` },
          agentKind: { type: "string", enum: [...AgentKindSchema.options], description: "Agent for the child. Rarely needed: constraints.model already picks the agent. With a model, the name is looked up on this agent only. Omitted with no model: the caller's own kind (with a claude fallback when that kind cannot take Realm's skills)." },
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

export function agentStartTool(menu: readonly string[] = []): Tool {
  return {
    name: AGENT_START_TOOL_NAME,
    description:
      `Start a sub-agent WITHOUT waiting for it, and get back a handle (the child's session id). Same arguments and same safety rules as ${AGENT_RUN_TOOL_NAME} — the only difference is that this returns immediately, so you can start up to ${MAX_RUNS_PER_PARENT} independent tasks and have them run at the same time. ${MODELS_BY_NAME} Splitting a plan across models is this tool: one ${AGENT_START_TOOL_NAME} per model with its share of the plan, then one ${AGENT_WAIT_TOOL_NAME}. Collect the reports with ${AGENT_WAIT_TOOL_NAME}; ${AGENT_STATUS_TOOL_NAME} lists what is outstanding. Start every agent you need BEFORE you wait on any of them — starting one and immediately waiting is just ${AGENT_RUN_TOOL_NAME} with extra steps. Each child gets its own time budget, enforced whether or not you ever wait. Give parallel agents separate worktrees (constraints.newWorktree) unless they genuinely need the same checkout.${availableNow(menu)}`,
    inputSchema: spawnInputSchema(menu),
  };
}

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
