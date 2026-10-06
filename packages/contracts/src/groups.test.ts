import { describe, expect, it } from "vitest";
import { DEFAULT_GROUP_NAME, SpaceGroupsSchema, activeGroup, activeLayout, allGroupItems, groupsFromLayout, migrateGroups, setActiveLayout, zoomLeaf, type PaneGroup, type SpaceGroups } from "./groups";
import { allItems, type Layout, type LayoutLeaf } from "./layout";

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

