import { describe, expect, it } from "vitest";
import {
  PANEL_MIN_WIDTH, PANE_DIVIDER, PANE_MIN, besidePane, clampPanelShare, columnOf, mainOf, mainRoom, minRoomOf, normalizeView,
  openBesideInView, ownerOfTab, panelWidthIn, parseStoredView, primaryLeaves, pruneView, rememberSidePane, showInView,
  splitEmptyInView, splitFits, viewFromGroups, withoutItem, type WindowView,
} from "./view";
import {
  LayoutSchema, allItems, closeItem, findLeaf, findLeafOfItem, findPanel, moveTab, openInSidePane, openItem, sideTabsOf, tabOwner,
  updateSizes, type Layout, type LayoutLeaf, type LayoutSplit,
} from "./layout";
import { SpaceGroupsSchema, type SpaceGroups } from "./groups";

const ULID = (n: number) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(n).padStart(2, "0")}`;
const leaf = (itemId: string | null, id = `L-${itemId ?? "empty"}`): LayoutLeaf => ({ type: "leaf", id, itemId });
/** A Plan 26/27 side pane: one strip per session, its owner said once for every tab. */
const sidePane = (owner: string, tabs: string[], itemId = tabs[0]!, id = `T-${owner}`): LayoutLeaf => ({ type: "leaf", id, itemId, tabs, owner });
/** Today's panel: one strip, every tab's session said per tab. */
const panelLeaf = (owners: [string, string][], itemId = owners[0]![0], id = "P"): LayoutLeaf =>
  ({ type: "leaf", id, itemId, tabs: owners.map(([t]) => t), owners: Object.fromEntries(owners) });
const split = (id: string, dir: "row" | "col", children: Layout[], sizes = children.map(() => 100 / children.length)): Layout =>
  ({ type: "split", id, dir, sizes, children });
const view = (layout: Layout, over: Partial<WindowView> = {}): WindowView => ({ layout, zoomedLeafId: null, sidePanes: {}, ...over });

/** The main panes, in reading order. */
const panes = (v: WindowView): string[] => primaryLeaves(v.layout).map((p) => p.itemId ?? "·");
/** The panel's strip as `session:tab`, in order. */
const strip = (v: WindowView): string[] => {
  const p = findPanel(v.layout);
  return p ? p.tabs!.map((t) => `${tabOwner(p, t)}:${t}`) : [];
};
const showing = (v: WindowView): string | null => findPanel(v.layout)?.itemId ?? null;

function leaves(l: Layout): LayoutLeaf[] { return l.type === "leaf" ? [l] : l.children.flatMap(leaves); }
function splits(l: Layout): LayoutSplit[] { return l.type === "leaf" ? [] : [l, ...l.children.flatMap(splits)]; }

/**
 * Every invariant of the one shape, asserted at once: what any normalized view must be, whatever
 * edits made it.
 */
function expectCanonical(v: WindowView) {
  const l = v.layout;
  const all = allItems(l);
  expect(new Set(all).size, "an item is on screen once").toBe(all.length);
  for (const s of splits(l)) {
    expect(s.children.length, "a split has two children at least").toBeGreaterThanOrEqual(2);
    expect(s.sizes).toHaveLength(s.children.length);
  }
  const strips = leaves(l).filter((x) => x.tabs);
  expect(strips.length, "one panel at most").toBeLessThanOrEqual(1);
  const panel = strips[0];
  const mains = primaryLeaves(l);
  if (panel) {
    expect(l.type, "the panel is beside the main panes, at the root").toBe("split");
    const root = l as LayoutSplit;
    expect(root.dir).toBe("row");
    expect(root.children).toHaveLength(2);
    expect(root.children[1], "the panel is the root's last child").toBe(panel);
    expect(leaves(root.children[0]!).some((x) => x.tabs), "never stacked under or split into the main panes").toBe(false);
    const share = clampPanelShare(v.panelShare) * 100;
    expect(root.sizes[1]).toBeCloseTo(share);
    expect(root.sizes[0]).toBeCloseTo(100 - share);
    expect(panel.tabs!.length).toBeGreaterThan(0);
    expect(panel.tabs!).toContain(panel.itemId);
    expect(panel.owner, "per tab, never per strip").toBeUndefined();
    const order = mains.map((p) => p.itemId);
    const ranks = panel.tabs!.map((t) => {
      const owner = panel.owners?.[t];
      expect(owner && order.includes(owner), `${t} belongs to a session on screen`).toBe(true);
      return order.indexOf(owner!);
    });
    expect(ranks, "a run per session, in the order its pane is read").toEqual([...ranks].sort((a, b) => a - b));
    expect(Object.keys(panel.owners!).sort()).toEqual([...panel.tabs!].sort());
  }
  const onScreen = new Set(mains.map((p) => p.itemId));
  for (const owner of Object.keys(v.sidePanes)) {
    expect(onScreen.has(owner), `${owner}'s tabs wait only while it is off screen`).toBe(false);
    expect(v.sidePanes[owner]!.tabs).toContain(v.sidePanes[owner]!.itemId);
  }
  if (v.zoomedLeafId) expect(findLeaf(l, v.zoomedLeafId)).not.toBeNull();
  expect(normalizeView(v), "normalizing again changes nothing").toBe(v);
}

