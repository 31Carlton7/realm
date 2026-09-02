import type { StoredSessionEvent } from "@realm/contracts";

/**
 * The delegation engine (Plan 13 W1) — the one settle/drain implementation behind BOTH delegation
 * tools (`browser_agent_run` and `agent_run`), extracted verbatim from Plan 11 W5's
 * `BrowserAgentService`. Extracted rather than forked on purpose: the cancelled-wins ordering below
 * was a live-found bug once, and two copies of this loop is how it gets re-introduced in exactly one
 * of them (`structure.test.ts` pins the single-copy fact).
 *
 * The engine owns two things and nothing else:
 *
 *   - **The run registry** — one active delegated run per PARENT session, across both tools: a parent
 *     mid-`browser_agent_run` cannot also start an `agent_run` (and vice versa), and
 *     `SessionService.interrupt`'s one `parentInterrupted` call cancels whichever kind is in flight.
 *     In memory, deliberately: an in-flight MCP call cannot outlive the process.
 *   - **The settle wait** — `drain()`, the `live-agent-check` idiom scoped to events after `fromSeq`.
 *
 * What the engine does NOT own: child records, toolset restrictions, permission-mode capping,
 * environments, budgets, result phrasing. Those are per-tool policy and live with each tool.
 */
export class DelegationEngine {
  /** One active run per parent session — see the class doc comment. */
  private readonly runs = new Map<string, ActiveRun>();

  constructor(private readonly d: {
    sessions: {
      events(id: string, afterSeq: number, limit: number): StoredSessionEvent[];
      interrupt(id: string): Promise<void>;
    };
  }) {}

  /** Whether this parent already has a delegated run in flight (either tool). The caller words its
   *  own refusal — the browser tool's exact message predates the engine and must not drift. */
  hasRun(parentSessionId: string): boolean {
    return this.runs.has(parentSessionId);
  }

  /**
   * Register a run. The caller has already checked `hasRun` and refused; this is the write.
   *
   * `interruptOnCancel` defaults TRUE so every delegation call site is byte-unchanged: a delegated
   * child is ours, and a stop on the parent must not leave a ghost agent running. Plan 20's ask
   * passes false — the session it targets is a PEER, not a child. See `parentInterrupted`.
   */
  begin(parentSessionId: string, targetSessionId: string, opts: { interruptOnCancel?: boolean } = {}): ActiveRun {
    const run: ActiveRun = { childSessionId: targetSessionId, cancelled: false, interruptOnCancel: opts.interruptOnCancel ?? true };
    this.runs.set(parentSessionId, run);
    return run;
  }

  /** The run is over (any outcome) — always called from the tool's `finally`. */
  end(parentSessionId: string): void {
    this.runs.delete(parentSessionId);
  }

  /** The PARENT was interrupted: its delegated run (if any) is cancelled and the child interrupted —
   *  a stop on the delegating session must not leave a ghost agent running. Called from
   *  `SessionService.interrupt` for every session; a session with no active run is a no-op. */
  parentInterrupted(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.cancelled = true;
    // A delegated CHILD is ours to stop. A PEER being asked a question is not: it was doing its own
    // work before the question arrived and is still doing it, and stopping it because the ASKER was
    // stopped would destroy work nobody asked to cancel. Cancelling the wait is the whole action.
    if (run.interruptOnCancel) void this.d.sessions.interrupt(run.childSessionId).catch(() => { /* child may be gone already */ });
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

/** `childSessionId` is the TARGET of the wait: a delegated child for the delegation tools, a peer
 *  session for Plan 20's ask — which is what `interruptOnCancel: false` distinguishes. */
export type ActiveRun = { childSessionId: string; cancelled: boolean; interruptOnCancel: boolean };
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
