/**
 * Where the WINDOW has been — the trail Go back and Go forward step through, rooms included.
 *
 * The pane trails (`PaneHistory`, contracts/nav.ts) answer "what did this pane show before", and a
 * room switch forgets them, because the new room's panes are different panes. This one answers the
 * question a room switch raises instead: where was I. Following an agent into another room and
 * coming back is one step back along it.
 *
 * A stop is a room and the item whose pane had the keyboard there. Pure, so the rules — what counts as
 * a new stop, what a step skips — are testable without a store.
 */

/** One place the window has been. `itemId` is null for a room whose focused pane held nothing. */
export type WindowStop = { spaceId: string; itemId: string | null };

/** The stops, oldest first, and where the window stands among them; -1 before the first landing. */
export type WindowTrail = { stops: WindowStop[]; index: number };

export const EMPTY_TRAIL: WindowTrail = { stops: [], index: -1 };

/** As far back as the window remembers — the pane trails' own cap, for the same reason: past this
 *  nobody presses Back, and the cap is a leak guard on a window left open for days. */
export const WINDOW_TRAIL_LIMIT = 50;

export const sameStop = (a: WindowStop | undefined, b: WindowStop): boolean =>
  a !== undefined && a.spaceId === b.spaceId && a.itemId === b.itemId;

/**
 * Record a landing. Standing where you already are is not a stop, which is what lets every write be
 * offered here without filling the trail with repeats. A landing from the middle of the trail drops
 * the forward run — the browser's rule: the branch you left is not reachable by going forward.
 * Returns `t` itself when nothing changed, so a caller can skip the write.
 */
export function pushStop(t: WindowTrail, stop: WindowStop): WindowTrail {
  if (sameStop(t.stops[t.index], stop)) return t;
  const stops = [...t.stops.slice(0, t.index + 1), stop].slice(-WINDOW_TRAIL_LIMIT);
  return { stops, index: stops.length - 1 };
}

/**
 * The stop one step `delta` away that can still be reached, or null at either end. A room deleted
 * since it was visited is stepped over rather than landed in: there is nothing there to go back to.
 */
export function stepTarget(t: WindowTrail, delta: number, reachable: (stop: WindowStop) => boolean): number | null {
  const dir = Math.sign(delta);
  if (dir === 0) return null;
  for (let i = t.index + dir; i >= 0 && i < t.stops.length; i += dir) if (reachable(t.stops[i]!)) return i;
  return null;
}

/**
 * The stop a step landed on, rewritten to where it actually landed — a step onto a stop whose item has
 * gone since lands in its room instead. Left as it was, the next write would read the room as somewhere
 * new and record it, which forks the trail and throws away the way forward. Folded into a neighbour it
 * now equals, because two identical stops side by side are a key press that goes nowhere.
 */
export function settleStop(t: WindowTrail, landed: WindowStop): WindowTrail {
  if (t.index < 0 || sameStop(t.stops[t.index], landed)) return t;
  const stops = t.stops.map((s, k) => (k === t.index ? landed : s));
  let index = t.index;
  if (sameStop(stops[index + 1], landed)) stops.splice(index + 1, 1);
  if (index > 0 && sameStop(stops[index - 1], landed)) { stops.splice(index, 1); index--; }
  return { stops, index };
}
