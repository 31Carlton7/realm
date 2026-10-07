import { z } from "zod";
import { newId } from "./ids";

/**
 * A leaf normally shows one item. A TABBED leaf (`tabs` present) holds several and shows the one in
 * `itemId`, which is always one of them; the rest are open, just not on screen. That is what the
 * window's side panel is: the browsers, devices, documents and sub-agent previews the sessions on
 * screen opened, as tabs in one strip rather than a column each.
 *
 * Every tab belongs to a session: `owners[tab]` is the session ITEM it was opened for, which is how
 * it leaves the screen with that session and comes back with it (view.ts). `owner` is how a Plan
 * 26/27 side pane said the same thing for its whole strip, one strip per session; it is read, and
 * never written.
 *
 * Not the pre-Plan-4 `{tabs, activeTab}` leaf `migrateShape` collapses: that one has no `itemId`.
 */
export type Layout =
  | { type: "split"; id: string; dir: "row" | "col"; sizes: number[]; children: Layout[] }
  | { type: "leaf"; id: string; itemId: string | null; tabs?: string[]; owner?: string; owners?: Record<string, string> };

export type LayoutLeaf = Extract<Layout, { type: "leaf" }>;
export type LayoutSplit = Extract<Layout, { type: "split" }>;

/** Shape-only normalization: converts a pre-Plan-4 leaf `{tabs, activeTab}` to `{itemId}`. A legacy leaf
 *  collapses to its active tab (else first tab, else empty); displaced tabs simply stop being open, which
 *  is exactly the Arc-true semantic. New-shape nodes pass through unchanged. Recurses through splits. */
function migrateShape(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const n = input as Record<string, unknown>;
  if (n.type === "split" && Array.isArray(n.children)) return { ...n, children: n.children.map(migrateShape) };
  if (n.type === "leaf" && !("itemId" in n) && Array.isArray(n.tabs)) {
    const tabs = n.tabs.filter((t): t is string => typeof t === "string");
    const active = typeof n.activeTab === "string" && tabs.includes(n.activeTab) ? n.activeTab : tabs[0] ?? null;
    return { type: "leaf", id: n.id, itemId: active };
  }
  return input;
}

/** Every op in this file assumes items are unique across the layout (openItem/closeItem/splitLeaf all
 *  key off "the leaf holding itemId", singular). That invariant isn't representable in the zod shape, so
 *  it's enforced here instead: walk the tree depth-first and null out every itemId after its first
 *  occurrence. Runs regardless of whether the input was legacy or already new-shape, since legacy
 *  migration is exactly the case that manufactures duplicates — two old leaves can independently have had
 *  the same activeTab (e.g. `{tabs:["t1","t2"],activeTab:"t1"}` and `{tabs:["t1","t3"],activeTab:"t1"}`),
 *  which is realistic persisted data, not a hypothetical. */
function dedupeItems(input: unknown): unknown {
  const seen = new Set<string>();
  function walk(node: unknown): unknown {
    if (typeof node !== "object" || node === null) return node;
    const n = node as Record<string, unknown>;
    if (n.type === "leaf" && Array.isArray(n.tabs)) {
      // A tabbed leaf claims every tab, not just the one on screen, and its `itemId` is one of them
      // or the leaf has nothing to show. An emptied tab strip is a plain empty leaf.
      const tabs = [...new Set(n.tabs.filter((t): t is string => typeof t === "string"))].filter((t) => !seen.has(t));
      for (const t of tabs) seen.add(t);
      const { tabs: _drop, owner: _owner, owners: _owners, ...plain } = n;
      if (tabs.length === 0) return { ...plain, itemId: null };
      const itemId = typeof n.itemId === "string" && tabs.includes(n.itemId) ? n.itemId : tabs[0]!;
      return { ...n, itemId, tabs };
    }
    if (n.type === "leaf") {
      if (typeof n.itemId !== "string") return n;
      if (seen.has(n.itemId)) return { ...n, itemId: null };
      seen.add(n.itemId);
      return n;
    }
    if (n.type === "split" && Array.isArray(n.children)) return { ...n, children: n.children.map(walk) };
    return node;
  }
  return walk(input);
}

