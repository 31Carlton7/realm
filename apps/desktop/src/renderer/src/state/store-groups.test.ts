import { describe, expect, it, beforeEach } from "vitest";
import { createAppStore, seedGroups } from "./store";
import { activeGroup, activeLayout, allGroupItems, allItems, findLeafOfItem, groupOfItem, type SpaceGroups } from "@realm/contracts";
import { fakeApi, item, space, type FakeApi } from "./store.test-fakes";

/** Boot with three items in s1, all unopened (the SPACE list), and open two of them side by side. */
async function booted(api: FakeApi) {
  api.data.items.s1 = [item("i1", "s1", { title: "One" }), item("i2", "s1", { title: "Two" }), item("i3", "s1", { title: "Three" })];
  const store = createAppStore(api);
  await store.getState().boot();
  return store;
}

const persists = (api: FakeApi) => api.calls.filter((c) => c.startsWith("setGroups:s1")).length;

describe("pane groups", () => {
  let api: FakeApi;
  beforeEach(() => { api = fakeApi(); });

  it("boot gives a space one 'Main' group whose layout IS the mirrored `layout` field", async () => {
    const store = await booted(api);
    const s = store.getState();
    expect(s.groups!.groups).toHaveLength(1);
    expect(s.groups!.groups[0]!.name).toBe("Main");
    expect(s.groups!.activeGroupId).toBe(s.groups!.groups[0]!.id);
    expect(s.layout).toBe(activeLayout(s.groups!));
  });

  // The mirror is the whole reason `layout` can stay untouched everywhere else. If any layout-editing
  // action wrote `layout` without `groups`, the two would drift and the next persist would ship the
  // pre-edit tree. This walks the layout-editing surface and asserts they never disagree.
  it("every layout edit keeps `layout` and the active group in step", async () => {
    const store = await booted(api);
    const agree = () => expect(store.getState().layout).toBe(activeLayout(store.getState().groups!));
    await store.getState().openItem("i1"); agree();
    await store.getState().splitFocused("row"); agree();
    await store.getState().openItem("i2"); agree();
    await store.getState().openItemAt("i3", findLeafOfItem(store.getState().layout!, "i1")!.id, "bottom"); agree();
    store.getState().resizeSplit(store.getState().layout!.id, [30, 70]); agree();
    store.getState().equalizeSplit(store.getState().layout!.id); agree();
    await store.getState().applyPreset("two-col"); agree();
    await store.getState().closeFromLayout("i1"); agree();
  });

  it("newPaneGroup adds an empty arrangement, switches to it, and persists", async () => {
    const store = await booted(api);
    await store.getState().openItem("i1");
    const before = persists(api);
    await store.getState().newPaneGroup();
    const s = store.getState();
    expect(s.groups!.groups.map((g) => g.name)).toEqual(["Main", "Group 2"]);
    expect(s.groups!.activeGroupId).toBe(s.groups!.groups[1]!.id);
    expect(allItems(s.layout!)).toEqual([]);            // the new arrangement is empty…
    expect(allGroupItems(s.groups!)).toEqual(["i1"]);   // …and Main still holds i1
    expect(persists(api)).toBe(before + 1);
  });

  it("focus moves into the newly active group rather than pointing at a leaf that is elsewhere", async () => {
    const store = await booted(api);
    await store.getState().openItem("i1");
    const mainLeaf = store.getState().focusedLeafId;
    await store.getState().newPaneGroup();
    expect(store.getState().focusedLeafId).not.toBe(mainLeaf);
    expect(store.getState().focusedLeafId).toBe(store.getState().layout!.id);
  });

  it("activatePaneGroup swaps which arrangement is on screen; both keep their panes", async () => {
    const store = await booted(api);
    await store.getState().openItem("i1");
    await store.getState().newPaneGroup();
    await store.getState().openItem("i2");
    const [main, second] = store.getState().groups!.groups;
    expect(allItems(store.getState().layout!)).toEqual(["i2"]);
    await store.getState().activatePaneGroup(main!.id);
    expect(allItems(store.getState().layout!)).toEqual(["i1"]);
    await store.getState().activatePaneGroup(second!.id);
    expect(allItems(store.getState().layout!)).toEqual(["i2"]);
  });

  it("stepPaneGroup walks the groups and clamps at both ends", async () => {
    const store = await booted(api);
    await store.getState().newPaneGroup();
    const ids = store.getState().groups!.groups.map((g) => g.id);
    await store.getState().stepPaneGroup(-1); expect(store.getState().groups!.activeGroupId).toBe(ids[0]);
    await store.getState().stepPaneGroup(-1); expect(store.getState().groups!.activeGroupId).toBe(ids[0]); // clamp
    await store.getState().stepPaneGroup(1);  expect(store.getState().groups!.activeGroupId).toBe(ids[1]);
    await store.getState().stepPaneGroup(1);  expect(store.getState().groups!.activeGroupId).toBe(ids[1]); // clamp
  });

  it("removePaneGroup returns its panes to the SPACE list without deleting anything", async () => {
    const store = await booted(api);
    await store.getState().openItem("i1");
    await store.getState().newPaneGroup();
    await store.getState().openItem("i2");
    const second = store.getState().groups!.activeGroupId;
    await store.getState().removePaneGroup(second);
    const s = store.getState();
    expect(s.groups!.groups).toHaveLength(1);
    expect(allGroupItems(s.groups!)).toEqual(["i1"]);
    expect(s.items.map((i) => i.id)).toEqual(["i1", "i2", "i3"]); // i2 still exists, just unopened
    expect(api.calls.some((c) => c.startsWith("deleteItem"))).toBe(false);
  });

  it("renamePaneGroup writes the name; renaming to the same name persists nothing", async () => {
    const store = await booted(api);
    const id = store.getState().groups!.activeGroupId;
    await store.getState().renamePaneGroup(id, "Ship");
    expect(store.getState().groups!.groups[0]!.name).toBe("Ship");
    const before = persists(api);
    await store.getState().renamePaneGroup(id, "Ship");
    await store.getState().renamePaneGroup(id, "  ");
    expect(persists(api)).toBe(before);
  });

  describe("cross-group uniqueness", () => {
    it("moveItemToPaneGroup moves a pane, leaving it open in exactly one group", async () => {
      const store = await booted(api);
      await store.getState().openItem("i1");
      await store.getState().newPaneGroup();
      const [main, second] = store.getState().groups!.groups;
      await store.getState().moveItemToPaneGroup("i1", second!.id);
      const s = store.getState();
      expect(allItems(s.groups!.groups[0]!.layout)).toEqual([]);
      expect(allItems(s.groups!.groups[1]!.layout)).toEqual(["i1"]);
      expect(allGroupItems(s.groups!).filter((x) => x === "i1")).toHaveLength(1);
      expect(main!.id).toBe(s.groups!.groups[0]!.id);
    });

    // Every path that opens an item into the ACTIVE group must first strip it from the others: the
    // layout ops only ever see one tree, so without the guard the pane ends up in two arrangements.
    it("a drag into the active group moves the pane out of the group that held it", async () => {
      const store = await booted(api);
      await store.getState().openItem("i1");
      await store.getState().newPaneGroup();
      await store.getState().openItem("i2");
      const target = findLeafOfItem(store.getState().layout!, "i2")!.id;
      await store.getState().openItemAt("i1", target, "right");
      const s = store.getState();
      expect(allItems(s.groups!.groups[0]!.layout)).toEqual([]);
      expect(allItems(s.layout!)).toEqual(["i2", "i1"]);
      expect(allGroupItems(s.groups!).filter((x) => x === "i1")).toHaveLength(1);
    });

    it("an agent-opened pane (openItemBeside) moves rather than duplicating", async () => {
      const store = await booted(api);
      await store.getState().openItem("i1");
      await store.getState().newPaneGroup();
      await store.getState().openItem("i2");
      await store.getState().openItemBeside("i1");
      const s = store.getState();
      expect(allGroupItems(s.groups!).filter((x) => x === "i1")).toHaveLength(1);
      expect(allItems(s.layout!)).toEqual(["i2", "i1"]);
    });

    // The quiet variant exists NOT to steal focus. Yanking a pane out of an arrangement the user is
    // not even looking at is a bigger surprise than a focus move, so it declines instead.
    it("openItemBesideQuiet leaves a pane that is open in another group where it is", async () => {
      const store = await booted(api);
      await store.getState().openItem("i1");
      await store.getState().newPaneGroup();
      await store.getState().openItem("i2");
      await store.getState().openItemBesideQuiet("i1");
      const s = store.getState();
      expect(allItems(s.groups!.groups[0]!.layout)).toEqual(["i1"]);
      expect(allItems(s.layout!)).toEqual(["i2"]);
    });
  });

  it("clicking a row for a pane in another group goes there — switches group, focuses the pane, moves nothing", async () => {
    const store = await booted(api);
    await store.getState().openItem("i1");
    const [main] = store.getState().groups!.groups;
    await store.getState().newPaneGroup();
    await store.getState().openItem("i2");
    await store.getState().openItem("i1"); // no explicit leaf → "go there"
    const s = store.getState();
    expect(s.groups!.activeGroupId).toBe(main!.id);
    expect(allItems(s.layout!)).toEqual(["i1"]);
    expect(s.focusedLeafId).toBe(findLeafOfItem(s.layout!, "i1")!.id);
    expect(allItems(s.groups!.groups[1]!.layout)).toEqual(["i2"]); // untouched
  });

  it("closeFromLayout closes a pane in a non-active group without disturbing the one on screen", async () => {
    const store = await booted(api);
    await store.getState().openItem("i1");
    await store.getState().newPaneGroup();
    await store.getState().openItem("i2");
    const onScreen = store.getState().layout;
    await store.getState().closeFromLayout("i1");
    const s = store.getState();
    expect(allItems(s.groups!.groups[0]!.layout)).toEqual([]);
    expect(s.layout).toBe(onScreen);
  });

  it("a deleted item is pruned from EVERY group, not only the one on screen", async () => {
    const store = await booted(api);
    await store.getState().openItem("i1");
    await store.getState().newPaneGroup();
    await store.getState().openItem("i2");
    api.data.items.s1 = api.data.items.s1!.filter((i) => i.id !== "i1");
    await store.getState().refreshItems();
    expect(allGroupItems(store.getState().groups!)).toEqual(["i2"]);
  });

  describe("focus (fill the space)", () => {
    it("focusPaneFull records the leaf and leaves the layout byte-identical", async () => {
      const store = await booted(api);
      await store.getState().openItem("i1");
      await store.getState().splitFocused("row");
      await store.getState().openItem("i2");
      const before = store.getState().layout;
      const leafId = findLeafOfItem(before!, "i2")!.id;
      await store.getState().focusPaneFull(leafId);
      const s = store.getState();
      expect(s.zoomedLeafId()).toBe(leafId);
      expect(s.layout).toBe(before);                    // nothing moved
      expect(allItems(s.layout!)).toEqual(["i1", "i2"]); // nothing left the group
      expect(groupOfItem(s.groups!, "i2")!.id).toBe(s.groups!.activeGroupId);
      expect(s.focusedLeafId).toBe(leafId);             // the keyboard follows the pane on screen
    });

    it("unfocusPane puts the split straight back, and is a no-op when nothing is focused", async () => {
      const store = await booted(api);
      await store.getState().openItem("i1");
      await store.getState().splitFocused("row");
      await store.getState().openItem("i2");
      await store.getState().focusPaneFull(findLeafOfItem(store.getState().layout!, "i1")!.id);
      const layout = store.getState().layout;
      await store.getState().unfocusPane();
      expect(store.getState().zoomedLeafId()).toBeNull();
      expect(store.getState().layout).toBe(layout);
      const before = persists(api);
      await store.getState().unfocusPane();
      expect(persists(api)).toBe(before);
    });

    it("toggleFocusPane toggles the FOCUSED leaf when given nothing (the ⌘⇧F path)", async () => {
      const store = await booted(api);
      await store.getState().openItem("i1");
      await store.getState().splitFocused("row");
      await store.getState().openItem("i2");
      const leafId = store.getState().focusedLeafId;
      await store.getState().toggleFocusPane();
      expect(store.getState().zoomedLeafId()).toBe(leafId);
      await store.getState().toggleFocusPane();
      expect(store.getState().zoomedLeafId()).toBeNull();
    });

    it("closing the focused pane ends the focus rather than leaving the host with nothing to render", async () => {
      const store = await booted(api);
      await store.getState().openItem("i1");
      await store.getState().splitFocused("row");
      await store.getState().openItem("i2");
      await store.getState().focusPaneFull(findLeafOfItem(store.getState().layout!, "i2")!.id);
      await store.getState().closeFromLayout("i2");
      expect(store.getState().zoomedLeafId()).toBeNull();
      expect(allItems(store.getState().layout!)).toEqual(["i1"]);
    });

    it("is per-group: switching away and back finds the same pane still focused", async () => {
      const store = await booted(api);
      await store.getState().openItem("i1");
      await store.getState().splitFocused("row");
      await store.getState().openItem("i2");
      const leafId = findLeafOfItem(store.getState().layout!, "i2")!.id;
      await store.getState().focusPaneFull(leafId);
      const [main] = store.getState().groups!.groups;
      await store.getState().newPaneGroup();
      expect(store.getState().zoomedLeafId()).toBeNull();
      await store.getState().activatePaneGroup(main!.id);
      expect(store.getState().zoomedLeafId()).toBe(leafId);
    });

    it("survives a round-trip through the server and a space switch", async () => {
      const store = await booted(api);
      await store.getState().openItem("i1");
      await store.getState().splitFocused("row");
      await store.getState().openItem("i2");
      const leafId = findLeafOfItem(store.getState().layout!, "i2")!.id;
      await store.getState().focusPaneFull(leafId);
      await store.getState().selectSpace("s2");
      await store.getState().selectSpace("s1");
      expect(store.getState().zoomedLeafId()).toBe(leafId);
      expect(allItems(store.getState().layout!)).toEqual(["i1", "i2"]);
    });
  });

  it("groups round-trip through persistence: names, membership and the active pointer all survive", async () => {
    const store = await booted(api);
    await store.getState().openItem("i1");
    await store.getState().renamePaneGroup(store.getState().groups!.activeGroupId, "Ship");
    await store.getState().newPaneGroup("Read");
    await store.getState().openItem("i2");
    const saved = store.getState().groups!;
    const activeAt = saved.groups.findIndex((g) => g.id === saved.activeGroupId);
    await store.getState().selectSpace("s2");
    await store.getState().selectSpace("s1");
    const back = store.getState().groups!;
    expect(back.groups.map((g) => g.name)).toEqual(["Ship", "Read"]);
    expect(back.groups.map((g) => allItems(g.layout))).toEqual([["i1"], ["i2"]]);
    expect(back.groups.findIndex((g) => g.id === back.activeGroupId)).toBe(activeAt);
  });

  // The ids only survive verbatim when the space id they are derived from is itself a valid ULID —
  // which every real space id is (`newId()` in SpacesStore.create); the shared fake's "s1"/"s2" are
  // not, and `migrateGroups` repairs them on read rather than discarding the whole set. This is the
  // production shape, and it must be byte-stable: an id that changed on every space switch would
  // break `activeGroupId` and every zoom that names a leaf.
  it("round-trips byte-identically for a space whose id is a real ULID", async () => {
    const sid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    api.data.spaces = [space(sid, "p1", "Versed"), space("s2", "p1", "Homework")];
    api.data.items[sid] = [item("i1", sid, { title: "One" }), item("i2", sid, { title: "Two" })];
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i1");
    await store.getState().newPaneGroup("Read");
    await store.getState().openItem("i2");
    const saved = store.getState().groups!;
    await store.getState().selectSpace("s2");
    await store.getState().selectSpace(sid);
    expect(store.getState().groups).toEqual(saved);
  });

  // migrateGroups repairs rather than rejects: one unusable id must cost that group its id, not cost
  // the user every arrangement they built.
  it("a group set with an unusable id is repaired, keeping every group, name and the active one", async () => {
    const store = await booted(api);
    await store.getState().openItem("i1");
    await store.getState().newPaneGroup("Read");
    await store.getState().openItem("i2");
    const before = store.getState().groups!;
    await store.getState().selectSpace("s2");
    await store.getState().selectSpace("s1");
    const after = store.getState().groups!;
    expect(after.groups).toHaveLength(2);
    expect(after.groups[0]!.id).not.toBe("s1");         // the unusable id was replaced…
    expect(after.groups[1]!.id).toBe(before.groups[1]!.id); // …and the valid one was left alone
    expect(after.activeGroupId).toBe(after.groups[1]!.id); // the active pointer followed the remap
  });

  it("applyPreset lays out the ACTIVE group's panes only — other arrangements are none of its business", async () => {
    const store = await booted(api);
    await store.getState().openItem("i1");
    await store.getState().newPaneGroup();
    await store.getState().openItem("i2");
    await store.getState().splitFocused("row");
    await store.getState().openItem("i3");
    await store.getState().applyPreset("two-col");
    const s = store.getState();
    expect(allItems(s.layout!).sort()).toEqual(["i2", "i3"]);
    expect(allItems(s.groups!.groups[0]!.layout)).toEqual(["i1"]);
  });
});

