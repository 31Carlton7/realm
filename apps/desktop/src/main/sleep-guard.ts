/** The part of Electron's `powerSaveBlocker` this needs, so a test can stand in for it. */
export type PowerBlocker = { start(type: "prevent-app-suspension"): number; stop(id: number): void };

/**
 * Keeps the Mac awake while an agent is working, when the user has asked for that.
 *
 * Two inputs, and the blocker is held exactly while both say so: the preference (Settings ▸ General
 * ▸ Power, read from the server when main connects and pushed by the renderer when it changes) and
 * whether any session is running (the daemon's `working` count, re-read on every `session.status`).
 * Held at most once — a second start would leak an assertion the next stop never releases — and
 * released the moment either input drops, so a Mac never stays awake for a turn that has ended.
 *
 * `prevent-app-suspension` rather than `prevent-display-sleep`: the work needs the system awake, not
 * the screen lit, and a laptop left running an agent overnight should still put its display out.
 */
export class SleepGuard {
  private id: number | null = null;
  private wanted = false;
  private working = 0;

  constructor(private readonly blocker: PowerBlocker) {}

  setPreference(on: boolean): void { this.wanted = on; this.apply(); }
  setWorking(count: number): void { this.working = Number.isFinite(count) && count > 0 ? count : 0; this.apply(); }

  get holding(): boolean { return this.id !== null; }

  private apply(): void {
    const hold = this.wanted && this.working > 0;
    if (hold && this.id === null) this.id = this.blocker.start("prevent-app-suspension");
    else if (!hold && this.id !== null) { this.blocker.stop(this.id); this.id = null; }
  }
}
