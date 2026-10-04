import { describe, expect, it, beforeEach } from "vitest";
import { createAppStore } from "./store";
import { allItems, findLeafOfItem, findSidePane, itemIdOfLeaf, primaryLeaves, type Layout, type StoredView } from "@realm/contracts";
import { fakeApi, item, profile, session, space, type FakeApi } from "./store.test-fakes";

/**
 * The window's one view (Plan 27): a pane, or a split of two, each with its own side pane, over every
 * space of the profile at once. What used to be per-space named splits — the Main group, Split 2, the
 * group bar — is gone; these are the rules that replaced them. Every test names the one-line change
 * that would make it fail.
 */

type Store = ReturnType<typeof createAppStore>;

/** Two spaces of one profile, a session in each and a session to spare in the first. */
function twoSpaces(over: Parameters<typeof fakeApi>[0] = {}) {
  return fakeApi({
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework")],
    items: {
      s1: [item("i-a", "s1", { kind: "session", refId: "a", title: "A" }), item("i-c", "s1", { kind: "session", refId: "c", title: "C" })],
      s2: [item("i-b", "s2", { kind: "session", refId: "b", title: "B" })],
    },
    sessions: [session("a", "s1", { updatedAt: 3 }), session("c", "s1", { updatedAt: 1 }), session("b", "s2", { updatedAt: 2 })],
    ...over,
  });
}

async function booted(api: FakeApi): Promise<Store> {
  const store = createAppStore(api);
  await store.getState().boot();
  return store;
}

const open = (store: Store) => allItems(store.getState().layout!);
const leafOf = (store: Store, itemId: string) => findLeafOfItem(store.getState().layout!, itemId)!.id;
const focusedItem = (store: Store) => itemIdOfLeaf(store.getState().layout, store.getState().focusedLeafId);
const viewWrites = (api: FakeApi) => api.calls.filter((c) => c.startsWith("setSetting:ui.view:p1")).length;
const stored = (api: FakeApi) => api.data.settings["ui.view:p1"] as StoredView;
/** A browser item a session's agent opened, in that session's space. */
const browser = (api: FakeApi, spaceId: string, id: string) => api.data.items[spaceId]!.push(item(id, spaceId, { kind: "browser", refId: `ref-${id}`, title: "Web" }));

/** A in the main pane with B beside it: two spaces' sessions side by side. */
async function sideBySide(api: FakeApi): Promise<Store> {
  const store = await booted(api);
  await store.getState().openItem("i-a");
  await store.getState().openItemAt("i-b", leafOf(store, "i-a"), "right");
  return store;
}

