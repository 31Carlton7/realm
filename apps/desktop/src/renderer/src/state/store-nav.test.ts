import { describe, expect, it } from "vitest";
import { allItems, navEntry } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, item, session, space, type FakeData } from "./store.test-fakes";

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

  it("navigateInPane is a no-op for an item that is not on screen — there is no pane to record on", async () => {
    const { store } = await boot({ items: THREE });
    const before = store.getState().paneHistory;
    store.getState().navigateInPane("i2", "whatever"); // i2 exists but was never opened
    expect(store.getState().paneHistory).toBe(before);
  });
});

/**
 * A page is opened OVER a space and carries that space's id. Making another space current used to
 * leave it pointing at the one you left — an Overview describing the wrong space, and every other page
 * a screen between you and the work, with nothing on it to say anything had moved.
 */
describe("a page overlay when another space is made current", () => {
  const TWO_SPACE_ITEMS = {
    s1: [item("i1", "s1", { kind: "session", title: "one", refId: "se1" })],
    /* The newest session is deliberately FIRST in the list and the oldest last: ordered the other way
       round, "the newest session" and "the last item" pick the same row and the assertion below
       cannot tell a real answer from a coincidence. */
    s2: [
      item("i3", "s2", { kind: "session", title: "newest", refId: "se3" }),
      item("i2", "s2", { kind: "session", title: "older", refId: "se2" }),
    ],
  };
  const SESSIONS = [
    session("se1", "s1", { updatedAt: 10 }),
    session("se2", "s2", { title: "older", updatedAt: 20 }),
    session("se3", "s2", { title: "newest", updatedAt: 99 }),
  ];

  it("re-points a space's Overview at the space you switched to", async () => {
    /* THE MUTANT: leave `pageOverlay` alone. The page keeps rendering the space you left, and the
       only thing on screen that would tell you is the name at the top of a page you just switched
       away from. */
    const { store } = await boot({ items: TWO_SPACE_ITEMS, sessions: SESSIONS });
    store.getState().openSpacePage("s1");
    expect(store.getState().pageOverlay).toEqual({ kind: "space-page", refId: "s1", spaceId: "s1" });

    await store.getState().selectSpace("s2");
    expect(store.getState().pageOverlay).toEqual({ kind: "space-page", refId: "s2", spaceId: "s2" });
  });

  it("keeps the profile page up, re-pointed at the new space's vantage", async () => {
    const { store } = await boot({ items: TWO_SPACE_ITEMS, sessions: SESSIONS });
    store.getState().openProfilePage();
    expect(store.getState().pageOverlay?.kind).toBe("profile-page");

    await store.getState().selectSpace("s2");
    expect(store.getState().pageOverlay?.kind).toBe("profile-page");
    expect(store.getState().pageOverlay?.spaceId).toBe("s2");
  });

  it("gives way from a destination page, landing on the new space's newest session", async () => {
    /* Settings, Agents, Library, Connections, Scheduled tasks: none of them is about the space being
       switched to, and switching is a request to be back in the work. THE MUTANT: close the page and
       stop — an empty space then shows "open something from the sidebar", which is the screen this
       is meant to avoid. */
    const { store } = await boot({ items: TWO_SPACE_ITEMS, sessions: SESSIONS });
    store.getState().openDestinationPage("code-review-page");
    expect(store.getState().pageOverlay).not.toBeNull();

    await store.getState().selectSpace("s2");
    expect(store.getState().pageOverlay).toBeNull();
    // `i3` is se3, updated at 99 — newer than se2's 20, and the FIRST item, not the last.
    expect(allItems(store.getState().layout!)).toContain("i3");
    expect(allItems(store.getState().layout!)).not.toContain("i2");
  });

  it("goes to a session of the space already on screen rather than moving another pane", async () => {
    /* The view already shows the older session of s2 beside s1's. Opening the newest one over the
       focused pane would rearrange — and persist — a view the user never touched. THE MUTANT: open
       the newest session unconditionally. */
    const { store } = await boot({
      items: TWO_SPACE_ITEMS,
      sessions: SESSIONS,
      spaces: [space("s1", "p1", "Versed", { layout: { type: "split", id: "R", dir: "row", sizes: [50, 50], children: [
        { type: "leaf", id: "L1", itemId: "i1" }, { type: "leaf", id: "L2", itemId: "i2" }] } }), space("s2", "p1", "Homework")],
    });
    store.getState().focusLeaf("L1");
    store.getState().openDestinationPage("code-review-page");

    await store.getState().selectSpace("s2");
    expect(store.getState().pageOverlay).toBeNull();
    expect(allItems(store.getState().layout!)).toEqual(["i1", "i2"]);
    expect(focused(store)).toBe("L2");
    expect(store.getState().activeSpaceId).toBe("s2");
  });

  it("opens ONE pane when a chat in another space is revealed from behind a page", async () => {
    /* `revealSession` opens the pane it was asked for, and nothing on the way: every space is loaded,
       so there is no switch that could land on the newest session first and open a pane nobody asked
       for. THE MUTANT: route it through selectSpace. */
    const { store } = await boot({ items: TWO_SPACE_ITEMS, sessions: SESSIONS });
    store.getState().openDestinationPage("code-review-page");

    const landed = await store.getState().revealSession("se2", "s2");
    expect(landed).toBe(true);
    expect(store.getState().pageOverlay).toBeNull();
    expect(allItems(store.getState().layout!)).toEqual(["i2"]);
    /* The end state alone cannot see this: `openItem` REPLACES the focused pane, so a landing that
       opened the newest session first is overwritten and leaves the same single pane. What it does
       leave is a stop in that pane's trail — one entry for what was asked for, two if the space
       switch opened something on the way. */
    expect(store.getState().paneHistory[focused(store)]?.entries.length ?? 0).toBe(1);
  });
});
