import { BROWSER_DISCARD_HIDDEN_DEFAULT, BROWSER_DISCARD_HIDDEN_KEY, BROWSER_KEEP_HIDDEN_DEFAULT, BROWSER_KEEP_HIDDEN_KEY } from "@realm/contracts";

/** How often the policies that run on the server's clock look again. */
export const POLICY_TICK_MS = 60_000;

/** A whole number of minutes from a setting: the default for anything that is not one, 0 for never. */
export function minutesSetting(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/**
 * The resource policies that run on the server's clock and act through the app: today, discarding
 * browser panes that have been off screen past their window (main's `BrowserPaneHost.sweep` decides,
 * view by view, what may go). Each other policy lives with what it governs — the engine reaper in the
 * session service, Laya's idle stop in the Laya service, the simulator sweep in the simulator service —
 * because each needs that service's own knowledge of what is mid-work.
 */
export class ResourcePolicies {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly d: {
    settings: { get(key: string): unknown };
    /** main's side of the bridge; null when no app is attached, and then there are no panes to discard. */
    app: () => { call(op: "browserSweep", params: { hiddenMs: number; keepHidden: number }): Promise<unknown> } | null;
  }) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, POLICY_TICK_MS);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The browser window, in minutes; 0 never discards. */
  browserMinutes(): number {
    return minutesSetting(this.d.settings.get(BROWSER_DISCARD_HIDDEN_KEY), BROWSER_DISCARD_HIDDEN_DEFAULT);
  }

  browserKeep(): number {
    return minutesSetting(this.d.settings.get(BROWSER_KEEP_HIDDEN_KEY), BROWSER_KEEP_HIDDEN_DEFAULT);
  }

  /** One look: what the clock does every minute. Never two at once — a sweep waits on pages answering. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const minutes = this.browserMinutes();
      const app = this.d.app();
      if (minutes > 0 && app) await app.call("browserSweep", { hiddenMs: minutes * 60_000, keepHidden: this.browserKeep() }).catch(() => {});
    } finally {
      this.running = false;
    }
  }
}
