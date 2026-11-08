import { readFileSync, writeFileSync } from "node:fs";

/**
 * Realm's windows (Plan 27 Phase 2: a window per profile).
 *
 * Main used to hold ONE window and assume it everywhere — where a toast click lands, what the menu bar
 * talks to, which window's views an agent drives. A profile can open in a window of its own now, Chrome's
 * model, so main keeps every window here with the profile it is showing, and answers the questions the
 * single window used to answer by being the only one:
 *
 *   - which window shows this profile — opening it again brings that window forward rather than
 *     making a second;
 *   - which window shows this space (a space is open in at most one: asking for it from another
 *     window brings this one forward, so one space's panes are never on screen twice);
 *   - which window to talk to when no window asked — a toast click, the tray, a second launch: the
 *     one showing the space it is about, else the one the person used last;
 *   - which windows to bring back on the next launch, and what each is titled.
 *
 * Electron-free, so those rules die in a unit test rather than in a live run.
 */

export type RegisteredWindow = { id: number; isDestroyed(): boolean };

type Entry<W> = {
  win: W;
  /** The profile the window was opened for, or null for the first window, which has none of its own. */
  bound: string | null;
  /** The space it was opened for, or null. Its panes are kept under that space's view key. */
  boundSpace: string | null;
  /** The profile it shows right now, as its renderer last said — the bound one at first, and whatever
   *  the person switched it to since. */
  showing: string | null;
  /** The space it shows right now, as its renderer last said. */
  space: string | null;
  /** When it was last focused, in registry order — the larger, the more recent. */
  focusedAt: number;
};

export class WindowRegistry<W extends RegisteredWindow> {
  private entries = new Map<number, Entry<W>>();
  private clock = 0;

  get size(): number { return this.live().length; }

