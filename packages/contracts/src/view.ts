import { z } from "zod";
import { newId } from "./ids";
import {
  LayoutSchema, allItems, closeItem, equalSizes, findLeaf, findLeafOfItem, findPanel, firstLeaf, leafItems, splitLeaf, tabOwner,
  type Layout, type LayoutLeaf, type LayoutSplit,
} from "./layout";
import { activeGroup, type SpaceGroups } from "./groups";

/**
 * The window's one view.
 *
 * A space used to be a room with its own arrangement — named splits, each its own layout — and
 * switching rooms swapped the whole screen. Every space's work is loaded at once now, and the window
 * shows ONE view of it (Plan 27): main panes, as many as the person makes, split right or down and
 * nested as they were made, and ONE side panel at the window's right edge holding the tabs of every
 * session on screen. A split is a way of looking at several things at once, so it needs no name, no
 * bar and no list of its own; the only limit on it is room (`PANE_MIN`, `splitFits`).
 *
 * The panel is not a pane of the split. It is the full height of the window, never split per pane
 * and never stacked under one, and by default half the main area wide (`panelShare`, remembered per
 * window). Its tabs still belong to their sessions — a browser an agent drives is that agent's
 * session's — so the strip is every on-screen session's tabs in one row, a run per session in the
 * order its pane is read. A session leaving the screen takes its run with it, into `sidePanes`, and
 * brings it back when it returns; a session joining the split brings its run into the strip.
 *
 * The view stays a `Layout`, so the pane host, focus, resizing and the trails read it as they always
 * did: the main panes' tree, and — while anything is open in it — the panel as the second child of a
 * row at the root. `normalizeView` is the one place that shape is enforced, and every write goes
 * through it:
 *
 *  - every strip in the tree, wherever an edit left it, is folded into the one panel at the root;
 *  - a tab whose session is not a main pane leaves with that session, into `sidePanes`, and comes
 *    back when it does — which is what "a session keeps its own tabs" means once the screen can show
 *    any session from any space;
 *  - the strip is put in reading order, and the root's shares follow `panelShare`; the main panes'
 *    tree keeps the split nodes it had, so a dragged divider keeps its place.
 *
 * Plan 27 shipped this as at most two main panes, each with a side pane of its own; those views, and
 * every older shape, are read by the same function (view.test.ts holds a hand-written one of each).
 */

/** A session's tabs off screen: what comes back with it, and the one that was showing. */
export type SidePane = { tabs: string[]; itemId: string };

export type WindowView = {
  /** What is on screen. */
  layout: Layout;
  /** The leaf filling the window under pane focus (⌘⇧F), or null for the whole view. */
  zoomedLeafId: string | null;
  /** The tabs of sessions NOT on screen, by owner item id: what comes back when they do. */
  sidePanes: Record<string, SidePane>;
  /** The side panel's width as a share of the main area — the space right of the sidebar. Absent is
   *  the default, half (`PANEL_SHARE`). */
  panelShare?: number;
};

/** Where a pane opened beside another goes: an edge of the pane it was dropped on. */
export type BesideEdge = "left" | "right" | "top" | "bottom";

/**
 * The least a main pane is drawn at. A session pane is the one every pane has to be able to hold, and
 * these are its own floors, measured in the built app (splits-live.mjs): below the composer's last
 * rung (`@container (max-width: 360px)`, where the branch has given way to its mark) nothing more
 * gives way, and at 280 wide the row still holds its controls and Send with nothing overflowing and a
 * message keeps a measure of five or six words. Below 300 tall the transcript stops shrinking at its
 * floor and the composer starts to cover it; at 300 there are still lines of it to read. A split that
 * would leave any pane below them is not offered, rather than squeezed.
 */
export const PANE_MIN = { width: 280, height: 300 } as const;
/** The panel's own floor: a browser at a phone's width, a strip with room for two tabs and its "+". */
export const PANEL_MIN_WIDTH = 320;
/** The panel's share of the main area: half by default, and never so much of it that the share
 *  stops meaning anything at either end. */
export const PANEL_SHARE = { default: 0.5, min: 0.1, max: 0.9 } as const;
/** A divider between two panes, and the panel's edge: one hairline of the layout's own. */
export const PANE_DIVIDER = 1;