describe("the main panes of a view", () => {
  it("are the leaves that are not the panel, and the panel stands for the pane of the session whose tab shows", () => {
    const l = split("R", "row", [split("M", "row", [leaf("A"), leaf("B")]), panelLeaf([["x", "A"], ["y", "B"]], "y")]);
    expect(primaryLeaves(l).map((p) => p.itemId)).toEqual(["A", "B"]);
    expect(columnOf(l, "P")?.itemId).toBe("B");
    expect(columnOf(l, "L-A")?.itemId).toBe("A");
    expect(columnOf(l, "nope")).toBeNull();
    expect(ownerOfTab(l, "x")).toBe("A");
    expect(ownerOfTab(l, "A")).toBeNull();
  });
});

describe("normalizeView — any number of panes", () => {
  it("keeps every pane as it was made: four in a row, a column of three, a grid", () => {
    const four = view(split("R", "row", [leaf("A"), leaf("B"), leaf("C"), leaf("D")]));
    expect(normalizeView(four)).toBe(four);
    const stack = view(split("R", "col", [leaf("A"), leaf("B"), leaf("C")]));
    expect(normalizeView(stack)).toBe(stack);
    const grid = view(split("R", "col", [split("r1", "row", [leaf("A"), leaf("B")]), split("r2", "row", [leaf("C"), leaf("D")])]));
    expect(normalizeView(grid)).toBe(grid);
    expectCanonical(grid);
  });

  it("keeps a dragged divider where it was", () => {
    const resized = updateSizes(split("R", "row", [leaf("A"), leaf("B"), leaf("C")]), "R", [50, 30, 20]);
    expect(normalizeView(view(resized)).layout).toMatchObject({ id: "R", sizes: [50, 30, 20] });
  });

  it("ends a pane focus whose pane has gone, and keeps one that is there", () => {
    expect(normalizeView(view(leaf("A"), { zoomedLeafId: "L-B" })).zoomedLeafId).toBeNull();
    expect(normalizeView(view(split("R", "row", [leaf("A"), leaf("B"), leaf("C")]), { zoomedLeafId: "L-C" })).zoomedLeafId).toBe("L-C");
  });
});

describe("normalizeView — one panel", () => {
  it("folds a strip left anywhere in the tree into the one panel at the root's right", () => {
    // `openItem` and a drop can leave a strip deep in the main panes' tree; it is never drawn there.
    const deep = split("R", "col", [split("r1", "row", [leaf("A"), sidePane("A", ["x"])]), leaf("B")]);
    const v = normalizeView(view(deep));
    expectCanonical(v);
    expect(panes(v)).toEqual(["A", "B"]);
    expect(strip(v)).toEqual(["A:x"]);
    // The main panes' tree keeps the nodes it had, so its own dividers stay where they were.
    expect((v.layout as LayoutSplit).children[0]).toMatchObject({ id: "R", dir: "col" });
  });

  it("is half the main area by default, and its share is the window's to remember", () => {
    const v = normalizeView(view(split("R", "row", [leaf("A"), sidePane("A", ["x"])])));
    expect((v.layout as LayoutSplit).sizes).toEqual([50, 50]);
    const wide = normalizeView({ ...v, panelShare: 0.3 });
    expect((wide.layout as LayoutSplit).sizes[1]).toBeCloseTo(30);
    expect(wide.panelShare).toBe(0.3);
    expectCanonical(wide);
    expect(clampPanelShare(2)).toBe(0.9);
    expect(clampPanelShare(Number.NaN)).toBe(0.5);
  });

  it("returns the very same view when it is already in shape — a write that changes nothing is not one", () => {
    const v = normalizeView(view(split("R", "row", [leaf("A"), leaf("B"), sidePane("B", ["y"])])));
    expect(normalizeView(v)).toBe(v);
    expect(normalizeView({ ...v })).toEqual(v);
  });

  it("goes when its last tab does: the main panes take the window again", () => {
    const v = normalizeView(view(split("R", "row", [leaf("A"), panelLeaf([["x", "A"]])])));
    const gone = normalizeView({ ...v, layout: closeItem(v.layout, "x") });
    expect(gone.layout).toEqual(leaf("A"));
    expectCanonical(gone);
  });
});

