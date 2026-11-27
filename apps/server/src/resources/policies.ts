import {
  BROWSER_DISCARD_HIDDEN_DEFAULT, BROWSER_DISCARD_HIDDEN_KEY, BROWSER_KEEP_HIDDEN_DEFAULT, BROWSER_KEEP_HIDDEN_KEY, MCP_IDLE_STOP_DEFAULT, MCP_IDLE_STOP_KEY,
  WINDOW_IDLE_MINUTES_DEFAULT, WINDOW_IDLE_MINUTES_KEY, WINDOW_PRESSURE_IDLE_MINUTES, WINDOW_UNLOAD_IDLE_DEFAULT, WINDOW_UNLOAD_IDLE_KEY, type PressureIdleMinutes,
} from "@realm/contracts";

type BrowserSweep = { hiddenMs: number | null; keepHidden: number; policy?: boolean };
type WindowSweep = { idleMs: number | null; unloadIdle: boolean; busySpaces: string[] };

/** How often the policies that run on the server's clock look again. */
export const POLICY_TICK_MS = 60_000;

/** A whole number of minutes from a setting: the default for anything that is not one, 0 for never. */
export function minutesSetting(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/**
 * The resource policies that run on the server's clock without a service of their own: discarding
 * browser panes off screen past their window (main's `HiddenViews.sweep` decides, view by view,
 * what may go), unloading Realm windows nobody has focused in hours (main's `WindowIdle.sweep`), and
 * stopping stdio MCP servers that have gone without a call (`McpHub.sleepIdle`).
 * Each other policy lives with what it governs — the engine reaper in the session service, Laya's idle
 * stop in the Laya service, the simulator sweep in the simulator service — because each needs that
 * service's own knowledge of what is mid-work. Every window here is shortened under memory pressure.
 */
export class ResourcePolicies {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly d: {
    settings: { get(key: string): unknown };
    /** main's side of the bridge; null when no app is attached, and then there are no panes to discard. */
    app: () => { call(op: "browserSweep" | "windowSweep", params: BrowserSweep | WindowSweep): Promise<unknown> } | null;
    mcp?: { sleepIdle(idleMs: number): string[] };
    /** A window as memory pressure leaves it (`ResourceService.adapt`). */
    adapt?: (minutes: number, windows?: PressureIdleMinutes) => number;
    /** The spaces with a session working or waiting on an answer: a window showing one stays loaded. */
    busySpaces?: () => string[];
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

  /** The browser window in force, in minutes; 0 never discards. */
  browserMinutes(): number {
    const m = minutesSetting(this.d.settings.get(BROWSER_DISCARD_HIDDEN_KEY), BROWSER_DISCARD_HIDDEN_DEFAULT);
    return this.d.adapt?.(m) ?? m;
  }

  /** The MCP window in force, in minutes; 0 never stops one. */
  mcpMinutes(): number {
    const m = minutesSetting(this.d.settings.get(MCP_IDLE_STOP_KEY), MCP_IDLE_STOP_DEFAULT);
    return this.d.adapt?.(m) ?? m;
  }

  /** The windows' idle window in force, in minutes; 0 never unloads one, nor does the switch off. */
  windowMinutes(): number {
    if (!this.unloadIdleWindows()) return 0;
    const m = minutesSetting(this.d.settings.get(WINDOW_IDLE_MINUTES_KEY), WINDOW_IDLE_MINUTES_DEFAULT);
    return this.d.adapt?.(m, WINDOW_PRESSURE_IDLE_MINUTES) ?? m;
  }

  unloadIdleWindows(): boolean {
    const raw = this.d.settings.get(WINDOW_UNLOAD_IDLE_KEY);
    return typeof raw === "boolean" ? raw : WINDOW_UNLOAD_IDLE_DEFAULT;
  }

  browserKeep(): number {
    return minutesSetting(this.d.settings.get(BROWSER_KEEP_HIDDEN_KEY), BROWSER_KEEP_HIDDEN_DEFAULT);
  }

  /** One look: what the clock does every minute. Never two at once — a sweep waits on pages answering. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const mcp = this.mcpMinutes();
      if (mcp > 0) this.d.mcp?.sleepIdle(mcp * 60_000);
      const minutes = this.browserMinutes();
      const app = this.d.app();
      // Sent with the window at Never too (`hiddenMs: null`): main's budget for unmounted panes keeps to
      // the same two settings, and learns them from here.
      if (app) await app.call("browserSweep", { hiddenMs: minutes > 0 ? minutes * 60_000 : null, keepHidden: this.browserKeep(), policy: true }).catch(() => {});
      // Sent with the window at Never and the switch off too: main throttles windows and opens them at
      // launch by the same switch, and learns it from here.
      const windows = this.windowMinutes();
      if (app) {
        await app.call("windowSweep", { idleMs: windows > 0 ? windows * 60_000 : null, unloadIdle: this.unloadIdleWindows(), busySpaces: this.d.busySpaces?.() ?? [] }).catch(() => {});
      }
    } finally {
      this.running = false;
    }
  }
}
