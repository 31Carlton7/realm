import { isRunTerminal, parseBlockRequest, RUN_BLOCK_SENTINEL, type AgentKind, type Run, type RunAttempt, type RunConstraints, type RunState, type Session, type SessionEvent } from "@realm/contracts";
import type { RunsStore } from "../store/runs";
import type { RpcServer } from "../rpc/server";
import type { SessionService } from "../sessions/service";
import { titleFromMessage } from "../sessions/service";
import type { SkillsService } from "../skills/service";
import { NotFoundError, RpcError } from "../store/rows";
import { cleanupWorktree, errorMessage, resolveAgentKind, resolveEnvironment, resolveSkillSubset, type EnvironmentDeps } from "../delegation/dispatch";

/** The persisted mark of a run's worker session — settings KV (Realm's own DB), the same posture the
 *  three delegation registries take, so a worker that survives a server restart still wears its run's
 *  preamble and skill narrowing when resumed. Keyed by SESSION id; removed when that session dies. */
const workerKey = (sessionId: string): string => `run.session:${sessionId}`;

export type RunWorkerRecord = { runId: string; goal: string; skills: string[] | null };

/** Session-status transitions that count as a turn SETTLING — the notifications feed's vocabulary,
 *  verbatim, because both hooks read the same event off the same rail and must agree about what an
 *  ending looks like. */
const SETTLED_FROM = new Set(["running", "waiting_permission"]);
const SETTLED_TO = new Set(["idle", "ended", "error"]);

type SettingsLike = { get(key: string): unknown; set(key: string, value: unknown): void };

export type CreateRunInput = {
  spaceId: string;
  goal: string;
  title?: string | undefined;
  constraints: RunConstraints | null;
  dedupeKey: string | null;
  maxAttempts: number;
  deadlineAt: number | null;
};

/**
 * Durable runs — a goal that owns a session across attempts and survives restarts.
 *
 * **Why this is not the delegation engine.** `DelegationEngine` holds its registry in memory
 * deliberately: an in-flight MCP tool call cannot outlive the process, so neither should the record
 * of it. A run is the opposite object — nobody is blocked on it, it is expected to outlive several
 * processes, and its state has to be answerable after a crash. So it is a row, and every transition
 * is a write.
 *
 * **The settle is EVENT-DRIVEN, not polled.** `handleSessionEvent` rides the same `SessionService`
 * hook the notifications feed does, so a run advances off the same persisted status event everything
 * else reconciles on. There is no drain loop here and no timer of any kind — a poll would be a second
 * source of truth that a restart silently loses, which is exactly what a durable run must not have.
 * `structure.test.ts` pins the absence.
 *
 * **Restarts do not spend the attempt budget.** `recoverOnBoot` re-queues a run whose attempt was
 * abandoned by a server restart and raises `maxAttempts` to fit. A restart is not evidence the work
 * is impossible, and a run with the default `maxAttempts: 1` must survive one — otherwise "durable"
 * means nothing. The attempt COUNTER still advances (its log rows are `abandoned`), because
 * `run_attempts(run_id, n)` is unique and rewinding a counter into an existing row is a collision.
 *
 * **The human gate.** A run stops at `blocked` when its worker asks for a person, and only
 * `approve` moves it on. Unattended automation that can never stop and ask is the failure mode this
 * state exists to make impossible — the same reason `bypassPermissions` is not in a run's vocabulary
 * at all (contracts/runs.ts).
 */
export class RunService {
  /** Shutdown latch. A dispatch is an async chain of DB writes that can outlive `close()`; without
   *  this it lands on a closed handle and throws where nobody can catch it (found by the suite, as
   *  an unhandled rejection). `SessionService.closing` is the same latch for the same reason. */
  private closing = false;

