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

/** Why a window past its idle window stays loaded: it has the keyboard, it is the one in front, an
 *  agent is driving one of its panes, a session in its space is working, or it is playing audio or
 *  hearing a microphone (dictation, a meeting's transcript). */
export type IdleKeep = "focused" | "front" | "agent" | "working" | "audio" | "listening";

export type IdleWindow = { id: number; isDestroyed(): boolean };

export class WindowIdle<W extends IdleWindow> {
  private windows = new Map<number, { win: W; focusedAt: number }>();
  /** Unloaded windows, each with its unload, which a focus waits for before loading it again. */
  private unloaded = new Map<number, Promise<void>>();

  constructor(private readonly d: {
    now: () => number;
    keep: (win: W) => IdleKeep | null;
    /** Give the window's renderer up, its view saved first. */
    unload: (win: W) => Promise<void>;
    /** Load the window's page again. */
    load: (win: W) => void;
  }) {}

  /** A new window: its idle clock starts now, as if it had just been focused. */
  opened(win: W): void {
    this.windows.set(win.id, { win, focusedAt: this.d.now() });
  }

  /** The window was focused or brought forward: its clock starts again, and an unloaded one loads. */
  async focused(win: W): Promise<void> {
    const entry = this.windows.get(win.id);
    if (entry) entry.focusedAt = this.d.now();
    const unloading = this.unloaded.get(win.id);
    if (!unloading) return;
    this.unloaded.delete(win.id);
    await unloading;
    if (!win.isDestroyed()) this.d.load(win);
  }

  /** The window lost the keyboard: it was in use until now, and its clock starts here. */
  blurred(win: W): void {
    const entry = this.windows.get(win.id);
    if (entry) entry.focusedAt = this.d.now();
  }

  closed(win: W): void {
    this.windows.delete(win.id);
    this.unloaded.delete(win.id);
  }

  isUnloaded(win: W): boolean { return this.unloaded.has(win.id); }

  /** Unload every window not focused for `idleMs`, but those with a reason to stay. Null unloads none. */
  async sweep(idleMs: number | null): Promise<{ unloaded: number[]; kept: { id: number; reason: IdleKeep }[] }> {
    const out: { unloaded: number[]; kept: { id: number; reason: IdleKeep }[] } = { unloaded: [], kept: [] };
    if (idleMs === null) return out;
    const now = this.d.now();
    const unloads: Promise<void>[] = [];
    for (const { win, focusedAt } of this.windows.values()) {
      if (win.isDestroyed() || this.unloaded.has(win.id) || now - focusedAt < idleMs) continue;
      const reason = this.d.keep(win);
      if (reason) {
        // Still in use: its clock starts again from now, so leaving it later is when it starts to idle.
        if (reason === "focused" || reason === "front") this.windows.get(win.id)!.focusedAt = now;
        out.kept.push({ id: win.id, reason });
        continue;
      }
      const unload = this.d.unload(win).catch(() => {});
      this.unloaded.set(win.id, unload);
      unloads.push(unload);
      out.unloaded.push(win.id);
    }
    await Promise.all(unloads);
    return out;
  }
}

/**
 * Whether a window's renderer is throttled in the background. Chromium throttles a window that is
 * occluded or hidden, which is what a window nobody is looking at should cost. Not while an agent is
 * driving it: a backgrounded page that goes through a cross-process navigation never produces a
 * compositor frame, and synthetic input is dropped until one exists. Not while it plays or hears
 * audio either. With Unload idle windows off, never, as Realm ran when every window was kept awake.
 */
export function backgroundThrottled(o: { unloadIdle: boolean; agent: boolean; audio: boolean; listening: boolean }): boolean {
  if (!o.unloadIdle) return false;
  return !(o.agent || o.audio || o.listening);
}
