/** Idle this long counts as away: Plan 28's "the Mac has been idle two minutes". */
export const AWAY_IDLE_SECONDS = 120;

/** How often main reads the idle clock. Away is noticed at most this late after the two minutes. */
export const PRESENCE_POLL_MS = 15_000;

/** The same answer is said again this often. The server stops believing a report after five minutes
 *  (`remote/presence.ts`), so a main that is alive but has nothing new to say must still say it. */
export const PRESENCE_REFRESH_MS = 2 * 60_000;

export type PresenceInputs = { idleSeconds: number; locked: boolean; windows: number };

/** Whether the owner counts as away from this Mac: the screen is locked, no Realm window is open, or
 *  nobody has touched the keyboard or trackpad for two minutes. */
export function isAway(i: PresenceInputs): boolean {
  return i.locked || i.windows === 0 || i.idleSeconds >= AWAY_IDLE_SECONDS;
}

/**
 * Electron main's half of "When the phone buzzes" (Plan 28): telling realm-server whether the owner
 * is at this Mac, so a push waits while they are and goes at once when they are not.
 *
 * Electron-free, like `sleep-guard.ts`: the idle clock, the window count and the RPC arrive as
 * functions, so the decision is tested without a screen to lock. It sends only a change — plus the
 * unchanged answer once it is old enough to need refreshing — and a send that fails is tried again on
 * the next look, since the server it failed to reach may be back by then.
 */
export class PresenceReporter {
  private locked = false;
  private sent: { away: boolean; at: number } | null = null;

  constructor(private readonly d: {
    idleSeconds: () => number;
    windows: () => number;
    send: (away: boolean) => Promise<unknown>;
    now?: () => number;
  }) {}

  /** `lock-screen` and `unlock-screen`. */
  setLocked(locked: boolean): void {
    this.locked = locked;
    this.check();
  }

  /** Look again: a poll tick, a window opening or closing, the Mac waking. */
  check(): void {
    const away = isAway({ idleSeconds: this.d.idleSeconds(), locked: this.locked, windows: this.d.windows() });
    const now = (this.d.now ?? Date.now)();
    if (this.sent && this.sent.away === away && now - this.sent.at < PRESENCE_REFRESH_MS) return;
    const record = { away, at: now };
    this.sent = record;
    this.d.send(away).catch(() => { if (this.sent === record) this.sent = null; });
  }

  /** The server connected (or reconnected): it has heard nothing from this process, so tell it now. */
  reset(): void {
    this.sent = null;
    this.check();
  }
}