  constructor(private readonly d: {
    store: RunsStore;
    settings: SettingsLike;
    sessions: Pick<SessionService, "create" | "send" | "get" | "events" | "interrupt">;
    rpc: Pick<RpcServer, "broadcast">;
    environments: EnvironmentDeps;
    skills: Pick<SkillsService, "list" | "discardStage">;
    notifications?: {
      runBlocked(input: { spaceId: string; sessionId: string | null; runId: string; title: string; body: string | null }): void;
      runBlockResolved(runId: string, outcome: string): void;
      runDone(input: { spaceId: string; sessionId: string | null; runId: string; title: string; body: string | null }): void;
    };
    /** Worker kind when the run named none: claude in production; tests override to the fake. */
    fallbackKind?: AgentKind;
    /** Test seam only — production leaves this alone and uses the real clock. */
    clock?: () => number;
  }) {}

  private now(): number { return this.d.clock ? this.d.clock() : Date.now(); }

  /** Shutdown: stop dispatching. In-flight chains check the latch after every await and drop out;
   *  their runs stay `running` in the database, which is exactly what `recoverOnBoot` reconciles. */
  close(): void { this.closing = true; }

  /* ------------------------------ the seams other code consults ------------------------------ */

  private workerRecord(sessionId: string): RunWorkerRecord | null {
    const v = this.d.settings.get(workerKey(sessionId));
    if (!v || typeof v !== "object") return null;
    const r = v as Partial<RunWorkerRecord>;
    if (typeof r.runId !== "string" || typeof r.goal !== "string") return null;
    return {
      runId: r.runId, goal: r.goal,
      skills: Array.isArray(r.skills) ? r.skills.filter((x): x is string => typeof x === "string") : null,
    };
  }

  /** Whether this session is a run's worker. NOTE what this is NOT used for: depth-1 exclusion. A
   *  run's worker is a top-level agent and MAY delegate — `agent_run` and `browser_agent_run` are
   *  the point of giving it a real session. Only a DELEGATED child is depth-capped. */
  isWorker(sessionId: string): boolean { return this.workerRecord(sessionId) !== null; }

  /** `SessionService.ensureLive`'s narrowing seam — the subset of the space's enabled skills this
   *  worker is staged, or null for no narrowing. */
  skillsFilter(sessionId: string): string[] | null { return this.workerRecord(sessionId)?.skills ?? null; }

  /** `SessionService.ensureLive`'s seam: the unattended-run preamble, appended to the space's normal
   *  systemContext. Undefined for every non-worker session. */
  extraSystemContext(sessionId: string): string | undefined {
    const w = this.workerRecord(sessionId);
    return w ? workerPreamble(w.goal) : undefined;
  }

  /**
   * A session was deleted. As a run's worker: forget the record and its per-session skill stage, and
   * FAIL the run — a run whose transcript was deleted cannot honestly be retried or reported on, and
   * leaving it `running` forever is the ghost state this method exists to prevent.
   */
  release(sessionId: string): void {
    const w = this.workerRecord(sessionId);
    if (!w) return;
    this.d.settings.set(workerKey(sessionId), null);
    this.d.skills.discardStage(sessionId);
    const run = this.d.store.get(w.runId);
    if (run && !isRunTerminal(run.state)) {
      this.d.store.closeAttempt(run.id, "abandoned", "the worker session was deleted");
      this.settle(run.id, "failed", { error: "the run's session was deleted before it finished" });
    }
  }

  /* -------------------------------------- read paths ----------------------------------------- */

  list(p: { spaceId: string; states: RunState[]; cursor: string | null; limit: number }): { runs: Run[]; nextCursor: string | null } {
    return this.d.store.list(p);
  }

  get(id: string): { run: Run; attempts: RunAttempt[] } | null {
    const run = this.d.store.get(id);
    return run ? { run, attempts: this.d.store.attempts(id) } : null;
  }

  /* ------------------------------------- entry points ---------------------------------------- */

