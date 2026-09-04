import type { DelegatedRun, StoredSessionEvent } from "@realm/contracts";

/**
 * The delegation engine (Plan 13 W1) — the one settle/drain implementation behind BOTH delegation
 * tools (`browser_agent_run` and `agent_run`), extracted verbatim from Plan 11 W5's
 * `BrowserAgentService`. Extracted rather than forked on purpose: the cancelled-wins ordering below
 * was a live-found bug once, and two copies of this loop is how it gets re-introduced in exactly one
 * of them (`structure.test.ts` pins the single-copy fact).
 *
 * The engine owns two things and nothing else:
 *
 *   - **The run registry** — the delegated runs of each PARENT session, across every tool, and the
 *     caps on how many may exist. `SessionService.interrupt`'s one `parentInterrupted` call cancels
 *     all of them. In memory, deliberately: an in-flight MCP call cannot outlive the process.
 *   - **The settle wait** — `drain()`, the `live-agent-check` idiom scoped to events after `fromSeq`,
 *     plus `watch()`, which runs that same drain in the BACKGROUND for a detached run.
 *
 * What the engine does NOT own: child records, toolset restrictions, permission-mode capping,
 * environments, budgets, result phrasing. Those are per-tool policy and live with each tool.
 *
 * **Blocking vs detached, and why `hasRun` still means what it always did.** Until Plan 24 a parent
 * had at most ONE run, so "has a run" and "is blocked inside a delegation call" were the same
 * sentence. They are not any more: `agent_start` leaves a run in the registry while its parent goes
 * on doing other things. Every predicate that meant *blocked* — the browser agent's refusal, the
 * reviewer's, and `ask`'s askability check on a PEER — must keep meaning blocked, so `hasRun`
 * counts only NON-detached runs and detached ones are invisible to it. The new predicate
 * `atCapacity` is the one that counts everything, because a cap is about machines running, not
 * about who is waiting.
 */
/** How many runs one parent may have going at once (`agent_start`'s cap). Four rather than "as many
 *  as you like": every child is a real agent process with its own context window and its own
 *  worktree, and the point of a cap is that a fan-out mistake costs one refusal instead of a laptop. */
export const MAX_RUNS_PER_PARENT = 4;

/** The engine-wide ceiling, across every parent and every tool. `MAX_RUNS_PER_PARENT` alone does not
 *  bound the tree: with a depth budget, four children each spawning four grandchildren is twenty
 *  processes from one prompt. This is the guard that makes the depth budget safe to hand out, and it
 *  is deliberately the smaller-feeling number — hitting it is a refusal an agent can read and retry,
 *  whereas the failure it prevents is the machine going away. */
export const MAX_RUNS_TOTAL = 12;

export class DelegationEngine {
  /** The runs of each parent session — see the class doc comment. A parent with none holds no entry
   *  (`end` prunes the empty array), so `runs.size` is the number of parents currently delegating. */
  private readonly runs = new Map<string, ActiveRun[]>();
  private readonly maxPerParent: number;
  private readonly maxTotal: number;

  constructor(private readonly d: {
    sessions: {
      events(id: string, afterSeq: number, limit: number): StoredSessionEvent[];
      interrupt(id: string): Promise<void>;
    };
    /** Tests tighten these to one and two so a cap is reachable without spawning four fake agents. */
    caps?: { perParent?: number; total?: number };
    /** Called with a parent whose live set just changed — a run began, settled, or was collected.
     *  The engine announces the CHANGE and nothing else: the listener reads the new set back off
     *  `liveRuns`, so there is still exactly one description of who is waiting on what, and nobody
     *  can be handed a snapshot the registry has already moved past. Optional, because settling must
     *  not depend on anyone listening. */
    onChange?: (parentSessionId: string) => void;
  }) {
    this.maxPerParent = d.caps?.perParent ?? MAX_RUNS_PER_PARENT;
    this.maxTotal = d.caps?.total ?? MAX_RUNS_TOTAL;
  }

  private list(parentSessionId: string): ActiveRun[] {
    return this.runs.get(parentSessionId) ?? [];
  }

