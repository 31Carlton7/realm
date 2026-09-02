import type { Layout } from "./layout";
import type { SpaceGroups } from "./groups";

/**
 * One stop in a pane's own back/forward history.
 *
 * A pane shows an ITEM, and some items show more than one thing: the notifications page has a selected
 * row, the space page has a tab. `view` is that second coordinate — an opaque, per-kind string the pane
 * itself defines and the store applies (`applyNavView`). `null` is the item's own front door (the
 * notifications list, the space page's General tab).
 *
 * Two entries are the same stop when BOTH coordinates match, which is what makes re-selecting the row
 * you are already on a no-op rather than a history entry you have to press Back twice to leave.
 */
export type NavEntry = { itemId: string; view: string | null };

/** One leaf's stack. `index` is where the user is standing; everything after it is the forward run. */
export type LeafHistory = { entries: NavEntry[]; index: number };

/**
 * Per-LEAF, not per-item and not per-window: a leaf is "the pane at this position", which is exactly
 * what the user points at when they press Back. Two panes side by side navigate independently, and a
 * split's history does not merge with its neighbour's.
 *
 * Deliberately NOT persisted. History is about the trail you walked in this sitting; a Back button that
 * survives a restart would offer to return you to a pane state from days ago, which is a different
 * (and worse) promise than the one the arrows make.
 */
export type PaneHistory = Record<string, LeafHistory>;

/**
 * How far back one pane remembers. Fifty is far past the point anyone presses Back to reach and cheap
 * enough that the cap is really just a leak guard on a long-lived window.
 */
export const NAV_HISTORY_LIMIT = 50;

/** Where the pane is standing, or null for a leaf that has never held anything. */
export function navEntry(h: PaneHistory, leafId: string | null): NavEntry | null {
  if (!leafId) return null;
  const lh = h[leafId];
  return lh ? lh.entries[lh.index] ?? null : null;
}

/** Is there somewhere to go `delta` steps away? (`-1` = back, `+1` = forward.) */
export function canNav(h: PaneHistory, leafId: string | null, delta: number): boolean {
  if (!leafId) return false;
  const lh = h[leafId];
  if (!lh) return false;
  const i = lh.index + delta;
  return i >= 0 && i < lh.entries.length;
}

/** Move the cursor. Returns `h` UNCHANGED when there is nowhere to go — callers lean on the identity
 *  to skip the layout write a no-op step would otherwise perform. */
export function stepNav(h: PaneHistory, leafId: string, delta: number): PaneHistory {
  if (!canNav(h, leafId, delta)) return h;
  const lh = h[leafId]!;
  return { ...h, [leafId]: { entries: lh.entries, index: lh.index + delta } };
}

/**
 * Record a new stop, dropping the forward run — the browser rule: navigating from the middle of a
 * history forks it, and the branch you left is not reachable by pressing Forward.
 *
 * Arriving where you already are is NOT a stop. That guard is what lets `reconcileNav` run on every
 * layout write (a resize, a split, a group switch) without stuffing the stack with duplicates, and it
 * is what makes a back/forward step itself invisible to recording: the step moves the cursor onto an
 * entry, and the reconcile that follows the layout write sees that entry already current.
 */
export function pushNav(h: PaneHistory, leafId: string, entry: NavEntry): PaneHistory {
  const lh = h[leafId];
  const cur = lh?.entries[lh.index];
  if (cur && cur.itemId === entry.itemId && cur.view === entry.view) return h;
  const kept = lh ? lh.entries.slice(0, lh.index + 1) : [];
  // slice(-LIMIT) drops from the OLD end: the cap costs you the far past, never the step you just took.
  const entries = [...kept, entry].slice(-NAV_HISTORY_LIMIT);
  return { ...h, [leafId]: { entries, index: entries.length - 1 } };
}

function collectLeaves(l: Layout, into: Map<string, string | null>): void {
  if (l.type === "leaf") { into.set(l.id, l.itemId); return; }
  for (const c of l.children) collectLeaves(c, into);
}

/**
 * Fold the layout back into the histories — the single recording site.
 *
 * Every way a pane's occupant can change (openItem, a drag-drop, a split, a preset, an agent opening a
 * pane beside you) ends in a layout write, so reconciling there catches all of them at once instead of
 * asking twenty call sites to remember to record. Two things happen:
 *
 * - a leaf whose item is not the entry it is standing on gets that item pushed as a new stop;
 * - a leaf that no longer exists in ANY of the space's groups is forgotten.
 *
 * Groups, not just the active layout: switching groups must not erase the history of the arrangement
 * you switched away from, because switching back should find those panes as you left them. Switching
 * SPACES does forget — the new space's groups name entirely different leaves — which is the honest
 * behaviour for arrows that only ever promised to retrace this pane's trail.
 */
export function reconcileNav(h: PaneHistory, groups: SpaceGroups | null): PaneHistory {
  const leaves = new Map<string, string | null>();
  for (const g of groups?.groups ?? []) collectLeaves(g.layout, leaves);
  let next = h;
  const copy = () => (next === h ? (next = { ...h }) : next);
  for (const leafId of Object.keys(h)) if (!leaves.has(leafId)) delete copy()[leafId];
  for (const [leafId, itemId] of leaves) {
    if (itemId === null) continue; // an empty leaf is not a stop — it keeps whatever trail it had
    // The ITEM alone is what a layout can tell us about, so it alone decides whether this is news.
    // Comparing the whole entry (item AND view) would read a pane standing on `{np, "n7"}` as having
    // moved on every unrelated write and push `{np, null}` over its forward run — the bug where
    // reading a notification made Back reachable exactly once.
    const cur = navEntry(next, leafId);
    if (cur && cur.itemId === itemId) continue;
    next = pushNav(next, leafId, { itemId, view: null });
  }
  return next;
}

/**
 * Drop every entry for an item that no longer exists (deleted here or in another window), so Back can
 * never land a pane on a session that was deleted out from under it.
 *
 * The cursor follows the entry it was standing on when that entry survives; when the deleted item IS
 * what the pane was showing, it clamps to the nearest surviving stop. A leaf left with nothing at all
 * is dropped entirely — there is no history of a pane whose whole trail was deleted.
 */
export function forgetNavItems(h: PaneHistory, keep: ReadonlySet<string>): PaneHistory {
  let next = h;
  for (const [leafId, lh] of Object.entries(h)) {
    const kept = lh.entries.filter((e) => keep.has(e.itemId));
    if (kept.length === lh.entries.length) continue;
    if (next === h) next = { ...h };
    if (kept.length === 0) { delete next[leafId]; continue; }
    const standing = lh.entries[lh.index];
    const at = standing ? kept.indexOf(standing) : -1;
    // The survivor the cursor was on, else the last stop that still exists BEFORE where it stood.
    const index = at >= 0 ? at : Math.max(0, Math.min(kept.length - 1, lh.index));
    next[leafId] = { entries: kept, index };
  }
  return next;
}