  /**
   * Create and queue a run. Returns as soon as the ROW exists; dispatch happens in the background
   * and every later transition arrives as `runs.changed`.
   *
   * A `dedupeKey` collision returns the live run with `created: false` rather than throwing — see
   * the method's contract doc. The collision is decided by the database's partial unique index, not
   * by a read here, so a poller firing twice inside one millisecond still gets one run.
   */
  create(input: CreateRunInput): { run: Run; created: boolean } {
    const constraints = input.constraints;
    if (constraints?.environmentId !== undefined && constraints?.newWorktree !== undefined && constraints.newWorktree !== false) {
      throw new RpcError("RUN_CONSTRAINTS", "constraints.environmentId and constraints.newWorktree are mutually exclusive — name an existing environment OR ask for a fresh worktree");
    }
    // Validated at CREATE, not at dispatch: a run whose skills can never resolve should fail the
    // call the caller is watching, not fail silently on a background attempt an hour later.
    const skills = resolveSkillSubset(input.spaceId, constraints?.skills, this.d.skills);
    if (!skills.ok) throw new RpcError("RUN_CONSTRAINTS", skills.message);

    const agentKind = resolveAgentKind(constraints?.agentKind, null, this.d.fallbackKind);
    const title = input.title ?? clip(titleFromMessage(input.goal) || "Run", 80);
    const created = this.d.store.create({
      spaceId: input.spaceId, title, goal: input.goal, agentKind,
      // Resolved at dispatch (it may need to CREATE a worktree, which is async); the column holds
      // whatever the run actually landed in, so a retry reuses that same checkout rather than
      // cutting a second worktree for one goal.
      environmentId: null,
      constraints, dedupeKey: input.dedupeKey, maxAttempts: input.maxAttempts, deadlineAt: input.deadlineAt,
    });
    if (!created) {
      const existing = input.dedupeKey ? this.d.store.findLiveByDedupeKey(input.spaceId, input.dedupeKey) : null;
      // The index refused the insert, so a live run with this key existed a moment ago. If it is
      // already gone (settled between the two statements), the honest answer is to try once more
      // rather than to report a run we cannot name.
      if (!existing) {
        const retry = this.d.store.create({
          spaceId: input.spaceId, title, goal: input.goal, agentKind, environmentId: null,
          constraints, dedupeKey: input.dedupeKey, maxAttempts: input.maxAttempts, deadlineAt: input.deadlineAt,
        });
        if (!retry) throw new RpcError("RUN_DEDUPE", "a live run with this dedupe key already exists in this space");
        this.broadcast(retry);
        void this.dispatch(retry.id, null);
        return { run: retry, created: true };
      }
      return { run: existing, created: false };
    }
    this.broadcast(created);
    void this.dispatch(created.id, null);
    return { run: created, created: true };
  }

  /** Cancel a live run. Already-terminal is a NO-OP, not an error: two windows can click it, and a
   *  run that finished under the click was not cancelled — reporting it as such would be a lie. */
  cancel(id: string): Run {
    const run = this.require(id);
    if (isRunTerminal(run.state)) return run;
    if (run.sessionId) void this.d.sessions.interrupt(run.sessionId).catch(() => { /* it may have just ended */ });
    this.d.store.closeAttempt(id, "cancelled", null);
    return this.settle(id, "cancelled", { error: "cancelled" });
  }

  /**
   * Put a terminal run back on the queue. The attempt counter is preserved and `maxAttempts` is
   * raised to fit — an explicit human retry is not what the automatic budget is there to stop.
   */
  retry(id: string): Run {
    const run = this.require(id);
    if (!isRunTerminal(run.state)) throw new RpcError("RUN_LIVE", "that run is still live; cancel it before retrying");
    const requeued = this.requeue(run);
    void this.dispatch(id, null);
    return requeued;
  }

  /** Answer a blocked run. THE human gate — the one transition out of `blocked`. */
  approve(id: string, approved: boolean, note: string | null): Run {
    const run = this.require(id);
    if (run.state !== "blocked") throw new RpcError("RUN_NOT_BLOCKED", "that run is not waiting for an answer");
    this.d.notifications?.runBlockResolved(id, approved ? "Approved" : "Declined");
    if (!approved) {
      return this.settle(id, "cancelled", { error: note ? `declined: ${note}` : "declined by the user" });
    }
    const requeued = this.requeue(run);
    void this.dispatch(id, note);
    return requeued;
  }

  /* --------------------------------------- the flow ------------------------------------------ */

  /** Back to `queued`, with the budget widened enough for the attempt that is about to happen. */
  private requeue(run: Run): Run {
    const updated = this.d.store.update(run.id, {
      state: "queued",
      maxAttempts: Math.max(run.maxAttempts, run.attempt + 1),
      error: null, settledAt: null,
    })!;
    this.broadcast(updated);
    return updated;
  }