export type Room = { width: number; height: number };

export function clampPanelShare(share: number | undefined): number {
  if (share === undefined || !Number.isFinite(share)) return PANEL_SHARE.default;
  return Math.min(PANEL_SHARE.max, Math.max(PANEL_SHARE.min, share));
}

export function emptyView(): WindowView {
  return { layout: { type: "leaf", id: newId(), itemId: null }, zoomedLeafId: null, sidePanes: {} };
}

/** Every leaf, depth-first. */
function leavesOf(l: Layout): LayoutLeaf[] {
  return l.type === "leaf" ? [l] : l.children.flatMap(leavesOf);
}

/** The main panes — every leaf that is not the panel — in reading order. */
export function primaryLeaves(l: Layout): LayoutLeaf[] {
  return leavesOf(l).filter((leaf) => !leaf.tabs);
}

/** The session item a tab of the panel belongs to, or null for anything that is not one. */
export function ownerOfTab(l: Layout, tab: string): string | null {
  const panel = findPanel(l);
  return panel?.tabs!.includes(tab) ? tabOwner(panel, tab) ?? null : null;
}

/** A tree with every strip taken out of it, on `closeItem`'s terms: a split left with one child is that
 *  child, and the shares of what is left are renormalised. Null when nothing is left. */
function withoutStrips(n: Layout): Layout | null {
  if (n.type === "leaf") return n.tabs ? null : n;
  const kept: Layout[] = []; const sizes: number[] = [];
  n.children.forEach((c, i) => { const p = withoutStrips(c); if (p) { kept.push(p); sizes.push(n.sizes[i] ?? 0); } });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!;
  if (kept.length === n.children.length && kept.every((c, i) => c === n.children[i])) return n;
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...n, children: kept, sizes: sizes.map((s) => (s / total) * 100) };
}

/** The main panes' tree: the view without its panel. Never nothing — an empty pane at the least. */
export function mainOf(l: Layout): Layout {
  return withoutStrips(l) ?? { type: "leaf", id: newId(), itemId: null };
}

/** `main` as the view's main panes, the panel (if any) still beside them on the root it had. */
function withMain(l: Layout, main: Layout): Layout {
  const panel = findPanel(l);
  if (!panel) return main;
  const root = l.type === "split" && l.children.length === 2 && l.children[1] === panel && l.id !== main.id ? l : null;
  return { type: "split", id: root?.id ?? newId(), dir: "row", sizes: root?.sizes ?? equalSizes(2), children: [main, panel] };
}

/**
 * The main pane `leafId` stands for: the leaf itself, or — for the panel — the pane of the session
 * whose tab is showing in it, which is the session the keyboard is working for while it is there.
 */
export function columnOf(l: Layout, leafId: string | null): LayoutLeaf | null {
  if (!leafId) return null;
  const leaf = findLeaf(l, leafId);
  if (!leaf) return null;
  if (!leaf.tabs) return leaf;
  const owner = leaf.itemId ? tabOwner(leaf, leaf.itemId) : undefined;
  return primaryLeaves(l).find((p) => p.itemId !== null && p.itemId === owner) ?? null;
}