  /**
   * Whether this parent is BLOCKED inside a delegation call right now. The caller words its own
   * refusal — the browser tool's exact message predates the engine and must not drift.
   *
   * Detached runs are deliberately invisible here: a parent that fired `agent_start` and walked away
   * is not blocked, and every caller of this predicate (the browser agent's refusal, the reviewer's,
   * and `ask`'s askability check on a peer) is asking about being blocked. See the class doc comment.
   */
  hasRun(parentSessionId: string): boolean {
    return this.list(parentSessionId).some((r) => !r.detached);
  }

  /** The parent's runs that are still EXECUTING — a settled-but-unclaimed detached run holds a
   *  result, not a machine, so it is not counted against the cap and is not listed here. */
  running(parentSessionId: string): ActiveRun[] {
    return this.list(parentSessionId).filter((r) => r.done === null);
  }

  /** The parent's live runs as the renderer reads them (`DelegatedRunSchema`). Derived here rather
   *  than at either call site, so the broadcast and the fetch cannot describe the registry
   *  differently and nothing outside this class has to know what "live" counts as. */
  liveRuns(parentSessionId: string): DelegatedRun[] {
    return this.running(parentSessionId).map((r) => ({
      sessionId: r.childSessionId, startedAt: r.startedAt, detached: r.detached, owned: r.interruptOnCancel,
    }));
  }

  /** Every run of this parent the registry still holds, settled ones included — `agent_status`'s
   *  read, and what `agent_wait` resolves a handle against. */
  runsOf(parentSessionId: string): ActiveRun[] {
    return [...this.list(parentSessionId)];
  }

  private totalRunning(): number {
    let n = 0;
    for (const list of this.runs.values()) for (const r of list) if (r.done === null) n += 1;
    return n;
  }

  /**
   * Whether a new run would exceed a cap — the check `agent_start`/`agent_run` make in place of the
   * old `hasRun`. Returns the reason so the caller can word a refusal that says WHICH ceiling was hit
   * (a per-parent cap is "wait for one of yours"; the global one is "the machine is busy"), or null
   * when there is room.
   */
  atCapacity(parentSessionId: string): { scope: "parent" | "total"; limit: number } | null {
    if (this.running(parentSessionId).length >= this.maxPerParent) return { scope: "parent", limit: this.maxPerParent };
    if (this.totalRunning() >= this.maxTotal) return { scope: "total", limit: this.maxTotal };
    return null;
  }

  /**
   * Register a run. The caller has already checked `hasRun`/`atCapacity` and refused; this is the write.
   *
   * `interruptOnCancel` defaults TRUE so every delegation call site is byte-unchanged: a delegated
   * child is ours, and a stop on the parent must not leave a ghost agent running. Plan 20's ask
   * passes false — the session it targets is a PEER, not a child. See `parentInterrupted`.
   *
   * `detached` marks a run nobody is currently awaiting (`agent_start`). It changes exactly two
   * things: `hasRun` ignores it, and its drain is expected to be running in the background under
   * `watch` rather than under the caller's own await.
   */
  begin(parentSessionId: string, targetSessionId: string, opts: { interruptOnCancel?: boolean; detached?: boolean } = {}): ActiveRun {
    const run: ActiveRun = {
      parentSessionId, childSessionId: targetSessionId, cancelled: false, startedAt: Date.now(),
      interruptOnCancel: opts.interruptOnCancel ?? true,
      detached: opts.detached ?? false, done: null, settled: null,
    };
    this.runs.set(parentSessionId, [...this.list(parentSessionId), run]);
    this.d.onChange?.(parentSessionId);
    return run;
  }

