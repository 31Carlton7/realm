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