/** The split whose children carry exactly these ids, in this order — the node a rebuild reuses. */
function splitWithChildren(l: Layout, ids: string[]): LayoutSplit | null {
  if (l.type === "leaf") return null;
  if (l.children.length === ids.length && l.children.every((c, i) => c.id === ids[i])) return l;
  for (const c of l.children) { const f = splitWithChildren(c, ids); if (f) return f; }
  return null;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export type NormalizeOptions = {
  /** The leaf with the keyboard: when several strips are folded into one (a Plan 27 view), the one it
   *  is in keeps its tab showing. */
  keep?: string | null;
  /** Items never written into a remembered run: a peek is a look, not a tab of anyone's. */
  transient?: ReadonlySet<string>;
};

/**
 * Bring a view to its one shape (see the file comment). Returns `view` itself when nothing changes,
 * so a caller can tell a real write from an echo by identity.
 */
export function normalizeView(view: WindowView, opts: NormalizeOptions = {}): WindowView {
  const l = view.layout;
  const transient = opts.transient ?? new Set<string>();
  const strips = leavesOf(l).filter((leaf) => leaf.tabs);
  const main = mainOf(l);
  const panes = primaryLeaves(main);
  const onScreen = new Set(panes.map((p) => p.itemId).filter((id): id is string => id !== null));

  // Every tab, in the order the strips held them, with the session it belongs to. A tab a plain open
  // put in a strip has no owner of its own: it is the session's whose tab it was opened beside.
  const tabs: { id: string; owner: string | null }[] = [];
  for (const s of strips) {
    const own = s.tabs!.map((t) => tabOwner(s, t) ?? null);
    for (let i = 0; i < own.length; i++) {
      if (own[i]) continue;
      const before = own.slice(0, i).reverse().find(Boolean);
      own[i] = before ?? own.slice(i + 1).find(Boolean) ?? null;
    }
    s.tabs!.forEach((t, i) => tabs.push({ id: t, owner: own[i]! }));
  }
  // A tab of a session that is itself a tab — a sub-agent previewed beside its parent — is the
  // parent's: what the preview opens comes and goes with the session on screen.
  const tabOwners = new Map(tabs.map((t) => [t.id, t.owner]));
  for (const t of tabs) {
    for (let hops = 0; t.owner && !onScreen.has(t.owner) && tabOwners.has(t.owner) && hops < 8; hops++) t.owner = tabOwners.get(t.owner) ?? null;
  }

  const showingBefore = strips.find((s) => s.id === opts.keep)?.itemId ?? strips[0]?.itemId ?? null;
  const sidePanes: Record<string, SidePane> = { ...view.sidePanes };
  const kept: { id: string; owner: string }[] = [];
  for (const t of tabs) {
    if (t.owner && onScreen.has(t.owner) && t.id !== t.owner) { kept.push({ id: t.id, owner: t.owner }); continue; }
    // Its session is not on screen: the tab goes with it, to come back when it does. A tab nobody
    // owns, and a peek, simply stop being open.
    if (!t.owner || transient.has(t.id)) continue;
    const held = sidePanes[t.owner];
    const list = held ? (held.tabs.includes(t.id) ? held.tabs : [...held.tabs, t.id]) : [t.id];
    const showing = t.id === showingBefore ? t.id : held && list.includes(held.itemId) ? held.itemId : list[0]!;
    sidePanes[t.owner] = { tabs: list, itemId: showing };
  }

  // A session back on screen gets its tabs back, minus anything now showing somewhere else.
  const shown = new Set<string>([...panes.flatMap(leafItems), ...kept.map((t) => t.id)]);
  let returning: string | null = null;
  for (const p of panes) {
    const owner = p.itemId;
    if (!owner || !sidePanes[owner]) continue;
    const held = sidePanes[owner]!;
    delete sidePanes[owner];
    for (const t of held.tabs) {
      if (shown.has(t) || t === owner) continue;
      shown.add(t);
      kept.push({ id: t, owner });
    }
    if (returning === null && kept.some((t) => t.id === held.itemId)) returning = held.itemId;
  }

  // One strip: each session's run in the order its pane is read, its own tabs in their own order.
  const rank = new Map(panes.map((p, i) => [p.itemId, i]));
  const ordered = kept.map((t, i) => ({ t, i }))
    .sort((a, b) => (rank.get(a.t.owner) ?? 0) - (rank.get(b.t.owner) ?? 0) || a.i - b.i)
    .map(({ t }) => t);
  const ids = ordered.map((t) => t.id);

  // The tab showing stays. Gone with its session, the panel shows what a session coming back had
  // showing when it left, else the tab beside the one that went — the next, else the one before.
  let showing = showingBefore && ids.includes(showingBefore) ? showingBefore : null;
  if (showing === null && ids.length > 0) {
    const was = tabs.map((t) => t.id);
    const at = showingBefore ? was.indexOf(showingBefore) : -1;
    const next = was.slice(at + 1).find((t) => ids.includes(t)) ?? was.slice(0, Math.max(at, 0)).reverse().find((t) => ids.includes(t));
    showing = returning ?? next ?? ids[0]!;
  }

  let layout: Layout = main;
  if (showing !== null) {
    const panel: LayoutLeaf = { type: "leaf", id: strips[0]?.id ?? newId(), itemId: showing, tabs: ids,
      owners: Object.fromEntries(ordered.map((t) => [t.id, t.owner])) };
    const share = clampPanelShare(view.panelShare) * 100;
    const had = splitWithChildren(l, [main.id, panel.id]);
    layout = { type: "split", id: had?.id ?? newId(), dir: "row", sizes: [100 - share, share], children: [main, panel] };
  }
  const zoomedLeafId = view.zoomedLeafId && findLeaf(layout, view.zoomedLeafId) ? view.zoomedLeafId : null;
  const next: WindowView = { layout, zoomedLeafId, sidePanes, ...(view.panelShare !== undefined ? { panelShare: view.panelShare } : {}) };
  return sameJson(next, view) ? view : next;
}

/** A leaf replaced by a plain one holding `itemId`, keeping its id. */
function fill(l: Layout, leafId: string, itemId: string | null): Layout {
  if (l.type === "leaf") return l.id === leafId ? { type: "leaf", id: l.id, itemId } : l;
  return { ...l, children: l.children.map((c) => fill(c, leafId, itemId)) };
}

/**
 * Put `itemId` in the main view, in the pane `leafId` stands for (or the first), in place of what
 * that pane shows. An item already on screen elsewhere moves here. The replaced session's tabs leave
 * with it, and `itemId`'s own come back, once the result is normalized.
 */
export function showInView(l: Layout, leafId: string | null, itemId: string): Layout {
  const at = findLeafOfItem(l, itemId);
  const target0 = columnOf(l, leafId) ?? primaryLeaves(l)[0] ?? null;
  if (at && !at.tabs && at.id === target0?.id) return l;
  const base = at ? closeItem(l, itemId) : l;
  const target = (target0 && findLeaf(base, target0.id)) ?? primaryLeaves(base)[0] ?? null;
  if (target && !target.tabs) return fill(base, target.id, itemId);
  // Nothing but the panel is left: the item takes the main pane in front of it.
  return { type: "split", id: newId(), dir: "row", sizes: equalSizes(2), children: [{ type: "leaf", id: newId(), itemId }, base] };
}

/** The main panes after `leafId`'s pane is split along `edge` with `fresh` — the tree a split, a drop
 *  on an edge and an open beside all make. Grows a split that already runs that way (`splitLeaf`). */
function splitMain(l: Layout, anchorId: string, edge: BesideEdge, itemId: string | null): { layout: Layout; leafId: string } {
  const main = mainOf(l);
  const dir: "row" | "col" = edge === "top" || edge === "bottom" ? "col" : "row";
  const before = edge === "left" || edge === "top";
  const grown = splitLeaf(main, anchorId, dir, itemId, before);
  const known = new Set(leavesOf(main).map((leaf) => leaf.id));
  const fresh = leavesOf(grown).find((leaf) => !known.has(leaf.id))!;
  return { layout: withMain(l, grown), leafId: fresh.id };
}

/**
 * Open `itemId` beside the pane `fromLeafId` stands for, on `edge`'s side of it (the right by
 * default): a new pane in the split — a column for left and right, a row for top and bottom. An empty
 * pane is filled rather than split, and an item already on screen moves. Room is the caller's to ask
 * first (`splitFits`); this only says where.
 */
export function openBesideInView(l: Layout, fromLeafId: string | null, itemId: string, edge: BesideEdge = "right"): Layout {
  const base = findLeafOfItem(l, itemId) ? closeItem(l, itemId) : l;
  const anchor = columnOf(base, fromLeafId) ?? primaryLeaves(base)[0] ?? null;
  if (!anchor) return { type: "split", id: newId(), dir: "row", sizes: equalSizes(2), children: [{ type: "leaf", id: newId(), itemId }, base] };
  if (anchor.itemId === null) return fill(base, anchor.id, itemId);
  return splitMain(base, anchor.id, edge, itemId).layout;
}

/** An empty pane beside the pane `leafId` stands for (the first, without one), for "Split right" and
 *  "Split down", and the new pane's leaf. Room is the caller's to ask first (`splitFits`). */
export function splitEmptyInView(l: Layout, leafId: string | null, dir: "row" | "col"): { layout: Layout; leafId: string } {
  const anchor = columnOf(l, leafId) ?? primaryLeaves(l)[0] ?? firstLeaf(mainOf(l));
  return splitMain(l, anchor.id, dir === "row" ? "right" : "bottom", null);
}

/** The pane beside `leafId`'s in reading order — the next, else the one before: what an open beside
 *  replaces when there is no room for another pane. Null when the view shows one. */
export function besidePane(l: Layout, leafId: string | null): LayoutLeaf | null {
  const panes = primaryLeaves(l);
  const from = columnOf(l, leafId);
  const at = from ? panes.findIndex((p) => p.id === from.id) : -1;
  if (at < 0) return panes[1] ?? null;
  return panes[at + 1] ?? panes[at - 1] ?? null;
}

/** The least room a tree of main panes can be drawn in, every pane at `PANE_MIN`. */
export function minRoomOf(l: Layout): Room {
  if (l.type === "leaf") return l.tabs ? { width: 0, height: 0 } : { width: PANE_MIN.width, height: PANE_MIN.height };
  const kids = l.children.filter((c) => c.type === "split" || !c.tabs).map(minRoomOf);
  if (kids.length === 0) return { width: 0, height: 0 };
  const gaps = (kids.length - 1) * PANE_DIVIDER;
  return l.dir === "row"
    ? { width: kids.reduce((a, k) => a + k.width, 0) + gaps, height: Math.max(...kids.map((k) => k.height)) }
    : { width: Math.max(...kids.map((k) => k.width)), height: kids.reduce((a, k) => a + k.height, 0) + gaps };
}

/** The room the main panes have in a host of `room`: all of it, less the panel at its floor while the
 *  panel is drawn beside them. */
export function mainRoom(room: Room, panelShown: boolean): Room {
  return panelShown ? { width: room.width - PANEL_MIN_WIDTH - PANE_DIVIDER, height: room.height } : room;
}

/**
 * Whether splitting the pane `leafId` stands for along `dir` leaves every main pane at least
 * `PANE_MIN` in `room` (the main panes' room: `mainRoom`). Unmeasured room (null) fits anything.
 */
export function splitFits(l: Layout, leafId: string | null, dir: "row" | "col", room: Room | null): boolean {
  if (!room) return true;
  const need = minRoomOf(mainOf(splitEmptyInView(l, leafId, dir).layout));
  return need.width <= room.width && need.height <= room.height;
}

/**
 * The panel's drawn width in a host of `room` beside main panes that need `need`, or null when it
 * does not fit at its floor and steps aside. It gives way first: it narrows from its share toward
 * `PANEL_MIN_WIDTH` before any pane goes below `PANE_MIN`, and below that it is not drawn beside them
 * at all — its tabs stay open, and the toggle shows it in the main panes' place.
 */
export function panelWidthIn(room: Room, need: Room, share: number | undefined): number | null {
  const room4Panel = room.width - need.width - PANE_DIVIDER;
  if (room4Panel < PANEL_MIN_WIDTH) return null;
  return Math.max(PANEL_MIN_WIDTH, Math.min(Math.round(clampPanelShare(share) * room.width), room4Panel));
}

/** `itemId` added to the run `owner` will have when it is next on screen, as the tab showing. */
export function rememberSidePane(view: WindowView, owner: string, itemId: string): WindowView {
  const held = view.sidePanes[owner];
  if (held?.itemId === itemId) return view;
  const tabs = held ? (held.tabs.includes(itemId) ? held.tabs : [...held.tabs, itemId]) : [itemId];
  return { ...view, sidePanes: { ...view.sidePanes, [owner]: { tabs, itemId } } };
}

/**
 * Drop what no longer exists. `live` is what may be on screen (archived items may not); `exists`
 * is what may be remembered — a session put away keeps its tabs for when it comes back.
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
 * user last saw it — every pane of it, and every session's side pane folded into the one panel.
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
  /** Absent in a view stored before the panel had a width of its own. */
  panelShare: z.number().optional(),
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
