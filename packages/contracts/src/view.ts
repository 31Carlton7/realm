import { z } from "zod";
import { newId } from "./ids";
import { LayoutSchema, allItems, closeItem, equalSizes, findLeaf, findLeafOfItem, firstLeaf, leafItems, type Layout, type LayoutLeaf, type LayoutSplit } from "./layout";
import { activeGroup, type SpaceGroups } from "./groups";

/**
 * The window's one view (Plan 27).
 *
 * A space used to be a room with its own arrangement — named splits, each its own layout — and
 * switching rooms swapped the whole screen. Now every space's work is loaded at once and the window
 * shows ONE view: the main pane holds one thing, or a split of two, and each of them keeps its own
 * side pane (Plan 26's tabs of what its agents opened). A split is a way of looking at two things at
 * once, so it needs no name, no bar and no list of its own.
 *
 * The view stays a `Layout`, so the pane host, focus, resizing and the trails read it as they always
 * did; this file is what keeps it to that shape. `normalizeView` is the one place the shape is
 * enforced, and every write goes through it:
 *
 *  - at most `VIEW_MAX_PANES` main panes, each optionally paired with the side pane that serves it;
 *  - a side pane whose owner leaves the screen goes with it, into `sidePanes`, and comes back when
 *    the owner does — which is what "a session keeps its own side pane" means once the screen can
 *    show any session from any space;
 *  - the tree is rebuilt into a canonical shape (a column per main pane, the two columns side by side
 *    or stacked), reusing the split nodes it already had so a dragged divider keeps its place.
 */
export const VIEW_MAX_PANES = 2;

/** A side pane taken off screen with its owner: its tabs, and the one that was showing. */
export type SidePane = { tabs: string[]; itemId: string };

export type WindowView = {
  /** What is on screen. */
  layout: Layout;
  /** The leaf filling the window under pane focus (⌘⇧F), or null for the whole view. */
  zoomedLeafId: string | null;
  /** The side panes of items NOT on screen, by owner item id: what comes back when they do. */
  sidePanes: Record<string, SidePane>;
};

/** Where a pane opened beside another goes: an edge of the pane it was dropped on. */
export type BesideEdge = "left" | "right" | "top" | "bottom";

export function emptyView(): WindowView {
  return { layout: { type: "leaf", id: newId(), itemId: null }, zoomedLeafId: null, sidePanes: {} };
}

/** Every leaf, depth-first. */
function leavesOf(l: Layout): LayoutLeaf[] {
  return l.type === "leaf" ? [l] : l.children.flatMap(leavesOf);
}

/** The main panes — every leaf that is not a side pane — in reading order. */
export function primaryLeaves(l: Layout): LayoutLeaf[] {
  return leavesOf(l).filter((leaf) => !leaf.tabs);
}

/** The main pane of the column `leafId` is in: the leaf itself, or the pane a side pane serves. */
export function columnOf(l: Layout, leafId: string | null): LayoutLeaf | null {
  if (!leafId) return null;
  const leaf = findLeaf(l, leafId);
  if (!leaf) return null;
  if (!leaf.tabs) return leaf;
  return primaryLeaves(l).find((p) => p.itemId !== null && p.itemId === leaf.owner) ?? null;
}

/** The split whose children carry exactly these ids, in this order — the node a rebuild reuses. */
function splitWithChildren(l: Layout, ids: string[]): LayoutSplit | null {
  if (l.type === "leaf") return null;
  if (l.children.length === ids.length && l.children.every((c, i) => c.id === ids[i])) return l;
  for (const c of l.children) { const f = splitWithChildren(c, ids); if (f) return f; }
  return null;
}

