import { z } from "zod";
import { newId } from "./ids";

export type Layout =
  | { type: "split"; id: string; dir: "row" | "col"; sizes: number[]; children: Layout[] }
  | { type: "leaf"; id: string; tabs: string[]; activeTab: string | null };

export const LayoutSchema: z.ZodType<Layout> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("split"), id: z.string(), dir: z.enum(["row", "col"]),
      sizes: z.array(z.number()), children: z.array(LayoutSchema) }),
    z.object({ type: z.literal("leaf"), id: z.string(), tabs: z.array(z.string()),
      activeTab: z.string().nullable() }),
  ]),
);

export type LayoutLeaf = Extract<Layout, { type: "leaf" }>;
export type LayoutSplit = Extract<Layout, { type: "split" }>;
export type PresetName = "one" | "two-col" | "three-col" | "grid-2x2" | "grid-3x3";
export const PRESETS: PresetName[] = ["one", "two-col", "three-col", "grid-2x2", "grid-3x3"];

export const emptyLayout = (): LayoutLeaf => ({ type: "leaf", id: newId(), tabs: [], activeTab: null });

export function allTabs(l: Layout): string[] {
  return l.type === "leaf" ? [...l.tabs] : l.children.flatMap(allTabs);
}

export function firstLeaf(l: Layout): LayoutLeaf {
  return l.type === "leaf" ? l : firstLeaf(l.children[0]!);
}

export function findLeafOfTab(l: Layout, tabId: string): LayoutLeaf | null {
  if (l.type === "leaf") return l.tabs.includes(tabId) ? l : null;
  for (const c of l.children) { const f = findLeafOfTab(c, tabId); if (f) return f; }
  return null;
}

function mapLeaves(l: Layout, fn: (leaf: LayoutLeaf) => Layout): Layout {
  return l.type === "leaf" ? fn(l) : { ...l, children: l.children.map((c) => mapLeaves(c, fn)) };
}

export function addTab(l: Layout, leafId: string | null, tabId: string): Layout {
  const target = leafId ?? firstLeaf(l).id;
  return mapLeaves(l, (leaf) =>
    leaf.id === target && !leaf.tabs.includes(tabId)
      ? { ...leaf, tabs: [...leaf.tabs, tabId], activeTab: tabId }
      : leaf,
  );
}

export function setActiveTab(l: Layout, tabId: string): Layout {
  return mapLeaves(l, (leaf) => (leaf.tabs.includes(tabId) ? { ...leaf, activeTab: tabId } : leaf));
}

export function splitLeaf(l: Layout, leafId: string, dir: "row" | "col", newTabId: string): Layout {
  return mapLeaves(l, (leaf) => {
    if (leaf.id !== leafId) return leaf;
    const fresh: LayoutLeaf = { type: "leaf", id: newId(), tabs: [newTabId], activeTab: newTabId };
    return { type: "split", id: newId(), dir, sizes: [50, 50], children: [leaf, fresh] };
  });
}

/** Remove a tab everywhere; prune empty leaves (except the last one); unwrap single-child splits. */
export function removeTab(l: Layout, tabId: string): Layout {
  const pruned = prune(l);
  return pruned ?? emptyLayout();

  function prune(n: Layout): Layout | null {
    if (n.type === "leaf") {
      if (!n.tabs.includes(tabId)) return n;
      const tabs = n.tabs.filter((t) => t !== tabId);
      if (tabs.length === 0) return null;
      const idx = n.tabs.indexOf(tabId);
      const activeTab = n.activeTab === tabId ? (tabs[Math.min(idx, tabs.length - 1)] ?? null) : n.activeTab;
      return { ...n, tabs, activeTab };
    }
    const kept: Layout[] = []; const sizes: number[] = [];
    n.children.forEach((c, i) => { const p = prune(c); if (p) { kept.push(p); sizes.push(n.sizes[i] ?? 0); } });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]!;
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    return { ...n, children: kept, sizes: sizes.map((s) => (s / total) * 100) };
  }
}

/** Build a preset layout from an ordered list of item ids. Extra items become tabs on leaves round-robin. */
export function gridPreset(name: PresetName, items: string[]): Layout {
  const shape: { rows: number; cols: number } =
    name === "one" ? { rows: 1, cols: 1 } : name === "two-col" ? { rows: 1, cols: 2 }
    : name === "three-col" ? { rows: 1, cols: 3 } : name === "grid-2x2" ? { rows: 2, cols: 2 }
    : { rows: 3, cols: 3 };
  const leafCount = shape.rows * shape.cols;
  const leaves: LayoutLeaf[] = Array.from({ length: leafCount }, () => emptyLayout());
  items.forEach((it, i) => { const leaf = leaves[i % leafCount]!; leaf.tabs.push(it); leaf.activeTab ??= it; });
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