describe("normalizeView — tabs merge and part by owner", () => {
  const ab = () => split("M", "row", [leaf("A"), leaf("B")]);

  it("merges every session's strip into one, a run each, in the order the panes are read", () => {
    // THE MUTANT: keep a strip per session. Two sessions with tabs would be four columns again.
    const v = normalizeView(view(split("R", "row", [split("C1", "row", [leaf("A"), sidePane("A", ["a1", "a2"])]),
      split("C2", "row", [leaf("B"), sidePane("B", ["b1"])])])));
    expectCanonical(v);
    expect(panes(v)).toEqual(["A", "B"]);
    expect(strip(v)).toEqual(["A:a1", "A:a2", "B:b1"]);
  });

  it("gives the session in the fourth pane its run as much as the first's", () => {
    const grid = split("M", "col", [split("r1", "row", [leaf("A"), leaf("B")]), split("r2", "row", [leaf("C"), leaf("D")])]);
    const v = normalizeView(view(split("R", "row", [grid, panelLeaf([["d1", "D"], ["a1", "A"], ["c1", "C"]], "d1")])));
    expect(strip(v)).toEqual(["A:a1", "C:c1", "D:d1"]);
    expect(showing(v)).toBe("d1");
    expect(v.sidePanes).toEqual({});
    expectCanonical(v);
  });

  it("puts a run back in reading order when the panes it follows move", () => {
    const tangled = view(split("R", "row", [split("M", "row", [leaf("B"), leaf("A")]), panelLeaf([["a1", "A"], ["b1", "B"], ["a2", "A"]])]));
    const v = normalizeView(tangled);
    expect(strip(v)).toEqual(["B:b1", "A:a1", "A:a2"]);
    expectCanonical(v);
  });

  it("a session leaving the screen takes its run with it, and brings it back when it returns", () => {
    // THE MUTANT: drop the run instead of remembering it. Showing another session in A's place would
    // lose the browser A's agent was driving, and A would come back with nothing beside it.
    const both = normalizeView(view(split("R", "row", [ab(), panelLeaf([["a1", "A"], ["a2", "A"], ["b1", "B"]], "a2")])));
    const gone = normalizeView({ ...both, layout: showInView(both.layout, "L-A", "C") });
    expect(panes(gone)).toEqual(["C", "B"]);
    expect(strip(gone)).toEqual(["B:b1"]);
    expect(gone.sidePanes).toEqual({ A: { tabs: ["a1", "a2"], itemId: "a2" } });
    expectCanonical(gone);
    const back = normalizeView({ ...gone, layout: showInView(gone.layout, "L-A", "A") });
    expect(panes(back)).toEqual(["A", "B"]);
    expect(strip(back)).toEqual(["A:a1", "A:a2", "B:b1"]);
    expect(back.sidePanes).toEqual({});
    expectCanonical(back);
  });

  it("a session joining the split brings its run into the strip, beside the tabs already there", () => {
    const one = normalizeView(view(split("R", "row", [leaf("A"), panelLeaf([["a1", "A"]])]), { sidePanes: { B: { tabs: ["b1", "b2"], itemId: "b2" } } }));
    const joined = normalizeView({ ...one, layout: openBesideInView(one.layout, "L-A", "B", "right") });
    expect(panes(joined)).toEqual(["A", "B"]);
    expect(strip(joined)).toEqual(["A:a1", "B:b1", "B:b2"]);
    // What the person was looking at stays: a merge never takes the panel away from them.
    expect(showing(joined)).toBe("a1");
    expectCanonical(joined);
  });

  it("shows what the session coming back had showing when the tab on screen leaves with its own", () => {
    const one = normalizeView(view(split("R", "row", [leaf("A"), panelLeaf([["a1", "A"]])]), { sidePanes: { B: { tabs: ["b1", "b2"], itemId: "b2" } } }));
    const swapped = normalizeView({ ...one, layout: showInView(one.layout, "L-A", "B") });
    expect(strip(swapped)).toEqual(["B:b1", "B:b2"]);
    expect(showing(swapped)).toBe("b2");
  });

  it("with nobody coming back, shows the tab beside the one that left — the next, else the one before", () => {
    const three = view(split("R", "row", [split("M", "row", [leaf("A"), leaf("B"), leaf("C")]), panelLeaf([["a1", "A"], ["b1", "B"], ["c1", "C"]], "b1")]));
    const noB = normalizeView({ ...three, layout: closeItem(three.layout, "B") });
    expect(showing(noB)).toBe("c1");
    const last = view(split("R", "row", [split("M", "row", [leaf("A"), leaf("B")]), panelLeaf([["a1", "A"], ["b1", "B"]], "b1")]));
    expect(showing(normalizeView({ ...last, layout: closeItem(last.layout, "B") }))).toBe("a1");
  });

  it("brings back only the tabs that are not already on screen elsewhere", () => {
    const v = normalizeView(view(split("R", "row", [leaf("A"), leaf("x")]), { sidePanes: { A: { tabs: ["x", "y"], itemId: "x" } } }));
    expect(panes(v)).toEqual(["A", "x"]);
    expect(strip(v)).toEqual(["A:y"]);
    expectCanonical(v);
  });

  it("gives a tab a plain open put in the strip to the session of the tab it was opened beside", () => {
    // `openItem` into the panel knows nothing of owners; it puts the tab after the one showing.
    const v = normalizeView(view(split("R", "row", [ab(), panelLeaf([["a1", "A"], ["b1", "B"]], "b1")])));
    const opened = normalizeView({ ...v, layout: openItem(v.layout, "P", "d1") });
    expect(strip(opened)).toEqual(["A:a1", "B:b1", "B:d1"]);
    expect(showing(opened)).toBe("d1");
  });

  it("a tab dropped into another session's run is that session's, and parts with it", () => {
    const v = normalizeView(view(split("R", "row", [ab(), panelLeaf([["a1", "A"], ["a2", "A"], ["b1", "B"]])])));
    const moved = normalizeView({ ...v, layout: moveTab(v.layout, "P", "a2", 2, "B") });
    expect(strip(moved)).toEqual(["A:a1", "B:b1", "B:a2"]);
    const noB = normalizeView({ ...moved, layout: closeItem(moved.layout, "B") });
    expect(strip(noB)).toEqual(["A:a1"]);
    expect(noB.sidePanes.B?.tabs).toEqual(["b1", "a2"]);
  });

  it("what a previewed sub-agent opens is its parent's, and goes with the parent", () => {
    const l = split("R", "row", [leaf("A"), panelLeaf([["child", "A"], ["b1", "child"]])]);
    const v = normalizeView(view(l));
    expect(strip(v)).toEqual(["A:child", "A:b1"]);
    const gone = normalizeView({ ...v, layout: showInView(v.layout, "L-A", "Z") });
    expect(gone.sidePanes).toEqual({ A: { tabs: ["child", "b1"], itemId: "child" } });
  });

  it("never remembers a peek as one of a session's tabs", () => {
    const l = split("R", "row", [leaf("B"), panelLeaf([["x", "A"], ["peek", "A"]], "peek")]);
    const v = normalizeView(view(l), { transient: new Set(["peek"]) });
    expect(v.sidePanes).toEqual({ A: { tabs: ["x"], itemId: "x" } });
  });

  it("drops a tab nobody owns rather than giving it to a stranger", () => {
    const orphan: LayoutLeaf = { type: "leaf", id: "T", itemId: "x", tabs: ["x"] };
    const v = normalizeView(view(split("R", "row", [leaf("A"), orphan])));
    expect(v.layout).toEqual(leaf("A"));
    expect(v.sidePanes).toEqual({});
  });
});

