import { z } from "zod";
import { newId } from "./ids";

export type Layout =
  | { type: "split"; id: string; dir: "row" | "col"; sizes: number[]; children: Layout[] }
  | { type: "leaf"; id: string; itemId: string | null };

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
    z.object({ type: z.literal("leaf"), id: z.string(), itemId: z.string().nullable() }),
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
  return l.type === "leaf" ? (l.itemId ? [l.itemId] : []) : l.children.flatMap(allItems);
}

export function firstLeaf(l: Layout): LayoutLeaf {
  return l.type === "leaf" ? l : firstLeaf(l.children[0]!);
}

export function findLeafOfItem(l: Layout, itemId: string): LayoutLeaf | null {
  if (l.type === "leaf") return l.itemId === itemId ? l : null;
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
  return pruned ?? { ...firstLeaf(l), itemId: null };

  function prune(n: Layout): Layout | null {
    if (n.type === "leaf") return n.itemId === itemId ? null : n;
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
  if (existing?.id === target0) return l;
  const base = existing ? closeItem(l, itemId) : l;
  // closeItem may have pruned the target leaf's ancestor structure; re-check.
  const target = hasLeaf(base, target0) ? target0 : firstLeaf(base).id;
  return mapLeaves(base, (leaf) => (leaf.id === target ? { ...leaf, itemId } : leaf));
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
