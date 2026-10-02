import { describe, expect, it } from "vitest";
import { allGroupItems, allItems, findLeafOfItem, findSidePane, type Layout } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, item, session, space } from "./store.test-fakes";

/**
 * Peek (W11b): a session looked at without being opened — a transient tab of the focused session's
 * side pane, from any space. Never written into the space's saved groups, gone on a space switch, one
 * at a time. Every test names the one-line change that would make it fail.
 */

type Store = ReturnType<typeof createAppStore>;
const side = (store: Store) => findSidePane(store.getState().layout!, "i-lead");
/** Every item the fake server holds in s1's saved groups — what a relaunch would restore. */
const saved = (api: ReturnType<typeof fakeApi>) => {
  const g = api.data.spaces.find((x) => x.id === "s1")!.groups;
  return g ? allGroupItems(g) : [];
};

/** The lead focused in s1; "Other" is a session in s2, and "Idle" an unopened one in s1. */
async function mount(over: { s2Layout?: Layout | null } = {}) {
  const api = fakeApi({
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework", { layout: over.s2Layout ?? null })],
    items: {
      s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" }), item("i-idle", "s1", { kind: "session", refId: "idle", title: "Idle" }),
        item("i-term", "s1", { kind: "terminal", title: "Terminal" })],
      s2: [item("i-other", "s2", { kind: "session", refId: "other", title: "Other" })],
    },
    sessions: [session("lead", "s1"), session("idle", "s1"), session("other", "s2", { title: "Other", status: "waiting_permission" })],
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-lead");
  return { api, store };
}

describe("peeking at a session", () => {
  it("opens another space's session as a tab of the focused session's side pane, with the keyboard", async () => {
    const { store } = await mount();
    expect(await store.getState().peekSession("other", "s2")).toBe(true);
    expect(side(store)).toMatchObject({ itemId: "i-other", tabs: ["i-other"] });
    expect(store.getState().focusedLeafId).toBe(side(store)!.id);
    expect(store.getState().peek).toMatchObject({ item: { id: "i-other", spaceId: "s2" }, owner: "i-lead" });
    expect(store.getState().activeSpaceId).toBe("s1");
    // Its row is held, so the pane has something to draw — it is in no list of this space's.
    expect(store.getState().sessions["other"]?.title).toBe("Other");
  });

  it("is never written into the space's saved groups, and never saved as its focus", async () => {
    // THE MUTANTS: persist the groups as they stand, and a relaunch restores another space's session
    // into this one's layout; save the focused item, and it restores focus to a tab that is not there.
    const { api, store } = await mount();
    await store.getState().peekSession("other", "s2");
    await store.getState().newTab(side(store)!.id); // a write that persists, with the peek on screen
    store.getState().focusLeaf(side(store)!.id);
    await store.getState().openItem("i-other"); // focus back on the peek, then a persist with it focused
    await store.getState().focusPaneFull(side(store)!.id);
    expect(saved(api)).not.toContain("i-other");
    expect(saved(api)).toContain("i-lead");
    expect(api.data.spaces.find((x) => x.id === "s1")!.activeItemId).toBe("i-lead");
  });

  it("outlives a refresh of this space's items, in whose list it is not", async () => {
    // THE MUTANT: prune it with every id the space does not hold — any other window's change to this
    // space closes the peek out from under the person reading it.
    const { store } = await mount();
    await store.getState().peekSession("other", "s2");
    await store.getState().refreshItems();
    expect(side(store)?.tabs).toEqual(["i-other"]);
    expect(store.getState().peek?.item.id).toBe("i-other");
  });

  it("keeps the session's row through a refresh of this space's sessions", async () => {
    // THE MUTANT: keep only the quick chat's row, and the pane falls back to "Loading session…".
    const { store } = await mount();
    await store.getState().peekSession("other", "s2");
    await store.getState().refreshSessions();
    expect(store.getState().sessions["other"]).toBeDefined();
  });

  it("is taken away by a space switch, even into the space whose session it was", async () => {
    // "Other" is a pane of s2's own layout. THE MUTANT: leave the peek to the layout check alone — in
    // s2 its item IS in the layout, so the pane there would stay a peek: italic, and no prompter.
    const { store } = await mount({ s2Layout: { type: "leaf", id: "L2", itemId: "i-other" } });
    await store.getState().peekSession("other", "s2");
    await store.getState().selectSpace("s2");
    expect(store.getState().peek).toBeNull();
    expect(allItems(store.getState().layout!)).toEqual(["i-other"]);
    await store.getState().selectSpace("s1");
    expect(allItems(store.getState().layout!)).toEqual(["i-lead"]);
  });

  it("is one at a time: the next peek replaces the last, as a preview tab does", async () => {
    // THE MUTANT: add each peek beside the last, and a strip fills with tabs nobody opened.
    const { store } = await mount();
    await store.getState().peekSession("other", "s2");
    await store.getState().peekSession("idle", "s1");
    expect(side(store)?.tabs).toEqual(["i-idle"]);
    expect(store.getState().peek?.item.id).toBe("i-idle");
  });

  it("ends with its tab, and leaves no stop behind for Back to put it back", async () => {
    // THE MUTANT: keep its trail. Back in the side pane would open another space's session there as
    // an ordinary tab, saved into this space for good.
    const { store } = await mount();
    await store.getState().newTab(side(store)?.id ?? null);
    const blank = store.getState().items.filter((i) => i.kind === "browser").at(-1)!.id;
    await store.getState().peekSession("other", "s2");
    await store.getState().closeFromLayout("i-other");
    expect(store.getState().peek).toBeNull();
    expect(side(store)?.tabs).toEqual([blank]);
    const stops = Object.values(store.getState().paneHistory).flatMap((h) => h.entries.map((e) => e.itemId));
    expect(stops).not.toContain("i-other");
  });

  it("goes to a session this space already has open, rather than moving it into a peek", async () => {
    // THE MUTANT: peek it regardless, and the person's own pane is pulled out of their arrangement.
    const { store } = await mount();
    await store.getState().openItemAt("i-idle", findLeafOfItem(store.getState().layout!, "i-lead")!.id, "right");
    await store.getState().openItem("i-lead");
    expect(await store.getState().peekSession("idle", "s1")).toBe(true);
    expect(store.getState().peek).toBeNull();
    expect(store.getState().focusedLeafId).toBe(findLeafOfItem(store.getState().layout!, "i-idle")!.id);
    expect(side(store)).toBeNull();
  });

  it("goes beside the session a focused side pane serves, not the first session on screen", async () => {
    // "Idle" sits left of the lead; the keyboard is in the lead's side pane, on a browser. THE MUTANT:
    // only a focused SESSION counts, and the peek grows a side pane beside Idle instead.
    const { store } = await mount();
    await store.getState().openItemAt("i-idle", findLeafOfItem(store.getState().layout!, "i-lead")!.id, "left");
    await store.getState().openItem("i-lead");
    await store.getState().newTab();
    const blank = store.getState().items.filter((i) => i.kind === "browser").at(-1)!.id;
    expect(store.getState().peekOwner()).toBe("i-lead");
    await store.getState().peekSession("other", "s2");
    expect(store.getState().peek?.owner).toBe("i-lead");
    expect(side(store)?.tabs).toEqual([blank, "i-other"]);
    expect(findSidePane(store.getState().layout!, "i-idle")).toBeNull();
  });

  it("has nowhere to go with no session on screen", async () => {
    // THE MUTANT: pick any pane as the owner, and a terminal grows a side pane of sessions.
    const { store } = await mount();
    await store.getState().openItem("i-term", findLeafOfItem(store.getState().layout!, "i-lead")!.id);
    expect(store.getState().peekOwner()).toBeNull();
    expect(await store.getState().peekSession("other", "s2")).toBe(false);
    expect(allItems(store.getState().layout!)).toEqual(["i-term"]);
  });
});

describe("opening a peek for real", () => {
  it("another space's: the peek goes, and the session opens in its own space as its row would", async () => {
    // THE MUTANT: keep the tab. The session would be open in two rooms at once, one of them a peek.
    const { api, store } = await mount();
    await store.getState().peekSession("other", "s2");
    await store.getState().openPeek();
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(store.getState().peek).toBeNull();
    expect(store.getState().focusedLeafId).toBe(findLeafOfItem(store.getState().layout!, "i-other")!.id);
    expect(saved(api)).not.toContain("i-other");
  });

  it("this space's: the tab stays where it is, and from now on is saved with the layout", async () => {
    // THE MUTANT: close it and open it the ordinary way — in the focused pane, which is the side pane
    // the peek was in, or the lead itself when that one goes with the tab.
    const { api, store } = await mount();
    await store.getState().peekSession("idle", "s1");
    await store.getState().openPeek();
    expect(store.getState().peek).toBeNull();
    expect(side(store)?.tabs).toEqual(["i-idle"]);
    expect(saved(api)).toContain("i-idle");
  });
});