describe("normalizeView — whatever the edits", () => {
  /** A seeded run of every edit the store makes, normalized after each, holding every invariant. */
  it("holds the one shape through a thousand mixed edits", () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const sessions = ["A", "B", "C", "D", "E"];
    let v = view(leaf(null, "L0"));
    let tabN = 0;
    const edges = ["left", "right", "top", "bottom"] as const;
    for (let step = 0; step < 1000; step++) {
      const l = v.layout;
      const mains = primaryLeaves(l);
      const pick = mains[rand(mains.length)]!;
      const s = sessions[rand(sessions.length)]!;
      const panel = findPanel(l);
      let next: Layout | null = l;
      switch (rand(8)) {
        case 0: next = showInView(l, pick.id, s); break;
        case 1: next = openBesideInView(l, pick.id, s, edges[rand(4)]); break;
        case 2: next = mains.length < 9 ? splitEmptyInView(l, pick.id, rand(2) ? "row" : "col").layout : l; break;
        case 3: { const owner = mains.find((m) => m.itemId)?.itemId; next = owner ? openInSidePane(l, owner, `t${tabN++}`, { front: rand(2) === 0 }) : l; break; }
        case 4: { const all = allItems(l); next = all.length ? closeItem(l, all[rand(all.length)]!) : l; break; }
        case 5: next = panel ? moveTab(l, panel.id, panel.tabs![rand(panel.tabs!.length)]!, rand(panel.tabs!.length), rand(3) === 0 ? mains.find((m) => m.itemId)?.itemId ?? undefined : undefined) : l; break;
        case 6: next = panel ? openItem(l, panel.id, `t${tabN++}`) : l; break;
        case 7: v = { ...v, panelShare: rand(10) / 10 }; break;
      }
      v = normalizeView({ ...v, layout: next ?? l });
      expectCanonical(v);
    }
  });
});

describe("showInView", () => {
  const abPanel = (): Layout => split("R", "row", [split("M", "row", [leaf("A"), leaf("B")]), panelLeaf([["x", "A"]])]);

  it("replaces what the focused pane shows, its run going with it", () => {
    const v = normalizeView(view(showInView(abPanel(), "L-A", "D")));
    expect(panes(v)).toEqual(["D", "B"]);
    expect(v.sidePanes.A).toEqual({ tabs: ["x"], itemId: "x" });
  });

  it("from the panel, takes the place of the session whose tab is showing — never a tab beside it", () => {
    const v = normalizeView(view(showInView(abPanel(), "P", "D")));
    expect(panes(v)).toEqual(["D", "B"]);
  });

  it("moves an item already on screen instead of showing it twice", () => {
    const v = normalizeView(view(showInView(abPanel(), "L-B", "A")));
    expect(allItems(v.layout).filter((id) => id === "A")).toHaveLength(1);
    expect(panes(v)).toEqual(["A"]);
    expect(strip(v)).toEqual(["A:x"]);
  });

  it("is a no-op for the pane already showing it", () => {
    const l = abPanel();
    expect(showInView(l, "L-A", "A")).toBe(l);
  });
});

