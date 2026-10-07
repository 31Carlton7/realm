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
 *
 * **What counts as "running" is turns and tasks, not adapter handles.** The plan this was built from
 * said to wait for `liveCount === 0`, and a live check showed that never happens: Realm keeps a
 * session's handle until the adapter's own stream ends, so any session anybody has used holds one
 * forever, and the drain ran its whole budget and got SIGTERM'd every time. A warm idle handle is not
 * work — closing it costs nothing, because the session resumes from its provider id on the next send
 * — and the thing a warm handle could actually break (exec'ing a bundle that has been deleted) is
 * already prevented by `ensureLive` refusing to start a COLD one. So the number the drain waits on is
 * the same one the tray shows and the quit dialog names: turns in flight, and tasks.
 */
export const QUIESCENT_HOLD_MS = 10_000;

export type DrainCounts = { working: number; activeRuns: number };

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
    const { working, activeRuns } = this.d.counts();
    if (working > 0 || activeRuns > 0) {
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