describe("the window's one view", () => {
  let api: FakeApi;
  beforeEach(() => { api = twoSpaces(); });

  it("is the mirrored `layout` field, from boot on", async () => {
    const store = await booted(api);
    expect(store.getState().view!.layout).toBe(store.getState().layout);
  });

  // The mirror is the whole reason `layout` can stay untouched everywhere else. If any action wrote
  // `layout` without `view`, the two would drift and the next persist would ship the pre-edit tree.
  it("every edit keeps `layout` and the view in step", async () => {
    const store = await booted(api);
    const agree = () => expect(store.getState().layout).toBe(store.getState().view!.layout);
    await store.getState().openItem("i-a"); agree();
    await store.getState().splitFocused("row"); agree();
    await store.getState().openItem("i-c"); agree();
    await store.getState().openItemAt("i-b", leafOf(store, "i-a"), "bottom"); agree();
    store.getState().resizeSplit(store.getState().layout!.id, [30, 70]); agree();
    store.getState().equalizeSplit(store.getState().layout!.id); agree();
    await store.getState().focusPaneFull(leafOf(store, "i-a")); agree();
    await store.getState().unfocusPane(); agree();
    await store.getState().closeFromLayout("i-b"); agree();
  });

  it("shows two sessions of two spaces side by side, and moving the keyboard between them unloads nothing", async () => {
    // THE MUTANT: tie loading to the current space again. Moving focus to B would empty A's space.
    const store = await sideBySide(api);
    expect(open(store)).toEqual(["i-a", "i-b"]);
    expect(store.getState().activeSpaceId).toBe("s2");
    api.calls.length = 0;
    store.getState().focusLeaf(leafOf(store, "i-a"));
    expect(store.getState().activeSpaceId).toBe("s1");
    store.getState().focusLeaf(leafOf(store, "i-b"));
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(store.getState().items.map((i) => i.id).sort()).toEqual(["i-a", "i-b", "i-c"]);
    expect(Object.keys(store.getState().sessions).sort()).toEqual(["a", "b", "c"]);
    expect(api.calls.filter((c) => c.startsWith("list"))).toEqual([]);
  });

  it("gives each of the two its own side pane, and keeps them apart", async () => {
    const store = await sideBySide(api);
    browser(api, "s1", "i-wa"); browser(api, "s2", "i-wb");
    await store.getState().refreshItems();
    expect(await store.getState().openInSidePane("a", "i-wa")).toBe(true);
    expect(await store.getState().openInSidePane("b", "i-wb")).toBe(true);
    expect(findSidePane(store.getState().layout!, "i-a")?.tabs).toEqual(["i-wa"]);
    expect(findSidePane(store.getState().layout!, "i-b")?.tabs).toEqual(["i-wb"]);
    // Two columns, a session and its side pane in each — never four columns in a row.
    const root = store.getState().layout!;
    expect(root.type === "split" ? root.children.length : 1).toBe(2);
    expect(primaryLeaves(root).map((p) => p.itemId)).toEqual(["i-a", "i-b"]);
  });

  it("a session's side pane leaves the screen with it, and comes back when it does", async () => {
    // THE MUTANT: leave the side pane where it was. The browser A's agent was driving would sit beside
    // C, served by nobody, and A would come back with nothing beside it.
    const store = await booted(api);
    await store.getState().openItem("i-a");
    browser(api, "s1", "i-wa");
    await store.getState().refreshItems();
    await store.getState().openInSidePane("a", "i-wa");
    store.getState().focusLeaf(leafOf(store, "i-a"));
    await store.getState().openItem("i-c");
    expect(open(store)).toEqual(["i-c"]);
    expect(store.getState().view!.sidePanes["i-a"]).toEqual({ tabs: ["i-wa"], itemId: "i-wa" });
    await store.getState().openItem("i-a");
    expect(findSidePane(store.getState().layout!, "i-a")?.tabs).toEqual(["i-wa"]);
  });

  it("opens beside: a second pane when it shows one, the other side's place when it shows two", async () => {
    const store = await booted(api);
    await store.getState().openItem("i-a");
    await store.getState().openItemBeside("i-b");
    expect(open(store)).toEqual(["i-a", "i-b"]);
    expect(focusedItem(store)).toBe("i-b");
    // From B, a third takes A's place — the side B is not.
    await store.getState().openItemBeside("i-c");
    expect(open(store)).toEqual(["i-c", "i-b"]);
    expect(focusedItem(store)).toBe("i-c");
  });

  it("a quiet open beside keeps the keyboard where it is", async () => {
    // Dispatch and agents' documents. THE MUTANT: move the focus, and the composer the user is
    // typing in loses the keyboard to a pane they did not ask to look at.
    const store = await sideBySide(api);
    store.getState().focusLeaf(leafOf(store, "i-a"));
    await store.getState().openItemBesideQuiet("i-c");
    expect(open(store)).toEqual(["i-a", "i-c"]);
    expect(focusedItem(store)).toBe("i-a");
  });

  it("clicking a row for a pane on screen goes there — focus moves, nothing else does", async () => {
    const store = await sideBySide(api);
    store.getState().focusLeaf(leafOf(store, "i-b"));
    const before = store.getState().layout;
    const writes = viewWrites(api);
    await store.getState().openItem("i-a");
    expect(store.getState().layout).toBe(before);
    expect(focusedItem(store)).toBe("i-a");
    expect(viewWrites(api)).toBe(writes);
  });

  it("a session row opens in the main pane even with the keyboard in a side pane — never as a tab there", async () => {
    // THE MUTANT: open into the focused leaf, as before. A session clicked from the sidebar would
    // become a tab of another session's side pane.
    const store = await booted(api);
    await store.getState().openItem("i-a");
    browser(api, "s1", "i-wa");
    await store.getState().refreshItems();
    await store.getState().openInSidePane("a", "i-wa", { focus: true });
    expect(store.getState().focusedLeafId).toBe(findSidePane(store.getState().layout!, "i-a")!.id);
    await store.getState().openItem("i-b");
    expect(primaryLeaves(store.getState().layout!).map((p) => p.itemId)).toEqual(["i-b"]);
    expect(focusedItem(store)).toBe("i-b");
  });

  it("closing a session keeps its side pane for later; closing a tab kept off screen forgets it", async () => {
    const store = await sideBySide(api);
    browser(api, "s1", "i-wa");
    await store.getState().refreshItems();
    await store.getState().openInSidePane("a", "i-wa");
    await store.getState().closeFromLayout("i-a");
    expect(open(store)).toEqual(["i-b"]);
    expect(store.getState().view!.sidePanes["i-a"]?.tabs).toEqual(["i-wa"]);
    await store.getState().closeFromLayout("i-wa");
    expect(store.getState().view!.sidePanes["i-a"]).toBeUndefined();
    expect(api.destroyedBrowserViews).toEqual(["ref-i-wa"]);
  });

  it("a deleted item leaves the screen and every side pane kept off screen", async () => {
    const store = await sideBySide(api);
    browser(api, "s1", "i-wa");
    await store.getState().refreshItems();
    await store.getState().openInSidePane("a", "i-wa");
    await store.getState().closeFromLayout("i-a");
    // Deleted from another window, then the broadcast's refresh.
    api.data.items.s1 = api.data.items.s1!.filter((i) => i.id !== "i-wa");
    await store.getState().refreshItems("s1");
    expect(store.getState().view!.sidePanes).toEqual({});
    api.data.items.s2 = [];
    await store.getState().refreshItems("s2");
    expect(open(store)).toEqual([]);
  });

  it("a deleted session takes the side pane it was keeping with it", async () => {
    const store = await sideBySide(api);
    browser(api, "s1", "i-wa");
    await store.getState().refreshItems();
    await store.getState().openInSidePane("a", "i-wa");
    await store.getState().closeFromLayout("i-a");
    await store.getState().deleteItem("i-a");
    expect(store.getState().view!.sidePanes["i-a"]).toBeUndefined();
  });

  describe("pane focus (fill the window)", () => {
    it("records the leaf and leaves the layout byte-identical; unfocus puts the split back", async () => {
      const store = await sideBySide(api);
      const before = store.getState().layout;
      await store.getState().focusPaneFull(leafOf(store, "i-a"));
      expect(store.getState().view!.zoomedLeafId).toBe(leafOf(store, "i-a"));
      expect(store.getState().zoomedLeafId()).toBe(leafOf(store, "i-a"));
      expect(store.getState().layout).toBe(before);
      expect(focusedItem(store)).toBe("i-a");
      await store.getState().unfocusPane();
      expect(store.getState().view!.zoomedLeafId).toBeNull();
      expect(store.getState().layout).toBe(before);
    });

    it("⌘⇧F toggles it on the focused pane", async () => {
      const store = await sideBySide(api);
      await store.getState().toggleFocusPane();
      expect(store.getState().view!.zoomedLeafId).toBe(leafOf(store, "i-b"));
      await store.getState().toggleFocusPane();
      expect(store.getState().view!.zoomedLeafId).toBeNull();
    });

    it("gives way to a pane opened behind it, rather than moving the keyboard somewhere invisible", async () => {
      const store = await sideBySide(api);
      await store.getState().focusPaneFull(leafOf(store, "i-b"));
      await store.getState().openItem("i-a");
      expect(store.getState().view!.zoomedLeafId).toBeNull();
      expect(focusedItem(store)).toBe("i-a");
    });
  });
});