describe("openBesideInView", () => {
  it("splits the pane it was opened from on the side it was dropped, as many times as asked", () => {
    const at = (l: Layout, itemId: string) => findLeafOfItem(l, itemId)!.id;
    let l: Layout = leaf("A");
    l = openBesideInView(l, "L-A", "B");
    l = openBesideInView(l, at(l, "B"), "C");
    l = openBesideInView(l, at(l, "C"), "D", "bottom");
    const v = normalizeView(view(l));
    expect(panes(v)).toEqual(["A", "B", "C", "D"]);
    // Right of B grows the row — three equal columns, never a nested half — and below C stacks in C's column.
    expect(v.layout).toMatchObject({ type: "split", dir: "row", children: [{ id: "L-A" }, { itemId: "B" }, { type: "split", dir: "col" }] });
    expect((v.layout as LayoutSplit).sizes.map(Math.round)).toEqual([33, 33, 33]);
    expect(panes(normalizeView(view(openBesideInView(leaf("A"), "L-A", "B", "left"))))).toEqual(["B", "A"]);
    expect(normalizeView(view(openBesideInView(leaf("A"), "L-A", "B", "top"))).layout).toMatchObject({ type: "split", dir: "col" });
  });

  it("splits a main pane, never the panel, and the panel keeps its place at the right", () => {
    const l = split("R", "row", [leaf("A"), panelLeaf([["x", "A"]])]);
    const v = normalizeView(view(openBesideInView(l, "P", "B", "right")));
    expect(panes(v)).toEqual(["A", "B"]);
    expect(strip(v)).toEqual(["A:x"]);
    expectCanonical(v);
  });

  it("fills a lone empty pane rather than splitting beside nothing", () => {
    expect(normalizeView(view(openBesideInView(leaf(null, "L0"), "L0", "A"))).layout).toEqual({ type: "leaf", id: "L0", itemId: "A" });
  });

  it("moves a pane already on screen rather than opening it twice", () => {
    const v = normalizeView(view(openBesideInView(split("R", "row", [leaf("A"), leaf("B")]), "L-A", "B", "left")));
    expect(panes(v)).toEqual(["B", "A"]);
  });

  it("takes a tab out of the panel into a pane of its own", () => {
    const l = split("R", "row", [leaf("A"), panelLeaf([["x", "A"], ["y", "A"]])]);
    const v = normalizeView(view(openBesideInView(l, "L-A", "y", "bottom")));
    expect(panes(v)).toEqual(["A", "y"]);
    expect(strip(v)).toEqual(["A:x"]);
  });
});

describe("splitEmptyInView", () => {
  it("adds an empty pane beside the one named, however many there are", () => {
    let l: Layout = leaf("A");
    for (let i = 0; i < 5; i++) {
      const at = primaryLeaves(l).at(-1)!.id;
      const made = splitEmptyInView(l, at, i % 2 ? "col" : "row");
      expect(findLeaf(made.layout, made.leafId)).toMatchObject({ itemId: null });
      l = made.layout;
    }
    expect(primaryLeaves(l)).toHaveLength(6);
  });

  it("from the panel, splits the pane of the session whose tab is showing", () => {
    const l = split("R", "row", [split("M", "row", [leaf("A"), leaf("B")]), panelLeaf([["y", "B"]])]);
    const made = splitEmptyInView(l, "P", "col");
    const v = normalizeView(view(made.layout));
    expect(v.layout).toMatchObject({ children: [{ children: [{ id: "L-A" }, { type: "split", dir: "col", children: [{ id: "L-B" }, { id: made.leafId }] }] }, { id: "P" }] });
  });
});

