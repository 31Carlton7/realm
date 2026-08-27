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

/** Split a leaf. `itemId` fills the new sibling (moved if open elsewhere); null makes an empty sibling
 *  awaiting the next openItem. Returns the new layout; the new leaf is always the second child of the
 *  split that replaced `leafId`, discoverable via findLeafOfItem (or the empty leaf id via newLeafId). */
export function splitLeaf(l: Layout, leafId: string, dir: "row" | "col", itemId: string | null): Layout {
  const base = itemId && findLeafOfItem(l, itemId) ? closeItem(l, itemId) : l;
  const target = hasLeaf(base, leafId) ? leafId : firstLeaf(base).id;
  return mapLeaves(base, (leaf) => {
    if (leaf.id !== target) return leaf;
    const fresh: LayoutLeaf = { type: "leaf", id: newId(), itemId };
    return { type: "split", id: newId(), dir, sizes: [50, 50], children: [leaf, fresh] };
  });
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
