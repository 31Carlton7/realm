import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROUP_NAME, SpaceGroupsSchema, activeGroup, activeLayout, addGroup, allGroupItems,
  detachItemFrom, firstEmptyLeafId, groupAtOffset, groupOfItem, groupsFromLayout, migrateGroups,
  moveItemToGroup, nextGroupName, reconcileGroups, removeGroup, renameGroup, setActiveGroup,
  setActiveLayout, toggleZoom, unzoom, zoomLeaf, type PaneGroup, type SpaceGroups,
} from "./groups";
import { allItems, findLeafOfItem, type Layout, type LayoutLeaf } from "./layout";

const ULID = (n: number) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(n).padStart(2, "0")}`;
const leaf = (itemId: string | null, id = `L-${itemId ?? "empty"}`): LayoutLeaf => ({ type: "leaf", id, itemId });
const row = (children: Layout[]): Layout =>
  ({ type: "split", id: "S1", dir: "row", sizes: children.map(() => 100 / children.length), children });

const group = (n: number, layout: Layout, over: Partial<PaneGroup> = {}): PaneGroup =>
  ({ id: ULID(n), name: `G${n}`, layout, zoomedLeafId: null, ...over });
/** Two groups, the first active: A|B split on screen, C parked in the second arrangement. */
const two = (): SpaceGroups => ({
  groups: [group(1, row([leaf("A"), leaf("B")])), group(2, leaf("C"))],
  activeGroupId: ULID(1),
});

describe("groupsFromLayout", () => {
  it("wraps a layout in one active 'Main' group", () => {
    const l = row([leaf("A"), leaf("B")]);
    const gs = groupsFromLayout(l);
    expect(gs.groups).toHaveLength(1);
    expect(gs.groups[0]!.name).toBe(DEFAULT_GROUP_NAME);
    expect(gs.groups[0]!.layout).toBe(l);
    expect(gs.activeGroupId).toBe(gs.groups[0]!.id);
  });
  it("gives a null layout an empty leaf rather than no layout at all", () => {
    expect(activeLayout(groupsFromLayout(null))).toEqual({ type: "leaf", id: expect.any(String), itemId: null });
  });
  // The read path derives this on EVERY read for a space with no groups_json yet; a fresh id per call
  // would hand two consecutive spaces.list() calls two different ids for the same group.
  it("is deterministic when given an id, and only then", () => {
    expect(groupsFromLayout(null, ULID(7)).activeGroupId).toBe(ULID(7));
    expect(groupsFromLayout(null, ULID(7))).toEqual(groupsFromLayout(null, ULID(7)));
    expect(groupsFromLayout(null).activeGroupId).not.toBe(groupsFromLayout(null).activeGroupId);
  });
});

describe("migrateGroups", () => {
  it("turns a bare pre-groups layout into a single Main group", () => {
    const l = row([leaf("A"), leaf("B")]);
    const gs = SpaceGroupsSchema.parse(l);
    expect(gs.groups).toHaveLength(1);
    expect(gs.groups[0]!.name).toBe(DEFAULT_GROUP_NAME);
    expect(allItems(gs.groups[0]!.layout)).toEqual(["A", "B"]);
  });
  it("repairs an activeGroupId that names no group", () => {
    const gs = SpaceGroupsSchema.parse({ ...two(), activeGroupId: ULID(99) });
    expect(gs.activeGroupId).toBe(ULID(1));
  });
  it("repairs an empty group list into one empty group", () => {
    const gs = SpaceGroupsSchema.parse({ groups: [], activeGroupId: ULID(1) });
    expect(gs.groups).toHaveLength(1);
    expect(allItems(gs.groups[0]!.layout)).toEqual([]);
  });
  it("drops a group whose layout is unparseable rather than trusting it onto the screen", () => {
    const gs = SpaceGroupsSchema.parse({
      groups: [group(1, leaf("A")), { id: ULID(2), name: "bad", layout: { type: "split", id: "x", dir: "row", sizes: [], children: [] }, zoomedLeafId: null }],
      activeGroupId: ULID(1),
    });
    expect(gs.groups.map((g) => g.id)).toEqual([ULID(1)]);
  });
  // The cross-group form of layout.ts's within-a-tree uniqueness. Two groups both claiming a pane
  // makes groupOfItem — which the sidebar's grouping and moveItemToGroup both rest on — start lying.
  it("dedupes an item claimed by two groups: the first group keeps it", () => {
    const gs = SpaceGroupsSchema.parse({
      groups: [group(1, row([leaf("A"), leaf("B")])), group(2, row([leaf("B", "L-B2"), leaf("C")]))],
      activeGroupId: ULID(1),
    });
    expect(allItems(gs.groups[0]!.layout)).toEqual(["A", "B"]);
    expect(allItems(gs.groups[1]!.layout)).toEqual(["C"]);
    expect(allGroupItems(gs)).toEqual(["A", "B", "C"]);
  });
  it("drops a zoom pointing at a leaf that is not in the group's tree", () => {
    const gs = SpaceGroupsSchema.parse({
      groups: [group(1, leaf("A"), { zoomedLeafId: "L-gone" })], activeGroupId: ULID(1),
    });
    expect(gs.groups[0]!.zoomedLeafId).toBeNull();
  });
  it("keeps a zoom pointing at a leaf that IS in the tree", () => {
    const gs = SpaceGroupsSchema.parse({
      groups: [group(1, row([leaf("A"), leaf("B")]), { zoomedLeafId: "L-B" })], activeGroupId: ULID(1),
    });
    expect(gs.groups[0]!.zoomedLeafId).toBe("L-B");
  });
  it("degrades anything unusable to one empty group instead of throwing", () => {
    for (const junk of [null, undefined, 7, "layout", { nope: true }]) {
      const gs = SpaceGroupsSchema.parse(migrateGroups(junk));
      expect(gs.groups).toHaveLength(1);
      expect(allItems(gs.groups[0]!.layout)).toEqual([]);
    }
  });
});

describe("group set edits", () => {
  it("addGroup appends an empty group and makes it active", () => {
    const gs = addGroup(two());
    expect(gs.groups).toHaveLength(3);
    expect(gs.activeGroupId).toBe(gs.groups[2]!.id);
    expect(allItems(activeLayout(gs))).toEqual([]);
  });
  it("nextGroupName skips names the space already uses", () => {
    expect(nextGroupName({ groups: [group(1, leaf(null), { name: "Group 2" })], activeGroupId: ULID(1) })).toBe("Group 3");
  });
  it("removeGroup drops it and its panes stop being open — nothing is deleted", () => {
    const gs = removeGroup(two(), ULID(2));
    expect(gs.groups.map((g) => g.id)).toEqual([ULID(1)]);
    expect(allGroupItems(gs)).toEqual(["A", "B"]); // C is simply no longer open anywhere
  });
  it("removeGroup activates a neighbour when the active group goes", () => {
    expect(removeGroup(two(), ULID(1)).activeGroupId).toBe(ULID(2));
  });
  it("removeGroup refuses the last group — a space must keep somewhere to render", () => {
    const one = groupsFromLayout(leaf("A"));
    expect(removeGroup(one, one.activeGroupId)).toBe(one);
  });
  it("renameGroup ignores a blank name and is a no-op when unchanged", () => {
    const gs = two();
    expect(renameGroup(gs, ULID(1), "   ")).toBe(gs);
    expect(renameGroup(gs, ULID(1), "G1")).toBe(gs);
    expect(renameGroup(gs, ULID(1), " Ship ").groups[0]!.name).toBe("Ship");
  });
  it("setActiveGroup ignores an unknown id and a no-op switch", () => {
    const gs = two();
    expect(setActiveGroup(gs, ULID(99))).toBe(gs);
    expect(setActiveGroup(gs, ULID(1))).toBe(gs);
    expect(setActiveGroup(gs, ULID(2)).activeGroupId).toBe(ULID(2));
  });
  it("groupAtOffset clamps at the ends rather than wrapping", () => {
    const gs = two();
    expect(groupAtOffset(gs, 1)!.id).toBe(ULID(2));
    expect(groupAtOffset(gs, -1)).toBeNull();
    expect(groupAtOffset(setActiveGroup(gs, ULID(2)), 1)).toBeNull();
  });
});

describe("setActiveLayout", () => {
  it("writes only the active group", () => {
    const gs = setActiveLayout(two(), leaf("A"));
    expect(allItems(gs.groups[0]!.layout)).toEqual(["A"]);
    expect(allItems(gs.groups[1]!.layout)).toEqual(["C"]); // untouched
  });
  it("ends a zoom whose leaf the edit pruned", () => {
    const zoomed = zoomLeaf(two(), "L-B");
    expect(activeGroup(zoomed).zoomedLeafId).toBe("L-B");
    expect(activeGroup(setActiveLayout(zoomed, leaf("A"))).zoomedLeafId).toBeNull();
  });
  it("keeps a zoom whose leaf survives the edit", () => {
    const zoomed = zoomLeaf(two(), "L-B");
    const next = setActiveLayout(zoomed, row([leaf("A"), leaf("B"), leaf("D")]));
    expect(activeGroup(next).zoomedLeafId).toBe("L-B");
  });
});

describe("moveItemToGroup", () => {
  it("moves a pane between groups — it is open in exactly one afterwards", () => {
    const gs = moveItemToGroup(two(), "B", ULID(2));
    expect(allItems(gs.groups[0]!.layout)).toEqual(["A"]);
    expect(allItems(gs.groups[1]!.layout)).toContain("B");
    expect(allGroupItems(gs).filter((x) => x === "B")).toHaveLength(1);
  });
  it("prefers an empty leaf so the target group never silently evicts a pane", () => {
    const gs: SpaceGroups = { groups: [group(1, leaf("A")), group(2, row([leaf("C"), leaf(null)]))], activeGroupId: ULID(1) };
    const next = moveItemToGroup(gs, "A", ULID(2));
    expect(allItems(next.groups[1]!.layout)).toEqual(["C", "A"]); // C kept its leaf
  });
  it("opens an item that was open nowhere", () => {
    const gs = moveItemToGroup(two(), "Z", ULID(2));
    expect(allItems(gs.groups[1]!.layout)).toContain("Z");
  });
  it("is a no-op for an unknown group, or a move to where the pane already is", () => {
    const gs = two();
    expect(moveItemToGroup(gs, "A", ULID(99))).toBe(gs);
    expect(moveItemToGroup(gs, "A", ULID(1))).toBe(gs);
  });
});

describe("detachItemFrom", () => {
  it("closes the item out of the group that is not being kept", () => {
    const gs = detachItemFrom(two(), "C", ULID(1));
    expect(allItems(gs.groups[1]!.layout)).toEqual([]);
  });
  it("leaves the kept group's copy alone", () => {
    const gs = two();
    expect(detachItemFrom(gs, "A", ULID(1))).toBe(gs);
    expect(detachItemFrom(gs, "nope", ULID(1))).toBe(gs);
  });
});

describe("focus (zoom)", () => {
  // The property the whole feature rests on: focusing does not remove the pane from its group.
  it("does not change the group's layout at all", () => {
    const gs = two();
    const zoomed = zoomLeaf(gs, "L-B");
    expect(zoomed.groups[0]!.layout).toBe(gs.groups[0]!.layout);
    expect(allItems(activeLayout(zoomed))).toEqual(["A", "B"]);
    expect(groupOfItem(zoomed, "B")!.id).toBe(ULID(1));
  });
  it("unzoom restores the split and is a no-op when nothing is zoomed", () => {
    const gs = two();
    expect(unzoom(gs)).toBe(gs);
    expect(activeGroup(unzoom(zoomLeaf(gs, "L-B"))).zoomedLeafId).toBeNull();
  });
  it("ignores a leaf that is not in the active group's tree", () => {
    const gs = two();
    expect(zoomLeaf(gs, "L-C")).toBe(gs); // L-C belongs to the OTHER group
    expect(zoomLeaf(gs, "nope")).toBe(gs);
  });
  it("toggleZoom zooms, then unzooms the same leaf, and re-targets a different one", () => {
    const gs = two();
    const a = toggleZoom(gs, "L-A");
    expect(activeGroup(a).zoomedLeafId).toBe("L-A");
    expect(activeGroup(toggleZoom(a, "L-A")).zoomedLeafId).toBeNull();
    expect(activeGroup(toggleZoom(a, "L-B")).zoomedLeafId).toBe("L-B");
  });
  it("is per-group: switching away and back finds the same pane focused", () => {
    const zoomed = zoomLeaf(two(), "L-B");
    const away = setActiveGroup(zoomed, ULID(2));
    expect(activeGroup(away).zoomedLeafId).toBeNull(); // the other group has its own (absent) focus
    expect(activeGroup(setActiveGroup(away, ULID(1))).zoomedLeafId).toBe("L-B");
  });
});

describe("reconcileGroups", () => {
  it("prunes deleted items from EVERY group, not just the active one", () => {
    const gs = reconcileGroups(two(), new Set(["A"]));
    expect(allItems(gs.groups[0]!.layout)).toEqual(["A"]);
    expect(allItems(gs.groups[1]!.layout)).toEqual([]);
  });
  it("ends a focus whose pane was deleted", () => {
    const gs = reconcileGroups(zoomLeaf(two(), "L-B"), new Set(["A", "C"]));
    expect(activeGroup(gs).zoomedLeafId).toBeNull();
  });
  it("returns the same object when nothing was pruned", () => {
    const gs = two();
    expect(reconcileGroups(gs, new Set(["A", "B", "C"]))).toBe(gs);
  });
});

describe("lookups", () => {
  it("groupOfItem finds the owning group, or null when the pane is open nowhere", () => {
    expect(groupOfItem(two(), "C")!.id).toBe(ULID(2));
    expect(groupOfItem(two(), "Z")).toBeNull();
  });
  it("firstEmptyLeafId finds the first unoccupied leaf depth-first", () => {
    expect(firstEmptyLeafId(row([leaf("A"), leaf(null, "E1"), leaf(null, "E2")]))).toBe("E1");
    expect(firstEmptyLeafId(row([leaf("A"), leaf("B")]))).toBeNull();
  });
  it("findLeafOfItem still answers within one group's tree", () => {
    expect(findLeafOfItem(activeLayout(two()), "B")!.id).toBe("L-B");
  });
});