describe("room", () => {
  it("a tree needs its panes' floors along each run, and a divider between each two", () => {
    expect(minRoomOf(leaf("A"))).toEqual({ width: PANE_MIN.width, height: PANE_MIN.height });
    const grid = split("R", "col", [split("r1", "row", [leaf("A"), leaf("B"), leaf("C")]), leaf("D")]);
    expect(minRoomOf(grid)).toEqual({ width: 3 * PANE_MIN.width + 2 * PANE_DIVIDER, height: 2 * PANE_MIN.height + PANE_DIVIDER });
    expect(minRoomOf(mainOf(split("X", "row", [leaf("A"), panelLeaf([["x", "A"]])])))).toEqual(minRoomOf(leaf("A")));
  });

  it("offers a split only while every pane keeps its floor, and leaves the panel its own", () => {
    // THE MUTANT: count the panes instead of the room (the old cap of two). Three columns that fit a
    // wide window would be refused, and a fourth that does not would be squeezed in.
    const two = split("R", "row", [leaf("A"), leaf("B")]);
    const room = { width: 3 * PANE_MIN.width + 2 * PANE_DIVIDER, height: PANE_MIN.height };
    expect(splitFits(two, "L-B", "row", room)).toBe(true);
    expect(splitFits(two, "L-B", "row", { ...room, width: room.width - 1 })).toBe(false);
    expect(splitFits(two, "L-B", "col", room)).toBe(false);
    expect(splitFits(two, "L-B", "col", { ...room, height: 2 * PANE_MIN.height + PANE_DIVIDER })).toBe(true);
    expect(splitFits(two, "L-B", "row", null)).toBe(true);
    const host = { width: room.width + PANEL_MIN_WIDTH + PANE_DIVIDER, height: room.height };
    expect(splitFits(two, "L-B", "row", mainRoom(host, true))).toBe(true);
    expect(splitFits(two, "L-B", "row", mainRoom({ ...host, width: host.width - 1 }, true))).toBe(false);
  });

  it("the panel gives way first: narrows to its floor before any pane does, then steps aside", () => {
    const host = { width: 1400, height: 800 };
    const one = minRoomOf(leaf("A"));
    expect(panelWidthIn(host, one, undefined)).toBe(700);
    expect(panelWidthIn(host, one, 0.3)).toBe(420);
    const three = minRoomOf(split("R", "row", [leaf("A"), leaf("B"), leaf("C")]));
    expect(panelWidthIn(host, three, 0.5)).toBe(host.width - three.width - PANE_DIVIDER);
    expect(panelWidthIn({ ...host, width: three.width + PANE_DIVIDER + PANEL_MIN_WIDTH }, three, 0.5)).toBe(PANEL_MIN_WIDTH);
    expect(panelWidthIn({ ...host, width: three.width + PANE_DIVIDER + PANEL_MIN_WIDTH - 1 }, three, 0.5)).toBeNull();
    expect(panelWidthIn(host, one, 0.01)).toBe(PANEL_MIN_WIDTH);
  });

  it("an open beside with no room replaces the pane next to the one it came from", () => {
    const l = split("R", "row", [leaf("A"), leaf("B"), leaf("C")]);
    expect(besidePane(l, "L-A")?.id).toBe("L-B");
    expect(besidePane(l, "L-C")?.id).toBe("L-B");
    expect(besidePane(leaf("A"), "L-A")).toBeNull();
  });
});

describe("a session's tabs while it is not on screen", () => {
  it("collect what its agents open, showing the newest", () => {
    let v = view(leaf("B"));
    v = rememberSidePane(v, "A", "x");
    v = rememberSidePane(v, "A", "y");
    v = rememberSidePane(v, "A", "x");
    expect(v.sidePanes.A).toEqual({ tabs: ["x", "y"], itemId: "x" });
    expect(rememberSidePane(v, "A", "x")).toBe(v);
  });

  it("are what openInSidePane-then-hide-then-show round-trips through", () => {
    const withTab = openInSidePane(leaf("A"), "A", "x")!;
    const hidden = normalizeView(view(showInView(withTab, findLeafOfItem(withTab, "A")!.id, "B")));
    expect(panes(hidden)).toEqual(["B"]);
    expect(strip(hidden)).toEqual([]);
    const shown = normalizeView({ ...hidden, layout: showInView(hidden.layout, null, "A") });
    expect(strip(shown)).toEqual(["A:x"]);
  });
});

describe("openInSidePane", () => {
  it("opens the panel at the right of everything, whichever pane asked", () => {
    const l = openInSidePane(split("M", "col", [leaf("A"), leaf("B")]), "A", "x")!;
    const v = normalizeView(view(l));
    expect(strip(v)).toEqual(["A:x"]);
    expect(v.layout).toMatchObject({ type: "split", dir: "row", children: [{ id: "M" }, { tabs: ["x"] }] });
  });

  it("puts each session's opens in its own run, after the tab showing when that one is its own", () => {
    let l: Layout = split("M", "row", [leaf("A"), leaf("B")]);
    l = openInSidePane(l, "A", "a1")!;
    l = openInSidePane(l, "B", "b1")!;
    l = openInSidePane(l, "A", "a2")!;
    expect(sideTabsOf(l, "A")).toEqual(["a1", "a2"]);
    expect(strip(normalizeView(view(l)))).toEqual(["A:a1", "A:a2", "B:b1"]);
  });

  it("behind the tab showing when asked not to take the panel", () => {
    let l: Layout = openInSidePane(split("M", "row", [leaf("A"), leaf("B")]), "A", "a1")!;
    l = openInSidePane(l, "B", "b1", { front: false })!;
    expect(findPanel(l)?.itemId).toBe("a1");
  });

  it("is null when the session is not in the layout, so nothing lands beside a stranger", () => {
    expect(openInSidePane(leaf("A"), "Z", "x")).toBeNull();
  });
});

