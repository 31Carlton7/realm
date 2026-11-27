/**
 * Realm windows nobody has looked at in hours (Settings ▸ RAM's Unload idle windows).
 *
 * Each window holds a renderer of its own, about 290 MB measured with eleven open, whether or not
 * anyone has looked at its space since the morning. A window that has gone the idle window without
 * focus gives its renderer up and stays on screen as a window; focused again, its page loads afresh
 * and puts back the view it had (the space it showed, its panes, the page over them, each reader's
 * scroll). realm-server's clock asks for the sweep with the window its setting and the Mac's memory
 * pressure decide (`resources/policies.ts`).
 *
 * Electron-free, so the rules die in a unit test rather than in a live run.
 */

/** Why a window past its idle window stays loaded: it has the keyboard, it is the one in front, it is
 *  the one used last (minimised or hidden, it is still the page that asks for toasts), it can be seen on
 *  another display, an agent is driving one of its panes, a session in its space is working, it is
 *  playing audio or hearing a microphone (dictation, a meeting's transcript), its page holds work kept
 *  nowhere else (`unsaved`: a prompt not sent, a file not settled, a sheet open), or its renderer
 *  process holds another page too, which ending it would end. */
export type IdleKeep = "focused" | "front" | "last" | "visible" | "agent" | "working" | "audio" | "listening" | "unsaved" | "shared";

export type IdleWindow = { id: number; isDestroyed(): boolean };

export class WindowIdle<W extends IdleWindow> {
  private windows = new Map<number, { win: W; focusedAt: number }>();
  /** Unloaded windows, each with its unload, which a focus waits for before loading it again. The
   *  unload answers why the window stayed after all, or null once its renderer has ended. */
  private unloaded = new Map<number, Promise<IdleKeep | null>>();
  /** Windows loading again, until their page has loaded. */
  private waking = new Map<number, Promise<void>>();
  /** The window focused or opened last, which no sweep unloads. */
  private lastUsed: number | null = null;

  constructor(private readonly d: {
    now: () => number;
    keep: (win: W) => IdleKeep | null;
    /** Give the window's renderer up, its view saved first. Answers why it stayed instead (its page
     *  refused, or it was focused while saving), or null once the renderer has ended. */
    unload: (win: W) => Promise<IdleKeep | null>;
    /** Load the window's page again, settled once the page has loaded (or failed to, or gone). */
    load: (win: W) => Promise<void>;
  }) {}

  /** A new window: its idle clock starts now, as if it had just been focused. */
  opened(win: W): void {
    this.windows.set(win.id, { win, focusedAt: this.d.now() });
    this.lastUsed = win.id;
  }

  /** The window was focused or brought forward: its clock starts again, and an unloaded one loads. */
  focused(win: W): Promise<void> {
    const entry = this.windows.get(win.id);
    if (entry) entry.focusedAt = this.d.now();
    this.lastUsed = win.id;
    return this.wake(win);
  }

  /** Load an unloaded window again, once its unload has finished; settled once its page has loaded.
   *  A window that is loaded, or already loading, is left as it is. */
  wake(win: W): Promise<void> {
    const unloading = this.unloaded.get(win.id);
    if (!unloading) return this.awake(win);
    this.unloaded.delete(win.id);
    const waking = (async () => {
      const kept = await unloading;
      // Still loaded after all (focused while it was saving its view): its page is the one it had.
      if (kept !== null || win.isDestroyed()) return;
      await this.d.load(win);
    })().finally(() => { if (this.waking.get(win.id) === waking) this.waking.delete(win.id); });
    this.waking.set(win.id, waking);
    return waking;
  }

  /** Wake every unloaded window `which` picks; settled as each page loads. */
  wakeWhere(which: (win: W) => boolean): Promise<void>[] {
    return [...this.windows.values()].filter(({ win }) => this.unloaded.has(win.id) && which(win)).map(({ win }) => this.wake(win));
  }

  /** Settled once the window's page is up: at once for a loaded window, after its load for one loading. */
  awake(win: W): Promise<void> { return this.waking.get(win.id) ?? Promise.resolve(); }

  /** The window lost the keyboard: it was in use until now, and its clock starts here. */
  blurred(win: W): void {
    const entry = this.windows.get(win.id);
    if (entry) entry.focusedAt = this.d.now();
  }

  closed(win: W): void {
    this.windows.delete(win.id);
    this.unloaded.delete(win.id);
    this.waking.delete(win.id);
    if (this.lastUsed === win.id) this.lastUsed = null;
  }

