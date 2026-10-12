import type { LabUpdateState } from "@realm/contracts";

/**
 * The lab's update window: an update installs when the team's work is between runs, not in the
 * middle of one (teams plan §12 "Updates"). Installing Realm stops every session it hosts, so on a
 * Mac left alone an update that lands whenever the download finishes is a run killed at random.
 *
 *   waiting ──(the hour, or "Update now")──▶ draining ──(quiet, or the cap)──▶ installing ──▶ resumed
 *
 * While draining and installing the window HOLDS: no team run starts (`holding`, consulted by the
 * team's admit). Running work is waited for, up to a cap; whatever is still running at the cap is
 * left to the restart, which is safe because a run abandoned by a restart is queued again without
 * spending its attempts (`RunService.recoverOnBoot`). Installing itself is main's: the window
 * broadcasts `lab.install`, and main calls the updater it already has.
 *
 * The state is written through `save` on every change, so a server that restarts mid-drain keeps
 * holding and the server that boots after the update can say how it went. The clock is injected and
 * `tick` is called on a timer, so a test drives the whole window without waiting for 04:00.
 */

/** How long nothing may be running before the window installs — a settled turn may be about to start
 *  its next from a queued message (the daemon drain's reason, daemon/drain.ts). */
export const QUIET_HOLD_MS = 10_000;
/** How long `installing` is given before the window decides the install never happened and resumes:
 *  an updater that quit and relaunched is back long before this. */
export const INSTALL_GIVE_UP_MS = 15 * 60_000;

export type UpdateWindowDeps = {
  now: () => number;
  load: () => LabUpdateState;
  save: (s: LabUpdateState) => void;
  /** The hour the window opens (0–23, local) and how long running work is waited for. */
  hour: () => number;
  capMinutes: () => number;
  /** Work in flight: running runs, and turns in sessions no run owns. */
  busy: () => { runs: number; sessions: number };
  /** Tell main to install now. */
  install: (version: string) => void;
  /** Team runs may start again. */
  release: () => void;
  changed: () => void;
};

/** The next moment the local clock reads `hour`:00 at or after `from` — or `from` itself while that
 *  hour is still running, so an update that arrives at 04:20 does not wait a day. */
export function nextWindow(from: number, hour: number): number {
  const d = new Date(from);
  if (d.getHours() === hour) return from;
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0);
  if (at.getTime() <= from) at.setDate(at.getDate() + 1);
  return at.getTime();
}

export class UpdateWindow {
  private state: LabUpdateState;
  private quietSince: number | null = null;

  constructor(private readonly d: UpdateWindowDeps) {
    this.state = d.load();
  }

  get current(): LabUpdateState { return this.state; }

  /** Whether team runs are held: from the moment the window opens until the update is behind it. */
  get holding(): boolean { return this.state.kind === "draining" || this.state.kind === "installing"; }

  /** Main: an update is downloaded. A second report of the same version changes nothing. */
  ready(version: string, from: string): void {
    const s = this.state;
    if ((s.kind === "waiting" || s.kind === "draining" || s.kind === "installing") && s.version === version) return;
    const now = this.d.now();
    this.set({ kind: "waiting", version, from, readyAt: now, opensAt: nextWindow(now, this.d.hour()) });
    this.tick();
  }

  /** Open the window now rather than at its hour. */
  openNow(): void {
    if (this.state.kind !== "waiting") return;
    this.set({ ...this.state, opensAt: this.d.now() });
    this.tick();
  }

  /** The window's hour changed: a waiting update moves to the new one. */
  rescheduled(): void {
    if (this.state.kind !== "waiting") return;
    this.set({ ...this.state, opensAt: nextWindow(this.state.readyAt, this.d.hour()) });
    this.tick();
  }

  /**
   * Main connected, running `version`. After an install that is how the window learns it landed —
   * or, on the version it started from, that it did not. Either way the hold ends.
   */
  appVersion(version: string): void {
    const s = this.state;
    if (s.kind === "installing") return this.resume(version === s.version);
    // Updated some other way (the rail's Restart) while the window waited: the wait is over.
    if ((s.kind === "waiting" || s.kind === "draining") && version === s.version) this.resume(true);
  }

  /** Lab mode was turned off: let go of anything held, and forget the waiting update. */
  standDown(): void {
    if (this.state.kind === "idle" || this.state.kind === "resumed") return;
    const held = this.holding;
    this.set({ kind: "idle" });
    if (held) this.d.release();
  }

  tick(): void {
    const s = this.state;
    const now = this.d.now();
    if (s.kind === "waiting") {
      if (now < s.opensAt) return;
      this.quietSince = null;
      const busy = this.d.busy();
      this.set({ kind: "draining", version: s.version, from: s.from, startedAt: now, capAt: now + this.d.capMinutes() * 60_000, running: busy.runs + busy.sessions });
      return this.tick();
    }
    if (s.kind === "draining") {
      const busy = this.d.busy();
      const running = busy.runs + busy.sessions;
      if (running !== s.running) this.set({ ...s, running });
      if (running > 0) {
        this.quietSince = null;
        if (now >= s.capAt) this.installNow(running);
        return;
      }
      if (this.quietSince === null) { this.quietSince = now; return; }
      if (now - this.quietSince >= QUIET_HOLD_MS || now >= s.capAt) this.installNow(0);
      return;
    }
    if (s.kind === "installing" && now - s.at >= INSTALL_GIVE_UP_MS) this.resume(false);
  }

  private installNow(leftRunning: number): void {
    const s = this.state;
    if (s.kind !== "draining") return;
    this.set({ kind: "installing", version: s.version, from: s.from, at: this.d.now(), heldSince: s.startedAt, leftRunning });
    this.d.install(s.version);
  }

  private resume(applied: boolean): void {
    const s = this.state;
    if (s.kind === "idle" || s.kind === "resumed") return;
    const now = this.d.now();
    const heldFrom = s.kind === "draining" ? s.startedAt : s.kind === "installing" ? s.heldSince : now;
    this.set({ kind: "resumed", version: s.version, from: s.from, at: now, applied, heldMs: Math.max(0, now - heldFrom) });
    this.d.release();
  }

  private set(next: LabUpdateState): void {
    this.state = next;
    this.d.save(next);
    this.d.changed();
  }
}
