/**
 * Going quiet so the bundle underneath can be swapped.
 *
 * The alternative — stop the old daemon, start the new one — is what `handoff-policy.ts` does by
 * default and is always correct: sessions resume from their provider ids, runs are requeued, and
 * terminals come back with their scrollback. A drain buys only one thing, and it is worth naming
 * precisely: the turn that happens to be mid-flight finishes instead of being interrupted.
 *
 * **The load-bearing rule is refusing to START a handle, not refusing to accept work.** A draining
 * daemon may finish anything it is already running — an exec'd child keeps its inode, so the bundle
 * being deleted under it is harmless. What it must never do is exec a NEW agent from a path
 * `install-local.mjs` has already removed. Refusing `sessions.create` and `runs.create` is the
 * visible half; refusing a cold handle start for an existing session is the half that actually
 * prevents the crash.
 *
 * Quiescence is held rather than sampled once: a session that just settled may be about to start its
 * next turn from a queued message, and a daemon that closed in that gap would take the queue with it.
 */
export const QUIESCENT_HOLD_MS = 10_000;

export type DrainCounts = { liveHandles: number; activeRuns: number };

/** Everything the drain needs to know about the world, injected so the decision below is testable
 *  without a server. */
export type DrainDeps = {
  counts: () => DrainCounts;
  now: () => number;
  /** Close the app gracefully. The supervisor in Electron main spawns the replacement when the socket
   *  goes; sessions come back by the ordinary boot path. */
  close: () => void;
  log?: (line: string) => void;
};

/**
 * Tracks how long the daemon has been idle, and closes it once it has been idle long enough.
 *
 * `tick` is called on a timer; `quiescentSince` is reset the moment anything is running again, so a
 * daemon that keeps being handed work never closes — which is correct. A drain that never completes
 * is a daemon still doing its job, and the launcher's dialog is what escalates.
 */
export class Drain {
  private quiescentSince: number | null = null;
  private closed = false;

  constructor(private readonly d: DrainDeps) {}

  get quiet(): boolean {
    return this.quiescentSince !== null;
  }

  tick(): void {
    if (this.closed) return;
    const { liveHandles, activeRuns } = this.d.counts();
    if (liveHandles > 0 || activeRuns > 0) {
      if (this.quiescentSince !== null) this.d.log?.("[daemon] work started again; drain is waiting");
      this.quiescentSince = null;
      return;
    }
    const at = this.d.now();
    if (this.quiescentSince === null) {
      this.quiescentSince = at;
      this.d.log?.("[daemon] nothing running; holding before close");
      return;
    }
    if (at - this.quiescentSince < QUIESCENT_HOLD_MS) return;
    this.closed = true;
    this.d.log?.("[daemon] drained; closing");
    this.d.close();
  }
}