  /**
   * Dispatch the run's next attempt. Fire-and-forget by every caller: the RPC that started it has
   * already returned, and everything this produces reaches the client as `runs.changed`.
   *
   * `claim` is a compare-and-set — two callers racing here means exactly one dispatches.
   */
  private async dispatch(id: string, note: string | null): Promise<void> {
    try {
      if (this.closing) return;
      const before = this.d.store.get(id);
      if (!before || before.state !== "queued") return;
      // Checked here rather than only at settle: a run whose deadline passed while it sat queued
      // should not spend an attempt proving it.
      if (this.expiredNow(before)) { this.settle(id, "expired", { error: "the run's deadline passed before it could start" }); return; }

      const run = this.d.store.claim(id);
      if (!run) return; // someone else claimed it; exactly one dispatcher wins

      // A retry reuses the checkout the run already landed in — one goal, one worktree.
      const env = run.environmentId
        ? ({ ok: true, value: { environmentId: run.environmentId, created: null } } as const)
        : await resolveEnvironment(
          run.spaceId,
          { environmentId: run.constraints?.environmentId, newWorktree: run.constraints?.newWorktree, worktreeTitle: titleFromMessage(run.goal) || null },
          this.d.environments,
          { what: "the run", ownership: "a run runs only in its own space" },
        );
      if (this.closing) return;
      if (!env.ok) {
        this.d.store.closeAttempt(id, "failed", env.message);
        this.settle(id, "failed", { error: env.message });
        return;
      }

      const skills = resolveSkillSubset(run.spaceId, run.constraints?.skills, this.d.skills);
      if (!skills.ok) {
        this.d.store.closeAttempt(id, "failed", skills.message);
        this.settle(id, "failed", { error: skills.message });
        return;
      }

      // Resume the run's existing session when it has one (the whole reason a restart is survivable:
      // SessionService restarts the adapter with `resume: providerSessionId`), otherwise create one.
      let sessionId = run.sessionId;
      let createdItemId: string | null = null;
      if (sessionId && !this.sessionExists(sessionId)) sessionId = null;
      if (!sessionId) {
        try {
          const created = this.d.sessions.create({
            spaceId: run.spaceId, agentKind: run.agentKind, projectId: null, environmentId: env.value.environmentId,
            model: null, effort: null,
            // Never `bypassPermissions` — it is not in a run's vocabulary at all (contracts/runs.ts).
            permissionMode: run.constraints?.permissionMode ?? "default",
            title: clip(run.title, 40),
            dispatchedBy: { sessionId: null, kind: "run" },
          });
          sessionId = created.session.id;
          createdItemId = created.itemId;
        } catch (e) {
          await cleanupWorktree(env.value.created, this.d.environments);
          if (this.closing) return;
          const why = `could not create the run's session: ${errorMessage(e)}`;
          this.d.store.closeAttempt(id, "failed", why);
          this.settle(id, "failed", { error: why });
          return;
        }
        // Persisted BEFORE the first send: `ensureLive` reads the preamble and the skill narrowing
        // off this record when it starts the adapter, so the record must exist first.
        const record: RunWorkerRecord = { runId: id, goal: run.goal, skills: skills.value };
        this.d.settings.set(workerKey(sessionId), record);
      }

      this.d.store.openAttempt({ runId: id, n: run.attempt, sessionId });
      const dispatched = this.d.store.update(id, { sessionId, environmentId: env.value.environmentId })!;
      if (createdItemId) {
        // The `agentOpened` idiom: the worker streams into its own pane, because a run the user
        // cannot watch is the thing this whole design refuses to ship.
        this.d.rpc.broadcast("session.agentOpened", { spaceId: run.spaceId, sessionId, itemId: createdItemId });
      }
      this.broadcast(dispatched);

      try {
        await this.d.sessions.send(sessionId, { text: note ? `${workerMessage(run.goal)}\n\nThe person supervising this run replied:\n\n${note}` : workerMessage(run.goal), attachments: [] });
      } catch (e) {
        if (this.closing) return;
        const why = `the run's session could not be started: ${errorMessage(e)}`;
        this.d.store.closeAttempt(id, "failed", why);
        this.failOrRetry(id, why);
      }
    } catch (e) {
      // A throw here would be an unhandled rejection on a fire-and-forget call, and the run would
      // sit `running` forever with nothing driving it. Fail it loudly instead — unless we are
      // shutting down, where the throw IS the shutdown and the row is recovery's business.
      if (this.closing) return;
      const why = `dispatch failed: ${errorMessage(e)}`;
      try {
        this.d.store.closeAttempt(id, "failed", why);
        this.failOrRetry(id, why);
      } catch { /* the row, or the database, is already gone */ }
    }
  }

