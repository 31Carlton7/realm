# Realm Plan 4 — Codex-flat shell (UI overhaul)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Realm's shell as the Codex-app flat design — panels-in-a-frame, hairline borders, consistent rounding, no vibrancy — with Arc-true navigation: the sidebar is the single navigation surface, the TabBar is retired, and a layout leaf holds exactly one item.

**Architecture:** Contracts reshape the layout leaf from `tabs`/`activeTab` to `itemId`, with `LayoutSchema` auto-migrating legacy persisted layouts via `z.preprocess`. The store separates three operations that today are one: *open* (place an item in a leaf), *close* (remove from layout, item survives), *delete* (destroy on the server). The renderer replaces the vibrancy/glass treatment with a three-level flat material (frame → panel → raised) driven by a rebuilt `--rl-*` token set; space colour becomes accent-only. No server or adapter changes.

**Spec:** `docs/superpowers/specs/2026-08-24-glass-shell-design.md` (Codex-flat revision). Read it first.

**Tech Stack:** as Plans 1–3. No new dependencies. System font stack (no bundled mono face — decided here: the reference app uses the platform stack, and bundling adds weight for no visible win at 12px).

**Conventions:** repo root `/Users/carltonaikins/Desktop/Home/Work/Projects/realm`; branch `feat/plan-04-flat-shell` off `main`; pnpm only; TDD per task; one commit per task with the given message. `pnpm vitest run <path>` for one file, `pnpm test` for all, `pnpm typecheck` before every commit.

**Two behavioural facts that shape everything** (verified against source, 2026-08-24):
1. `reconcileLayout` (`apps/desktop/src/renderer/src/state/store.ts:134-141`) force-adds **every** item to the layout. Arc-true requires items to exist *outside* the layout (the `SPACE` group), so reconcile becomes prune-only.
2. `closeItem` (`store.ts:309-321`) **deletes the item on the server** (kills ptys, drops transcripts). Arc-true "close" is layout-only. The destructive operation survives as `deleteItem`, reachable from the context menu as "Delete".

---

## File structure (new / changed / deleted)

```
packages/contracts/src/
  layout.ts                REWRITE: itemId leaves, migrateLayout preprocess, renamed ops
  layout.test.ts           REWRITE alongside
packages/ui/src/
  theme.ts                 REWRITE: flat token palette (frame/panel/raised/line/text tiers/accent)
  theme.test.ts            update
apps/desktop/src/main/
  index.ts                 vibrancy removed; opaque background
apps/desktop/src/renderer/src/
  styles.css               FULL REWRITE (flat material system)
  App.tsx                  Main→frame topbar; ⌘\ hotkey; Breadcrumb via focused leaf
  components/TabBar.tsx    DELETE
  components/PaneHost.tsx  REWRITE: panels + PanelBar + drop zones
  components/PanelBar.tsx  NEW: per-leaf header (icon, title, meta, split, close)
  components/panehost.test.tsx  REWRITE
  components/sidebar/ItemList.tsx      REWRITE: grouped rows, open/space variants, draggable
  components/sidebar/SpaceSwiper.tsx   page body: OPEN/SPACE groups
  components/sidebar/ItemContextMenu.tsx  Close→layout-only + Delete (danger)
  components/sidebar/active-tabs.ts    DELETE (replaced by contracts allItems)
  components/sidebar/sidebar.test.tsx  update
  panes/registry.tsx       + paneMeta registry slot
  panes/session/SessionPane.tsx  header removed (PanelBar owns it); empty-state suggestions
  panes/session/suggestions.ts   NEW: static per-agent-kind suggestion chips
  panes/session/Composer.tsx     warning treatment for bypassPermissions; cost handling
  panes/session/ToolCard.tsx     recessed output well markup (class changes only)
  panes/session/tool-summary.ts  extend to codex + ACP tool names
  panes/session/session-pane.test.tsx  update
  state/store.ts           layout slice rework (see Task 2)
  state/store.test.ts      update
```

**Deliberately out of scope** (spec §7): browser pane, realm-mcp, Pull Requests tab, ACP mode mapping, dynamic model pickers, ground tinting, sidebar width preference, server/adapter changes.

---

## Part A — Foundations

### Task 1: Contracts — `itemId` leaves with legacy migration

The leaf shape changes from `{tabs: string[], activeTab: string | null}` to `{itemId: string | null}`. Legacy layouts are persisted in every existing space row **and** flow through zod-validated RPC results, so `LayoutSchema` itself must accept-and-migrate: `z.preprocess(migrateLayout, strict schema)`. Every parse anywhere — client RPC validation, server, tests — silently normalizes.

**Files:**
- Rewrite: `packages/contracts/src/layout.ts`
- Rewrite: `packages/contracts/src/layout.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace `packages/contracts/src/layout.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import {
  LayoutSchema, allItems, closeItem, emptyLayout, findLeafOfItem, firstLeaf,
  gridPreset, migrateLayout, openItem, splitLeaf, updateSizes, type Layout, type LayoutLeaf,
} from "./layout";

const leaf = (itemId: string | null): LayoutLeaf => ({ type: "leaf", id: `L-${itemId ?? "empty"}`, itemId });
const row = (children: Layout[], sizes = children.map(() => 100 / children.length)): Layout =>
  ({ type: "split", id: "S1", dir: "row", sizes, children });

describe("migrateLayout", () => {
  it("converts a legacy leaf to its active tab", () => {
    const legacy = { type: "leaf", id: "a", tabs: ["t1", "t2", "t3"], activeTab: "t2" };
    expect(migrateLayout(legacy)).toEqual({ type: "leaf", id: "a", itemId: "t2" });
  });
  it("falls back to the first tab, then null", () => {
    expect(migrateLayout({ type: "leaf", id: "a", tabs: ["t1"], activeTab: null }))
      .toEqual({ type: "leaf", id: "a", itemId: "t1" });
    expect(migrateLayout({ type: "leaf", id: "a", tabs: [], activeTab: null }))
      .toEqual({ type: "leaf", id: "a", itemId: null });
  });
  it("recurses through splits and passes new-shape nodes through unchanged", () => {
    const mixed = { type: "split", id: "s", dir: "row", sizes: [50, 50],
      children: [{ type: "leaf", id: "a", tabs: ["t1"], activeTab: "t1" }, { type: "leaf", id: "b", itemId: "t9" }] };
    const out = migrateLayout(mixed) as { children: LayoutLeaf[] };
    expect(out.children).toEqual([{ type: "leaf", id: "a", itemId: "t1" }, { type: "leaf", id: "b", itemId: "t9" }]);
  });
  it("LayoutSchema parses legacy shapes into the new shape", () => {
    const parsed = LayoutSchema.parse({ type: "leaf", id: "a", tabs: ["t1", "t2"], activeTab: "t2" });
    expect(parsed).toEqual({ type: "leaf", id: "a", itemId: "t2" });
  });
  it("LayoutSchema still rejects structural garbage", () => {
    expect(() => LayoutSchema.parse({ type: "split", id: "s", dir: "row", sizes: [100], children: [leaf("x")] })).toThrow();
  });
});

describe("openItem / closeItem", () => {
  it("opens into the target leaf, replacing its item", () => {
    const l = row([leaf("a"), leaf("b")]);
    const out = openItem(l, "L-a", "c");
    expect(allItems(out)).toEqual(["c", "b"]);
  });
  it("moves an item that is already open elsewhere (uniqueness)", () => {
    const l = row([leaf("a"), leaf("b")]);
    const out = openItem(l, "L-a", "b");
    // b moved into L-a; its old leaf empties and single-child splits unwrap.
    expect(allItems(out)).toEqual(["b"]);
    expect(out.type).toBe("leaf");
  });
  it("opening into an unknown/null leaf targets the first leaf", () => {
    const l = row([leaf("a"), leaf("b")]);
    expect(allItems(openItem(l, null, "c"))).toEqual(["c", "b"]);
    expect(allItems(openItem(l, "nope", "c"))).toEqual(["c", "b"]);
  });
  it("closeItem empties a lone leaf but keeps its id", () => {
    const l = leaf("a");
    expect(closeItem(l, "a")).toEqual({ type: "leaf", id: "L-a", itemId: null });
  });
  it("closeItem collapses a split whose leaf empties", () => {
    const out = closeItem(row([leaf("a"), leaf("b")]), "a");
    expect(out).toEqual({ type: "leaf", id: "L-b", itemId: "b" });
  });
  it("closeItem keeps empty leaves that were already empty elsewhere", () => {
    const out = closeItem(row([leaf(null), leaf("b")]), "b");
    // b's leaf empties and is pruned; the deliberately-empty leaf survives as the tree.
    expect(out).toEqual({ type: "leaf", id: "L-empty", itemId: null });
  });
});