/**
 * Normalize any persisted layout — including the pre-Plan-4 leaf shape `{tabs, activeTab}` — into the
 * current one-item-per-leaf shape, and dedupe so every itemId appears in at most one leaf (first
 * depth-first occurrence wins). Runs inside LayoutSchema's preprocess, so every parse (RPC results, DB
 * reads, tests) migrates and dedupes silently.
 */
export function migrateLayout(input: unknown): unknown {
  return dedupeItems(migrateShape(input));
}

// `migrateLayout` already walks the whole tree recursively (see above), so by the time this schema
// validates a node, every descendant has already been normalized to the new shape — the array of
// children needs no further preprocessing here, just structural validation.
const LayoutBaseSchema: z.ZodType<Layout> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("split"), id: z.string(), dir: z.enum(["row", "col"]),
      sizes: z.array(z.number()), children: z.array(LayoutBaseSchema) }),
    z.object({ type: z.literal("leaf"), id: z.string(), itemId: z.string().nullable(),
      tabs: z.array(z.string()).optional(), owner: z.string().optional(), owners: z.record(z.string()).optional() }),
  ]),
);

/** Structural invariants: every split has >= 2 children and one size per child. */
function validateLayout(node: Layout, ctx: z.RefinementCtx, path: (string | number)[] = []): void {
  if (node.type === "leaf") return;
  if (node.children.length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "children"], message: "split must have at least 2 children" });
  }
  if (node.sizes.length !== node.children.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "sizes"], message: "sizes.length must equal children.length" });
  }
  node.children.forEach((c, i) => validateLayout(c, ctx, [...path, "children", i]));
}

export const LayoutSchema: z.ZodType<Layout> = z.preprocess(migrateLayout, LayoutBaseSchema)
  .superRefine((l, ctx) => validateLayout(l as Layout, ctx)) as z.ZodType<Layout>;

export type PresetName = "one" | "two-col" | "three-col" | "grid-2x2" | "grid-3x3";
export const PRESETS: PresetName[] = ["one", "two-col", "three-col", "grid-2x2", "grid-3x3"];

export const emptyLayout = (): LayoutLeaf => ({ type: "leaf", id: newId(), itemId: null });

/** Every open item, depth-first. The layout's "open set". */
export function allItems(l: Layout): string[] {
  return l.type === "leaf" ? leafItems(l) : l.children.flatMap(allItems);
}

/** Everything a leaf holds: its tabs, or its one item. */
export function leafItems(l: LayoutLeaf): string[] {
  return l.tabs ?? (l.itemId ? [l.itemId] : []);
}

export function firstLeaf(l: Layout): LayoutLeaf {
  return l.type === "leaf" ? l : firstLeaf(l.children[0]!);
}

/** The leaf holding this item — on screen, or as a tab behind another. */
export function findLeafOfItem(l: Layout, itemId: string): LayoutLeaf | null {
  if (l.type === "leaf") return leafItems(l).includes(itemId) ? l : null;
  for (const c of l.children) { const f = findLeafOfItem(c, itemId); if (f) return f; }
  return null;
}

/** The leaf node with this id, or null. The by-id counterpart of `findLeafOfItem` — what the pane
 *  host renders when one pane is focused full-screen, and what tells a stale zoom from a live one. */
export function findLeaf(l: Layout, leafId: string): LayoutLeaf | null {
  if (l.type === "leaf") return l.id === leafId ? l : null;
  for (const c of l.children) { const f = findLeaf(c, leafId); if (f) return f; }
  return null;
}

/** The inverse of findLeafOfItem: the itemId held by the leaf with this id, or null (leaf empty,
 *  leafId missing, or not found). */