describe("the view across a relaunch", () => {
  let api: FakeApi;
  beforeEach(() => { api = twoSpaces(); });

  it("round-trips: both panes, the focus, and the side panes kept off screen", async () => {
    const store = await sideBySide(api);
    browser(api, "s1", "i-wa");
    await store.getState().refreshItems();
    await store.getState().openInSidePane("a", "i-wa");
    store.getState().focusLeaf(leafOf(store, "i-a"));
    await store.getState().openItem("i-c"); // A leaves with its side pane
    await store.getState().flushPersist();
    const next = await booted(api);
    expect(allItems(next.getState().layout!)).toEqual(["i-c", "i-b"]);
    expect(focusedItem(next)).toBe("i-c");
    expect(next.getState().view!.sidePanes["i-a"]).toEqual({ tabs: ["i-wa"], itemId: "i-wa" });
  });

  it("writes focus in the same call as the layout, as an ITEM", async () => {
    // The item, not only the leaf: the same pane rebuilt into a new split gets a new leaf.
    const store = await sideBySide(api);
    store.getState().focusLeaf(leafOf(store, "i-a"));
    await store.getState().focusPaneFull(leafOf(store, "i-a"));
    expect(stored(api).focusedItemId).toBe("i-a");
    expect(stored(api).layout).toEqual(store.getState().layout);
  });

  it("is NOT moved by a later items change — another window must not take the keyboard", async () => {
    const store = await sideBySide(api);
    store.getState().focusLeaf(leafOf(store, "i-a"));
    await store.getState().refreshItems();
    expect(focusedItem(store)).toBe("i-a");
  });

  it("drops what was deleted while the app was closed, and focus falls back to the first pane", async () => {
    const store = await sideBySide(api);
    await store.getState().flushPersist();
    api.data.items.s2 = [];
    const next = await booted(api);
    expect(allItems(next.getState().layout!)).toEqual(["i-a"]);
    expect(focusedItem(next)).toBe("i-a");
  });

  it("is kept per profile: switching profile brings back that profile's own", async () => {
    api.data.profiles.push(profile("p3", "School"));
    api.data.spaces.push(space("s3", "p3", "Thesis"));
    api.data.items.s3 = [item("i-t", "s3", { kind: "session", refId: "t" })];
    api.data.sessions.push(session("t", "s3"));
    const store = await sideBySide(api);
    await store.getState().selectProfile("p3");
    expect(open(store)).toEqual([]);
    await store.getState().openItem("i-t");
    await store.getState().selectProfile("p1");
    expect(open(store)).toEqual(["i-a", "i-b"]);
    await store.getState().selectProfile("p3");
    expect(open(store)).toEqual(["i-t"]);
  });
});