describe("pruneView", () => {
  it("closes what was deleted, and forgets the tabs of a deleted session", () => {
    const v = view(split("R", "row", [leaf("A"), leaf("B")]), { sidePanes: { gone: { tabs: ["x"], itemId: "x" }, C: { tabs: ["x", "dead"], itemId: "dead" } } });
    const next = pruneView(v, new Set(["A", "x", "C"]));
    expect(panes(next)).toEqual(["A"]);
    expect(next.sidePanes).toEqual({ C: { tabs: ["x"], itemId: "x" } });
  });

  it("keeps the tabs of a session that was only put away", () => {
    const v = view(split("R", "row", [leaf("A"), panelLeaf([["x", "A"]])]));
    expect(pruneView(v, new Set(["x"]), new Set(["x", "A"])).sidePanes).toEqual({ A: { tabs: ["x"], itemId: "x" } });
  });

  it("is the same view when nothing was deleted", () => {
    const v = view(split("R", "row", [leaf("A"), leaf("B")]));
    expect(pruneView(v, new Set(["A", "B"]))).toBe(v);
  });
});

describe("withoutItem", () => {
  it("takes a peek out of what is saved, and does not remember it", () => {
    const v = normalizeView(view(split("R", "row", [leaf("A"), panelLeaf([["x", "A"], ["peek", "A"]], "peek")])));
    const saved = withoutItem(v, "peek");
    expect(strip(saved)).toEqual(["A:x"]);
    expect(withoutItem(saved, "peek")).toBe(saved);
  });
});

/*
 * Restoring what older builds wrote. Every fixture here is typed out by hand in the shape that build
 * stored — never produced by today's functions, which could only ever round-trip their own output.
 */