  /** A new window, opened for `profileId` (null for the first window). It counts as the most recently
   *  used, since a window that has just opened is the one in front. */
  add(win: W, profileId: string | null, spaceId: string | null = null): void {
    this.entries.set(win.id, { win, bound: profileId, boundSpace: spaceId, showing: profileId, space: null, focusedAt: ++this.clock });
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

  /** The window's renderer says which space it is showing now. */
  setSpace(win: W, spaceId: string | null): void {
    const e = this.entries.get(win.id);
    if (e) e.space = spaceId;
  }

  showing(win: W): string | null { return this.entries.get(win.id)?.showing ?? null; }
  spaceOf(win: W): string | null { return this.entries.get(win.id)?.space ?? null; }
  boundTo(win: W): string | null { return this.entries.get(win.id)?.bound ?? null; }

  /** The live window showing this profile, other than `except` — the one to bring forward instead of
   *  opening a second window for the same profile. The most recently used, should two ever show it. */
  windowFor(profileId: string, except?: W): W | null {
    return this.live()
      .filter((e) => e.showing === profileId && e.win.id !== except?.id)
      .sort((a, b) => b.focusedAt - a.focusedAt)[0]?.win ?? null;
  }

  /** The live window showing this space, other than `except`. */
  windowForSpace(spaceId: string, except?: W): W | null {
    return this.live().find((e) => e.space === spaceId && e.win.id !== except?.id)?.win ?? null;
  }

  /** Every space some window is showing. */
  openSpaces(): Set<string> {
    return new Set(this.live().flatMap((e) => (e.space ? [e.space] : [])));
  }

  /** The window to talk to when no window asked: the one used last. */
  primary(): W | null {
    return this.live().sort((a, b) => b.focusedAt - a.focusedAt)[0]?.win ?? null;
  }

  /** Where something about a space opens — a toast's session, a session picked from the menu bar:
   *  the window showing that space, else the one used last, which switches to it. */
  windowToOpen(spaceId: string | null): W | null {
    return (spaceId ? this.windowForSpace(spaceId) : null) ?? this.primary();
  }

  all(): W[] { return this.live().map((e) => e.win); }

  /** Every window as it would come back after a relaunch, the one used longest ago first, so opening
   *  them in this order leaves the one used last in front. */
  saved(): SavedWindow[] {
    return this.live().sort((a, b) => a.focusedAt - b.focusedAt)
      .map((e) => ({ profileId: e.bound, spaceId: e.boundSpace, showing: e.space }));
  }

  private live(): Entry<W>[] {
    return [...this.entries.values()].filter((e) => !e.win.isDestroyed());
  }
}

/**
 * A window to bring back on the next launch. `profileId` and `spaceId` are what it was opened for, so
 * it comes back with the same view key and the same saved place; `showing` is the space it was on.
 */
export type SavedWindow = { profileId: string | null; spaceId: string | null; showing: string | null };

/** The window a relaunch opens: what to open it for, and the space it lands on (`--realm-land`). */
export type RestoredWindow = { profileId: string | null; spaceId: string | null; land: string | null };

/**
 * The windows to open at launch, from the ones saved at quit. Each lands on the space it showed; a
 * window whose space has been deleted lands on the space it was opened for, and is skipped when that
 * has gone too. A space is open in at most one window, so a second window landing on a space already
 * taken is dropped. With nothing left, one first window, which finds its own way as it always has.
 */
export function windowsToRestore(saved: readonly SavedWindow[], spaces: readonly { id: string; profileId: string }[]): RestoredWindow[] {
  const profileOf = new Map(spaces.map((sp) => [sp.id, sp.profileId]));
  const exists = (id: string | null): id is string => id !== null && profileOf.has(id);
  const out: RestoredWindow[] = [];
  for (const w of saved) {
    const land = [w.showing, w.spaceId].find(exists) ?? null;
    if (land === null && w.profileId !== null) continue;
    if (out.some((r) => r.land === land)) continue;
    // A window opened for a profile comes back for the profile of the space it lands on, which is
    // the one it showed. The first window stays the first window.
    out.push({ profileId: land !== null && w.profileId !== null ? profileOf.get(land)! : null, spaceId: exists(w.spaceId) ? w.spaceId : null, land });
  }
  return out.length > 0 ? out : [{ profileId: null, spaceId: null, land: null }];
}

export function readSavedWindows(
  file: string,
  read: (path: string, encoding: "utf8") => string = readFileSync,
): SavedWindow[] {
  try {
    const raw = JSON.parse(read(file, "utf8")) as { windows?: unknown };
    if (!Array.isArray(raw.windows)) return [];
    const id = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
    return raw.windows.flatMap((w: unknown) => {
      if (typeof w !== "object" || w === null) return [];
      const o = w as Record<string, unknown>;
      return [{ profileId: id(o.profileId), spaceId: id(o.spaceId), showing: id(o.showing) }];
    });
  } catch {
    return []; // first launch, or a file edited by hand
  }
}

export function writeSavedWindows(file: string, windows: readonly SavedWindow[], write = writeFileSync): void {
  try { write(file, JSON.stringify({ windows })); } catch { /* a read-only userData costs only the memory */ }
}

/**
 * A window's title, which is what the Window menu, Mission Control and the Dock list it by: the name
 * of the space it shows. When a space in another profile has the same name, the profile's name follows,
 * so two "Inbox" windows can be told apart. Before the window says which space it shows, its profile's
 * name, and before that "Realm".
 */
export function windowTitle(
  spaceId: string | null, profileId: string | null,
  spaces: readonly { id: string; profileId: string; name: string }[], profileName: (id: string) => string | undefined,
): string {
  const space = spaces.find((sp) => sp.id === spaceId);
  if (!space) return (profileId ? profileName(profileId) : undefined) ?? "Realm";
  const twin = spaces.some((sp) => sp.profileId !== space.profileId && sp.name === space.name);
  const profile = twin ? profileName(space.profileId) : undefined;
  return profile ? `${space.name} — ${profile}` : space.name;
}

/**
 * The space File ▸ New Window opens on: the next one after the space the front window shows, in the
 * front window's profile and the person's order, wrapping round — skipping every space a window
 * already has. Then the other profiles' spaces in their order. Null when every space is open.
 */
export function spaceForNewWindow<S extends { id: string; profileId: string }>(
  spaces: readonly S[], front: { profileId: string | null; spaceId: string | null } | null, open: ReadonlySet<string>,
): S | null {
  const mine = spaces.filter((sp) => sp.profileId === front?.profileId);
  const at = mine.findIndex((sp) => sp.id === front?.spaceId);
  const after = [...mine.slice(at + 1), ...mine.slice(0, at + 1)];
  return [...after, ...spaces.filter((sp) => sp.profileId !== front?.profileId)].find((sp) => !open.has(sp.id)) ?? null;
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
