import { describe, expect, it } from "vitest";
import {
  VIEW_MAX_PANES, columnOf, normalizeView, openBesideInView, parseStoredView, primaryLeaves, pruneView,
  rememberSidePane, showInView, splitEmptyInView, viewFromGroups, withoutItem, type WindowView,
} from "./view";
import { allItems, findLeaf, findLeafOfItem, findSidePane, openInSidePane, updateSizes, type Layout, type LayoutLeaf } from "./layout";
import type { SpaceGroups } from "./groups";

const ULID = (n: number) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(n).padStart(2, "0")}`;
const leaf = (itemId: string | null, id = `L-${itemId ?? "empty"}`): LayoutLeaf => ({ type: "leaf", id, itemId });
const side = (owner: string, tabs: string[], itemId = tabs[0]!, id = `T-${owner}`): LayoutLeaf => ({ type: "leaf", id, itemId, tabs, owner });
const split = (id: string, dir: "row" | "col", children: Layout[], sizes = children.map(() => 100 / children.length)): Layout =>
  ({ type: "split", id, dir, sizes, children });
const view = (layout: Layout, over: Partial<WindowView> = {}): WindowView => ({ layout, zoomedLeafId: null, sidePanes: {}, ...over });
/** What is on screen, column by column: each main pane, and its side pane's tabs after a slash. */
const shape = (v: WindowView): string[] => primaryLeaves(v.layout).map((p) => {
  const sp = p.itemId ? findSidePane(v.layout, p.itemId) : null;
  return sp ? `${p.itemId ?? "·"}/${sp.tabs!.join(",")}` : p.itemId ?? "·";
});

describe("the main panes of a view", () => {
  it("are the leaves that are not side panes, and a side pane's column is its owner's", () => {
    const l = split("R", "row", [split("C", "row", [leaf("A"), side("A", ["x", "y"])]), leaf("B")]);
    expect(primaryLeaves(l).map((p) => p.itemId)).toEqual(["A", "B"]);
    expect(columnOf(l, "T-A")?.itemId).toBe("A");
    expect(columnOf(l, "L-B")?.itemId).toBe("B");
    expect(columnOf(l, "nope")).toBeNull();
  });
});

describe("normalizeView", () => {
  it("puts a side pane in its owner's column, however the tree got flat", () => {
    // `openInSidePane` grows the split it finds, so [A | B] gaining A's side pane came out [A, sideA, B].
    const flat = split("R", "row", [leaf("A"), side("A", ["x"]), leaf("B")]);
    const v = normalizeView(view(flat));
    expect(shape(v)).toEqual(["A/x", "B"]);
    const root = v.layout as Extract<Layout, { type: "split" }>;
    expect(root.children).toHaveLength(2);
    expect(root.children[0]).toMatchObject({ type: "split", dir: "row", children: [{ id: "L-A" }, { id: "T-A" }] });
  });

  it("returns the very same view when it is already in shape — a write that changes nothing is not one", () => {
    const v = view(split("R", "row", [split("C", "row", [leaf("A"), side("A", ["x"])]), leaf("B")]));
    expect(normalizeView(v)).toBe(v);
  });

  it("keeps a dragged divider where it was", () => {
    const resized = updateSizes(split("R", "row", [leaf("A"), leaf("B")]), "R", [70, 30]);
    const v = normalizeView(view(resized));
    expect(v.layout).toMatchObject({ id: "R", sizes: [70, 30] });
  });

  it("takes a side pane off screen with its owner, and gives it back when the owner returns", () => {
    // THE MUTANT: drop the orphan instead of remembering it. Showing another session in A's place
    // would then lose the browser A's agent was driving, and A would come back with nothing beside it.
    const gone = normalizeView(view(split("R", "row", [leaf("B"), side("A", ["x", "y"], "y")])));
    expect(shape(gone)).toEqual(["B"]);
    expect(gone.sidePanes).toEqual({ A: { tabs: ["x", "y"], itemId: "y" } });
    const back = normalizeView({ ...gone, layout: leaf("A") });
    expect(shape(back)).toEqual(["A/x,y"]);
    expect(findSidePane(back.layout, "A")?.itemId).toBe("y");
    expect(back.sidePanes).toEqual({});
  });

  it("brings back only the tabs that are not already on screen elsewhere", () => {
    const v = normalizeView(view(split("R", "row", [leaf("A"), leaf("x")]), { sidePanes: { A: { tabs: ["x", "y"], itemId: "x" } } }));
    expect(shape(v)).toEqual(["A/y", "x"]);
  });

  it("never remembers a peek as one of the owner's tabs", () => {
    const v = normalizeView(view(split("R", "row", [leaf("B"), side("A", ["x", "peek"], "peek")])), { transient: new Set(["peek"]) });
    expect(v.sidePanes).toEqual({ A: { tabs: ["x"], itemId: "x" } });
  });

  it(`shows at most ${VIEW_MAX_PANES} panes, keeping the focused one and the first other`, () => {
    const three = split("R", "row", [leaf("A"), leaf("B"), split("C", "row", [leaf("C"), side("C", ["z"])])]);
    const v = normalizeView(view(three), { keep: "T-C" });
    expect(shape(v)).toEqual(["A", "C/z"]);
    // The one that fell off is an item of its space still, and nothing of its is lost.
    const dropped = normalizeView(view(three), { keep: "L-A" });
    expect(shape(dropped)).toEqual(["A", "B"]);
    expect(dropped.sidePanes).toEqual({ C: { tabs: ["z"], itemId: "z" } });
  });

  it("ends a pane focus whose pane has gone", () => {
    const v = normalizeView(view(leaf("A"), { zoomedLeafId: "L-B" }));
    expect(v.zoomedLeafId).toBeNull();
    const kept = view(split("R", "row", [leaf("A"), leaf("B")]), { zoomedLeafId: "L-B" });
    expect(normalizeView(kept).zoomedLeafId).toBe("L-B");
  });
});

describe("showInView", () => {
  const ab = (): Layout => split("R", "row", [split("C", "row", [leaf("A"), side("A", ["x"])]), leaf("B")]);

  it("replaces what the focused column shows, its side pane going with it", () => {
    const v = normalizeView(view(showInView(ab(), "L-A", "D")));
    expect(shape(v)).toEqual(["D", "B"]);
    expect(v.sidePanes.A).toEqual({ tabs: ["x"], itemId: "x" });
  });

  it("from a side pane, takes that side pane's session's place — never a tab beside it", () => {
    const v = normalizeView(view(showInView(ab(), "T-A", "D")));
    expect(shape(v)).toEqual(["D", "B"]);
  });

  it("moves an item already on screen instead of showing it twice", () => {
    const v = normalizeView(view(showInView(ab(), "L-B", "A")));
    expect(allItems(v.layout).filter((id) => id === "A")).toHaveLength(1);
    expect(shape(v)).toEqual(["A/x"]);
  });

  it("is a no-op for the pane already showing it", () => {
    const l = ab();
    expect(showInView(l, "L-A", "A")).toBe(l);
  });
});

describe("openBesideInView", () => {
  it("makes a second column beside a lone pane, on the side it was dropped", () => {
    expect(shape(normalizeView(view(openBesideInView(leaf("A"), "L-A", "B"))))).toEqual(["A", "B"]);
    expect(shape(normalizeView(view(openBesideInView(leaf("A"), "L-A", "B", "left"))))).toEqual(["B", "A"]);
    const below = normalizeView(view(openBesideInView(leaf("A"), "L-A", "B", "bottom")));
    expect(below.layout).toMatchObject({ type: "split", dir: "col" });
    expect(shape(below)).toEqual(["A", "B"]);
  });

  it("keeps the side pane with the session it serves when a second column arrives", () => {
    const v = normalizeView(view(openBesideInView(split("C", "row", [leaf("A"), side("A", ["x"])]), "T-A", "B")));
    expect(shape(v)).toEqual(["A/x", "B"]);
  });

  it("a third replaces the OTHER side, never the pane it was opened from", () => {
    // THE MUTANT: replace the anchor (or grow a third column). The pane you asked from is the one you
    // are looking at; it is the one that stays.
    const l = split("R", "row", [leaf("A"), split("C", "row", [leaf("B"), side("B", ["y"])])]);
    const v = normalizeView(view(openBesideInView(l, "L-A", "C")));
    expect(shape(v)).toEqual(["A", "C"]);
    expect(v.sidePanes.B).toEqual({ tabs: ["y"], itemId: "y" });
    expect(shape(normalizeView(view(openBesideInView(l, "T-B", "C"))))).toEqual(["C", "B/y"]);
  });

  it("with two, a drop on an edge also says where the new one sits", () => {
    const l = split("R", "row", [leaf("A"), leaf("B")]);
    const v = normalizeView(view(openBesideInView(l, "L-A", "C", "top")));
    expect(v.layout).toMatchObject({ type: "split", dir: "col" });
    expect(shape(v)).toEqual(["C", "A"]);
  });

  it("fills a lone empty pane rather than splitting beside nothing", () => {
    const v = normalizeView(view(openBesideInView(leaf(null, "L0"), "L0", "A")));
    expect(v.layout).toEqual({ type: "leaf", id: "L0", itemId: "A" });
  });

  it("moves a pane already on screen rather than opening it twice", () => {
    const l = split("R", "row", [leaf("A"), leaf("B")]);
    const v = normalizeView(view(openBesideInView(l, "L-A", "B", "left")));
    expect(shape(v)).toEqual(["B", "A"]);
  });
});

describe("splitEmptyInView", () => {
  it("adds an empty pane beside a lone one, and refuses a third", () => {
    const { layout, leafId } = splitEmptyInView(leaf("A"), "row");
    expect(leafId).not.toBeNull();
    expect(findLeaf(layout, leafId!)).toMatchObject({ itemId: null });
    const again = splitEmptyInView(layout, "col");
    expect(again.leafId).toBeNull();
    expect(again.layout).toBe(layout);
  });
});

describe("a side pane for a session not on screen", () => {
  it("collects what its agents open, showing the newest", () => {
    let v = view(leaf("B"));
    v = rememberSidePane(v, "A", "x");
    v = rememberSidePane(v, "A", "y");
    v = rememberSidePane(v, "A", "x");
    expect(v.sidePanes.A).toEqual({ tabs: ["x", "y"], itemId: "x" });
    expect(rememberSidePane(v, "A", "x")).toBe(v);
  });

  it("is what openInSidePane-then-hide-then-show round-trips through", () => {
    const withSide = openInSidePane(leaf("A"), "A", "x")!;
    const hidden = normalizeView(view(showInView(withSide, findLeafOfItem(withSide, "A")!.id, "B")));
    expect(shape(hidden)).toEqual(["B"]);
    const shown = normalizeView({ ...hidden, layout: showInView(hidden.layout, null, "A") });
    expect(shape(shown)).toEqual(["A/x"]);
  });
});

describe("pruneView", () => {
  it("closes what was deleted, and forgets the side pane of a deleted session", () => {
    const v = view(split("R", "row", [leaf("A"), leaf("B")]), { sidePanes: { gone: { tabs: ["x"], itemId: "x" }, C: { tabs: ["x", "dead"], itemId: "dead" } } });
    const live = new Set(["A", "x", "C"]);
    const next = pruneView(v, live);
    expect(shape(next)).toEqual(["A"]);
    expect(next.sidePanes).toEqual({ C: { tabs: ["x"], itemId: "x" } });
  });

  it("keeps the side pane of a session that was only put away", () => {
    const v = view(split("C", "row", [leaf("A"), side("A", ["x"])]));
    const next = pruneView(v, new Set(["x"]), new Set(["x", "A"]));
    expect(next.sidePanes).toEqual({ A: { tabs: ["x"], itemId: "x" } });
  });

  it("is the same view when nothing was deleted", () => {
    const v = view(split("R", "row", [leaf("A"), leaf("B")]));
    expect(pruneView(v, new Set(["A", "B"]))).toBe(v);
  });
});

describe("withoutItem", () => {
  it("takes a peek out of what is saved, and does not remember it", () => {
    const v = view(split("C", "row", [leaf("A"), side("A", ["x", "peek"], "peek")]));
    const saved = withoutItem(v, "peek");
    expect(shape(saved)).toEqual(["A/x"]);
    expect(withoutItem(saved, "peek")).toBe(saved);
  });
});

describe("viewFromGroups — the view a home upgraded from rooms opens on", () => {
  const groups = (layout: Layout, over: Partial<SpaceGroups["groups"][number]> = {}): SpaceGroups => ({
    groups: [{ id: ULID(1), name: "Main", layout: leaf("other"), zoomedLeafId: null }, { id: ULID(2), name: "Split 2", layout, zoomedLeafId: null, ...over }],
    activeGroupId: ULID(2),
  });

  it("is the active split, as it was, zoom included", () => {
    const l = split("R", "row", [split("C", "row", [leaf("A"), side("A", ["x"])]), leaf("B")]);
    const v = viewFromGroups(groups(l, { zoomedLeafId: "L-B" }), null);
    expect(shape(v)).toEqual(["A/x", "B"]);
    expect(v.zoomedLeafId).toBe("L-B");
    expect(allItems(v.layout)).not.toContain("other");
  });

  it("keeps the focused pane of a split wider than two, and remembers the rest's side panes", () => {
    const l = split("R", "row", [leaf("A"), split("C", "row", [leaf("B"), side("B", ["y"])]), leaf("C")]);
    const v = viewFromGroups(groups(l), "C");
    expect(shape(v)).toEqual(["A", "C"]);
    expect(v.sidePanes).toEqual({ B: { tabs: ["y"], itemId: "y" } });
  });
});

describe("parseStoredView", () => {
  it("reads back what was written", () => {
    const stored = { v: 1, layout: split("R", "row", [leaf("A"), leaf("B")]), zoomedLeafId: null, sidePanes: { C: { tabs: ["x"], itemId: "x" } }, focusedItemId: "A" };
    expect(parseStoredView(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("is null for anything else, and repairs a side pane whose showing tab is not one of its tabs", () => {
    expect(parseStoredView(null)).toBeNull();
    expect(parseStoredView({ v: 2 })).toBeNull();
    expect(parseStoredView({ groups: [], activeGroupId: ULID(1) })).toBeNull();
    const repaired = parseStoredView({ v: 1, layout: leaf("A"), zoomedLeafId: null, sidePanes: { C: { tabs: ["x", "x"], itemId: "q" } }, focusedItemId: null });
    expect(repaired?.sidePanes.C).toEqual({ tabs: ["x"], itemId: "x" });
  });
});
