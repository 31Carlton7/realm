/**
 * Noticing that realm-server has gone, and bringing it back.
 *
 * There is no `child.on("exit")` to hang this on. The daemon this app is talking to was very often
 * started by a previous launch and adopted, so this process holds no handle for it — which is the
 * whole point, and also why liveness has to be inferred rather than delivered.
 *
 * The signal is the bridge, which already redials every two seconds, plus the recorded pid. The rule
 * they make together is the important part:
 *
 *   - disconnected AND the pid is gone → the daemon died. Respawn, with capped backoff.
 *   - disconnected AND the pid is alive → the socket is busy, or flapping, or we lost a race with a
 *     restart. Reconnect only. Respawning here is how you end up with two daemons on one `realm.db`,
 *     which is the one failure in this feature that is data-shaped rather than crash-shaped.
 *
 * Five failures inside two minutes stops the loop for good and names the log, because a daemon that
 * cannot start is not going to start on the sixth try, and a restart loop that never gives up is a
 * restart loop nobody can read.
 */
/**
 * What the app is prepared to say about the server it is talking to.
 *
 * `stale` is not the supervisor's — it is decided once at launch, when the user chose to keep an
 * older daemon working — but it travels the same channel to the same banner, because from the
 * renderer's side these are one question: is the thing under me healthy, and if not, what do I do.
 */
export type DaemonUiState = SupervisorState | { kind: "stale"; why: "bundle" | "protocol" };

export type SupervisorState =
  | { kind: "connected" }
  /** Disconnected, and we are not acting on it yet — either the pid is alive, or the grace period
   *  since the drop has not elapsed. */
  | { kind: "disconnected" }
  | { kind: "restarting"; attempt: number }
  | { kind: "failed"; logPath: string };

/** How long the bridge must be down before a dead pid counts as a dead daemon. Short enough that a
 *  crash is invisible, long enough that an ordinary restart is not raced. */
export const DOWN_GRACE_MS = 5_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;
export const CRASH_LOOP_WINDOW_MS = 120_000;
export const CRASH_LOOP_LIMIT = 5;

export const backoffFor = (attempt: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));

export type SupervisorDeps = {
  logPath: string;
  /** The pid the state file records, or null when there is no readable state file — which is itself
   *  a dead daemon, since a live one wrote that file and clears it only on the way out. */
  recordedPid: () => number | null;
  pidAlive: (pid: number) => boolean;
  spawn: () => void;
  onState: (s: SupervisorState) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
};

export class DaemonSupervisor {
  private state: SupervisorState = { kind: "connected" };
  private downSince: number | null = null;
  private restarts: number[] = [];
  private attempt = 0;
  private timer: unknown = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private d: SupervisorDeps) {
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** The bridge connected. Whatever we were worrying about is over. */
  onConnected(): void {
    if (this.stopped || this.state.kind === "failed") return;
    this.downSince = null;
    this.attempt = 0;
    this.cancelTimer();
    this.set({ kind: "connected" });
  }

  /** The bridge dropped, or failed to redial. Starts the clock; the decision is `tick`'s. */
  onDisconnected(): void {
    if (this.stopped || this.state.kind === "failed" || this.state.kind === "restarting") return;
    this.downSince ??= this.now();
    this.set({ kind: "disconnected" });
  }

  /**
   * Re-examine the world. Called on the bridge's own redial cadence, so the supervisor never needs a
   * clock of its own for the grace period — only for the backoff.
   */
  tick(): void {
    if (this.stopped || this.state.kind !== "disconnected" || this.downSince === null) return;
    if (this.now() - this.downSince < DOWN_GRACE_MS) return;
    const pid = this.d.recordedPid();
    // The pid is alive: the daemon is there and the socket is not answering us yet. Reconnecting is
    // the bridge's job and it is already doing it.
    if (pid !== null && this.d.pidAlive(pid)) return;
    this.restart();
  }

  private restart(): void {
    const at = this.now();
    this.restarts = this.restarts.filter((t) => at - t < CRASH_LOOP_WINDOW_MS);
    if (this.restarts.length >= CRASH_LOOP_LIMIT) {
      this.cancelTimer();
      this.set({ kind: "failed", logPath: this.d.logPath });
      return;
    }
    this.restarts.push(at);
    this.attempt++;
    this.set({ kind: "restarting", attempt: this.attempt });
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.stopped) return;
      this.d.spawn();
      // Back to waiting: the bridge's next connect is what tells us this worked. If it does not, the
      // drop that follows starts the clock again with a longer backoff.
      this.downSince = this.now();
      this.set({ kind: "disconnected" });
    }, backoffFor(this.attempt));
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
  }

  private set(s: SupervisorState): void {
    if (s.kind === this.state.kind && JSON.stringify(s) === JSON.stringify(this.state)) return;
    this.state = s;
    this.d.onState(s);
  }
}