  isUnloaded(win: W): boolean { return this.unloaded.has(win.id); }
  isLoading(win: W): boolean { return this.waking.has(win.id); }
  /** How many of these windows have a page: what can still ask for a toast. */
  loadedCount(wins: readonly W[]): number { return wins.filter((w) => !w.isDestroyed() && !this.unloaded.has(w.id)).length; }

  /** Unload every window not focused for `idleMs`, but those with a reason to stay. Null unloads none. */
  async sweep(idleMs: number | null): Promise<{ unloaded: number[]; kept: { id: number; reason: IdleKeep }[] }> {
    const out: { unloaded: number[]; kept: { id: number; reason: IdleKeep }[] } = { unloaded: [], kept: [] };
    if (idleMs === null) return out;
    const now = this.d.now();
    const answers: Promise<{ id: number; kept: IdleKeep | null }>[] = [];
    for (const { win, focusedAt } of this.windows.values()) {
      if (win.isDestroyed() || this.unloaded.has(win.id) || this.isLoading(win) || now - focusedAt < idleMs) continue;
      const reason = win.id === this.lastUsed ? "last" : this.d.keep(win);
      if (reason) {
        // Still in use: its clock starts again from now, so leaving it later is when it starts to idle.
        if (reason === "focused" || reason === "front" || reason === "last") this.windows.get(win.id)!.focusedAt = now;
        answers.push(Promise.resolve({ id: win.id, kept: reason }));
        continue;
      }
      const unload = this.d.unload(win).catch(() => null);
      this.unloaded.set(win.id, unload);
      answers.push(unload.then((kept) => {
        // Refused, or focused while it saved: not unloaded, and asked again at the next sweep.
        if (kept !== null && this.unloaded.get(win.id) === unload) this.unloaded.delete(win.id);
        return { id: win.id, kept };
      }));
    }
    for (const { id, kept } of await Promise.all(answers)) {
      if (kept === null) out.unloaded.push(id); else out.kept.push({ id, reason: kept });
    }
    return out;
  }
}

/** The events of a window's webContents that end a load. */
export type LoadEvents = {
  once(event: string, fn: (...args: unknown[]) => void): unknown;
  removeListener(event: string, fn: (...args: unknown[]) => void): unknown;
};

/** Settled when the page loading in `wc` has loaded, failed to in its main frame, or gone with its
 *  webContents, or after `timeoutMs` whichever way it went. */
export function pageLoaded(wc: LoadEvents, timeoutMs: number): Promise<"loaded" | "failed" | "gone" | "timeout"> {
  return new Promise((resolve) => {
    const finish = (how: "loaded" | "failed" | "gone" | "timeout") => {
      clearTimeout(timer);
      wc.removeListener("did-finish-load", loaded);
      wc.removeListener("did-fail-load", failed);
      wc.removeListener("destroyed", gone);
      resolve(how);
    };
    const loaded = () => finish("loaded");
    // Every frame's failure is told; only the page's own ends its load.
    const failed = (...args: unknown[]) => { if (args[4] === true) finish("failed"); else wc.once("did-fail-load", failed); };
    const gone = () => finish("gone");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    wc.once("did-finish-load", loaded);
    wc.once("did-fail-load", failed);
    wc.once("destroyed", gone);
  });
}

/** Whether a session's new status is work starting: what loads an unloaded window on its space. */
export function wakesWindows(payload: unknown): boolean {
  const status = (payload as { status?: unknown } | null | undefined)?.status;
  return status === "running" || status === "waiting_permission";
}

export function busySpaces(sessions: readonly { spaceId: string; status: string }[]): Set<string> {
  return new Set(sessions.filter((s) => s.status === "running" || s.status === "waiting_permission").map((s) => s.spaceId));
}

/** Whether another live page runs in this webContents' renderer process: ending it would end that one. */
export function sharesRenderer<C extends { id: number; getOSProcessId(): number; isDestroyed(): boolean }>(wc: C, all: readonly C[]): boolean {
  const pid = wc.getOSProcessId();
  return all.some((o) => o.id !== wc.id && !o.isDestroyed() && o.getOSProcessId() === pid);
}

/** Whether a window is on screen on another display than the one in front: someone may be looking at
 *  it, and an unloaded window shows nothing. */
export function onAnotherDisplay(win: { visible: boolean; minimized: boolean; display: number }, frontDisplay: number | null): boolean {
  return win.visible && !win.minimized && frontDisplay !== null && win.display !== frontDisplay;
}
