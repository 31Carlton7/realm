import { readFileSync, writeFileSync } from "node:fs";
import { readWindowState, type Rect, type SavedWindow } from "./window-state";

/**
 * Realm's windows, and the one rule that makes several of them safe: **a space is open in at most one
 * window.** A space's pane layout lives on the server and every window refetches it when it changes,
 * so two windows on one space would mirror each other — split in one, and the other splits too. One
 * space per window is VS Code's answer to the same question for a folder, and the one the person
 * chose: asking for a space that is open elsewhere brings that window forward instead.
 *
 * Generic over the window and its per-window furniture (the browser pane and the agent's host over
 * it), so the rules can be tested without Electron.
 */
export type WindowLike = {
  readonly id: number;
  isDestroyed(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  getNormalBounds(): Rect;
  isMaximized(): boolean;
  isFullScreen(): boolean;
};

export type Slot<W extends WindowLike, P> = {
  win: W;
  /** The space this window shows, or null before its renderer has claimed one. */
  spaceId: string | null;
  /** The window's browser pane and agent host; set once the window has built them. */
  furniture: P | null;
};

/** What a window should come back as on relaunch. */
export type SavedWindows = { windows: SavedWindow[] };

export type Claim = { ok: true } | { ok: false; ownerId: number };

export class WindowRegistry<W extends WindowLike, P = unknown> {
  private readonly slots = new Map<number, Slot<W, P>>();
  /** Most recently focused first, so "the window" has a definite answer when none is focused. */
  private order: number[] = [];
  /** Windows that closed but are still to come back, by id, in their last state. */
  private readonly retired = new Map<number, SavedWindow | null>();
  /** Set while the app closes every window at once (⌘Q, a real quit, an update). Windows closed in
   *  that sweep are remembered for the next launch; one the person closes alone is not. */
  private closingAll = false;

  add(win: W): Slot<W, P> {
    const slot: Slot<W, P> = { win, spaceId: null, furniture: null };
    this.slots.set(win.id, slot);
    this.touch(win.id);
    return slot;
  }

  /**
   * The window is closing — called from its `close` event, while its bounds can still be read.
   * Returns whether it should still come back: it does when the app is closing everything, or when
   * it is the last window, so reopening Realm lands where it was. A window the person closes while
   * others stay open is forgotten.
   */
  remove(id: number): boolean {
    const keep = this.closingAll || this.slots.size === 1;
    if (keep) this.retired.set(id, this.saved(id));
    this.slots.delete(id);
    this.order = this.order.filter((x) => x !== id);
    return keep;
  }

  get size(): number { return this.slots.size; }
  all(): Slot<W, P>[] { return [...this.slots.values()].filter((s) => !s.win.isDestroyed()); }
  get(id: number): Slot<W, P> | null { return this.slots.get(id) ?? null; }

  touch(id: number): void { this.order = [id, ...this.order.filter((x) => x !== id)]; }

  /** The focused window, else the one focused most recently. */
  current(): Slot<W, P> | null {
    const focused = this.all().find((s) => s.win.isFocused());
    if (focused) return focused;
    for (const id of this.order) { const s = this.slots.get(id); if (s && !s.win.isDestroyed()) return s; }
    return null;
  }

  ownerOf(spaceId: string): Slot<W, P> | null {
    return this.all().find((s) => s.spaceId === spaceId) ?? null;
  }

  /** Spaces open in windows other than `exceptId`. */
  claimedBy(exceptId: number): string[] {
    return this.all().filter((s) => s.win.id !== exceptId && s.spaceId !== null).map((s) => s.spaceId!);
  }

  /**
   * Window `id` wants to show `spaceId`. Granted when no other window has it; otherwise refused,
   * naming the window that does, which the caller brings forward instead.
   */
  claim(id: number, spaceId: string): Claim {
    const owner = this.ownerOf(spaceId);
    if (owner && owner.win.id !== id) return { ok: false, ownerId: owner.win.id };
    const slot = this.slots.get(id);
    if (slot) slot.spaceId = spaceId;
    return { ok: true };
  }

  /** Bring a window forward, out of the Dock if it was minimised. */
  raise(slot: Slot<W, P>): void {
    if (slot.win.isMinimized()) slot.win.restore();
    slot.win.show();
    slot.win.focus();
    this.touch(slot.win.id);
  }

  beginClosingAll(): void { this.closingAll = true; }
  /** Windows are open again: whatever closes next is closed on purpose. */
  endClosingAll(): void { this.closingAll = false; this.retired.clear(); }

  private saved(id: number): SavedWindow | null {
    const s = this.slots.get(id);
    if (!s || s.win.isDestroyed()) return null;
    return { ...s.win.getNormalBounds(), maximized: s.win.isMaximized(), fullScreen: s.win.isFullScreen(), spaceId: s.spaceId };
  }

  /** Every window to bring back, open ones in focus order then those closed in a sweep. */
  snapshot(): SavedWindows {
    const open = [...this.order, ...[...this.slots.keys()].filter((id) => !this.order.includes(id))]
      .map((id) => this.saved(id)).filter((w): w is SavedWindow => w !== null);
    const closed = [...this.retired.values()].filter((w): w is SavedWindow => w !== null);
    return { windows: [...open, ...closed] };
  }
}

/** The windows to bring back, from `windows.json` — or, on the first launch after this landed, the
 *  one window `window-state.json` remembered. */
export function readSavedWindows(file: string, legacyFile: string): SavedWindow[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { windows?: unknown };
    if (Array.isArray(raw.windows)) {
      return raw.windows.flatMap((w) => {
        if (typeof w !== "object" || w === null) return [];
        const o = w as Record<string, unknown>;
        // Numbers only: `Number(null)` is 0, and a coordinate that serialised as null is not a place.
        const rect = [o.x, o.y, o.width, o.height];
        if (!rect.every((v): v is number => typeof v === "number" && Number.isFinite(v))) return [];
        return [{ x: rect[0]!, y: rect[1]!, width: rect[2]!, height: rect[3]!, maximized: o.maximized === true,
          fullScreen: o.fullScreen === true, spaceId: typeof o.spaceId === "string" ? o.spaceId : null }];
      });
    }
  } catch { /* first launch, or a file edited by hand */ }
  const legacy = readWindowState(legacyFile);
  return legacy ? [legacy] : [];
}

export function writeSavedWindows(file: string, saved: SavedWindows, write = writeFileSync): void {
  try { write(file, JSON.stringify(saved)); } catch { /* a read-only userData costs only the memory */ }
}

/** Where a NEW window opens: the window it was asked from, moved down and right the way macOS
 *  cascades a new document window, so both stay in view. */
export const CASCADE = 26;
export function cascadeFrom(from: Rect | null, size: { width: number; height: number }): Rect | null {
  if (!from) return null;
  return { x: from.x + CASCADE, y: from.y + CASCADE, width: size.width || from.width, height: size.height || from.height };
}
