import { describe, expect, it } from "vitest";
import { navEntry } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, item, notification, type FakeData } from "./store.test-fakes";

const boot = async (overrides: FakeData = {}) => {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
};

/** The store's own name for "the pane on screen". */
const focused = (store: { getState: () => { focusedLeafId: string | null } }) => store.getState().focusedLeafId!;
const showing = (store: ReturnType<typeof createAppStore>) => {
  const s = store.getState();
  const leaf = s.layout && s.focusedLeafId ? s.paneHistory[s.focusedLeafId] : undefined;
  return leaf?.entries[leaf.index] ?? null;
};

const THREE = { s1: [
  item("i1", "s1", { kind: "session", title: "one", refId: "se1" }),
  item("i2", "s1", { kind: "session", title: "two", refId: "se2" }),
  item("i3", "s1", { kind: "session", title: "three", refId: "se3" }),
] };

describe("store — per-pane back/forward", () => {
  it("records every item a pane held, and the arrows put it back", async () => {
    const { store } = await boot({ items: THREE });
    const leaf = focused(store);
    await store.getState().openItem("i1", leaf);
    await store.getState().openItem("i2", leaf);
    await store.getState().openItem("i3", leaf);
    expect(store.getState().canPaneNav(leaf, -1)).toBe(true);
    expect(store.getState().canPaneNav(leaf, 1)).toBe(false);

    await store.getState().stepPaneNav(leaf, -1);
    expect(showing(store)).toEqual({ itemId: "i2", view: null });
    // The LAYOUT moved too, not just the bookkeeping — the pane really shows i2 again.
    expect(store.getState().layout).toMatchObject({ type: "leaf", id: leaf, itemId: "i2" });

    await store.getState().stepPaneNav(leaf, -1);
    expect(showing(store)).toEqual({ itemId: "i1", view: null });
    await store.getState().stepPaneNav(leaf, 1);
    expect(showing(store)).toEqual({ itemId: "i2", view: null });
  });

  it("THE stall mutant: pressing Back twice moves two stops, not one", async () => {
    const { store } = await boot({ items: THREE });
    const leaf = focused(store);
    for (const id of ["i1", "i2", "i3"]) await store.getState().openItem(id, leaf);
    await store.getState().stepPaneNav(leaf, -1);
    await store.getState().stepPaneNav(leaf, -1);
    // A step that recorded itself as a new stop would leave the pane pinned on i2 forever.
    expect(showing(store)).toEqual({ itemId: "i1", view: null });
    expect(store.getState().paneHistory[leaf]!.entries.map((e) => e.itemId)).toEqual(["i1", "i2", "i3"]);
  });

  it("stops at the ends, changing nothing", async () => {
    const { store } = await boot({ items: THREE });
    const leaf = focused(store);
    await store.getState().openItem("i1", leaf);
    const before = store.getState().paneHistory;
    await store.getState().stepPaneNav(leaf, -1);
    await store.getState().stepPaneNav(leaf, 1);
    expect(store.getState().paneHistory).toBe(before);
    expect(store.getState().canPaneNav(leaf, -1)).toBe(false);
  });

  it("a new stop from the middle forks the trail — Forward does not resurrect the branch you left", async () => {
    const { store } = await boot({ items: THREE });
    const leaf = focused(store);
    for (const id of ["i1", "i2"]) await store.getState().openItem(id, leaf);
    await store.getState().stepPaneNav(leaf, -1); // back on i1, i2 ahead
    await store.getState().openItem("i3", leaf);
    expect(store.getState().canPaneNav(leaf, 1)).toBe(false);
    expect(store.getState().paneHistory[leaf]!.entries.map((e) => e.itemId)).toEqual(["i1", "i3"]);
  });

  it("splits navigate independently — one pane's Back never moves its neighbour", async () => {
    const { store } = await boot({ items: THREE });
    const a = focused(store);
    await store.getState().openItem("i1", a);
    await store.getState().splitFocused("row");
    const b = focused(store);
    expect(b).not.toBe(a);
    await store.getState().openItem("i2", b);
    await store.getState().openItem("i3", b);

    await store.getState().stepPaneNav(b, -1);
    expect(navEntry(store.getState().paneHistory, b)).toEqual({ itemId: "i2", view: null });
    expect(navEntry(store.getState().paneHistory, a)).toEqual({ itemId: "i1", view: null });
    expect(store.getState().canPaneNav(a, -1)).toBe(false); // pane A went nowhere
  });

  it("forgets a deleted item, so Back can never land on a pane that no longer exists", async () => {
    const { store } = await boot({ items: THREE });
    const leaf = focused(store);
    for (const id of ["i1", "i2"]) await store.getState().openItem(id, leaf);
    await store.getState().deleteItem("i1");
    expect(store.getState().paneHistory[leaf]?.entries.map((e) => e.itemId) ?? []).not.toContain("i1");
  });

  it("records a notification selection as a stop, and the arrows retrace the reading", async () => {
    const { store } = await boot({
      items: { s1: [item("np", "s1", { kind: "notifications-page", title: "Notifications", refId: "00000000000000000000000003" })] },
      notifications: [notification("n1", { title: "one" }), notification("n2", { title: "two", createdAt: 100 })],
    });
    const leaf = focused(store);
    await store.getState().openItem("np", leaf);
    await store.getState().refreshNotifications();

    await store.getState().selectNotification("np", "n1");
    await store.getState().selectNotification("np", "n2");
    expect(store.getState().notificationsSelectedId).toBe("n2");

    await store.getState().stepPaneNav(leaf, -1);
    expect(store.getState().notificationsSelectedId).toBe("n1"); // the in-pane view came back too
    await store.getState().stepPaneNav(leaf, -1);
    expect(store.getState().notificationsSelectedId).toBeNull(); // …all the way to the bare list
    await store.getState().stepPaneNav(leaf, 1);
    expect(store.getState().notificationsSelectedId).toBe("n1");
  });

  it("re-selecting the row you are already reading is not a stop", async () => {
    const { store } = await boot({
      items: { s1: [item("np", "s1", { kind: "notifications-page", title: "Notifications", refId: "00000000000000000000000003" })] },
      notifications: [notification("n1", { title: "one" })],
    });
    const leaf = focused(store);
    await store.getState().openItem("np", leaf);
    await store.getState().refreshNotifications();
    await store.getState().selectNotification("np", "n1");
    const depth = store.getState().paneHistory[leaf]!.entries.length;
    await store.getState().selectNotification("np", "n1");
    expect(store.getState().paneHistory[leaf]!.entries).toHaveLength(depth);
  });

  it("retracing does not re-mark rows read — read state is stamped by opening, not by the arrows", async () => {
    const { api, store } = await boot({
      items: { s1: [item("np", "s1", { kind: "notifications-page", title: "Notifications", refId: "00000000000000000000000003" })] },
      notifications: [notification("n1", { title: "one" })],
    });
    const leaf = focused(store);
    await store.getState().openItem("np", leaf);
    await store.getState().refreshNotifications();
    await store.getState().selectNotification("np", "n1");
    const reads = api.calls.filter((c) => c.startsWith("markNotificationsRead")).length;
    await store.getState().stepPaneNav(leaf, -1);
    await store.getState().stepPaneNav(leaf, 1);
    expect(api.calls.filter((c) => c.startsWith("markNotificationsRead"))).toHaveLength(reads);
  });

  it("the notifications selection is USER-level: it survives a space switch, unlike the pane it was read in", async () => {
    const { store } = await boot({
      items: { s1: [item("np", "s1", { kind: "notifications-page", title: "Notifications", refId: "00000000000000000000000003" })] },
      notifications: [notification("n1", { title: "one" })],
    });
    await store.getState().openItem("np", focused(store));
    await store.getState().refreshNotifications();
    await store.getState().selectNotification("np", "n1");
    await store.getState().selectSpace("s2");
    expect(store.getState().activeSpaceId).toBe("s2");
    // The page is one page. Opening it anywhere finds the row you were reading.
    expect(store.getState().notificationsSelectedId).toBe("n1");
  });

  it("navigateInPane is a no-op for an item that is not on screen — there is no pane to record on", async () => {
    const { store } = await boot({ items: THREE });
    const before = store.getState().paneHistory;
    store.getState().navigateInPane("i2", "whatever"); // i2 exists but was never opened
    expect(store.getState().paneHistory).toBe(before);
  });
});