/** The direction of the innermost split holding both leaves — how two panes sat — else a row. */
function dirBetween(l: Layout, a: string, b: string): "row" | "col" {
  let dir: "row" | "col" = "row";
  const holds = (n: Layout, id: string): boolean => (n.type === "leaf" ? n.id === id : n.children.some((c) => holds(c, id)));
  const walk = (n: Layout) => {
    if (n.type === "leaf") return;
    if (!holds(n, a) || !holds(n, b)) return;
    dir = n.dir;
    for (const c of n.children) walk(c);
  };
  walk(l);
  return dir;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export type NormalizeOptions = {
  /** A leaf whose column must survive the cap — the focused one. */
  keep?: string | null;
  /** Items never written into a remembered side pane: a peek is a look, not a tab of anyone's. */
  transient?: ReadonlySet<string>;
};

/**
 * Bring a view to its one shape (see the file comment). Returns `view` itself when nothing changes,
 * so a caller can tell a real write from an echo by identity.
 */
export function normalizeView(view: WindowView, opts: NormalizeOptions = {}): WindowView {
  const l = view.layout;
  const transient = opts.transient ?? new Set<string>();
  let prims = primaryLeaves(l);

  // The cap. The kept column first, then reading order; what falls off leaves the screen, and its
  // side pane with it. Reading order is kept among the survivors.
  if (prims.length > VIEW_MAX_PANES) {
    const keep = columnOf(l, opts.keep ?? null);
    const ranked = keep ? [keep, ...prims.filter((p) => p !== keep)] : prims;
    const chosen = new Set(ranked.slice(0, VIEW_MAX_PANES));
    prims = prims.filter((p) => chosen.has(p));
  }
  const owners = new Set(prims.map((p) => p.itemId).filter((id): id is string => id !== null));

  const sides = new Map<string, LayoutLeaf>();
  const sidePanes: Record<string, SidePane> = { ...view.sidePanes };
  for (const leaf of leavesOf(l)) {
    if (!leaf.tabs) continue;
    const owner = leaf.owner ?? null;
    const held = sides.get(owner ?? "");
    if (owner && owners.has(owner)) {
      // Two strips for one session is one strip with both sets of tabs.
      if (held) sides.set(owner, { ...held, tabs: [...held.tabs!, ...leaf.tabs.filter((t) => !held.tabs!.includes(t))] });
      else sides.set(owner, leaf);
      continue;
    }
    // Its owner is not on screen: the side pane goes with it, to come back when it does.
    const tabs = leaf.tabs.filter((t) => !transient.has(t));
    if (owner && tabs.length > 0) sidePanes[owner] = { tabs, itemId: leaf.itemId && tabs.includes(leaf.itemId) ? leaf.itemId : tabs[0]! };
  }

  // An owner back on screen gets its side pane back, minus anything now showing somewhere else.
  const onScreen = new Set<string>([...prims.flatMap(leafItems), ...[...sides.values()].flatMap(leafItems)]);
  for (const p of prims) {
    const owner = p.itemId;
    if (!owner || !sidePanes[owner]) continue;
    const kept = sidePanes[owner]!;
    delete sidePanes[owner];
    if (sides.has(owner)) continue; // it already has one: what was remembered is stale
    const tabs = kept.tabs.filter((t) => !onScreen.has(t) && t !== owner);
    if (tabs.length === 0) continue;
    for (const t of tabs) onScreen.add(t);
    sides.set(owner, { type: "leaf", id: newId(), itemId: tabs.includes(kept.itemId) ? kept.itemId : tabs[0]!, tabs, owner });
  }

  const column = (p: LayoutLeaf): Layout => {
    const side = p.itemId ? sides.get(p.itemId) : undefined;
    if (!side) return p;
    const had = splitWithChildren(l, [p.id, side.id]);
    return had ? { ...had, dir: "row", children: [p, side] } : { type: "split", id: newId(), dir: "row", sizes: equalSizes(2), children: [p, side] };
  };
  const cols = prims.map(column);
  let layout: Layout;
  if (cols.length === 0) layout = { type: "leaf", id: newId(), itemId: null };
  else if (cols.length === 1) layout = cols[0]!;
  else {
    const had = splitWithChildren(l, cols.map((c) => c.id));
    layout = had ? { ...had, children: cols }
      : { type: "split", id: newId(), dir: dirBetween(l, prims[0]!.id, prims[1]!.id), sizes: equalSizes(cols.length), children: cols };
  }
  const zoomedLeafId = view.zoomedLeafId && findLeaf(layout, view.zoomedLeafId) ? view.zoomedLeafId : null;
  const next: WindowView = { layout, zoomedLeafId, sidePanes };
  return sameJson(next, view) ? view : next;
}

/** A leaf replaced by a plain one holding `itemId`, keeping its id. */
function fill(l: Layout, leafId: string, itemId: string | null): Layout {
  if (l.type === "leaf") return l.id === leafId ? { type: "leaf", id: l.id, itemId } : l;
  return { ...l, children: l.children.map((c) => fill(c, leafId, itemId)) };
}

/**
 * Put `itemId` in the main view, in the column `leafId` is in (or the first column), in place of
 * what that pane shows. An item already on screen elsewhere moves here. The replaced item's side
 * pane leaves with it, and `itemId`'s own comes back, once the result is normalized.
 */
export function showInView(l: Layout, leafId: string | null, itemId: string): Layout {
  const at = findLeafOfItem(l, itemId);
  const target0 = columnOf(l, leafId) ?? primaryLeaves(l)[0] ?? null;
  if (at && !at.tabs && at.id === target0?.id) return l;
  const base = at ? closeItem(l, itemId) : l;
  const target = (target0 && findLeaf(base, target0.id)) ?? primaryLeaves(base)[0] ?? null;
  if (target && !target.tabs) return fill(base, target.id, itemId);
  // Nothing but side panes is left: the item takes the main pane in front of them.
  return { type: "split", id: newId(), dir: "row", sizes: equalSizes(2), children: [{ type: "leaf", id: newId(), itemId }, base] };
}

/**
 * Open `itemId` beside the column of `fromLeafId`: as a second column when the view has one — on
 * `edge`'s side, stacked for top and bottom — and in place of the OTHER side when it already has two.
 * An empty single pane is filled rather than split. An item already on screen moves.
 *
 * `edge` omitted with two columns keeps their arrangement; given, the drop decides where it lands.
 */
export function openBesideInView(l: Layout, fromLeafId: string | null, itemId: string, edge?: BesideEdge): Layout {
  const base = findLeafOfItem(l, itemId) ? closeItem(l, itemId) : l;
  const prims = primaryLeaves(base);
  const anchor = columnOf(base, fromLeafId) ?? prims[0] ?? null;
  const fresh: LayoutLeaf = { type: "leaf", id: newId(), itemId };
  const dir: "row" | "col" = edge === "top" || edge === "bottom" ? "col" : "row";
  const before = edge === "left" || edge === "top";
  if (!anchor) return { type: "split", id: newId(), dir: "row", sizes: equalSizes(2), children: [fresh, base] };
  if (prims.length < VIEW_MAX_PANES) {
    if (anchor.itemId === null) return fill(base, anchor.id, itemId);
    return { type: "split", id: newId(), dir, sizes: equalSizes(2), children: before ? [fresh, base] : [base, fresh] };
  }
  const other = prims.find((p) => p.id !== anchor.id)!;
  const replaced = fill(base, other.id, itemId);
  if (!edge) return replaced;
  // A drop on an edge says where the new pane goes relative to the one it was dropped on.
  const placed = findLeaf(replaced, other.id)!;
  const rest = leavesOf(replaced).filter((leaf) => leaf.tabs);
  const ordered = before ? [placed, anchor] : [anchor, placed];
  return { type: "split", id: newId(), dir, sizes: equalSizes(ordered.length + rest.length), children: [...ordered, ...rest] };
}

/** An empty pane beside the view, for "Split right" and "Split down". Null `leafId` when the view
 *  already shows two: a third would be a column nobody asked the window to hold. */
export function splitEmptyInView(l: Layout, dir: "row" | "col"): { layout: Layout; leafId: string | null } {
  if (primaryLeaves(l).length >= VIEW_MAX_PANES) return { layout: l, leafId: null };
  const fresh: LayoutLeaf = { type: "leaf", id: newId(), itemId: null };
  return { layout: { type: "split", id: newId(), dir, sizes: equalSizes(2), children: [l, fresh] }, leafId: fresh.id };
}

/** `itemId` added to the side pane `owner` will have when it is next on screen, as the tab showing. */
export function rememberSidePane(view: WindowView, owner: string, itemId: string): WindowView {
  const held = view.sidePanes[owner];
  if (held?.itemId === itemId) return view;
  const tabs = held ? (held.tabs.includes(itemId) ? held.tabs : [...held.tabs, itemId]) : [itemId];
  return { ...view, sidePanes: { ...view.sidePanes, [owner]: { tabs, itemId } } };
}

/**
 * Drop what no longer exists. `live` is what may be on screen (archived items may not); `exists`
 * is what may be remembered — a session put away keeps its side pane for when it comes back.
 */
export function pruneView(view: WindowView, live: ReadonlySet<string>, exists: ReadonlySet<string> = live, opts: NormalizeOptions = {}): WindowView {
  let layout = view.layout;
  for (const id of allItems(layout)) if (!live.has(id)) layout = closeItem(layout, id);
  const shaped = normalizeView(layout === view.layout ? view : { ...view, layout }, opts);
  const sidePanes: Record<string, SidePane> = {};
  for (const [owner, sp] of Object.entries(shaped.sidePanes)) {
    if (!exists.has(owner)) continue;
    const tabs = sp.tabs.filter((t) => live.has(t));
    if (tabs.length > 0) sidePanes[owner] = { tabs, itemId: tabs.includes(sp.itemId) ? sp.itemId : tabs[0]! };
  }
  const next = { ...shaped, sidePanes };
  return sameJson(next, view) ? view : next;
}

/** `itemId` taken out of the view entirely — a peek leaving what is saved. */
export function withoutItem(view: WindowView, itemId: string): WindowView {
  if (!allItems(view.layout).includes(itemId)) return view;
  return normalizeView({ ...view, layout: closeItem(view.layout, itemId) }, { transient: new Set([itemId]) });
}

/**
 * The view a home upgraded from rooms opens on: the active split of the space it was last in, as the
 * user last saw it. A split of more than two keeps the pane that had focus and the first other one;
 * the rest stay items of their space, and their side panes are remembered for when they reopen.
 */
export function viewFromGroups(groups: SpaceGroups, focusItemId: string | null): WindowView {
  const g = activeGroup(groups);
  const keep = focusItemId ? findLeafOfItem(g.layout, focusItemId)?.id ?? null : null;
  return normalizeView({ layout: g.layout, zoomedLeafId: g.zoomedLeafId, sidePanes: {} }, { keep });
}

export const SidePaneSchema: z.ZodType<SidePane> = z.object({ tabs: z.array(z.string()).min(1), itemId: z.string() })
  .transform((sp) => ({ tabs: [...new Set(sp.tabs)], itemId: sp.tabs.includes(sp.itemId) ? sp.itemId : sp.tabs[0]! }));

/** How a window's view is stored (the `ui.view:<profileId>` setting), with what had focus: the item,
 *  which survives the pane being rebuilt, and the leaf, for a focused pane with nothing in it. */
export const StoredViewSchema = z.object({
  v: z.literal(1),
  layout: LayoutSchema,
  zoomedLeafId: z.string().nullable(),
  sidePanes: z.record(SidePaneSchema),
  focusedItemId: z.string().nullable(),
  focusedLeafId: z.string().nullable().optional(),
});
export type StoredView = z.infer<typeof StoredViewSchema>;

/** A stored view, or null for anything that is not one — an older build's, or a hand edit gone wrong. */
export function parseStoredView(raw: unknown): StoredView | null {
  const p = StoredViewSchema.safeParse(raw);
  return p.success ? p.data : null;
}

/** The first leaf of the view a focus with nowhere better to go lands on: the first main pane. */
export function firstPaneLeaf(l: Layout): LayoutLeaf {
  return primaryLeaves(l)[0] ?? firstLeaf(l);
}
