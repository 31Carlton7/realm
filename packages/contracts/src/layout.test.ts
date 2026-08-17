import { describe, expect, it } from "vitest";
import {
  emptyLayout, addTab, splitLeaf, removeTab, findLeafOfTab, allTabs, gridPreset, setActiveTab,
  LayoutSchema, type Layout,
} from "./layout";

describe("layout ops", () => {
  it("emptyLayout is a single empty leaf", () => {
    const l = emptyLayout();
    expect(l.type).toBe("leaf");
    expect(allTabs(l)).toEqual([]);
  });

  it("addTab puts tab in target leaf and activates it", () => {
    const l = emptyLayout();
    const l2 = addTab(l, l.id, "A");
    expect(allTabs(l2)).toEqual(["A"]);
    expect(findLeafOfTab(l2, "A")?.activeTab).toBe("A");
  });

  it("addTab with no leafId uses first leaf", () => {
    const l2 = addTab(emptyLayout(), null, "A");
    expect(allTabs(l2)).toEqual(["A"]);
  });

  it("splitLeaf creates a split with old leaf and new leaf holding new tab", () => {
    const l = addTab(emptyLayout(), null, "A");
    const l2 = splitLeaf(l, l.id, "row", "B");
    expect(l2.type).toBe("split");
    if (l2.type !== "split") throw new Error();
    expect(l2.dir).toBe("row");
    expect(l2.children).toHaveLength(2);
    expect(l2.sizes).toEqual([50, 50]);
    expect(allTabs(l2)).toEqual(["A", "B"]);
  });

  it("removeTab removes tab; empty leaves collapse; single-child splits unwrap", () => {
    const l = addTab(emptyLayout(), null, "A");
    const l2 = splitLeaf(l, l.id, "row", "B");
    const l3 = removeTab(l2, "B");
    expect(l3.type).toBe("leaf");
    expect(allTabs(l3)).toEqual(["A"]);
  });

  it("removeTab never removes the last leaf", () => {
    const l = addTab(emptyLayout(), null, "A");
    const l2 = removeTab(l, "A");
    expect(l2.type).toBe("leaf");
    expect(allTabs(l2)).toEqual([]);
  });

  it("removeTab moves activeTab to a neighbor", () => {
    let l = addTab(emptyLayout(), null, "A");
    l = addTab(l, null, "B");
    l = removeTab(l, "B");
    expect(findLeafOfTab(l, "A")?.activeTab).toBe("A");
  });

  it("setActiveTab activates in the containing leaf", () => {
    let l = addTab(emptyLayout(), null, "A");
    l = addTab(l, null, "B");
    l = setActiveTab(l, "A");
    expect(findLeafOfTab(l, "A")?.activeTab).toBe("A");
  });

  it("gridPreset 2x2 distributes items across 4 leaves", () => {
    const l = gridPreset("grid-2x2", ["A", "B", "C", "D", "E"]);
    expect(l.type).toBe("split");
    if (l.type !== "split") throw new Error();
    expect(l.dir).toBe("col");
    expect(l.children).toHaveLength(2);
    // allTabs walks the tree in order, so the round-robin extra ("E") follows "A"
    expect(allTabs(l)).toEqual(["A", "E", "B", "C", "D"]);
    // 5th item lands in the first leaf as an extra tab
    expect(findLeafOfTab(l, "E")?.tabs).toEqual(["A", "E"]);
  });

  it("gridPreset 1-up puts everything in one leaf", () => {
    const l = gridPreset("one", ["A", "B"]);
    expect(l.type).toBe("leaf");
    expect(allTabs(l)).toEqual(["A", "B"]);
  });

  it("removeTab of the last tab preserves the original leaf id", () => {
    const l = addTab(emptyLayout(), null, "A");
    const l2 = removeTab(l, "A");
    expect(l2.type).toBe("leaf");
    expect(l2.id).toBe(l.id);
    expect(allTabs(l2)).toEqual([]);
  });

  it("removeTab of the last tab in a split preserves the first leaf id", () => {
    const l = addTab(emptyLayout(), null, "A");
    const l2 = splitLeaf(l, l.id, "row", "B");
    const l3 = removeTab(removeTab(l2, "B"), "A");
    expect(l3.type).toBe("leaf");
    expect(l3.id).toBe(l.id);
  });

  it("removeTab of a middle active tab activates the right neighbor", () => {
    let l = addTab(emptyLayout(), null, "A");
    l = addTab(l, null, "B");
    l = addTab(l, null, "C");
    l = setActiveTab(l, "B");
    l = removeTab(l, "B");
    expect(allTabs(l)).toEqual(["A", "C"]);
    expect(findLeafOfTab(l, "A")?.activeTab).toBe("C");
  });

  it("removeTab inside a nested row-in-col split renormalizes that split's sizes", () => {
    const leaf = (id: string, tab: string): Layout => ({ type: "leaf", id, tabs: [tab], activeTab: tab });
    const l: Layout = {
      type: "split", id: "col", dir: "col", sizes: [40, 60],
      children: [
        { type: "split", id: "row", dir: "row", sizes: [20, 30, 50], children: [leaf("la", "A"), leaf("lb", "B"), leaf("lc", "C")] },
        leaf("ld", "D"),
      ],
    };
    const l2 = removeTab(l, "B");
    if (l2.type !== "split") throw new Error();
    expect(l2.sizes).toEqual([40, 60]);
    const row = l2.children[0]!;
    if (row.type !== "split") throw new Error();
    expect(row.children.map((c) => c.id)).toEqual(["la", "lc"]);
    expect(row.sizes[0]).toBeCloseTo((20 / 70) * 100);
    expect(row.sizes[1]).toBeCloseTo((50 / 70) * 100);
    expect(row.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });

  it("addTab moves a tab that already lives in another leaf", () => {
    const l = addTab(emptyLayout(), null, "A");
    const l2 = splitLeaf(l, l.id, "row", "B");
    const target = findLeafOfTab(l2, "B")!;
    const l3 = addTab(l2, target.id, "A");
    expect(allTabs(l3)).toEqual(["B", "A"]);
    expect(allTabs(l3).filter((t) => t === "A")).toHaveLength(1);
    expect(findLeafOfTab(l3, "A")?.id).toBe(target.id);
    expect(findLeafOfTab(l3, "A")?.activeTab).toBe("A");
    expect(findLeafOfTab(l3, "A")?.tabs).toEqual(["B", "A"]);
  });

  it("addTab of a tab already in the target leaf just activates it", () => {
    let l = addTab(emptyLayout(), null, "A");
    l = addTab(l, null, "B");
    const l2 = addTab(l, null, "A");
    expect(allTabs(l2)).toEqual(["A", "B"]);
    expect(findLeafOfTab(l2, "A")?.activeTab).toBe("A");
  });

  it("gridPreset with fewer items than leaves leaves the extra leaves empty", () => {
    const l = gridPreset("two-col", ["A"]);
    if (l.type !== "split") throw new Error();
    expect(l.children).toHaveLength(2);
    expect(allTabs(l)).toEqual(["A"]);
    const second = l.children[1]!;
    if (second.type !== "leaf") throw new Error();
    expect(second.tabs).toEqual([]);
    expect(second.activeTab).toBeNull();
  });
});

describe("LayoutSchema", () => {
  it("rejects a split with fewer than 2 children", () => {
    const bad = { type: "split", id: "s", dir: "row", sizes: [100],
      children: [{ type: "leaf", id: "l", tabs: [], activeTab: null }] };
    expect(LayoutSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a split whose sizes length differs from children length", () => {
    const bad = { type: "split", id: "s", dir: "row", sizes: [50, 50, 0], children: [
      { type: "leaf", id: "a", tabs: [], activeTab: null },
      { type: "leaf", id: "b", tabs: [], activeTab: null },
    ] };
    expect(LayoutSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an invalid split nested deep inside a valid tree", () => {
    const bad = { type: "split", id: "s", dir: "col", sizes: [50, 50], children: [
      { type: "leaf", id: "a", tabs: [], activeTab: null },
      { type: "split", id: "inner", dir: "row", sizes: [100], children: [
        { type: "leaf", id: "b", tabs: [], activeTab: null },
      ] },
    ] };
    expect(LayoutSchema.safeParse(bad).success).toBe(false);
  });

  it("round-trips a valid nested tree", () => {
    const l = gridPreset("grid-3x3", ["A", "B", "C", "D"]);
    const parsed = LayoutSchema.parse(JSON.parse(JSON.stringify(l)));
    expect(parsed).toEqual(l);
  });
});