describe("the current space", () => {
  let api: FakeApi;
  beforeEach(() => { api = twoSpaces(); });

  it("is the space of the session in focus — in a side pane, the session it serves", async () => {
    const store = await sideBySide(api);
    browser(api, "s1", "i-wa");
    await store.getState().refreshItems();
    await store.getState().openInSidePane("a", "i-wa", { focus: true });
    expect(store.getState().activeSpaceId).toBe("s1");
    store.getState().focusLeaf(leafOf(store, "i-b"));
    expect(store.getState().activeSpaceId).toBe("s2");
  });

  it("falls back to the one last current when the focus holds nothing", async () => {
    const store = await sideBySide(api); // B, of s2, had the keyboard last
    await store.getState().splitFocused("row"); // refused at two: still B
    await store.getState().closeFromLayout("i-a");
    await store.getState().splitFocused("row");
    expect(focusedItem(store)).toBeNull();
    expect(store.getState().activeSpaceId).toBe("s2");
  });

  it("is where a create with no space named goes, and a named space wins over it", async () => {
    // THE MUTANT: create in the current space whatever the caller named — a space section's own +
    // would make its session in whichever space had the focus.
    const store = await sideBySide(api);
    expect(store.getState().activeSpaceId).toBe("s2");
    await store.getState().newSessionInstant();
    expect(api.data.sessions.at(-1)!.spaceId).toBe("s2");
    await store.getState().newSessionInstant(null, undefined, "s1");
    expect(api.data.sessions.at(-1)!.spaceId).toBe("s1");
    await store.getState().newTerminal(null, "s1");
    expect(api.calls).toContain("createTerminal:s1");
    await store.getState().newSession({ agentKind: "fake", spaceId: "s1" });
    expect(api.data.sessions.at(-1)!.spaceId).toBe("s1");
  });

  it("a tool from a session's bar is that session's, whichever space has the focus", async () => {
    const store = await sideBySide(api);
    store.getState().focusLeaf(leafOf(store, "i-b")); // s2 current
    await store.getState().newBrowser(null, { sessionId: "a" });
    expect(api.calls).toContain("createBrowser:s1");
    expect(findSidePane(store.getState().layout!, "i-a")?.tabs).toHaveLength(1);
  });

  it("a diff opens in its checkout's space; documents in theirs", async () => {
    api.data.environments = { s1: [{ id: "env-a", spaceId: "s1", path: "/w/a", branch: "main", kind: "primary", portBlockStart: null, createdAt: 0, updatedAt: 0 }] };
    const store = await sideBySide(api);
    store.getState().focusLeaf(leafOf(store, "i-b")); // s2 current
    await store.getState().openDiff("env-a");
    expect(api.calls.some((c) => c.startsWith("createItem:s1"))).toBe(true);
    await store.getState().openDocuments("env-a");
    expect(api.calls).toContain("createDocuments:s1:env-a");
  });

  it("a fan-out runs in the space it names", async () => {
    const store = await sideBySide(api);
    await store.getState().fanOutAgents({ brief: "go", count: 2, agentKind: "fake", worktrees: false, spaceId: "s1" });
    expect(api.data.sessions.slice(-2).map((x) => x.spaceId)).toEqual(["s1", "s1"]);
  });
});