  /**
   * The run is over (any outcome) — always called from the tool's `finally`.
   *
   * Omitting `run` removes ALL of the parent's runs, which is what `release` (the parent session was
   * deleted) means and what every pre-Plan-24 caller meant when a parent could only have one. A
   * caller that may have siblings in flight — only `agent_run`/`agent_wait` — passes its own run, so
   * a sibling's `finally` can never evict a detached run whose report has not been collected yet.
   */
  end(parentSessionId: string, run?: ActiveRun): void {
    if (!run) { this.runs.delete(parentSessionId); this.d.onChange?.(parentSessionId); return; }
    const rest = this.list(parentSessionId).filter((r) => r !== run);
    if (rest.length === 0) this.runs.delete(parentSessionId);
    else this.runs.set(parentSessionId, rest);
    this.d.onChange?.(parentSessionId);
  }

  /** The PARENT was interrupted: ALL its delegated runs are cancelled and their children interrupted
   *  — a stop on the delegating session must not leave a ghost agent running, and after `agent_start`
   *  there may be several. Called from `SessionService.interrupt` for every session; a session with
   *  no active run is a no-op. */
  parentInterrupted(sessionId: string): void {
    for (const run of this.list(sessionId)) {
      if (run.cancelled) continue;
      run.cancelled = true;
      // A delegated CHILD is ours to stop. A PEER being asked a question is not: it was doing its own
      // work before the question arrived and is still doing it, and stopping it because the ASKER was
      // stopped would destroy work nobody asked to cancel. Cancelling the wait is the whole action.
      if (run.interruptOnCancel) void this.d.sessions.interrupt(run.childSessionId).catch(() => { /* child may be gone already */ });
    }
  }

  /**
   * Start this run's settle wait in the BACKGROUND — the same `drain`, not a second one, just nobody
   * awaiting it yet. Both delegation shapes go through here: `agent_run` calls `watch` and then
   * immediately awaits `run.settled`, `agent_start` calls `watch` and returns. One code path, so a
   * detached run cannot settle by rules the blocking one does not have.
   *
   * The watcher owns the deadline whether or not anyone ever waits, which is the whole reason it is
   * started at spawn instead of at `agent_wait`: a parent that fires three children and then forgets
   * them must still not leave three agents running forever, and drain's own timeout interrupts the
   * child. `agent_wait`'s timeout is therefore a separate, shorter thing — giving up on LISTENING,
   * which never stops the child.
   */
  watch(run: ActiveRun, childId: string, fromSeq: number, deadline: number, pollMs: number): void {
    run.settled = this.drain(childId, fromSeq, run, deadline, pollMs).then((s) => { run.done = s; this.d.onChange?.(run.parentSessionId); return s; });
    // drain resolves for every outcome rather than throwing, but an unobserved promise that somehow
    // did reject would take the process down — and a detached run is unobserved by construction.
    void run.settled.catch(() => { /* surfaced through run.done / the awaiting tool */ });
  }

  /**
   * Wait for a set of already-watched runs to settle — `agent_wait`'s wait, and the reason that tool
   * needs no timer of its own (`structure.test.ts` forbids one in the tools).
   *
   * The deadline here is a LISTENING budget, not an execution one: it gives up on waiting and returns
   * `timeout`, leaving every child running under its own `watch` deadline. That asymmetry is the
   * point of detached runs — a parent may stop listening and come back later — and it is why this
   * never interrupts anything, unlike `drain`'s timeout.
   *
   * Polls `run.done` rather than racing the `settled` promises so that `mode: "any"` does not have to
   * abandon promises it is no longer interested in, and so a run that settled BEFORE this call (the
   * common case: fire three, do other work, collect) resolves on the first pass with no wait at all.
   */
  async awaitRuns(runs: ActiveRun[], mode: "all" | "any", deadline: number, pollMs: number): Promise<"settled" | "timeout"> {
    if (runs.length === 0) return "settled";
    const satisfied = (): boolean => mode === "all" ? runs.every((r) => r.done !== null) : runs.some((r) => r.done !== null);
    for (;;) {
      if (satisfied()) return "settled";
      // A cancelled run whose drain has returned is `done`; one whose parent was interrupted mid-poll
      // resolves on the next pass. Either way the loop below is what notices, so there is no separate
      // cancellation branch here.
      if (Date.now() >= deadline) return "timeout";
      await sleep(pollMs);
    }
  }