describe("splitLeaf", () => {
  it("splits with an empty new leaf when itemId is null", () => {
    const out = splitLeaf(leaf("a"), "L-a", "row", null);
    expect(out.type).toBe("split");
    const kids = (out as { children: LayoutLeaf[] }).children;
    expect(kids.map((c) => c.itemId)).toEqual(["a", null]);
  });
  it("moves an already-open item into the new sibling", () => {
    const out = splitLeaf(row([leaf("a"), leaf("b")]), "L-a", "col", "b");
    expect(allItems(out)).toEqual(["a", "b"]);
  });
});

describe("gridPreset", () => {
  it("fills leaves one item each; extras stay unopened", () => {
    const out = gridPreset("two-col", ["a", "b", "c"]);
    expect(allItems(out)).toEqual(["a", "b"]);
  });
  it("leaves trailing leaves empty when items run short", () => {
    const out = gridPreset("grid-2x2", ["a"]);
    expect(allItems(out)).toEqual(["a"]);
    let empties = 0;
    const walk = (n: Layout) => { if (n.type === "leaf") { if (n.itemId === null) empties++; } else n.children.forEach(walk); };
    walk(out);
    expect(empties).toBe(3);
  });
});

describe("plumbing", () => {
  it("emptyLayout / firstLeaf / findLeafOfItem / updateSizes", () => {
    expect(emptyLayout().itemId).toBeNull();
    const l = row([leaf("a"), leaf("b")], [30, 70]);
    expect(firstLeaf(l).id).toBe("L-a");
    expect(findLeafOfItem(l, "b")?.id).toBe("L-b");
    expect(findLeafOfItem(l, "zz")).toBeNull();
    expect((updateSizes(l, "S1", [60, 40]) as { sizes: number[] }).sizes).toEqual([60, 40]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/contracts/src/layout.test.ts`
Expected: FAIL — `migrateLayout`, `openItem`, etc. are not exported.

- [ ] **Step 3: Rewrite the implementation**

Replace `packages/contracts/src/layout.ts` with:

```ts
import { z } from "zod";
import { newId } from "./ids";

export type Layout =
  | { type: "split"; id: string; dir: "row" | "col"; sizes: number[]; children: Layout[] }
  | { type: "leaf"; id: string; itemId: string | null };

export type LayoutLeaf = Extract<Layout, { type: "leaf" }>;
export type LayoutSplit = Extract<Layout, { type: "split" }>;

/**
 * Normalize any persisted layout — including the pre-Plan-4 leaf shape `{tabs, activeTab}` — into the
 * current one-item-per-leaf shape. A legacy leaf collapses to its active tab (else first tab, else empty);
 * displaced tabs simply stop being open, which is exactly the Arc-true semantic. Runs inside LayoutSchema's
 * preprocess, so every parse (RPC results, DB reads, tests) migrates silently.
 */
export function migrateLayout(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const n = input as Record<string, unknown>;
  if (n.type === "split" && Array.isArray(n.children)) return { ...n, children: n.children.map(migrateLayout) };
  if (n.type === "leaf" && !("itemId" in n) && Array.isArray(n.tabs)) {
    const tabs = n.tabs.filter((t): t is string => typeof t === "string");
    const active = typeof n.activeTab === "string" && tabs.includes(n.activeTab) ? n.activeTab : tabs[0] ?? null;
    return { type: "leaf", id: n.id, itemId: active };
  }
  return input;
}

const LayoutBaseSchema: z.ZodType<Layout> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("split"), id: z.string(), dir: z.enum(["row", "col"]),
      sizes: z.array(z.number()), children: z.array(z.preprocess(migrateLayout, LayoutBaseSchema)) }),
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
```

Note the deleted exports: `addTab`, `setActiveTab`, `removeTab`, `allTabs`, `findLeafOfTab`. **Do not** leave aliases — the compiler must force every call site through the rename (the store rework in Task 2 and renderer tasks fix them; `pnpm typecheck` will fail at repo level until then, which is fine — this package's own typecheck must pass).

- [ ] **Step 4: Run to verify the contracts package passes**

Run: `pnpm vitest run packages/contracts` and `pnpm --filter @realm/contracts typecheck`
Expected: both PASS. (Repo-level typecheck fails until Task 2/5 — expected.)

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/layout.ts packages/contracts/src/layout.test.ts
git commit -m "feat(contracts)!: one item per layout leaf, with silent legacy migration"
```

---

### Task 2: Store — open/close/delete separation, focused leaf, prune-only reconcile

**Files:**
- Modify: `apps/desktop/src/renderer/src/state/store.ts`
- Modify: `apps/desktop/src/renderer/src/state/store.test.ts`

The layout slice changes:

| Old | New | Semantics |
|---|---|---|
| `reconcileLayout` adds every item | prune-only | removes ids that no longer exist; never adds |
| `activateTab(itemId)` | `openItem(itemId, leafId?)` | opens into `leafId` ?? `focusedLeafId` ?? first leaf, replacing; focuses that leaf |
| `closeItem(itemId)` (deletes on server!) | `closeFromLayout(itemId)` | layout-only; item returns to the SPACE group |
| — | `deleteItem(itemId)` | the old destructive behaviour, verbatim (server delete, pty/transcript cleanup), plus `closeFromLayout` first |
| `splitWithNewTerminal(leafId, dir)` | `splitFocused(dir)` | splits `focusedLeafId` (or first leaf) with an **empty** sibling and focuses the new leaf |
| — | `openItemAt(itemId, leafId, edge)` | drag-to-split: `edge: "left"|"right"|"top"|"bottom"|"center"`; center = openItem into leaf; edges = splitLeaf(dir by edge) then the new leaf gets the item. For `left`/`top` the item lands in the *first* child — implement by splitting with the **existing** leaf's item moved appropriately: split with `itemId`, then for left/top swap the two children's `itemId`s |
| — | `focusedLeafId: string | null` + `focusLeaf(leafId)` | set by pane clicks, open/split actions; cleared/reset to first leaf when the layout loses it |

`adoptItem` (used by `newTerminal` / `newSession`) opens the new item via `openItem(itemId, targetLeafId ?? focusedLeafId)`. `applyPreset` unchanged in shape. Keyboard `⌘\` is wired in Task 5.

- [ ] **Step 1: Write the failing tests** — add to `store.test.ts` (adapt imports/harness to the file's existing fake-api pattern; read the file first):

```ts
describe("arc-true layout slice", () => {
  it("reconcile prunes deleted items but never force-opens", async () => {
    // seed two items, layout containing only item1 → after refreshItems, item2 stays unopened
    // delete item1 server-side, refresh → layout leaf empties, item2 still unopened
  });
  it("openItem replaces the focused leaf's item and focuses the leaf", async () => {});
  it("closeFromLayout removes from layout but keeps the item and its transcript", async () => {});
  it("deleteItem removes the item server-side and from the layout", async () => {});
  it("splitFocused creates an empty sibling; next openItem fills it", async () => {});
  it("openItemAt center replaces; edge splits in the right direction and position", async () => {});
  it("focusedLeafId falls back to first leaf when its leaf is pruned", async () => {});
});
```

Write these as real tests against the store's existing test harness (`store.test.ts` already builds a store over a fake `Api` — follow its patterns exactly; each test above must assert on `allItems(...)`, `focusedLeafId`, `items`, and for close-vs-delete on whether the fake api's `deleteItem` was called). **No test may be left as an empty body — the skeletons above name the required coverage; fill each with real arrange/act/assert.**

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run apps/desktop/src/renderer/src/state/store.test.ts` — FAIL (missing actions).

- [ ] **Step 3: Implement.** In `store.ts`:

```ts
// imports change:
import { allItems, closeItem as layoutClose, emptyLayout, findLeafOfItem, firstLeaf, gridPreset,
  openItem as layoutOpen, splitLeaf, updateSizes, migrateLayout, LayoutSchema, /* … */ } from "@realm/contracts";

/** Prune-only: drop ids that no longer exist. Never adds — unopened items live in the SPACE group. */
export function reconcileLayout(layout: Layout | null, items: Item[]): Layout {
  let l: Layout = layout ?? emptyLayout();
  const ids = new Set(items.map((i) => i.id));
  for (const t of allItems(l)) if (!ids.has(t)) l = layoutClose(l, t);
  return l;
}
```

State gains `focusedLeafId: string | null` (initial null). Actions:

```ts
focusLeaf(leafId) { set({ focusedLeafId: leafId }); },

async openItem(itemId, leafId = null) {
  const target = leafId ?? get().focusedLeafId;
  const layout = layoutOpen(get().layout ?? emptyLayout(), target, itemId);
  const leaf = findLeafOfItem(layout, itemId);
  set({ layout, focusedLeafId: leaf?.id ?? null });
  await persist();
},

async closeFromLayout(itemId) {
  const layout = layoutClose(get().layout ?? emptyLayout(), itemId);
  const focused = get().focusedLeafId;
  set({ layout, focusedLeafId: focused && hasLeafIn(layout, focused) ? focused : firstLeaf(layout).id });
  await persist();
},

async deleteItem(itemId) {
  await get().closeFromLayout(itemId);
  // …then the whole body of the OLD closeItem verbatim (api.deleteItem, pty dispose, transcript/session cleanup),
  // minus its removeTab line (already handled above).
},

async splitFocused(dir) {
  const l = get().layout ?? emptyLayout();
  const target = get().focusedLeafId ?? firstLeaf(l).id;
  const layout = splitLeaf(l, target, dir, null);
  // the fresh empty leaf is the one whose itemId is null inside the split that replaced `target`:
  const fresh = findEmptySiblingOf(layout, target);
  set({ layout, focusedLeafId: fresh ?? target });
  await persist();
},

async openItemAt(itemId, leafId, edge) {
  if (edge === "center") return get().openItem(itemId, leafId);
  const dir = edge === "left" || edge === "right" ? "row" : "col";
  let layout = splitLeaf(get().layout ?? emptyLayout(), leafId, dir, itemId);
  if (edge === "left" || edge === "top") layout = swapSplitChildrenOf(layout, leafId, itemId);
  const leaf = findLeafOfItem(layout, itemId);
  set({ layout, focusedLeafId: leaf?.id ?? null });
  await persist();
},
```

Write the two small helpers (`hasLeafIn`, `findEmptySiblingOf`, `swapSplitChildrenOf`) as module-level pure functions with unit tests in `store.test.ts` (`swapSplitChildrenOf` swaps the `itemId`s of the two children of the split containing the original leaf + the new item — it must not swap grandchildren). Delete `activateTab` and `splitWithNewTerminal`; update `adoptItem`; keep `applyPreset` (now via new `gridPreset`). `selectSpace`'s layout read stays as-is — RPC parse already migrated it via `LayoutSchema`; **verify this** by grepping `apps/desktop/src/renderer/src/rpc/client.ts` and `state/live-api.ts` for where Space results are parsed; if layout is NOT zod-parsed on the client, apply `LayoutSchema.parse` in `selectSpace` before seeding.

- [ ] **Step 4: Run** — store tests PASS; `pnpm --filter @realm/desktop typecheck` still fails on components (Task 5 fixes) — that's fine only if the failures are confined to `TabBar/PaneHost/App/ItemList/active-tabs/session-pane` files.

- [ ] **Step 5: Commit** — `feat(desktop): arc-true store — open/close/delete separation and focused leaf`

---

### Task 3: Theme — flat token palette, vibrancy removal

**Files:**
- Rewrite: `packages/ui/src/theme.ts` (keep `hexToHsl`/`hslToHex`)
- Modify: `packages/ui/src/theme.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Read first: `apps/desktop/src/renderer/src/theme/useTheme.ts` (interface must keep working)

- [ ] **Step 1: Failing tests** — replace palette assertions in `theme.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hexToHsl, hslToHex, paletteFromColor, themeToCssVars } from "./theme";

describe("paletteFromColor (flat)", () => {
  it("dark palette uses fixed neutral surfaces and the space colour only as accent", () => {
    const p = paletteFromColor("#3ddc97", "dark");
    expect(p.frame).toBe("#131417");
    expect(p.panel).toBe("#1b1c20");
    expect(p.raised).toBe("#222329");
    expect(p.line).toBe("#26272c");
    expect(p.accent).not.toBe(p.frame);
  });
  it("accent is contrast-adjusted: a near-black accent is lightened in dark mode", () => {
    const p = paletteFromColor("#111111", "dark");
    expect(hexToHsl(p.accent).l).toBeGreaterThan(40);
  });
  it("light palette flips the ladder", () => {
    const p = paletteFromColor("#3ddc97", "light");
    expect(hexToHsl(p.frame).l).toBeGreaterThan(90);                        // light ground
    expect(hexToHsl(p.frame).l).toBeLessThan(hexToHsl(p.panel).l);          // panel sits above frame
    expect(hexToHsl(p.textBright).l).toBeLessThan(30);
  });
  it("css vars are kebab-cased --rl-*", () => {
    const vars = themeToCssVars(paletteFromColor("#7c6cff", "dark"));
    expect(vars["--rl-frame"]).toBeDefined();
    expect(vars["--rl-text-bright"]).toBeDefined();
    expect(vars["--rl-mode"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** New `Palette`:

```ts
export type Palette = {
  mode: Mode; accent: string;
  frame: string; panel: string; raised: string; line: string; lineStrong: string;
  textBright: string; textDim: string; textFaint: string;
  danger: string; success: string; warning: string;
  terminalBg: string; shadow: string;
};

/** Flat Codex-style palette. Surfaces are fixed neutrals; the space colour survives only as `accent`,
 *  contrast-adjusted so it stays legible on the mode's surfaces (dark: lightness clamped to [55, 75];
 *  light: clamped to [35, 55]; saturation floor 25 so grey accents stay visible). */
export function paletteFromColor(hex: string, mode: Mode): Palette {
  const h = hexToHsl(hex);
  const accent = hslToHex(mode === "dark"
    ? { h: h.h, s: Math.max(h.s, 25), l: Math.min(75, Math.max(55, h.l)) }
    : { h: h.h, s: Math.max(h.s, 25), l: Math.min(55, Math.max(35, h.l)) });
  if (mode === "dark") return {
    mode, accent,
    frame: "#131417", panel: "#1b1c20", raised: "#222329", line: "#26272c", lineStrong: "#33343b",
    textBright: "#ececf1", textDim: "#9a9ba5", textFaint: "#5e5f68",
    danger: "#f87171", success: "#6ee7a0", warning: "#e8963a",
    terminalBg: "#101114", shadow: "0 8px 24px rgba(0,0,0,.4)",
  };
  return {
    mode, accent,
    frame: "#f2f2f4", panel: "#ffffff", raised: "#ffffff", line: "#e3e3e8", lineStrong: "#d2d2d9",
    textBright: "#1c1c21", textDim: "#5f6068", textFaint: "#9a9aa4",
    danger: "#dc2626", success: "#16a34a", warning: "#c2701d",
    terminalBg: "#16171a", shadow: "0 8px 24px rgba(20,20,40,.14)",
  };
}
```

`themeToCssVars`/`applyTheme` keep their shape (mode → `data-mode`, keys → kebab `--rl-*`). In `apps/desktop/src/main/index.ts`, remove the vibrancy block: `backgroundColor: "#131417"`, drop `vibrancy`/`visualEffectState` and the `--realm-vibrancy=1` argument; delete the comment. Grep the renderer for `data-vibrancy`/`realm-vibrancy` and remove the wiring (`main.tsx` or wherever `body[data-vibrancy]` is set).

- [ ] **Step 4: Run** — `pnpm vitest run packages/ui` PASS; `pnpm --filter @realm/ui typecheck` PASS. Renderer typecheck errors referencing removed palette keys (`sidebarBg` etc.) are fixed by Tasks 4–5.

- [ ] **Step 5: Commit** — `feat(ui)!: flat frame/panel/raised palette; space colour is accent-only; drop vibrancy`

---

## Part B — Shell

### Task 4: The stylesheet — full rewrite

One task, one file, the complete flat material system. Later tasks change only TSX; every class they need is defined here.

**Files:**
- Rewrite: `apps/desktop/src/renderer/src/styles.css`

- [ ] **Step 1: Replace `styles.css` entirely** with the stylesheet below. It preserves every class name the components use today except the deleted tab classes (`.tabbar`, `.tab*`) and the glass-era tokens; new classes: `.topbar`, `.panel-bar*`, `.group-label`, `.item-glyph`, `.drop-*`, `.suggestions`, `.suggestion-chip`, `.composer-chip[data-warning]`, `.tool-well`.

```css
/* Realm — Codex-flat material system. Three levels: frame (window ground), panel (leaves),
   raised (overlays). Separation is luminance + hairlines; shadows only on raised. Space colour
   appears only through --rl-accent. Tokens are written by applyTheme(); these are pre-boot fallbacks. */
:root {
  --rl-accent: #7c6cff;
  --rl-frame: #131417; --rl-panel: #1b1c20; --rl-raised: #222329;
  --rl-line: #26272c; --rl-line-strong: #33343b;
  --rl-text-bright: #ececf1; --rl-text-dim: #9a9ba5; --rl-text-faint: #5e5f68;
  --rl-danger: #f87171; --rl-success: #6ee7a0; --rl-warning: #e8963a;
  --rl-terminal-bg: #101114; --rl-shadow: 0 8px 24px rgba(0,0,0,.4);
  --r-panel: 12px; --r-ctl: 8px; --r-chip: 6px;
  --sidebar-w: 240px; --ease: cubic-bezier(.2,.8,.2,1);
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; color: var(--rl-text-bright); font: 13px/1.45 -apple-system, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
html, body { background: var(--rl-frame); }
button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; padding: 0; }
button:disabled { cursor: default; opacity: .45; }
input, select, textarea { font: inherit; color: inherit; }
kbd { font: 11px ui-monospace, Menlo, monospace; }
.muted { color: var(--rl-text-dim); }
:focus-visible { outline: 2px solid var(--rl-accent); outline-offset: 1px; }

/* ── Frame + sidebar (drawn directly on the frame) ─────────────────────── */
.app { display: flex; height: 100%; background: var(--rl-frame); }
.sidebar { width: var(--sidebar-w); flex: none; display: flex; flex-direction: column; min-height: 0; -webkit-app-region: drag; }
.sidebar button, .sidebar input, .sidebar [data-swiper] { -webkit-app-region: no-drag; }
.sb-top { padding: 40px 12px 8px; }
.search { display: flex; align-items: center; gap: 8px; width: 100%; height: 30px; padding: 0 10px; border-radius: var(--r-ctl);
  background: var(--rl-panel); border: 1px solid var(--rl-line); color: var(--rl-text-faint); text-align: left; }
.search:hover { border-color: var(--rl-line-strong); color: var(--rl-text-dim); }
.search span { flex: 1; } .search kbd { opacity: .7; }

.swiper { flex: 1; min-height: 0; overflow: clip; position: relative; }
.swiper-track { display: flex; height: 100%; width: 100%; will-change: transform; }
.space-page { flex: 0 0 100%; min-width: 0; height: 100%; display: flex; flex-direction: column; padding: 4px 12px 8px; overflow: hidden; }
.space-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }

.space-header { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 6px 0 8px; }
.space-header h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; font-weight: 600; min-width: 0; letter-spacing: -0.01em; }
.space-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--rl-accent); flex: none; }
.space-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.space-header-actions { display: flex; align-items: center; gap: 2px; flex: none; }
.pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--rl-panel); border: 1px solid var(--rl-line); color: var(--rl-text-dim); }
.icon-btn { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; color: var(--rl-text-dim); }
.icon-btn:hover { background: var(--rl-panel); color: var(--rl-text-bright); }
.menu-anchor { position: relative; }

.group-label { font-size: 10.5px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase;
  color: var(--rl-text-faint); padding: 10px 5px 4px; }

.pinned-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; padding-bottom: 4px; }
.tile { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; aspect-ratio: 1; border-radius: 10px;
  background: var(--rl-panel); border: 1px solid var(--rl-line); color: var(--rl-text-bright); padding: 4px; min-width: 0; }
.tile:hover { border-color: var(--rl-line-strong); }
.tile[data-active] { border-color: var(--rl-accent); }
.tile-title { font-size: 10px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--rl-text-dim); }
.tile-rename { aspect-ratio: auto; grid-column: 1 / -1; padding: 0; }

.item-list { display: flex; flex-direction: column; gap: 1px; }
.item { position: relative; display: flex; align-items: center; border-radius: 7px; min-height: 28px; font-size: 12.5px; }
.item:hover { background: var(--rl-panel); }
.item[data-active] { background: var(--rl-panel); }
.item[data-active]::before { content: ""; position: absolute; left: 0; top: 6px; bottom: 6px; width: 2px; border-radius: 2px; background: var(--rl-accent); }
.item[data-active] .item-row { font-weight: 550; color: var(--rl-text-bright); }
.item-row { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; text-align: left; padding: 5px 8px 5px 10px; color: var(--rl-text-dim); border-radius: 7px; }
.item:hover .item-row { color: var(--rl-text-bright); }
.item-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-status { margin-left: auto; width: 6px; height: 6px; }
.item-glyph { margin-left: auto; width: 10px; height: 10px; flex: none; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 1px; opacity: .7; }
.item-glyph span { background: var(--rl-line-strong); border-radius: 1px; }
.item-glyph span[data-on] { background: var(--rl-accent); }
.item-close { opacity: 0; display: grid; place-items: center; width: 22px; height: 22px; margin-right: 3px; border-radius: 6px; color: var(--rl-text-dim); }
.item:hover .item-close { opacity: 1; } .item-close:hover { background: var(--rl-raised); color: var(--rl-text-bright); }
.item[data-dragging] { opacity: .45; }
.rename { width: 100%; height: 28px; padding: 0 8px; border-radius: 7px; border: 1px solid var(--rl-accent); background: var(--rl-panel); color: var(--rl-text-bright); outline: none; }
.new-item { margin-top: auto; padding-top: 4px; }
.sb-divider { height: 1px; background: var(--rl-line); margin: 4px 4px 6px; }
.new-row { color: var(--rl-text-dim); width: 100%; } .new-row:hover { background: var(--rl-panel); color: var(--rl-text-bright); }

.space-strip { flex: none; display: flex; align-items: center; gap: 4px; padding: 6px 8px 10px; }
.strip-spaces { flex: 1; display: flex; align-items: center; justify-content: center; gap: 2px; min-width: 0; overflow-x: auto; }
.strip-side { flex: none; }
.strip-space { position: relative; display: grid; place-items: center; width: 30px; height: 30px; border-radius: var(--r-ctl); color: var(--rl-text-dim); flex: none; }
.strip-space:hover { background: var(--rl-panel); color: var(--rl-text-bright); }
.strip-space[data-active] { color: var(--space-color, var(--rl-accent)); background: var(--rl-panel); border: 1px solid var(--rl-line-strong); }
.strip-space[data-drag-over] { box-shadow: inset 2px 0 0 var(--rl-accent); }
.strip-dot { position: absolute; bottom: 2px; left: 50%; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: currentColor; opacity: 0; }
.strip-space[data-active] .strip-dot { opacity: 1; }

/* ── Menus / overlays (raised) ─────────────────────────────────────────── */
.menu { z-index: 100; min-width: 160px; padding: 4px; display: flex; flex-direction: column;
  background: var(--rl-raised); color: var(--rl-text-bright); border: 1px solid var(--rl-line-strong); border-radius: var(--r-panel); box-shadow: var(--rl-shadow); }
.menu [role="menuitem"] { text-align: left; padding: 6px 10px; border-radius: var(--r-chip); display: flex; align-items: center; gap: 8px; }
.menu [role="menuitem"]:hover:not(:disabled) { background: var(--rl-panel); }
.menu [role="menuitem"].checked::after { content: "✓"; margin-left: auto; color: var(--rl-accent); }
.menu [role="menuitem"].danger { color: var(--rl-danger); }
.menu-sep { height: 1px; background: var(--rl-line); margin: 4px 2px; }

/* ── Main: frame topbar + panel host ───────────────────────────────────── */
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; -webkit-app-region: drag; }
.topbar { height: 36px; flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 10px 0 4px; }
.topbar button { -webkit-app-region: no-drag; }
.breadcrumb { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; color: var(--rl-text-dim); font-weight: 500; font-size: 12.5px; }
.crumb { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .crumb-sep { color: var(--rl-text-faint); }
.layout-menu { position: relative; }
.layout-menu > button { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; color: var(--rl-text-dim); }
.layout-menu > button:hover { background: var(--rl-panel); color: var(--rl-text-bright); }

.panehost { flex: 1; min-height: 0; display: flex; padding: 0 8px 8px; -webkit-app-region: no-drag; }
.panehost > * { flex: 1; min-width: 0; min-height: 0; }
.panel { position: relative; display: flex; flex-direction: column; height: 100%; min-width: 0;
  background: var(--rl-panel); border: 1px solid var(--rl-line); border-radius: var(--r-panel); overflow: hidden; }
.panel[data-focused] { border-color: var(--rl-line-strong); }
.panel-bar { flex: none; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 6px 0 12px; border-bottom: 1px solid var(--rl-line); font-size: 12px; }
.panel-icon { color: var(--rl-accent); display: grid; place-items: center; }
.panel-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.panel-meta { margin-left: auto; display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--rl-text-dim); white-space: nowrap; }
.panel-actions { display: flex; align-items: center; gap: 2px; flex: none; }
.panel-body { flex: 1; min-height: 0; position: relative; display: flex; }
.pane-slot { flex: 1; min-width: 0; min-height: 0; display: flex; }
.pane-placeholder { flex: 1; display: grid; place-content: center; text-align: center; gap: 6px; color: var(--rl-text-dim); }
.resize-handle { flex: 0 0 8px; background: transparent; position: relative; }
.resize-handle::after { content: ""; position: absolute; inset: 30% 3px; border-radius: 2px; background: transparent; }
.resize-handle:hover::after, .resize-handle[data-resize-handle-active]::after { background: var(--rl-accent); }

.drop-overlay { position: absolute; inset: 0; z-index: 5; pointer-events: none; }
.drop-zone { position: absolute; background: color-mix(in srgb, var(--rl-accent) 18%, transparent);
  border: 1.5px dashed var(--rl-accent); border-radius: 8px; opacity: 0; }
.drop-zone[data-hot] { opacity: 1; }
.drop-zone[data-edge="left"] { inset: 6px auto 6px 6px; width: 32%; }
.drop-zone[data-edge="right"] { inset: 6px 6px 6px auto; width: 32%; }
.drop-zone[data-edge="top"] { inset: 6px 6px auto 6px; height: 32%; }
.drop-zone[data-edge="bottom"] { inset: auto 6px 6px 6px; height: 32%; }
.drop-zone[data-edge="center"] { inset: 34%; }

.terminal-pane { flex: 1; min-width: 0; min-height: 0; padding: 6px; background: var(--rl-terminal-bg); display: flex; }
.terminal-pane .xterm { height: 100%; }
.terminal-host { flex: 1; min-width: 0; min-height: 0; height: 100%; }
.error-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 8px 6px; padding: 6px 10px; border: 1px solid color-mix(in srgb, var(--rl-danger) 40%, transparent); border-radius: var(--r-ctl);
  background: color-mix(in srgb, var(--rl-danger) 10%, var(--rl-panel)); color: var(--rl-danger); font-size: 12px; -webkit-app-region: no-drag; }
.error-bar button { color: inherit; padding: 2px 6px; }

/* ── Sheets / palette (raised) ─────────────────────────────────────────── */
.sheet-backdrop { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; background: rgba(0,0,0,.4); }
.sheet { max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow: auto; border-radius: var(--r-panel); background: var(--rl-raised); color: var(--rl-text-bright);
  border: 1px solid var(--rl-line-strong); box-shadow: var(--rl-shadow); outline: none; }
.sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 6px; }
.sheet-head h3 { margin: 0; font-size: 15px; font-weight: 600; }
.sheet-body { padding: 8px 16px 16px; }
.form { display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.field > span { font-size: 12px; color: var(--rl-text-dim); }
.field input, .field select { height: 30px; padding: 0 9px; border-radius: var(--r-ctl); border: 1px solid var(--rl-line); background: var(--rl-panel); color: var(--rl-text-bright); outline: none; }
.field input:focus, .field select:focus { border-color: var(--rl-accent); }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.btn { height: 30px; padding: 0 12px; border-radius: var(--r-ctl); border: 1px solid var(--rl-line); background: var(--rl-panel); }
.btn:hover:not(:disabled) { border-color: var(--rl-line-strong); }
.btn.primary { background: var(--rl-accent); border-color: transparent; color: #fff; }
.btn.danger { color: var(--rl-danger); }
.icon-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.icon-choice { display: grid; place-items: center; width: 34px; height: 34px; border-radius: var(--r-ctl); border: 1px solid var(--rl-line); background: var(--rl-panel); color: var(--rl-text-dim); }
.icon-choice:hover { color: var(--rl-text-bright); } .icon-choice[data-selected] { border-color: var(--rl-accent); color: var(--rl-accent); }
.swatches { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; }
.swatch[data-selected] { border-color: var(--rl-text-bright); }
.hex { width: 90px; height: 26px; padding: 0 8px; border-radius: var(--r-chip); border: 1px solid var(--rl-line); background: var(--rl-panel); font: 12px ui-monospace, Menlo, monospace; }
.danger-zone { justify-content: flex-start; align-items: center; border-top: 1px solid var(--rl-line); padding-top: 12px; }
.danger-zone .muted { flex: 1; }

.palette-backdrop { position: fixed; inset: 0; z-index: 50; display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; background: rgba(0,0,0,.35); }
.palette { width: min(560px, calc(100vw - 32px)); border-radius: var(--r-panel); overflow: hidden; background: var(--rl-raised); color: var(--rl-text-bright); border: 1px solid var(--rl-line-strong); box-shadow: var(--rl-shadow); }
.palette-input { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--rl-line); color: var(--rl-text-dim); }
.palette-input input { flex: 1; border: none; outline: none; background: transparent; font-size: 15px; color: var(--rl-text-bright); }
.palette-input kbd { padding: 1px 5px; border: 1px solid var(--rl-line); border-radius: 4px; }
.palette-list { max-height: 50vh; overflow-y: auto; padding: 6px; }
.palette-opt { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--r-ctl); cursor: default; }
.palette-opt.selected { background: var(--rl-panel); }
.palette-opt.disabled { opacity: .45; }
.palette-icon { display: grid; place-items: center; width: 20px; color: var(--rl-text-dim); }
.palette-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.palette-hint { font-size: 11px; color: var(--rl-text-dim); }
.palette-empty { padding: 14px; text-align: center; }

/* ── Session pane ──────────────────────────────────────────────────────── */
.session-pane { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--rl-panel); }
.status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--rl-text-faint); flex: none; }
.status-dot[data-status="running"] { background: var(--rl-accent); animation: rl-pulse 1.4s ease-in-out infinite; }
.status-dot[data-status="waiting_permission"] { background: var(--rl-warning); animation: rl-pulse 0.9s ease-in-out infinite; }
.status-dot[data-status="error"] { background: var(--rl-danger); }
.status-dot[data-status="idle"] { background: var(--rl-success); opacity: .8; }
.status-dot[data-status="ended"] { background: var(--rl-text-faint); opacity: .6; }
@keyframes rl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
@keyframes rl-spin { to { transform: rotate(360deg); } }
.spin { animation: rl-spin 0.9s linear infinite; }

.transcript-wrap { flex: 1; min-height: 0; position: relative; display: flex; }
.transcript { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 18px 8px; display: flex; flex-direction: column; gap: 10px; }
.transcript-empty { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; max-width: 420px; }
.transcript-empty svg { color: var(--rl-text-faint); }
.empty-title { font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
.empty-title em { font-style: normal; text-decoration: underline; text-decoration-color: var(--rl-line-strong); text-underline-offset: 3px; }
.suggestions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 4px; }
.suggestion-chip { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; padding: 10px 12px; border-radius: 10px;
  border: 1px solid var(--rl-line); background: var(--rl-panel); color: var(--rl-text-dim); font-size: 12px; max-width: 200px; }
.suggestion-chip:hover { border-color: var(--rl-line-strong); color: var(--rl-text-bright); }

.msg-user-row { display: flex; justify-content: flex-end; }
.msg-user { max-width: 78%; padding: 8px 12px; border-radius: 12px 12px 4px 12px; background: var(--rl-raised); white-space: pre-wrap; overflow-wrap: anywhere; }
.msg-assistant { max-width: 72ch; }
.md { line-height: 1.55; overflow-wrap: anywhere; }
.md > div > :first-child { margin-top: 0; } .md > div > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 8px; } .md ul, .md ol { margin: 0 0 8px; padding-left: 20px; }
.md h1, .md h2, .md h3, .md h4 { margin: 12px 0 6px; font-weight: 600; line-height: 1.3; } .md h1 { font-size: 16px; } .md h2 { font-size: 15px; } .md h3 { font-size: 14px; }
.md code { font: 12px ui-monospace, Menlo, monospace; padding: 1px 4px; border-radius: 4px; background: var(--rl-raised); }
.md pre { margin: 6px 0 8px; padding: 10px 12px; border-radius: var(--r-ctl); background: var(--rl-frame); border: 1px solid var(--rl-line); overflow-x: auto; }
.md pre code { padding: 0; background: none; }
.md a { color: var(--rl-accent); }
.md blockquote { margin: 0 0 8px; padding: 2px 10px; border-left: 3px solid var(--rl-line-strong); color: var(--rl-text-dim); }
.md table { border-collapse: collapse; margin: 6px 0 8px; } .md th, .md td { border: 1px solid var(--rl-line); padding: 4px 8px; }
.md-caret { color: var(--rl-accent); animation: rl-pulse 1s ease-in-out infinite; }
.msg-thinking { font-size: 12px; }
.thinking-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--rl-text-faint); padding: 2px 6px; border-radius: var(--r-chip); }
.thinking-toggle:hover { background: var(--rl-raised); color: var(--rl-text-dim); }
.thinking-body { margin-top: 4px; padding: 8px 10px; border-left: 2px solid var(--rl-line-strong); color: var(--rl-text-dim); white-space: pre-wrap; }
.msg-error { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: var(--r-ctl); color: var(--rl-danger); border: 1px solid color-mix(in srgb, var(--rl-danger) 35%, transparent); background: color-mix(in srgb, var(--rl-danger) 8%, var(--rl-panel)); }
.msg-error pre { margin: 0; white-space: pre-wrap; font: 12px ui-monospace, Menlo, monospace; max-height: 240px; overflow: auto; }
.msg-working { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--rl-text-dim); }
.new-msgs-pill { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); display: flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; font-size: 12px;
  background: var(--rl-accent); color: #fff; box-shadow: var(--rl-shadow); }

.tool-card { border: 1px solid var(--rl-line); border-radius: 10px; background: var(--rl-panel); font-size: 12px; overflow: hidden; }
.tool-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; text-align: left; color: var(--rl-text-bright); }
.tool-row:hover { background: var(--rl-raised); }
.tool-chevron { color: var(--rl-text-faint); transition: transform 120ms var(--ease); flex: none; }
.tool-card[data-open] .tool-chevron { transform: rotate(90deg); }
.tool-name { font-weight: 600; flex: none; }
.tool-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--rl-text-dim); font: 12px ui-monospace, Menlo, monospace; }
.tool-status { display: grid; place-items: center; width: 16px; color: var(--rl-text-faint); flex: none; }
.tool-card[data-state="ok"] .tool-status { color: var(--rl-success); }
.tool-card[data-state="error"] .tool-status { color: var(--rl-danger); }
.tool-card[data-state="running"] .tool-status { color: var(--rl-accent); }
.tool-body { border-top: 1px solid var(--rl-line); padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
.tool-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--rl-text-faint); margin-bottom: 4px; }
.tool-well, .tool-body pre, .permission-details pre { margin: 0; padding: 8px 10px; border-radius: var(--r-chip); background: var(--rl-frame); border: 1px solid var(--rl-line); font: 12px ui-monospace, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; }
.tool-body pre[data-error] { color: var(--rl-danger); }

.permission-card { border: 1px solid color-mix(in srgb, var(--rl-warning) 50%, transparent); border-radius: var(--r-panel); padding: 12px 14px; background: color-mix(in srgb, var(--rl-warning) 8%, var(--rl-panel)); display: flex; flex-direction: column; gap: 8px; }
.permission-head { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--rl-warning); }
.permission-tool { display: flex; align-items: center; gap: 8px; min-width: 0; }
.permission-tool code { font: 12px ui-monospace, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--rl-text-dim); }
.permission-details summary { font-size: 11px; color: var(--rl-text-dim); cursor: default; }
.permission-details pre { margin-top: 6px; }
.permission-actions { display: flex; justify-content: flex-end; gap: 8px; }

.composer { flex: none; margin: 8px 12px 12px; border: 1px solid var(--rl-line-strong); border-radius: var(--r-panel); background: var(--rl-raised); box-shadow: var(--rl-shadow); display: flex; flex-direction: column; }
.composer:focus-within { border-color: color-mix(in srgb, var(--rl-accent) 60%, var(--rl-line-strong)); }
.composer-input { border: none; outline: none; resize: none; background: transparent; color: var(--rl-text-bright); font: inherit; line-height: 1.45; padding: 10px 12px 4px; min-height: 36px; max-height: 220px; }
.composer-input::placeholder { color: var(--rl-text-faint); }
.composer-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px 8px 8px; }
.composer-opts { display: flex; align-items: center; gap: 4px; min-width: 0; flex-wrap: wrap; }
.composer-select { height: 24px; padding: 0 6px; border-radius: var(--r-chip); border: 1px solid transparent; background: transparent; color: var(--rl-text-dim); font-size: 10.5px; max-width: 150px; }
.composer-select:hover { background: var(--rl-panel); color: var(--rl-text-bright); }
.composer-select[data-warning] { color: var(--rl-warning); border-color: color-mix(in srgb, var(--rl-warning) 45%, transparent); background: color-mix(in srgb, var(--rl-warning) 10%, transparent); }
.composer-chip { display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; height: 24px; border-radius: var(--r-chip); font-size: 10.5px; color: var(--rl-text-dim); background: var(--rl-panel); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.composer-btn { display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--r-ctl); color: var(--rl-text-dim); }
.composer-btn:hover:not(:disabled) { background: var(--rl-panel); color: var(--rl-text-bright); }
.composer-btn.send:not(:disabled) { background: var(--rl-accent); color: #fff; }
.composer-btn.stop { color: var(--rl-danger); }

.agent-list { display: flex; flex-direction: column; gap: 4px; }
.agent-choice { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--r-ctl); border: 1px solid var(--rl-line); background: var(--rl-panel); text-align: left; }
.agent-choice[data-selected] { border-color: var(--rl-accent); }
.agent-error { font-size: 12px; color: var(--rl-danger); }
.agent-hint-text { font-size: 11px; color: var(--rl-text-dim); } .agent-hint-text code { font: 11px ui-monospace, Menlo, monospace; }
.agent-name { font-weight: 550; } .agent-hint { margin-left: auto; font-size: 11px; color: var(--rl-text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }

/* ── Motion (spec §4): panel settle + permission enter; nothing else ───── */
.panel-body[data-settle] .pane-slot { animation: rl-settle 150ms var(--ease); }
@keyframes rl-settle { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.permission-card { animation: rl-perm-in 120ms var(--ease); }
@keyframes rl-perm-in { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
```

- [ ] **Step 2: Sanity** — `pnpm vitest run apps/desktop` (component tests will fail until Tasks 5–6 update markup; note which failures are markup-related and proceed). `pnpm dev` should boot with the frame background even while components still reference old markup.

- [ ] **Step 3: Commit** — `feat(desktop): flat material stylesheet (frame/panel/raised)`

---

### Task 5: PaneHost + PanelBar; App shell; delete TabBar

**Files:**
- Create: `apps/desktop/src/renderer/src/components/PanelBar.tsx`
- Rewrite: `apps/desktop/src/renderer/src/components/PaneHost.tsx`
- Delete: `apps/desktop/src/renderer/src/components/TabBar.tsx`
- Modify: `apps/desktop/src/renderer/src/panes/registry.tsx` (add `paneMeta`)
- Modify: `apps/desktop/src/renderer/src/panes/session/SessionPane.tsx` (remove internal header; export meta)
- Modify: `apps/desktop/src/renderer/src/App.tsx` (topbar, ⌘\, Breadcrumb via focused leaf, onClose→closeFromLayout)
- Delete: `apps/desktop/src/renderer/src/components/sidebar/active-tabs.ts` (use `allItems`/`findLeafOfItem` from contracts)
- Rewrite: `apps/desktop/src/renderer/src/components/panehost.test.tsx`

- [ ] **Step 1: Failing tests** — rewrite `panehost.test.tsx`:

```tsx
// Renders a layout of itemId leaves; asserts: each leaf renders a .panel with a PanelBar showing the
// item's title; empty leaf renders the placeholder "Open something from the sidebar"; the focused leaf
// has data-focused; clicking a panel calls onFocus(leafId); the close button calls onClose(itemId);
// the split button calls onSplit(leafId, "row"); a session item's PanelBar shows the meta from paneMeta
// (model label) — use the store-less render pattern the current file uses (props in, spies out).
```

Write these as five real `it(...)` blocks with `@testing-library/react` following the existing file's conventions. Required new `PaneHostProps`:

```ts
export type PaneHostProps = {
  layout: Layout; items: Item[]; focusedLeafId: string | null;
  onFocus: (leafId: string) => void;
  onClose: (itemId: string) => void;               // layout-only close
  onSplit: (leafId: string, dir: "row" | "col") => void;
  onResize?: (splitId: string, sizes: number[]) => void;
  onDropItem?: (itemId: string, leafId: string, edge: DropEdge) => void;  // Task 7 wires; optional here
};
export type DropEdge = "left" | "right" | "top" | "bottom" | "center";
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**

`PanelBar.tsx`:

```tsx
import { Icon } from "@realm/ui";
import type { Item } from "@realm/contracts";
import { paneMeta } from "../panes/registry";

/** Slim per-panel header: item icon + title, per-kind meta (right), split + close actions. */
export function PanelBar({ item, onSplit, onClose }: {
  item: Item; onSplit: (dir: "row" | "col") => void; onClose: () => void;
}) {
  const Meta = paneMeta[item.kind];
  return (
    <div className="panel-bar">
      <span className="panel-icon"><Icon name={item.kind} size={14} /></span>
      <span className="panel-title">{item.title}</span>
      <span className="panel-meta">{Meta ? <Meta item={item} /> : null}</span>
      <span className="panel-actions">
        <button className="icon-btn" aria-label="Split right" title="Split right (⌘\)" onClick={() => onSplit("row")}><Icon name="layout" size={13} /></button>
        <button className="icon-btn" aria-label={`Close ${item.title}`} title="Close" onClick={onClose}><Icon name="close" size={13} /></button>
      </span>
    </div>
  );
}
```

`PaneHost.tsx` — leaves render:

```tsx
function renderNode(n: Layout): JSX.Element {
  if (n.type === "leaf") {
    const item = n.itemId ? byId.get(n.itemId) ?? null : null;
    return (
      <div className="panel" data-leaf-id={n.id} data-focused={n.id === p.focusedLeafId || undefined}
        onPointerDownCapture={() => p.onFocus(n.id)}>
        {item && <PanelBar item={item} onSplit={(dir) => p.onSplit(n.id, dir)} onClose={() => p.onClose(item.id)} />}
        <div className="panel-body">
          {!item && <div className="pane-placeholder muted">Open something from the sidebar.</div>}
          {item && <div className="pane-slot"><PaneFor item={item} visible /></div>}
        </div>
      </div>
    );
  }
  /* split branch unchanged from today (PanelGroup / PanelResizeHandle) */
}
```

`registry.tsx` gains alongside the pane registry:

```tsx
/** Optional right-side PanelBar content per item kind. */
export const paneMeta: Partial<Record<Item["kind"], (p: { item: Item }) => JSX.Element | null>> = {
  session: SessionMeta,   // model label + status dot + cost, moved out of SessionPane's old header
};
```

`SessionMeta` lives in `panes/session/SessionPane.tsx` (exported): renders what the old `.session-header`'s right side showed — model, status dot, and cost — **cost only when `costUsd > 0`** (spec §3 closure; today `SessionPane.tsx:42` shows it whenever `numTurns > 0`). Then delete the `.session-header` row from `SessionPane` (PanelBar owns icon+title now).

`App.tsx`: `Main` renders `<div className="topbar"><Breadcrumb/><LayoutMenu/></div>` + `<ErrorBar/>` + `<PaneHost … focusedLeafId={focusedLeafId} onFocus={focusLeaf} onClose={closeFromLayout} onSplit={(leafId, dir) => { focusLeaf(leafId); run(() => splitFocused(dir)); }} …/>` — PanelBar's split button targets its own leaf, so focus it first, then split; one of the panehost tests must pin this order. Breadcrumb shows the **focused** leaf's item (`findLeafOfItem` no longer needed — walk layout for `focusedLeafId`, read its `itemId`). Add the hotkey next to `usePaletteHotkey`: `⌘\` → `run(() => splitFocused("row"))`.

Sweep the renderer for remaining old-API call sites — `grep -rn "activateTab\|splitWithNewTerminal\|allTabs\|findLeafOfTab" apps/desktop/src/renderer/src` — and update each (`CommandPalette.tsx` calls `activateTab` for item navigation → `openItem`; its "split" command if present → `splitFocused`). Delete `TabBar.tsx` and `active-tabs.ts`; fix all imports (`Breadcrumb`, `ItemList` — the latter is rewritten in Task 6 but must compile now: switch its `activeTabIds(layout)` to `new Set(allItems(layout ?? emptyLayout()))` as an interim).

- [ ] **Step 4: Run** — `pnpm vitest run apps/desktop/src/renderer/src/components/panehost.test.tsx` PASS; `pnpm --filter @realm/desktop typecheck` PASS (repo typecheck now green again).

- [ ] **Step 5: Commit** — `feat(desktop)!: panels with PanelBar replace tabs; focused-leaf model`

---

### Task 6: Sidebar — OPEN/SPACE groups, close vs delete

**Files:**
- Rewrite: `apps/desktop/src/renderer/src/components/sidebar/ItemList.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sidebar/SpaceSwiper.tsx` (page body)
- Modify: `apps/desktop/src/renderer/src/components/sidebar/ItemContextMenu.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sidebar/sidebar.test.tsx`

- [ ] **Step 1: Failing tests** — in `sidebar.test.tsx`, following its existing harness:
  - renders `OPEN` and `SPACE` group labels; items in the layout appear under OPEN in layout order; the rest under SPACE (pinned tiles first).
  - clicking a SPACE row calls `openItem(id)` (opens into the focused leaf); clicking an OPEN row focuses the item's existing pane only — never moves it (move is drag-only).
  - the × on an OPEN row calls `closeFromLayout`, not `deleteItem`.
  - SPACE rows show no ×.
  - context menu shows `Close` only for open items (calls `closeFromLayout`) and always shows `Delete` (danger, calls `deleteItem`).
  - during a split (layout with 2 leaves), OPEN rows render `.item-glyph` with the correct quadrant `data-on`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** `ItemList` becomes:

```tsx
export function ItemList({ items, variant }: { items: Item[]; variant: "open" | "space" }) { /* rows as today, but:
  - active detection: variant === "open" && item is in allItems(layout)
  - variant "open": × button → closeFromLayout; quadrant glyph via leafPositionOf(layout, item.id)
  - variant "space": no × button
  - both: click → run(() => openItem(item.id))  */ }
```

`leafPositionOf(layout, itemId): 0|1|2|3|null` — a small pure helper (module-level, unit-tested): index of the item's leaf among the root split's children mapped to quadrants (row split: 0→left half [data-on on cells 0,2], 1→right; col split: top/bottom; nested/complex trees: index modulo 4). Keep it deliberately approximate — it's a glanceable glyph, not a map.

`SpaceSwiper` page body becomes:

```tsx
<SpaceHeader space={sp} />
<div className="space-body">
  {open.length > 0 && <><div className="group-label">Open</div><ItemList items={open} variant="open" /></>}
  <div className="group-label">Space</div>
  {pinned.length > 0 && <PinnedGrid items={pinned} />}
  <ItemList items={unopened} variant="space" />
</div>
<NewItemMenu />
```

where `open` = items in `allItems(layout)` order, `unopened` = the rest (pinned first via `PinnedGrid`, then unpinned rows). `ItemContextMenu`: `Close` (only when open, calls `closeFromLayout`), `Delete` (danger, calls `deleteItem`, replaces old `Close`). Pin/Rename unchanged.

- [ ] **Step 4: Run** — sidebar tests PASS; full `pnpm vitest run apps/desktop` PASS.

- [ ] **Step 5: Commit** — `feat(desktop): sidebar is the open set — OPEN/SPACE groups, close vs delete`

---

### Task 7: Drag-to-split

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/sidebar/ItemList.tsx` (draggable rows)
- Modify: `apps/desktop/src/renderer/src/components/PaneHost.tsx` (drop zones)
- Modify: `apps/desktop/src/renderer/src/App.tsx` (wire `onDropItem` → `openItemAt`)
- Modify: `apps/desktop/src/renderer/src/components/panehost.test.tsx`, `sidebar.test.tsx`

- [ ] **Step 1: Failing tests**
  - PaneHost: with a drag in progress (simulate `dragover` with `dataTransfer` type `application/x-realm-item`), each panel shows `.drop-overlay` with five `.drop-zone`s; `drop` on `[data-edge="right"]` calls `onDropItem(itemId, leafId, "right")`; the zone under the pointer gets `data-hot`.
  - Sidebar: rows set `draggable` and populate `dataTransfer` with the item id on `dragstart`; `data-dragging` while dragging.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** HTML5 DnD, no library. `ItemList` rows: `draggable onDragStart={(e) => { e.dataTransfer.setData("application/x-realm-item", it.id); e.dataTransfer.effectAllowed = "move"; }}`. PaneHost keeps `const [dragging, setDragging] = useState(false)` toggled by window-level `dragstart`/`dragend`/`drop` listeners filtered to the custom type; while dragging, each leaf renders:

```tsx
{dragging && (
  <div className="drop-overlay" style={{ pointerEvents: "auto" }}
    onDragOver={(e) => { if (has(e)) { e.preventDefault(); setHot(zoneAt(e)); } }}
    onDragLeave={() => setHot(null)}
    onDrop={(e) => { const id = e.dataTransfer.getData("application/x-realm-item"); if (id) p.onDropItem?.(id, n.id, zoneAt(e)); setHot(null); }}>
    {(["left","right","top","bottom","center"] as const).map((edge) => (
      <div key={edge} className="drop-zone" data-edge={edge} data-hot={hot === edge || undefined} />
    ))}
  </div>
)}
```

`zoneAt(e)`: pointer position relative to the panel rect → nearest edge if within 32% of it, else `center`. `App` wires `onDropItem={(id, leafId, edge) => run(() => openItemAt(id, leafId, edge))}`.

- [ ] **Step 4: Run — PASS**; also `pnpm dev` and verify by hand: drag a SPACE row onto a panel's right edge → split; onto centre → replace.

- [ ] **Step 5: Commit** — `feat(desktop): drag a sidebar item onto a panel edge to split`

---

## Part C — Panel contents

### Task 8: Session pane — empty state, composer, tool cards

**Files:**
- Create: `apps/desktop/src/renderer/src/panes/session/suggestions.ts`
- Modify: `panes/session/SessionPane.tsx`, `Composer.tsx`, `ToolCard.tsx`, `tool-summary.ts`
- Modify: `panes/session/session-pane.test.tsx`

- [ ] **Step 1: Failing tests** (in `session-pane.test.tsx`, existing harness):
  - empty transcript renders `.empty-title` containing the space name and `.suggestion-chip`s for the session's agent kind; clicking a chip puts its prompt into the composer textarea (not sent).
  - composer permission-mode select has `data-warning` when value is `bypassPermissions`, not otherwise.
  - session meta (in PanelBar, via Task 5's `SessionMeta`) omits the cost element when `costUsd === 0`.
  - `toolSummary` unit block: `exec_command` input `{command, cwd}` summarizes to the command; `apply_patch` `{changes:[{path}]}` to the first path; an ACP call falls back to its name with first-string summary (write exact expectations against `tool-summary.ts`'s real signature — read it first).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**

`suggestions.ts`:

```ts
import type { AgentKind } from "@realm/contracts";
/** Static empty-state prompt starters per agent kind (spec §3): fill the composer, never auto-send. */
export const SUGGESTIONS: Record<AgentKind, { title: string; prompt: string }[]> = {
  claude: [
    { title: "Explore this project", prompt: "Give me a tour of this project: structure, entry points, and how the pieces fit together." },
    { title: "Fix a bug", prompt: "Help me track down a bug. I'll describe the symptom; ask me what you need." },
    { title: "Review my changes", prompt: "Review my uncommitted changes for bugs and style issues." },
  ],
  codex: [
    { title: "Build a feature", prompt: "I want to add a new feature. Let's plan it before writing code." },
    { title: "Explain code", prompt: "Explain what this codebase does and where its core logic lives." },
    { title: "Run the tests", prompt: "Run the test suite and summarize any failures." },
  ],
  "acp:cursor": [
    { title: "Refactor something", prompt: "Suggest the highest-value refactor in this codebase and carry it out." },
    { title: "Write tests", prompt: "Find the least-tested critical module and add tests for it." },
  ],
  "acp:gemini": [
    { title: "Summarize this repo", prompt: "Summarize this repository: purpose, stack, and layout." },
  ],
  fake: [{ title: "Say hello", prompt: "Hello!" }],
};
```

`SessionPane`: the `empty` prop becomes the centered block — agent icon, `<div className="empty-title">What should we work on in <em>{space?.name}</em>?</div>`, and `.suggestions` chips calling a new `onSuggest(prompt)` that sets the composer draft (thread a `draft`/`setDraft` state pair from SessionPane into Composer — Composer's internal `text` state lifts up; keep ⌘↵ behaviour identical). `Composer`: permission select gets `data-warning={session.permissionMode === "bypassPermissions" || undefined}`. `ToolCard`: output `<pre>` gains the `tool-well` class. `tool-summary.ts`: add cases for `exec_command` (input.command), `apply_patch` (first change path), and default-to-name for unknown tools (ACP titles arrive as names already).

- [ ] **Step 4: Run — PASS** (`pnpm vitest run apps/desktop`).

- [ ] **Step 5: Commit** — `feat(desktop): codex-style empty state, composer warning chip, tool wells`

---

### Task 9: Verification pass

**Files:** none (fixes only if found).

- [ ] **Step 1:** `pnpm test` → all green. `pnpm typecheck` → clean. `pnpm build` → success.
- [ ] **Step 2:** Migration proof: run the app against the existing dev home (`pnpm dev`) — pre-Plan-4 spaces must load with each leaf showing its previously-active tab, remaining items in SPACE, nothing lost, no console errors. Then restart once more to prove the *migrated* layout round-trips.
- [ ] **Step 3:** CDP screenshot pass (reuse the session's driver pattern from Plan 3 verification): both `data-mode`s × 3 space accents (violet, green, near-black `#111`), capturing: sidebar with both groups, a 2-panel split, the empty state, a permission card (Codex Plan mode), the composer in `bypassPermissions`. Check: no unreadable text (spot-check `textDim` on `panel` ≥ 4.5:1 — compute, don't eyeball), accent legible for `#111` space colour (the clamp from Task 3).
- [ ] **Step 4:** Manual flows in the running app: open/close from sidebar (close ≠ delete — item returns to SPACE with transcript intact), ⌘\ split + fill from sidebar, drag-to-split all four edges + centre, preset from LayoutMenu, two-finger space swipe, permission card allow/deny, `prefers-reduced-motion` (System Settings → Accessibility) kills the three animations.
- [ ] **Step 5:** Commit any fixes; then use `superpowers:finishing-a-development-branch`.

---

## Self-review notes

- **Spec coverage:** §1 material → Tasks 3–4; §2 structure/migration/splits → Tasks 1, 2, 5, 6, 7; §3 contents → Tasks 5 (meta/cost), 8; §4 motion → Task 4 CSS + reduced-motion; §5 light mode → Task 3 palette + Task 9 screenshots; §6 verification → per-task tests + Task 9. Suggestion chips, warning chip, cost-blank, toolSummary extension all have named tasks.
- **Consistency:** `openItem`/`closeFromLayout`/`deleteItem`/`splitFocused`/`openItemAt`/`focusLeaf` are the only new store actions and are used with those exact names in Tasks 5–7. Contracts exports used later: `allItems`, `findLeafOfItem`, `emptyLayout`, `migrateLayout`.
- **Known risks for the implementer:** (1) `LayoutSchema` preprocess + superRefine typing is fiddly — the cast is annotated; if zod fights, fall back to validating post-migration with a plain `.refine`. (2) The rpc client may or may not zod-parse Space results — Task 2 Step 3 says verify, don't assume. (3) `Composer` state lifting (Task 8) touches ⌘↵ send behaviour — the existing session-pane tests must stay green.

## Post-review follow-ups

Deferred out of the final-review fix batch (`fix(desktop): final review batch — settle animation, focused-row highlight, scrollbars`) — not spec gaps, just not worth blocking that commit on:

- Draggable pinned tiles (reordering the `PinnedGrid` grid is currently not supported).
- Preset seeding order: should `gridPreset` seed open items before empty leaves ("open-items-first")? Needs a decision, not just an implementation.
- Fake-timer the three debounce-gate store tests (the ones that currently wait out `PERSIST_DEBOUNCE_MS` for real) so the suite doesn't carry that real time cost.
- Silence the `NewSessionSheet` `act()` warning surfaced in test output.
- Spec-doc updates to reflect what shipped: accent usage broadened beyond the original spec's scope, pane title now 12px, and active-row highlighting now means "the focused pane" rather than "every open row."
- Task 2's table above should gain a note that `openItem` focuses the item's existing pane (no layout change) when the item is already open — the current row only documents the "not yet open" path.
