import { describe, expect, it } from "vitest";
import { allItems, findLeafOfItem, findSidePane, type Layout, type StoredView } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, item, profile, session, space } from "./store.test-fakes";

/**
 * Peek (W11b): a session looked at without being opened — a transient tab of the focused session's
 * side pane, from any space. Never written into the saved view, ended by opening its session, one at
 * a time. Every test names the one-line change that would make it fail.
 */

type Store = ReturnType<typeof createAppStore>;
const side = (store: Store) => findSidePane(store.getState().layout!, "i-lead");
/** The window's saved view — what a relaunch would restore. */
const stored = (api: ReturnType<typeof fakeApi>) => api.data.settings["ui.view:p1"] as StoredView | undefined;
/** Every item in it: on screen, and kept in a side pane off screen. */
const saved = (api: ReturnType<typeof fakeApi>) => {
  const v = stored(api);
  return v ? [...allItems(v.layout), ...Object.values(v.sidePanes).flatMap((sp) => sp.tabs)] : [];
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

  it("is never written into the saved view, and never saved as its focus", async () => {
    // THE MUTANTS: persist the view as it stands, and a relaunch restores a session nobody opened as a
    // tab of the lead's side pane; save the focused item, and it restores focus to a tab that is not there.
    const { api, store } = await mount();
    await store.getState().peekSession("other", "s2");
    await store.getState().newTab(side(store)!.id); // a write that persists, with the peek on screen
    await store.getState().peekSession("other", "s2"); // its tab in front again, with the keyboard
    expect(store.getState().focusedLeafId).toBe(side(store)!.id);
    await store.getState().focusPaneFull(side(store)!.id); // a persist with the peek focused
    expect(saved(api)).not.toContain("i-other");
    expect(saved(api)).toContain("i-lead");
    expect(stored(api)!.focusedItemId).toBe("i-lead");
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

  it("ends when its session is opened, from its own space — it becomes a pane, not a peek", async () => {
    // THE MUTANT: "go there" to the peek's tab. Its item IS on screen, so the open would only focus
    // it, and the pane would stay a peek: italic, and no prompter.
    const { store } = await mount();
    await store.getState().peekSession("other", "s2");
    await store.getState().selectSpace("s2");
    expect(store.getState().peek).toBeNull();
    expect(allItems(store.getState().layout!)).toEqual(["i-other"]);
    expect(side(store)).toBeNull();
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
  it("opens the session in the main view, in place of the one it was peeked beside", async () => {
    // THE MUTANT: keep the tab. The session would be open twice, once as a peek.
    const { api, store } = await mount();
    await store.getState().peekSession("other", "s2");
    await store.getState().openPeek();
    expect(store.getState().peek).toBeNull();
    expect(allItems(store.getState().layout!)).toEqual(["i-other"]);
    expect(store.getState().focusedLeafId).toBe(findLeafOfItem(store.getState().layout!, "i-other")!.id);
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(store.getState().keyboardFor?.sessionId).toBe("other");
    // Saved as a pane now, and the lead's side pane is gone with the peek.
    expect(saved(api)).toContain("i-other");
  });

  it("another profile's: the window switches to that profile, and the session opens there", async () => {
    const api = fakeApi({
      profiles: [profile("p1", "Work"), profile("p2", "School")],
      spaces: [space("s1", "p1", "Versed"), space("s3", "p2", "Thesis")],
      items: { s1: [item("i-lead", "s1", { kind: "session", refId: "lead" })], s3: [item("i-far", "s3", { kind: "session", refId: "far" })] },
      sessions: [session("lead", "s1"), session("far", "s3")],
    });
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i-lead");
    expect(await store.getState().peekSession("far", "s3")).toBe(true);
    expect(side(store)?.tabs).toEqual(["i-far"]);
    await store.getState().openPeek();
    expect(store.getState().activeProfileId).toBe("p2");
    expect(store.getState().peek).toBeNull();
    expect(allItems(store.getState().layout!)).toEqual(["i-far"]);
    // It never went into Work's saved view.
    expect(saved(api)).not.toContain("i-far");
  });
});