  /**
   * Advance past `cursor`, folding the slice into last-status / last-assistant-text. Returns the new
   * cursor, or `null` when the session is gone (its events threw). `awaitAnswer`'s transcript read.
   *
   * Turn boundaries are detected HERE, not by comparing `lastStatus` across polls: a single batch can
   * hold an entire turn (running → text → idle), so a caller watching only the batch's final status
   * would never see the `running` at all.
   */
  private scan(id: string, cursor: number, acc: TranscriptScan): number | null {
    let batch: StoredSessionEvent[];
    try { batch = this.d.sessions.events(id, cursor, 500); } catch { return null; }
    let last = cursor;
    for (const stored of batch) {
      last = stored.seq;
      const ev = stored.event;
      if (ev.type === "status") {
        // A turn STARTS here. Everything buffered before it belongs to the previous turn — for an
        // interjection that is the work the peer was already doing, which is not a reply to anything.
        if (ev.payload.status === "running" && acc.lastStatus !== "running") { acc.sawTurnStart = true; acc.finalText = null; }
        acc.lastStatus = ev.payload.status;
      }
      if (ev.type === "assistant_text") acc.finalText = ev.payload.text;
    }
    return last;
  }

  /**
   * The interjection wait (Plan 20) — `drain`'s sibling, and deliberately NOT `drain`. Three
   * differences, each a decision rather than an accident:
   *
   *   - The settle condition is an ANSWER (a resolved `answer` box, written by the `agent_answer`
   *     tool), not the peer's turn ending. A peer's turn ending is its own business.
   *   - A timeout does NOT interrupt the peer. `drain` interrupts because the child is ours; the peer
   *     is not, and killing a peer's own work for being slow to answer someone else is indefensible.
   *   - The fallback: a peer that settles to idle with assistant text and never called `agent_answer`
   *     has still, in the only sense that matters, replied. That text is returned, labelled as such,
   *     rather than the asker hanging for the full budget.
   *
   * Cancelled wins first, for `drain`'s reason: a peer that answers in the same poll window as the
   * asker's interrupt must report cancelled, because nobody is listening any more.
   *
   * **The fallback only counts text from a turn that STARTED after the question.** `drain` needs no
   * such rule — its child is born for the run, so every event it sees belongs to it. Here the target
   * was already mid-turn, and the events just after `fromSeq` are the tail of the work it was doing
   * BEFORE being asked: the interrupt ends that turn, so an `idle` arrives carrying assistant text
   * that predates the question entirely. Without `sawTurnStart` the very act of interrupting a busy
   * peer is read as it having answered, and the asker is handed a fragment of the peer's unrelated
   * work as its "reply". `finalText` is cleared at each turn boundary for the same reason.
   */
  async awaitAnswer(input: { targetId: string; fromSeq: number; run: ActiveRun; answer: { text: string | null };
    deadline: number; pollMs: number }): Promise<SettledAsk> {
    const { targetId, run, answer, deadline, pollMs } = input;
    let cursor = input.fromSeq;
    const acc: TranscriptScan = { lastStatus: null, finalText: null, sawTurnStart: false };
    for (;;) {
      const next = this.scan(targetId, cursor, acc);
      if (next === null) return { outcome: "gone", answer: null, lastStatus: acc.lastStatus };
      cursor = next;
      if (run.cancelled) return { outcome: "cancelled", answer: null, lastStatus: acc.lastStatus };
      if (answer.text !== null) return { outcome: "answered", answer: answer.text, lastStatus: acc.lastStatus };
      if (acc.sawTurnStart && acc.lastStatus === "idle" && acc.finalText !== null) return { outcome: "replied", answer: acc.finalText, lastStatus: acc.lastStatus };
      if (acc.lastStatus === "error" || acc.lastStatus === "ended") return { outcome: "failed", answer: null, lastStatus: acc.lastStatus };
      // No interrupt here, unlike drain's timeout. See the doc comment.
      if (Date.now() >= deadline) return { outcome: "timeout", answer: null, lastStatus: acc.lastStatus };
      await sleep(pollMs);
    }
  }