export function itemIdOfLeaf(l: Layout | null, leafId: string | null): string | null {
  if (!l || !leafId) return null;
  if (l.type === "leaf") return l.id === leafId ? l.itemId : null;
  for (const c of l.children) { const found = itemIdOfLeaf(c, leafId); if (found !== null) return found; }
  return null;
}

function mapLeaves(l: Layout, fn: (leaf: LayoutLeaf) => Layout): Layout {
  return l.type === "leaf" ? fn(l) : { ...l, children: l.children.map((c) => mapLeaves(c, fn)) };
}

function hasLeaf(l: Layout, leafId: string): boolean {
  return l.type === "leaf" ? l.id === leafId : l.children.some((c) => hasLeaf(c, leafId));
}

/** Remove an item from wherever it is open, pruning the leaf it vacates (unless that empties the whole
 *  tree — then the first leaf survives, same id, empty). Leaves that were ALREADY deliberately empty are
 *  kept: only the leaf the item vacated is pruned. */
export function closeItem(l: Layout, itemId: string): Layout {
  const pruned = prune(l);
  return pruned ?? plainLeaf({ ...firstLeaf(l), itemId: null });

  function prune(n: Layout): Layout | null {
    if (n.type === "leaf" && n.tabs?.includes(itemId)) return closeTab(n, itemId);
    if (n.type === "leaf") return n.itemId === itemId ? null : n;
    const kept: Layout[] = []; const sizes: number[] = [];
    n.children.forEach((c, i) => { const p = prune(c); if (p) { kept.push(p); sizes.push(n.sizes[i] ?? 0); } });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]!;
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    return { ...n, children: kept, sizes: sizes.map((s) => (s / total) * 100) };
  }
}

/** A leaf with its tab strip and owners taken off — what a leaf is once it holds one thing or none. */
function plainLeaf(l: LayoutLeaf): LayoutLeaf {
  const { tabs: _t, owner: _o, owners: _os, ...plain } = l;
  return plain;
}

/** A tab leaves its strip. The leaf goes with its last tab, and the tab beside a closed active one
 *  comes on screen — the next one, else the one before, as every tab strip does it. */
function closeTab(leaf: LayoutLeaf, itemId: string): LayoutLeaf | null {
  const tabs = leaf.tabs!;
  const at = tabs.indexOf(itemId);
  const left = tabs.filter((t) => t !== itemId);
  if (left.length === 0) return null;
  const active = leaf.itemId === itemId ? left[Math.min(at, left.length - 1)]! : leaf.itemId;
  return { ...leaf, itemId: active, tabs: left };
}

/**
 * Remove an EMPTY leaf by id, pruning on the same terms `closeItem` does.
 *
 * Its own function rather than a branch in `closeItem`, because the two are keyed differently: an
 * item can only be open in one leaf, while a deliberately-empty leaf has nothing to look it up by
 * except where it is. `closeItem`'s own note says it keeps leaves that were already empty — this is
 * how the one the user actually pointed at goes.
 *
 * A leaf holding an item is left alone: closing THAT is `closeItem`'s job, and pruning it here would
 * lift an open session out of the layout from a control that only ever means "drop this empty box".
 */
export function closeLeaf(l: Layout, leafId: string): Layout {
  const pruned = prune(l);
  // The tree may not become nothing: the last leaf survives, same id, empty — which is exactly the
  // state this function is usually asked to remove, and is the right answer when it is the only one.
  return pruned ?? plainLeaf({ ...firstLeaf(l), itemId: null });

  function prune(n: Layout): Layout | null {
    if (n.type === "leaf") return n.id === leafId && n.itemId === null ? null : n;
    const kept: Layout[] = []; const sizes: number[] = [];
    n.children.forEach((c, i) => { const p = prune(c); if (p) { kept.push(p); sizes.push(n.sizes[i] ?? 0); } });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]!;
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    return { ...n, children: kept, sizes: sizes.map((s) => (s / total) * 100) };
  }
}

