/**
 * Realm's windows (Plan 27 Phase 2: a window per profile).
 *
 * Main used to hold ONE window and assume it everywhere — where a toast click lands, what the menu bar
 * talks to, which window's views an agent drives. A profile can open in a window of its own now, Chrome's
 * model, so main keeps every window here with the profile it is showing, and answers the questions the
 * single window used to answer by being the only one:
 *
 *   - which window shows this profile (a profile is open in at most one: opening it again brings that
 *     window forward rather than making a second);
 *   - which window to talk to when no window asked — a toast click, the tray, a second launch: the one
 *     the person used last.
 *
 * Electron-free, so those rules die in a unit test rather than in a live run.
 */

export type RegisteredWindow = { id: number; isDestroyed(): boolean };

type Entry<W> = {
  win: W;
  /** The profile the window was opened for, or null for the first window, which has none of its own. */
  bound: string | null;
  /** The profile it shows right now, as its renderer last said — the bound one at first, and whatever
   *  the person switched it to since. */
  showing: string | null;
  /** When it was last focused, in registry order — the larger, the more recent. */
  focusedAt: number;
};

export class WindowRegistry<W extends RegisteredWindow> {
  private entries = new Map<number, Entry<W>>();
  private clock = 0;

  get size(): number { return this.live().length; }

  /** A new window, opened for `profileId` (null for the first window). It counts as the most recently
   *  used, since a window that has just opened is the one in front. */
  add(win: W, profileId: string | null): void {
    this.entries.set(win.id, { win, bound: profileId, showing: profileId, focusedAt: ++this.clock });
  }

  remove(win: W): void { this.entries.delete(win.id); }

  /** The person brought this window forward. */
  focused(win: W): void {
    const e = this.entries.get(win.id);
    if (e) e.focusedAt = ++this.clock;
  }

  /** The window's renderer says which profile it is showing now. */
  setShowing(win: W, profileId: string | null): void {
    const e = this.entries.get(win.id);
    if (e) e.showing = profileId;
  }

  showing(win: W): string | null { return this.entries.get(win.id)?.showing ?? null; }
  boundTo(win: W): string | null { return this.entries.get(win.id)?.bound ?? null; }

  /** The live window showing this profile, other than `except` — the one to bring forward instead of
   *  opening a second window for the same profile. The most recently used, should two ever show it. */
  windowFor(profileId: string, except?: W): W | null {
    return this.live()
      .filter((e) => e.showing === profileId && e.win.id !== except?.id)
      .sort((a, b) => b.focusedAt - a.focusedAt)[0]?.win ?? null;
  }

  /** The window to talk to when no window asked: the one used last. */
  primary(): W | null {
    return this.live().sort((a, b) => b.focusedAt - a.focusedAt)[0]?.win ?? null;
  }

  all(): W[] { return this.live().map((e) => e.win); }

  private live(): Entry<W>[] {
    return [...this.entries.values()].filter((e) => !e.win.isDestroyed());
  }
}

/**
 * Where a new profile window opens when that profile has no place of its own saved: just down and to
 * the right of the window it was opened from, so it is plainly a second window rather than one exactly
 * covering the first.
 */
export const CASCADE_OFFSET = 28;
export function cascadeFrom(from: { x: number; y: number; width: number; height: number } | null): { x: number; y: number; width: number; height: number; maximized?: boolean; fullScreen?: boolean } | null {
  return from ? { x: from.x + CASCADE_OFFSET, y: from.y + CASCADE_OFFSET, width: from.width, height: from.height } : null;
}
