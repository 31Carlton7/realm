import { describe, expect, it } from "vitest";
import {
  LayoutSchema, allItems, closeItem, emptyLayout, findLeafOfItem, firstLeaf,
  equalSizes, equalizeSplit, gridPreset, migrateLayout, openItem, splitLeaf, updateSizes,
  type Layout, type LayoutLeaf, type LayoutSplit,
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
  it("falls back to the first tab when activeTab is not among the tabs", () => {
    expect(migrateLayout({ type: "leaf", id: "a", tabs: ["t1", "t2"], activeTab: "zz" }))
      .toEqual({ type: "leaf", id: "a", itemId: "t1" });
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
  it("LayoutSchema rejects a split with 1 child after legacy migration collapses shapes", () => {
    // A legacy split whose only child is itself a legacy leaf: migration converts the leaf,
    // but the split still has just 1 child post-migration, which must still fail validation.
    expect(() => LayoutSchema.parse({
      type: "split", id: "s", dir: "row", sizes: [100],
      children: [{ type: "leaf", id: "a", tabs: ["t1"], activeTab: "t1" }],
    })).toThrow();
  });
  it("LayoutSchema rejects a split whose sizes.length mismatches children.length, independent of the children>=2 check", () => {
    // Two children (satisfies the >=2 invariant) but only one size — isolates the sizes check from
    // the children-count check, which the garbage tests above always trip at the same time.
    expect(() => LayoutSchema.parse({
      type: "split", id: "s", dir: "row", sizes: [100],
      children: [leaf("x"), leaf("y")],
    })).toThrow(/sizes/i);
  });
  it("dedupes two legacy leaves that migrated to the same active tab (first depth-first occurrence wins)", () => {
    // Realistic persisted data: two independent legacy leaves can each have had the same
    // activeTab. Migration alone would produce a layout with the same itemId open in two
    // leaves, breaking the uniqueness every op in this file assumes — migrateLayout must
    // dedupe as part of normalization, not leave it to callers.
    const legacy = {
      type: "split", id: "s", dir: "row", sizes: [50, 50],
      children: [
        { type: "leaf", id: "a", tabs: ["t1", "t2"], activeTab: "t1" },
        { type: "leaf", id: "b", tabs: ["t1", "t3"], activeTab: "t1" },
      ],
    };
    const out = migrateLayout(legacy) as { children: LayoutLeaf[] };
    expect(out.children.map((c) => c.itemId)).toEqual(["t1", null]);
  });
  it("LayoutSchema.parse of that same legacy input yields no duplicate items", () => {
    const legacy = {
      type: "split", id: "s", dir: "row", sizes: [50, 50],
      children: [
        { type: "leaf", id: "a", tabs: ["t1", "t2"], activeTab: "t1" },
        { type: "leaf", id: "b", tabs: ["t1", "t3"], activeTab: "t1" },
      ],
    };
    const parsed = LayoutSchema.parse(legacy);
    expect(allItems(parsed)).toEqual(["t1"]);
  });
  it("LayoutSchema.parse also dedupes hand-built new-shape input with duplicate itemIds", () => {
    // Not just a migration artifact: preprocess runs on every parse, new-shape input included,
    // so a duplicate that bypassed the legacy path (e.g. a bug, or hand-constructed JSON) is
    // still caught at the parse boundary.
    const dup = {
      type: "split", id: "s", dir: "row", sizes: [50, 50],
      children: [
        { type: "leaf", id: "a", itemId: "x" },
        { type: "leaf", id: "b", itemId: "x" },
      ],
    };
    const parsed = LayoutSchema.parse(dup) as { children: LayoutLeaf[] };
    expect(parsed.children.map((c) => c.itemId)).toEqual(["x", null]);
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
  it("opening an item into the leaf it already occupies is a true no-op (sibling survives)", () => {
    // Without the existing?.id === target0 short-circuit, this would route through
    // closeItem (unwrapping the 2-child split down to leaf "b") and then overwrite that
    // surviving leaf's itemId with "a" — silently destroying "b".
    const l = row([leaf("a"), leaf("b")]);
    const out = openItem(l, "L-a", "a");
    expect(allItems(out)).toEqual(["a", "b"]);
    expect(findLeafOfItem(out, "b")?.id).toBe("L-b");
  });
  it("opening into an unknown/null leaf targets the first leaf", () => {
    const l = row([leaf("a"), leaf("b")]);
    expect(allItems(openItem(l, null, "c"))).toEqual(["c", "b"]);
    expect(allItems(openItem(l, "nope", "c"))).toEqual(["c", "b"]);
  });
  it("opening an item already at the first leaf with an unknown target leafId is a no-op (sibling survives)", () => {
    // Pins openItem's validation of the caller-supplied leafId (hasLeaf(l, leafId)). Without it,
    // target0 would be the bogus id itself instead of falling back to the first leaf. Since "a"
    // is already at the first leaf, the no-op guard wouldn't fire (existing.id !== bogus target0),
    // so closeItem+mapLeaves would proceed and overwrite the sibling leaf with "a", destroying "b".
    const l = row([leaf("a"), leaf("b")]);
    const out = openItem(l, "totally-unknown-leaf-id", "a");
    expect(allItems(out)).toEqual(["a", "b"]);
  });
  it("openItem's target re-check protects a hand-built duplicate-item layout from losing the item entirely", () => {
    // LayoutSchema's preprocess dedupes on every *parse* (see migrateLayout tests above), but a
    // Layout value can also be constructed directly in memory without ever passing through
    // LayoutSchema.parse — e.g. built by hand here, or by any future code path that mutates a
    // Layout object without re-validating it. Such a tree is a legitimate, constructible input to
    // openItem regardless of how it came to exist. Here "x" is open in BOTH leaves; findLeafOfItem
    // finds the first ("LA"), so the no-op guard doesn't fire when targeting the second ("LB").
    // closeItem's prune matches by itemId, not leaf id, so it removes EVERY leaf holding "x" —
    // including the target "LB" — leaving `base` a single leaf with neither original id. Without
    // the `hasLeaf(base, target0)` re-check, mapLeaves would look for a leaf id ("LB") that no
    // longer exists and silently drop the item instead of reinserting it via the first-leaf fallback.
    const dup: Layout = {
      type: "split", id: "S-dup", dir: "row", sizes: [50, 50],
      children: [
        { type: "leaf", id: "LA", itemId: "x" },
        { type: "leaf", id: "LB", itemId: "x" },
      ],
    };
    const out = openItem(dup, "LB", "x");
    expect(allItems(out)).toEqual(["x"]);
  });
  it("moving an item into a leaf whose own pruning collapses the target's sibling structure", () => {
    // Three leaves in a row: a, b, c. Move "c" into leaf "a": closeItem prunes c's leaf, which
    // collapses the row down to a 2-child split (a, b) — target "L-a" must still be found post-prune.
    const l = row([leaf("a"), leaf("b"), leaf("c")], [33, 33, 34]);
    const out = openItem(l, "L-a", "c");
    expect(allItems(out)).toEqual(["c", "b"]);
    const kids = (out as { children: LayoutLeaf[] }).children;
    expect(kids.map((k) => k.itemId)).toEqual(["c", "b"]);
  });
  it("moving an item into a leaf that itself gets pruned away by the move falls back to the first leaf", () => {
    // Nested: outer row of [leaf a, split[leaf b, leaf c]]. Move "c" into leaf "b": closing c
    // from the inner split collapses it to leaf b directly, changing the tree shape but "L-b" survives.
    const inner = row([leaf("b"), leaf("c")], [40, 60]);
    const l = row([leaf("a"), inner], [50, 50]);
    const out = openItem(l, "L-b", "c");
    expect(allItems(out)).toEqual(["a", "c"]);
    expect(findLeafOfItem(out, "c")?.id).toBe("L-b");
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
  it("closeItem renormalizes sizes of the surviving split after pruning a leaf", () => {
    const l = row([leaf("a"), leaf("b"), leaf("c")], [20, 30, 50]);
    const out = closeItem(l, "b") as { type: "split"; sizes: number[]; children: LayoutLeaf[] };
    expect(out.type).toBe("split");
    expect(out.children.map((c) => c.itemId)).toEqual(["a", "c"]);
    // Original a:c ratio was 20:50 -> renormalized to sum to 100
    expect(out.sizes[0]).toBeCloseTo((20 / 70) * 100, 5);
    expect(out.sizes[1]).toBeCloseTo((50 / 70) * 100, 5);
    expect(out.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(100, 5);
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
    const kids = (out as { children: LayoutLeaf[] }).children;
    expect(kids.map((c) => c.itemId)).toEqual(["a", "b"]);
    expect((out as { dir: string }).dir).toBe("col");
  });

  it("`before` puts the new leaf on the near side of a fresh split", () => {
    const out = splitLeaf(leaf("a"), "L-a", "row", "b", true) as LayoutSplit;
    expect(out.children.map((c) => (c as LayoutLeaf).itemId)).toEqual(["b", "a"]);
    expect(out.sizes).toEqual([50, 50]);
  });

  it("a leaf in a same-direction split gains a SIBLING, and the split re-balances to equal", () => {
    // The headline case: two panes side by side, a third dropped on the right edge of the right one.
    // Nesting would read 50/25/25; growing the row reads 33/33/33.
    const out = splitLeaf(row([leaf("a"), leaf("b")]), "L-b", "row", "c") as LayoutSplit;
    expect(out.id).toBe("S1"); // the same split, grown — not a new one wrapping a child
    expect(out.children).toHaveLength(3);
    expect(out.children.every((c) => c.type === "leaf")).toBe(true); // flat, no nesting
    expect(out.children.map((c) => (c as LayoutLeaf).itemId)).toEqual(["a", "b", "c"]);
    out.sizes.forEach((sz) => expect(sz).toBeCloseTo(100 / 3, 5));
  });

  it("re-balances a dragged split too: the sibling arrives equal, not into the leftover", () => {
    const dragged = row([leaf("a"), leaf("b")], [80, 20]);
    const out = splitLeaf(dragged, "L-a", "row", "c", true) as LayoutSplit;
    expect(out.children.map((c) => (c as LayoutLeaf).itemId)).toEqual(["c", "a", "b"]);
    out.sizes.forEach((sz) => expect(sz).toBeCloseTo(100 / 3, 5));
  });

  it("a leaf in a PERPENDICULAR split still nests, 50/50, leaving the outer split alone", () => {
    const out = splitLeaf(row([leaf("a"), leaf("b")]), "L-b", "col", "c") as LayoutSplit;
    expect(out.dir).toBe("row");
    expect(out.sizes).toEqual([50, 50]); // outer shares untouched
    const nested = out.children[1] as LayoutSplit;
    expect(nested.type).toBe("split");
    expect(nested.dir).toBe("col");
    expect(nested.sizes).toEqual([50, 50]);
    expect(nested.children.map((c) => (c as LayoutLeaf).itemId)).toEqual(["b", "c"]);
  });

  it("grows the split that DIRECTLY holds the leaf, not an equally-directed ancestor", () => {
    const l: Layout = { type: "split", id: "outer", dir: "row", sizes: [50, 50], children: [
      leaf("a"),
      { type: "split", id: "inner", dir: "row", sizes: [50, 50], children: [leaf("b"), leaf("c")] },
    ] };
    const out = splitLeaf(l, "L-c", "row", "d") as LayoutSplit;
    expect(out.id).toBe("outer");
    expect(out.sizes).toEqual([50, 50]); // the ancestor is not re-balanced
    const inner = out.children[1] as LayoutSplit;
    expect(inner.children.map((c) => (c as LayoutLeaf).itemId)).toEqual(["b", "c", "d"]);
    inner.sizes.forEach((sz) => expect(sz).toBeCloseTo(100 / 3, 5));
  });

  it("three drops onto the same growing row land in order, all equal", () => {
    let l: Layout = leaf("a");
    l = splitLeaf(l, "L-a", "row", "b");
    l = splitLeaf(l, findLeafOfItem(l, "b")!.id, "row", "c");
    l = splitLeaf(l, findLeafOfItem(l, "c")!.id, "row", "d");
    const out = l as LayoutSplit;
    expect(out.children).toHaveLength(4);
    expect(allItems(out)).toEqual(["a", "b", "c", "d"]);
    expect(out.sizes).toEqual([25, 25, 25, 25]);
  });

  it("the split result always stays schema-valid (sizes match children, sum to 100)", () => {
    const out = splitLeaf(row([leaf("a"), leaf("b")]), "L-b", "row", "c") as LayoutSplit;
    expect(() => LayoutSchema.parse(out)).not.toThrow();
    expect(out.sizes).toHaveLength(out.children.length);
    expect(out.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(100, 5);
  });
});

describe("equalizeSplit", () => {
  it("equalSizes splits 100 evenly", () => {
    expect(equalSizes(2)).toEqual([50, 50]);
    expect(equalSizes(4)).toEqual([25, 25, 25, 25]);
    expect(equalSizes(3).reduce((x, y) => x + y, 0)).toBeCloseTo(100, 5);
  });

  it("puts a dragged split back on equal shares", () => {
    const out = equalizeSplit(row([leaf("a"), leaf("b"), leaf("c")], [60, 25, 15]), "S1") as LayoutSplit;
    out.sizes.forEach((sz) => expect(sz).toBeCloseTo(100 / 3, 5));
    expect(out.children).toEqual([leaf("a"), leaf("b"), leaf("c")]); // children untouched, only sizes moved
  });

  it("returns the very same object when the split is already equal — an unmodified divider is a no-op", () => {
    const l = row([leaf("a"), leaf("b")]);
    expect(equalizeSplit(l, "S1")).toBe(l);
  });

  it("returns the very same object when no split carries that id", () => {
    const l = row([leaf("a"), leaf("b")], [70, 30]);
    expect(equalizeSplit(l, "nope")).toBe(l);
    const bare = leaf("a");
    expect(equalizeSplit(bare, "S1")).toBe(bare);
  });

  it("touches only the named split, leaving dragged siblings and ancestors alone", () => {
    const l: Layout = { type: "split", id: "outer", dir: "row", sizes: [70, 30], children: [
      { type: "split", id: "inner", dir: "col", sizes: [90, 10], children: [leaf("a"), leaf("b")] },
      { type: "split", id: "other", dir: "col", sizes: [80, 20], children: [leaf("c"), leaf("d")] },
    ] };
    const out = equalizeSplit(l, "inner") as LayoutSplit;
    expect(out.sizes).toEqual([70, 30]); // ancestor untouched
    expect((out.children[0] as LayoutSplit).sizes).toEqual([50, 50]);
    expect(out.children[1]).toBe((l as LayoutSplit).children[1]); // untouched subtree is not even re-created
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
  it("three-col produces a single row split with exactly 3 leaf children", () => {
    const out = gridPreset("three-col", ["a", "b", "c"]) as LayoutSplit;
    expect(out.type).toBe("split");
    expect(out.dir).toBe("row");
    expect(out.children).toHaveLength(3);
    expect(out.children.every((c) => c.type === "leaf")).toBe(true);
    expect(out.children.map((c) => (c as LayoutLeaf).itemId)).toEqual(["a", "b", "c"]);
  });
  it("grid-3x3 produces a col split of 3 row splits, each with 3 leaf children", () => {
    const out = gridPreset("grid-3x3", ["a"]) as LayoutSplit;
    expect(out.type).toBe("split");
    expect(out.dir).toBe("col");
    expect(out.children).toHaveLength(3);
    out.children.forEach((rowNode) => {
      expect(rowNode.type).toBe("split");
      const r = rowNode as LayoutSplit;
      expect(r.dir).toBe("row");
      expect(r.children).toHaveLength(3);
      r.children.forEach((c) => expect(c.type).toBe("leaf"));
    });
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