/** Open an item into a leaf, replacing whatever it held (the replaced item just stops being open).
 *  Items are unique in the layout: if the item is open elsewhere it is moved. A null/unknown leafId
 *  targets the first leaf. */
export function openItem(l: Layout, leafId: string | null, itemId: string): Layout {
  const existing = findLeafOfItem(l, itemId);
  const target0 = leafId !== null && hasLeaf(l, leafId) ? leafId : firstLeaf(l).id;
  // Already in this leaf: on screen, or a tab behind another that now comes to the front.
  if (existing?.id === target0) return existing.itemId === itemId ? l : mapLeaves(l, (leaf) => (leaf.id === target0 ? { ...leaf, itemId } : leaf));
  const base = existing ? closeItem(l, itemId) : l;
  // closeItem may have pruned the target leaf's ancestor structure; re-check.
  const target = hasLeaf(base, target0) ? target0 : firstLeaf(base).id;
  // A tabbed leaf takes the item as a new tab, after the one on screen, rather than replacing it.
  return mapLeaves(base, (leaf) => (leaf.id !== target ? leaf : leaf.tabs ? { ...leaf, itemId, tabs: withTab(leaf, itemId) } : { ...leaf, itemId }));
}

function withTab(leaf: LayoutLeaf, itemId: string): string[] {
  const tabs = leaf.tabs ?? [];
  const at = leaf.itemId ? tabs.indexOf(leaf.itemId) : -1;
  return at < 0 ? [...tabs, itemId] : [...tabs.slice(0, at + 1), itemId, ...tabs.slice(at + 1)];
}

/** The session item a tab belongs to: its own, or — in a Plan 26/27 strip — the strip's. */
export function tabOwner(leaf: LayoutLeaf, tab: string): string | undefined {
  return leaf.owners?.[tab] ?? leaf.owner;
}

/** Every tab's session, written out — a Plan 26/27 strip's one `owner` becomes one per tab. */
function ownersOf(leaf: LayoutLeaf): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of leaf.tabs ?? []) { const o = tabOwner(leaf, t); if (o) out[t] = o; }
  return out;
}

/** The window's side panel — the tabbed leaf — or null while nothing is open in it. */
export function findPanel(l: Layout): LayoutLeaf | null {
  if (l.type === "leaf") return l.tabs ? l : null;
  for (const c of l.children) { const f = findPanel(c); if (f) return f; }
  return null;
}

/** The side panel when it holds a tab of this session item, or null. */
export function findSidePane(l: Layout, ownerItemId: string): LayoutLeaf | null {
  if (l.type === "leaf") return l.tabs?.some((t) => tabOwner(l, t) === ownerItemId) ? l : null;
  for (const c of l.children) { const f = findSidePane(c, ownerItemId); if (f) return f; }
  return null;
}

/** This session's own tabs in the side panel, in the strip's order. */
export function sideTabsOf(l: Layout, ownerItemId: string): string[] {
  const panel = findSidePane(l, ownerItemId);
  return panel ? panel.tabs!.filter((t) => tabOwner(panel, t) === ownerItemId) : [];
}

/**
 * Open `itemId` as a tab of the side panel, for the session item `ownerItemId`: in that session's run
 * of the panel's strip, or in a new panel at the right of everything when nothing is open in one yet.
 * Null when the session is not in this layout — there is nothing to be beside.
 *
 * One strip for everything the sessions on screen open is the point. Eight agent-opened browsers used
 * to be eight columns a fifth of a window wide, every title an ellipsis; as tabs, the one showing gets
 * the whole panel and the rest are a click away.
 *
 * `front` false adds the tab behind the one showing — an agent's open beside a person reading another
 * session's tab (the store decides). A tab that is already there comes to the front and stays whose
 * it was.
 */