  /**
   * The `SessionService` hook — the same rail the notifications feed rides. `session` is the row as
   * it stood BEFORE this event, so `session.status` is the previous status and a settle is the
   * transition between the two sets.
   */
  handleSessionEvent(session: Session, ev: SessionEvent): void {
    if (ev.type !== "status") return;
    if (!SETTLED_FROM.has(session.status) || !SETTLED_TO.has(ev.payload.status)) return;
    const run = this.d.store.findLiveBySessionId(session.id);
    if (!run || run.state !== "running") return;

    const finalText = this.finalTextOf(session.id);
    // A run that ran past its deadline is `expired` however the turn ended: the work is stale, and
    // retrying it under the same deadline would only expire again.
    if (this.expiredNow(run)) {
      this.d.store.closeAttempt(run.id, "expired", null);
      this.settle(run.id, "expired", { error: "the run's deadline passed", result: finalText });
      return;
    }
    if (ev.payload.status === "error" || ev.payload.status === "ended") {
      const why = `the run's session ended with status "${ev.payload.status}"`;
      this.d.store.closeAttempt(run.id, "failed", why);
      this.failOrRetry(run.id, why, finalText);
      return;
    }
    // `idle` with nothing said is not a finish — it is the adapter's start-of-life idle, or a turn
    // that produced no output. Treat it as a failed attempt rather than reporting an empty result
    // as the run's deliverable.
    if (finalText === null) {
      const why = "the run's session settled without producing any output";
      this.d.store.closeAttempt(run.id, "failed", why);
      this.failOrRetry(run.id, why);
      return;
    }
    const blockReason = parseBlockRequest(finalText);
    if (blockReason !== null) {
      this.d.store.closeAttempt(run.id, "blocked", blockReason);
      const blocked = this.d.store.update(run.id, { state: "blocked", result: finalText, error: null })!;
      this.d.notifications?.runBlocked({
        spaceId: blocked.spaceId, sessionId: blocked.sessionId, runId: blocked.id,
        title: `${blocked.title} needs you`, body: clip(blockReason, 200),
      });
      this.broadcast(blocked);
      return;
    }
    this.d.store.closeAttempt(run.id, "succeeded", null);
    this.settle(run.id, "succeeded", { result: finalText });
  }

  /**
   * Boot: reconcile every live run against the world that survived the restart.
   *
   * Must run AFTER `SessionService.markStaleOnBoot`, which is what turns a session that was mid-turn
   * back into a resumable `idle` row. Called once from app.ts.
   */
  recoverOnBoot(): void {
    for (const run of this.d.store.listLive()) {
      if (run.state === "blocked") continue; // waiting on a person; a restart changes nothing
      if (this.expiredNow(run)) {
        this.d.store.closeAttempt(run.id, "expired", null);
        this.settle(run.id, "expired", { error: "the run's deadline passed while the server was down" });
        continue;
      }
      if (run.state === "running") {
        // The adapter did not survive; the attempt is over however far it got. A restart is not the
        // run's fault, so `requeue` widens the budget rather than spending it — see the class doc.
        this.d.store.closeAttempt(run.id, "abandoned", "the server restarted mid-attempt");
        this.requeue(run);
      }
      void this.dispatch(run.id, null);
    }
  }

  /* --------------------------------------- internals ----------------------------------------- */