describe("views stored by older builds", () => {
  it("Plan 27: two panes, each with a side pane of its own, and a session's tabs kept off screen", () => {
    const raw = JSON.parse(`{
      "v": 1,
      "layout": { "type": "split", "id": "R", "dir": "row", "sizes": [60, 40], "children": [
        { "type": "split", "id": "C1", "dir": "row", "sizes": [50, 50], "children": [
          { "type": "leaf", "id": "LA", "itemId": "A" },
          { "type": "leaf", "id": "TA", "itemId": "a2", "tabs": ["a1", "a2"], "owner": "A" } ] },
        { "type": "split", "id": "C2", "dir": "row", "sizes": [70, 30], "children": [
          { "type": "leaf", "id": "LB", "itemId": "B" },
          { "type": "leaf", "id": "TB", "itemId": "b1", "tabs": ["b1"], "owner": "B" } ] } ] },
      "zoomedLeafId": null,
      "sidePanes": { "C": { "tabs": ["c1"], "itemId": "c1" } },
      "focusedItemId": "B",
      "focusedLeafId": "TB"
    }`);
    const stored = parseStoredView(raw)!;
    expect(stored).not.toBeNull();
    const v = normalizeView({ layout: stored.layout, zoomedLeafId: stored.zoomedLeafId, sidePanes: stored.sidePanes }, { keep: stored.focusedLeafId });
    expectCanonical(v);
    expect(panes(v)).toEqual(["A", "B"]);
    expect(strip(v)).toEqual(["A:a1", "A:a2", "B:b1"]);
    // The strip the keyboard was in keeps its tab showing; the other's tabs are all still there.
    expect(showing(v)).toBe("b1");
    expect(v.sidePanes).toEqual({ C: { tabs: ["c1"], itemId: "c1" } });
    // The two panes keep the split they shared, its divider where it was dragged.
    expect((v.layout as LayoutSplit).children[0]).toMatchObject({ id: "R", sizes: [60, 40] });
    expect(findLeaf(v.layout, "TA")?.tabs).toEqual(["a1", "a2", "b1"]);
  });

  it("Plan 27: one pane and its side pane, zoomed, from before focusedLeafId was stored", () => {
    const raw = JSON.parse(`{
      "v": 1,
      "layout": { "type": "split", "id": "C", "dir": "row", "sizes": [50, 50], "children": [
        { "type": "leaf", "id": "LA", "itemId": "A" },
        { "type": "leaf", "id": "TA", "itemId": "x", "tabs": ["x"], "owner": "A" } ] },
      "zoomedLeafId": "TA",
      "sidePanes": {},
      "focusedItemId": "x"
    }`);
    const stored = parseStoredView(raw)!;
    const v = normalizeView({ layout: stored.layout, zoomedLeafId: stored.zoomedLeafId, sidePanes: stored.sidePanes });
    expectCanonical(v);
    expect(v.zoomedLeafId).toBe("TA");
    expect(strip(v)).toEqual(["A:x"]);
    expect(stored.panelShare).toBeUndefined();
  });

  it("Plan 27: a side pane left flat beside its owner and the other pane", () => {
    // `openInSidePane` grew the split it found, so [A | B] gaining A's side pane came out [A, sideA, B].
    const raw = JSON.parse(`{ "type": "split", "id": "R", "dir": "row", "sizes": [34, 33, 33], "children": [
      { "type": "leaf", "id": "LA", "itemId": "A" },
      { "type": "leaf", "id": "TA", "itemId": "x", "tabs": ["x"], "owner": "A" },
      { "type": "leaf", "id": "LB", "itemId": "B" } ] }`);
    const v = normalizeView({ layout: LayoutSchema.parse(raw), zoomedLeafId: null, sidePanes: {} });
    expectCanonical(v);
    expect(panes(v)).toEqual(["A", "B"]);
    expect(strip(v)).toEqual(["A:x"]);
  });

  it("Plan 26: a room of three with side panes, as a space's groups stored it — every pane comes back", () => {
    const raw = JSON.parse(`{
      "groups": [
        { "id": "${ULID(1)}", "name": "Main", "layout": { "type": "leaf", "id": "L0", "itemId": "other" }, "zoomedLeafId": null },
        { "id": "${ULID(2)}", "name": "Split 2", "zoomedLeafId": null, "layout":
          { "type": "split", "id": "R", "dir": "row", "sizes": [25, 25, 25, 25], "children": [
            { "type": "leaf", "id": "LA", "itemId": "A" },
            { "type": "split", "id": "CB", "dir": "row", "sizes": [50, 50], "children": [
              { "type": "leaf", "id": "LB", "itemId": "B" },
              { "type": "leaf", "id": "TB", "itemId": "y", "tabs": ["y", "z"], "owner": "B" } ] },
            { "type": "leaf", "id": "LC", "itemId": "C" },
            { "type": "leaf", "id": "LD", "itemId": "D" } ] } }
      ],
      "activeGroupId": "${ULID(2)}"
    }`);
    const groups = SpaceGroupsSchema.parse(raw) as SpaceGroups;
    const v = viewFromGroups(groups, "C");
    expectCanonical(v);
    // THE MUTANT: the old cap of two. C, D and A would fall out of the view the person last saw.
    expect(panes(v)).toEqual(["A", "B", "C", "D"]);
    expect(strip(v)).toEqual(["B:y", "B:z"]);
    expect(allItems(v.layout)).not.toContain("other");
  });

  it("rooms: a three-by-three grid and a zoomed pane, as gridPreset wrote them", () => {
    const row = (r: number) => `{ "type": "split", "id": "row${r}", "dir": "row", "sizes": [33.333333333333336, 33.333333333333336, 33.333333333333336], "children": [
      { "type": "leaf", "id": "L${r}0", "itemId": "s${r}0" }, { "type": "leaf", "id": "L${r}1", "itemId": "s${r}1" }, { "type": "leaf", "id": "L${r}2", "itemId": null } ] }`;
    const raw = JSON.parse(`{ "groups": [ { "id": "${ULID(3)}", "name": "Grid", "zoomedLeafId": "L11", "layout":
      { "type": "split", "id": "G", "dir": "col", "sizes": [33.333333333333336, 33.333333333333336, 33.333333333333336], "children": [${row(0)}, ${row(1)}, ${row(2)}] } } ],
      "activeGroupId": "${ULID(3)}" }`);
    const v = viewFromGroups(SpaceGroupsSchema.parse(raw) as SpaceGroups, null);
    expectCanonical(v);
    expect(panes(v)).toEqual(["s00", "s01", "·", "s10", "s11", "·", "s20", "s21", "·"]);
    expect(v.zoomedLeafId).toBe("L11");
  });

  it("before rooms: a space's bare layout, with a pre-Plan-4 tabbed leaf in it", () => {
    // The `{tabs, activeTab}` leaf collapses to its active tab; a bare layout becomes the one group.
    const raw = JSON.parse(`{ "type": "split", "id": "R", "dir": "col", "sizes": [50, 50], "children": [
      { "type": "leaf", "id": "L1", "tabs": ["t1", "t2"], "activeTab": "t2" },
      { "type": "leaf", "id": "L2", "tabs": ["t3"] } ] }`);
    const v = viewFromGroups(SpaceGroupsSchema.parse(raw) as SpaceGroups, null);
    expectCanonical(v);
    expect(panes(v)).toEqual(["t2", "t3"]);
    expect(findPanel(v.layout)).toBeNull();
  });
});

describe("parseStoredView", () => {
  it("reads back what was written, the panel's share with it", () => {
    const stored = { v: 1, layout: split("R", "row", [leaf("A"), leaf("B")]), zoomedLeafId: null, sidePanes: { C: { tabs: ["x"], itemId: "x" } }, focusedItemId: "A", panelShare: 0.4 };
    expect(parseStoredView(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("is null for anything else, and repairs a remembered run whose showing tab is not one of its tabs", () => {
    expect(parseStoredView(null)).toBeNull();
    expect(parseStoredView({ v: 2 })).toBeNull();
    expect(parseStoredView({ groups: [], activeGroupId: ULID(1) })).toBeNull();
    const repaired = parseStoredView({ v: 1, layout: leaf("A"), zoomedLeafId: null, sidePanes: { C: { tabs: ["x", "x"], itemId: "q" } }, focusedItemId: null });
    expect(repaired?.sidePanes.C).toEqual({ tabs: ["x"], itemId: "x" });
  });
});