export function openInSidePane(l: Layout, ownerItemId: string, itemId: string, opts: { front?: boolean } = {}): Layout | null {
  if (ownerItemId === itemId) return null;
  const front = opts.front ?? true;
  const there = findPanel(l);
  if (there?.tabs!.includes(itemId)) return front ? openItem(l, there.id, itemId) : l;
  const base = findLeafOfItem(l, itemId) ? closeItem(l, itemId) : l;
  const at = findLeafOfItem(base, ownerItemId);
  if (!at) return null;
  // The session is itself a tab — a sub-agent previewed beside its parent. What it opens is the
  // parent's: a strip per agent is the column-per-agent layout again.
  const owner = at.tabs ? tabOwner(at, ownerItemId) ?? ownerItemId : ownerItemId;
  const panel = findPanel(base);
  if (!panel) {
    const fresh: LayoutLeaf = { type: "leaf", id: newId(), itemId, tabs: [itemId], owners: { [itemId]: owner } };
    return { type: "split", id: newId(), dir: "row", sizes: equalSizes(2), children: [base, fresh] };
  }
  // After the tab showing when that one is the session's own, else after the session's last: its run
  // stays one run (view.ts puts the runs in order).
  const tabs = panel.tabs!;
  const mine = tabs.filter((t) => tabOwner(panel, t) === owner);
  const after = panel.itemId && tabOwner(panel, panel.itemId) === owner ? panel.itemId : mine.at(-1);
  const i = after ? tabs.indexOf(after) + 1 : tabs.length;
  const next = [...tabs.slice(0, i), itemId, ...tabs.slice(i)];
  const owners = { ...ownersOf(panel), [itemId]: owner };
  return mapLeaves(base, (leaf) => {
    if (leaf.id !== panel.id) return leaf;
    const { owner: _o, ...rest } = leaf;
    return { ...rest, itemId: front ? itemId : leaf.itemId, tabs: next, owners };
  });
}

/**
 * Move a tab within its strip, to `index` among the tabs. Anything else is returned unchanged.
 * `owner` hands the tab to another session — a tab dropped into another session's run is that
 * session's from then on, and leaves the screen with it.
 */
export function moveTab(l: Layout, leafId: string, itemId: string, index: number, owner?: string): Layout {
  return mapLeaves(l, (leaf) => {
    if (leaf.id !== leafId || !leaf.tabs?.includes(itemId)) return leaf;
    const rest = leaf.tabs.filter((t) => t !== itemId);
    const at = Math.max(0, Math.min(index, rest.length));
    const tabs = [...rest.slice(0, at), itemId, ...rest.slice(at)];
    if (!owner || tabOwner(leaf, itemId) === owner) return { ...leaf, tabs };
    const { owner: _o, ...plain } = leaf;
    return { ...plain, tabs, owners: { ...ownersOf(leaf), [itemId]: owner } };
  });
}

/** The shares a split is born with, and the ones `equalizeSplit` restores: every child the same. */
export function equalSizes(count: number): number[] {
  return Array.from({ length: count }, () => 100 / count);
}

/**
 * Add `fresh` next to `leafId` inside the split that ALREADY runs along `dir`, re-balancing that split
 * to equal shares. Returns null when there is no such split — the leaf is the root, or the split holding
 * it runs the other way — and the caller wraps the leaf in a new nested split instead.
 *
 * This is what keeps a third pane from being a second-class citizen: without it, dropping onto the right
 * edge of the right-hand pane of a 50/50 row nests a split INSIDE that pane, so the shares read
 * 50/25/25. Growing the existing row instead makes them 33/33/33 — one flat row of equal columns,
 * which is also the shape `gridPreset("three-col")` produces, so the two routes to three columns agree.
 */
function insertSibling(n: Layout, leafId: string, dir: "row" | "col", before: boolean, fresh: LayoutLeaf): Layout | null {
  if (n.type === "leaf") return null;
  if (n.dir === dir) {
    const at = n.children.findIndex((c) => c.type === "leaf" && c.id === leafId);
    if (at >= 0) {
      const children = [...n.children];
      children.splice(before ? at : at + 1, 0, fresh);
      return { ...n, children, sizes: equalSizes(children.length) };
    }
  }
  for (let i = 0; i < n.children.length; i++) {
    const replaced = insertSibling(n.children[i]!, leafId, dir, before, fresh);
    if (!replaced) continue;
    const children = [...n.children];
    children[i] = replaced;
    return { ...n, children };
  }
  return null;
}

