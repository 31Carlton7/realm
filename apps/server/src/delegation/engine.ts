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

  /** Register a run. The caller has already checked `hasRun` and refused; this is the write. */
  begin(parentSessionId: string, childSessionId: string): ActiveRun {
    const run: ActiveRun = { childSessionId, cancelled: false };
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
    void this.d.sessions.interrupt(run.childSessionId).catch(() => { /* child may be gone already */ });
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

export type ActiveRun = { childSessionId: string; cancelled: boolean };
export type SettledRun = { outcome: "done" | "interrupted" | "timeout" | "failed" | "gone"; finalText: string | null; lastStatus: string | null };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