describe("seedGroups", () => {
  it("prefers a valid group set from the server", () => {
    const gs: SpaceGroups = {
      groups: [{ id: "01ARZ3NDEKTSV4RRFFQ69G5F01", name: "Ship", layout: { type: "leaf", id: "L1", itemId: null }, zoomedLeafId: null }],
      activeGroupId: "01ARZ3NDEKTSV4RRFFQ69G5F01",
    };
    expect(seedGroups(space("s9", "p1", "S", { groups: gs }))).toEqual(gs);
  });
  // Version-skew defence: a server that predates groups sends only a layout, and the user must land
  // on the identical arrangement they left — just addressed as a group now.
  it("wraps a pre-groups layout in one Main group", () => {
    const layout = { type: "leaf", id: "L1", itemId: "i1" } as const;
    const seeded = seedGroups(space("s9", "p1", "S", { layout }));
    expect(seeded.groups).toHaveLength(1);
    expect(seeded.groups[0]!.name).toBe("Main");
    expect(seeded.groups[0]!.layout).toEqual(layout);
  });
  it("repairs a corrupt group set instead of blanking the space", () => {
    const seeded = seedGroups(space("s9", "p1", "S", { groups: { groups: [], activeGroupId: "nope" } as unknown as SpaceGroups }));
    expect(seeded.groups).toHaveLength(1);
    expect(activeGroup(seeded).name).toBe("Main");
  });
  it("is deterministic for a space with neither: the same space re-seeds to the same ids", () => {
    const sp = space("s9", "p1", "S");
    expect(seedGroups(sp)).toEqual(seedGroups(sp));
  });
});