  /** Another attempt if the budget allows, otherwise terminal. The ONE place that decision is made. */
  private failOrRetry(id: string, why: string, result?: string | null): void {
    const run = this.d.store.get(id);
    if (!run || isRunTerminal(run.state)) return;
    if (run.attempt < run.maxAttempts) {
      const requeued = this.d.store.update(id, { state: "queued", error: why })!;
      this.broadcast(requeued);
      void this.dispatch(id, null);
      return;
    }
    this.settle(id, "failed", { error: why, result: result ?? null });
  }

  /** The one terminal write: stamp the state, the outcome, and `settled_at`, then tell everyone. */
  private settle(id: string, state: RunState, out: { error?: string | null; result?: string | null }): Run {
    const run = this.d.store.update(id, {
      state, settledAt: this.now(),
      ...(out.error !== undefined ? { error: out.error } : {}),
      ...(out.result !== undefined ? { result: out.result } : {}),
    })!;
    this.d.notifications?.runDone({
      spaceId: run.spaceId, sessionId: run.sessionId, runId: run.id,
      title: `${run.title} ${OUTCOME_WORD[state] ?? "settled"}`,
      body: firstLine(run.error ?? run.result ?? ""),
    });
    this.broadcast(run);
    return run;
  }

  private broadcast(run: Run): void {
    this.d.rpc.broadcast("runs.changed", { spaceId: run.spaceId, run });
  }

  private require(id: string): Run {
    const run = this.d.store.get(id);
    if (!run) throw new NotFoundError("run", id);
    return run;
  }

  private expiredNow(run: Run): boolean {
    return run.deadlineAt !== null && this.now() >= run.deadlineAt;
  }

  private sessionExists(sessionId: string): boolean {
    try { this.d.sessions.get(sessionId); return true; } catch { return false; }
  }

  /**
   * The worker's most recent report: the LAST `assistant_text` in the session.
   *
   * Last-overall rather than last-since-this-attempt on purpose — a retry resumes the SAME session,
   * so the newest assistant message is by construction the newest attempt's. Scanned forward in
   * pages because the events API is forward-only; it runs once per settle, not per poll.
   */
  private finalTextOf(sessionId: string): string | null {
    let after = 0;
    let text: string | null = null;
    for (;;) {
      let batch;
      try { batch = this.d.sessions.events(sessionId, after, 500); } catch { return text; }
      if (batch.length === 0) return text;
      for (const stored of batch) {
        after = stored.seq;
        if (stored.event.type === "assistant_text") text = stored.event.payload.text;
      }
    }
  }
}

const OUTCOME_WORD: Record<string, string> = {
  succeeded: "finished", failed: "failed", cancelled: "was cancelled", expired: "expired",
};

/** The unattended-run posture, stated once as the worker's standing context. */
function workerPreamble(goal: string): string {
  return [
    "# Unattended run (Realm)",
    "",
    "This session is a durable RUN: it was started to accomplish one goal, and nobody is watching it work.",
    "",
    goal,
    "",
    "Ground rules:",
    "- Nobody is at the keyboard. Do not ask a question and wait — there is no one to answer in-band.",
    `- When you genuinely need a person (a decision only they can make, a login or paywall you cannot pass, work you should not submit unreviewed), STOP and end your turn with a line beginning \`${RUN_BLOCK_SENTINEL}\` followed by what you need. That parks the run and notifies them; they answer and the run resumes with their reply.`,
    "- Never work around a human gate. A CAPTCHA, a bot check, a login you do not have, or an identity assertion you cannot honestly make is a `" + RUN_BLOCK_SENTINEL + "` — not a puzzle to defeat.",
    "- Your final message is the deliverable: it is stored as the run's result and shown to the person who started it. Make it self-contained.",
    "- Work in THIS session's own checkout (your working directory).",
  ].join("\n");
}

/** The one message a worker receives. Thin — the preamble carries the rules. */
function workerMessage(goal: string): string {
  return [
    "You are an unattended run. Accomplish this goal:",
    "",
    goal,
    "",
    `When done — or when you need a person — reply with a concise final report (using \`${RUN_BLOCK_SENTINEL}\` if you are stuck). That report is stored as this run's result.`,
  ].join("\n");
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string): string | null => clip(s.trim().split("\n").find((l) => l.trim())?.trim() ?? "", 200) || null;
