/**
 * The menu-bar indicator for "an agent is driving this Mac".
 *
 * Where this lives is forced by what computer use does. The helper refuses to click unless the
 * target application actually comes frontmost — that is the `not_frontmost` check in AxHelper.swift
 * — so at the instant an act lands, Realm is by definition not the active application and its window
 * may be behind everything or hidden outright. The browser pane's `driving` dot has a window to live
 * in and computer use has none, so mirroring it in the renderer would put the signal exactly where
 * it cannot be seen.
 *
 * A floating always-on-top window was the other candidate and is actively harmful here: an overlay
 * above the target is the case `occludingApp` documents its layer filter as unable to see, and one
 * owned by Realm would sit over the very point about to be clicked. The menu bar is the platform's
 * own answer for "something is running that you are not looking at" — where macOS puts its screen
 * recording and location indicators — and it is visible whichever application is frontmost.
 */

/** The part of Electron's `Tray` this needs, so the counting and lingering below can be exercised
 *  without a menu bar. */
export type DrivingTray = {
  setTitle(title: string): void;
  setToolTip(tip: string): void;
  destroy(): void;
};

export type ComputerDrivingDeps = {
  /** Builds the menu-bar item, called on the first act rather than at startup: this is not a
   *  permanent resident, and an item that sat there while nothing was driving would say nothing. */
  createTray: () => DrivingTray;
};

/**
 * How long the item stays up after the last act settles.
 *
 * An act is often tens of milliseconds and agents issue them in runs, so tearing the item down
 * between each would flash the menu bar rather than inform it. Worse, every appearance and
 * disappearance shifts the position of every item to its left, so the flicker would move other
 * applications' icons under the user's cursor. The linger coalesces a burst into one showing.
 */
const LINGER_MS = 1500;

/** Menu bar width is shared with every other item, so a long application name is clipped rather
 *  than allowed to push the rest off the screen. */
const MAX_NAME = 22;

export class ComputerDrivingIndicator {
  private tray: DrivingTray | null = null;
  private inFlight = 0;
  private linger: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly d: ComputerDrivingDeps) {}

  /** True while the menu-bar item exists. */
  get showing(): boolean {
    return this.tray !== null;
  }

  /**
   * One act is starting against `appName`.
   *
   * Counted rather than flagged: two sessions can have acts in flight at once, and the first to
   * settle must not take the indicator down while the second is still clicking.
   */
  acquire(appName: string): void {
    this.inFlight += 1;
    this.cancelLinger();
    if (!this.tray) this.tray = this.d.createTray();
    const name = drivingName(appName);
    this.tray.setTitle(`Driving ${name}`);
    // The tooltip carries the sentence the title has no room for, and names Realm — the title alone
    // does not say who is doing the driving.
    this.tray.setToolTip(`Realm is driving ${name}. An agent you are running is controlling this Mac.`);
  }

  /** The matching settle, whatever the outcome. */
  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight > 0) return;
    this.cancelLinger();
    this.linger = setTimeout(() => {
      this.linger = null;
      this.teardown();
    }, LINGER_MS);
  }

  /** Drop the item now. Quit calls this, where a pending linger would otherwise outlive the app. */
  dispose(): void {
    this.cancelLinger();
    this.inFlight = 0;
    this.teardown();
  }

  private cancelLinger(): void {
    if (!this.linger) return;
    clearTimeout(this.linger);
    this.linger = null;
  }

  private teardown(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}

function drivingName(appName: string): string {
  const name = appName.trim();
  if (!name) return "an app";
  // trimEnd so a name clipped at a word boundary does not leave a gap before the ellipsis.
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1).trimEnd()}…` : name;
}