/** Split a leaf. `itemId` fills the new sibling (moved if open elsewhere); null makes an empty sibling
 *  awaiting the next openItem. `before` puts the new leaf on the near side (the left/top drop edges)
 *  instead of after the target. Either way the new leaf is discoverable via findLeafOfItem (or the empty
 *  leaf id via newLeafId), and every child of the split that gained it ends up the same size. */
export function splitLeaf(l: Layout, leafId: string, dir: "row" | "col", itemId: string | null, before = false): Layout {
  const base = itemId && findLeafOfItem(l, itemId) ? closeItem(l, itemId) : l;
  const target = hasLeaf(base, leafId) ? leafId : firstLeaf(base).id;
  const fresh: LayoutLeaf = { type: "leaf", id: newId(), itemId };
  const grown = insertSibling(base, target, dir, before, fresh);
  if (grown) return grown;
  return mapLeaves(base, (leaf) => {
    if (leaf.id !== target) return leaf;
    return { type: "split", id: newId(), dir, sizes: equalSizes(2), children: before ? [fresh, leaf] : [leaf, fresh] };
  });
}

/** Reset one split to the equal shares it was born with; every other node is returned unchanged. The
 *  double-click-a-divider gesture. Returns the layout untouched (same object) when nothing would move,
 *  so an unmodified split double-clicked is a genuine no-op rather than a no-op-shaped write. */
export function equalizeSplit(l: Layout, splitId: string): Layout {
  if (l.type === "leaf") return l;
  if (l.id !== splitId) {
    const children = l.children.map((c) => equalizeSplit(c, splitId));
    return children.some((c, i) => c !== l.children[i]) ? { ...l, children } : l;
  }
  const sizes = equalSizes(l.children.length);
  return sizes.every((s, i) => Math.abs(s - (l.sizes[i] ?? NaN)) < 0.01) ? l : { ...l, sizes };
}

/** Replace the sizes of the split with `splitId`; every other node is returned unchanged. */
export function updateSizes(l: Layout, splitId: string, sizes: number[]): Layout {
  if (l.type === "leaf") return l;
  return l.id === splitId ? { ...l, sizes } : { ...l, children: l.children.map((c) => updateSizes(c, splitId, sizes)) };
}

/** Build a preset layout: one item per leaf in order; extra items stay unopened; extra leaves stay empty. */
export function gridPreset(name: PresetName, items: string[]): Layout {
  const shape: { rows: number; cols: number } =
    name === "one" ? { rows: 1, cols: 1 } : name === "two-col" ? { rows: 1, cols: 2 }
    : name === "three-col" ? { rows: 1, cols: 3 } : name === "grid-2x2" ? { rows: 2, cols: 2 }
    : { rows: 3, cols: 3 };
  const leafCount = shape.rows * shape.cols;
  const leaves: LayoutLeaf[] = Array.from({ length: leafCount }, (_, i) =>
    ({ type: "leaf", id: newId(), itemId: items[i] ?? null }));
  if (leafCount === 1) return leaves[0]!;
  const rows: Layout[] = [];
  for (let r = 0; r < shape.rows; r++) {
    const rowLeaves = leaves.slice(r * shape.cols, (r + 1) * shape.cols);
    rows.push(shape.cols === 1 ? rowLeaves[0]! :
      { type: "split", id: newId(), dir: "row", sizes: rowLeaves.map(() => 100 / shape.cols), children: rowLeaves });
  }
  return shape.rows === 1 ? rows[0]! :
    { type: "split", id: newId(), dir: "col", sizes: rows.map(() => 100 / shape.rows), children: rows };
}