describe("work from a space that is not current", () => {
  let api: FakeApi;
  beforeEach(() => { api = twoSpaces(); });

  it("an agent's browser in another space of the profile lands in its session's side pane", async () => {
    // THE MUTANT: the old "is it the active space" gate. B's browser would only be a sidebar row.
    const store = await sideBySide(api);
    store.getState().focusLeaf(leafOf(store, "i-a")); // s1 current; B is s2's
    browser(api, "s2", "i-wb");
    await store.getState().applyAgentPaneOpened({ spaceId: "s2", itemId: "i-wb", openedBy: "b" });
    expect(findSidePane(store.getState().layout!, "i-b")?.tabs).toEqual(["i-wb"]);
    expect(focusedItem(store)).toBe("i-a");
  });

  it("an agent's terminal does the same", async () => {
    const store = await sideBySide(api);
    api.data.items.s2!.push(item("i-tb", "s2", { kind: "terminal", refId: "tb", title: "Terminal" }));
    await store.getState().applyAgentPaneOpened({ spaceId: "s2", itemId: "i-tb", openedBy: "b" });
    expect(findSidePane(store.getState().layout!, "i-b")?.tabs).toEqual(["i-tb"]);
  });

  it("another profile's opens change nothing in this window", async () => {
    api.data.spaces.push(space("s9", "p2", "Elsewhere"));
    const store = await sideBySide(api);
    const before = store.getState().layout;
    await store.getState().applyAgentPaneOpened({ spaceId: "s9", itemId: "nope", openedBy: "x" });
    await store.getState().applyAgentOpened({ spaceId: "s9", sessionId: "x", itemId: "nope" });
    expect(store.getState().layout).toBe(before);
    expect(api.calls).not.toContain("listItems:s9");
  });

  it("a space's own refresh replaces only that space's rows", async () => {
    const store = await booted(api);
    api.data.items.s2!.push(item("i-new", "s2"));
    api.calls.length = 0;
    await store.getState().refreshItems("s2");
    expect(api.calls).toEqual(["listItems:s2"]);
    expect(store.getState().items.map((i) => i.id)).toEqual(["i-a", "i-c", "i-b", "i-new"]);
  });
});

describe("no named splits", () => {
  it("leaves nothing of the old store surface behind", () => {
    const store = createAppStore(fakeApi());
    const s = store.getState() as unknown as Record<string, unknown>;
    // THE MUTANT: keep a back door to per-space arrangements — any of these is a second view.
    for (const gone of ["groups", "newPaneGroup", "activatePaneGroup", "stepPaneGroup", "moveItemToPaneGroup", "removePaneGroup", "renamePaneGroup", "movePaneGroup", "applyPreset"]) {
      expect(s[gone], gone).toBeUndefined();
    }
  });

  it("never writes a space's groups or layout — the view is a setting of the window's profile", async () => {
    const api = twoSpaces();
    const store = await sideBySide(api);
    await store.getState().splitFocused("row");
    await store.getState().flushPersist();
    expect(api.calls.some((c) => c.startsWith("setGroups") || c.startsWith("setLayout"))).toBe(false);
    expect(api.data.spaces.every((sp) => sp.groups === null && sp.layout === null)).toBe(true);
    expect((stored(api).layout as Layout).type).toBe("split");
  });
});