  /**
   * The settle wait — `live-agent-check`'s drain idiom, scoped to events AFTER `fromSeq` so history
   * from before this run can never satisfy the condition. Settled means: the child's LAST status in
   * the slice is `idle` AND at least one `assistant_text` arrived — the turn actually ran and ended.
   * The adapter's start-of-life `idle` (emitted before the turn begins) cannot settle it, because no
   * assistant_text exists yet; a turn that is still running cannot either, because its last status
   * is `running`/`waiting_permission` until the adapter closes the turn.
   */
  async drain(childId: string, fromSeq: number, run: ActiveRun, deadline: number, pollMs: number): Promise<SettledRun> {
    let last = fromSeq;
    let lastStatus: string | null = null;
    let finalText: string | null = null;
    for (;;) {
      let batch: StoredSessionEvent[];
      try { batch = this.d.sessions.events(childId, last, 500); } catch { return { outcome: "gone", finalText, lastStatus }; }
      for (const stored of batch) {
        last = stored.seq;
        const ev = stored.event;
        if (ev.type === "status") lastStatus = ev.payload.status;
        if (ev.type === "assistant_text") finalText = ev.payload.text;
      }
      // Cancellation wins over everything, including a turn that settled in the same poll window:
      // once the parent interrupted, the honest answer is "this run was cancelled (here is the
      // partial text)" — proven live: an interrupted Claude child winds down to idle WITH earlier
      // assistant text present, and checking settled first mislabels that as a clean finish.
      if (run.cancelled) return { outcome: "interrupted", finalText, lastStatus };
      if (lastStatus === "idle" && finalText !== null) return { outcome: "done", finalText, lastStatus };
      if (lastStatus === "error" || lastStatus === "ended") return { outcome: "failed", finalText, lastStatus };
      if (Date.now() >= deadline) {
        void this.d.sessions.interrupt(childId).catch(() => { /* best effort — it may have just ended */ });
        return { outcome: "timeout", finalText, lastStatus };
      }
      await sleep(pollMs);
    }
  }
}

/**
 * `childSessionId` is the TARGET of the wait: a delegated child for the delegation tools, a peer
 * session for Plan 20's ask — which is what `interruptOnCancel: false` distinguishes. It doubles as
 * the run's HANDLE: `agent_start` hands the child's session id back, and `agent_wait` resolves a
 * handle by matching it here. No second identifier space, and the handle an agent holds is the same
 * string that names the pane it can go read.
 *
 * `settled` is the background drain's promise (set by `watch`); `done` is its result, written when
 * that promise resolves. `done !== null` is the difference between a run that is still burning a
 * process and one that is only holding a report nobody has collected — which is why the caps count
 * `done === null` and `agent_status` reads both.
 */
export type ActiveRun = {
  /** The registry's key, carried on the run as well. `watch` resolves in the background holding only
   *  the run, and a settle nobody can attribute to a parent is a settle nobody can be told about.
   *  `begin` is the only place a run is built, so the two cannot disagree. */
  parentSessionId: string;
  childSessionId: string;
  cancelled: boolean;
  /** When `begin` registered the run — wall clock, because its only reader is a human watching a
   *  duration tick up in a pane. */
  startedAt: number;
  interruptOnCancel: boolean;
  detached: boolean;
  settled: Promise<SettledRun> | null;
  done: SettledRun | null;
};
export type SettledRun = { outcome: "done" | "interrupted" | "timeout" | "failed" | "gone"; finalText: string | null; lastStatus: string | null };
/** `sawTurnStart` is what makes the prose fallback safe — see `scan`. */
type TranscriptScan = { lastStatus: string | null; finalText: string | null; sawTurnStart: boolean };
/** `answered` = the peer called `agent_answer`. `replied` = it settled with prose instead, which the
 *  asker is told so it can weigh the difference. */
export type SettledAsk = {
  outcome: "answered" | "replied" | "cancelled" | "timeout" | "failed" | "gone";
  answer: string | null; lastStatus: string | null;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
