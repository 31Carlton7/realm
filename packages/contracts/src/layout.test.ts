import { describe, expect, it } from "vitest";
import {
  emptyLayout, addTab, splitLeaf, removeTab, findLeafOfTab, allTabs, gridPreset, setActiveTab,
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
});
