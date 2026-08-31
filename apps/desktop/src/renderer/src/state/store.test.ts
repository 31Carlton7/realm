import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { createAppStore, findEmptySiblingOf, hasLeafIn, patchKey, swapSplitChildrenOf, PERSIST_DEBOUNCE_MS, SETTING_LAST_AGENT, type DropEdge } from "./store";
import { allItems, findLeafOfItem, firstLeaf, sessionEvent, type Environment, type Layout, type StoredSessionEvent } from "@realm/contracts";
import { fakeApi, item, session, skillRow, space, type FakeApi } from "./store.test-fakes";

const leaf = (id: string, itemId: string | null): Layout => ({ type: "leaf", id, itemId });
const split = (id: string, dir: "row" | "col", children: Layout[]): Layout =>
  ({ type: "split", id, dir, sizes: children.map(() => 100 / children.length), children });

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("app store", () => {
  let api: FakeApi;
  beforeEach(() => { api = fakeApi(); });
  afterEach(() => { vi.useRealTimers(); });

  it("boot loads profiles and all spaces, selects the first space and loads its items", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    const s = store.getState();
    expect(s.profiles.map((p) => p.name)).toEqual(["Work", "School"]);
    expect(s.spaces.map((x) => x.name)).toEqual(["Versed", "Homework"]);
    expect(s.activeSpaceId).toBe("s1");
    expect(s.activeSpace()?.name).toBe("Versed"); expect(s.activeIndex()).toBe(0);
    expect(s.items.map((i) => i.id)).toEqual(["i1"]);
    expect(s.themePref).toBe("system");
    // a null layout materializes as a single empty leaf; items stay unopened (SPACE group)
    expect(s.layout?.type).toBe("leaf");
    expect(allItems(s.layout!)).toEqual([]);
  });

  it("boot selects the setting-persisted active space, else the first", async () => {
    const store = createAppStore({ ...api, getSetting: async (k) => (k === "ui.activeSpaceId" ? "s2" : null) });
    await store.getState().boot();
    expect(store.getState().activeSpaceId).toBe("s2");
    const store2 = createAppStore({ ...api, getSetting: async (k) => (k === "ui.activeSpaceId" ? "gone" : null) });
    await store2.getState().boot();
    expect(store2.getState().activeSpaceId).toBe("s1");
  });

  it("boot reads the theme pref; garbage falls back to system", async () => {
    const a = createAppStore({ ...api, getSetting: async (k) => (k === "ui.theme" ? "dark" : null) });
    await a.getState().boot(); expect(a.getState().themePref).toBe("dark");
    const b = createAppStore({ ...api, getSetting: async (k) => (k === "ui.theme" ? { mode: "x" } : null) });
    await b.getState().boot(); expect(b.getState().themePref).toBe("system");
  });

  it("selectSpace persists the choice under ui.activeSpaceId", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().selectSpace("s2");
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(store.getState().items).toEqual([]);
    expect(api.calls).toContain("setSetting:ui.activeSpaceId=s2");
  });

  it("nextSpace/prevSpace cycle with clamping and persist the choice", async () => {
    const set: string[] = [];
    const store = createAppStore({ ...api, setSetting: async (k, v) => { set.push(`${k}=${v}`); } });
    await store.getState().boot();                 // s1 active (first)
    await store.getState().nextSpace(); expect(store.getState().activeSpaceId).toBe("s2");
    await store.getState().nextSpace(); expect(store.getState().activeSpaceId).toBe("s2"); // clamp
    await store.getState().prevSpace(); expect(store.getState().activeSpaceId).toBe("s1");
    await store.getState().prevSpace(); expect(store.getState().activeSpaceId).toBe("s1"); // clamp
    expect(set).toContain("ui.activeSpaceId=s2");
  });

  it("createSpace appends and activates; updateSpace merges; deleteSpace moves to neighbor", async () => {
    const store = createAppStore(api); await store.getState().boot();
    await store.getState().createSpace({ name: "New", icon: "folder", profileId: "p1" });
    expect(store.getState().activeSpace()?.name).toBe("New");
    expect(store.getState().spaces.map((s) => s.name)).toEqual(["Versed", "Homework", "New"]);
    await store.getState().updateSpace({ id: store.getState().activeSpaceId!, color: "#ff0000" });
    expect(store.getState().activeSpace()?.color).toBe("#ff0000");
    await store.getState().deleteSpace(store.getState().activeSpaceId!);
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(store.getState().spaces.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("deleteSpace of the first (active) space selects the new first; deleting a non-active space keeps selection", async () => {
    const store = createAppStore(api); await store.getState().boot();
    await store.getState().deleteSpace("s2");
    expect(store.getState().activeSpaceId).toBe("s1");
    await store.getState().deleteSpace("s1");
    expect(store.getState().activeSpaceId).toBeNull();
    expect(store.getState().layout).toBeNull();
  });

  it("reorderSpaces reorders optimistically and calls the api", async () => {
    const store = createAppStore(api); await store.getState().boot();
    await store.getState().reorderSpaces(["s2", "s1"]);
    expect(store.getState().spaces.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(api.calls).toContain("reorderSpaces:s2,s1");
    expect(store.getState().activeIndex()).toBe(1);
  });

  it("reorderSpaces rolls back the optimistic order when the api rejects", async () => {
    const store = createAppStore({ ...api, reorderSpaces: async () => { throw new Error("nope"); } }); await store.getState().boot();
    await expect(store.getState().reorderSpaces(["s2", "s1"])).rejects.toThrow("nope");
    expect(store.getState().spaces.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("deleteSpace: a spaces.changed refresh landing mid-delete still ends on the neighbor", async () => {
    api.data.spaces.push(space("s3", "p1", "Third"));
    const store = createAppStore(api); await store.getState().boot();
    await store.getState().selectSpace("s3");
    // Server removes the row and broadcasts before the delete call resolves; the handler refreshes.
    const store2 = store;
    api.deleteSpace = async (id) => {
      api.data.spaces = api.data.spaces.filter((s) => s.id !== id);
      await store2.getState().refreshSpaces();
      await new Promise((r) => setTimeout(r, 10));
    };
    await store.getState().deleteSpace("s3");
    await new Promise((r) => setTimeout(r, 30));
    expect(store.getState().spaces.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(["s1", "s2"]).toContain(store.getState().activeSpaceId);
    expect(store.getState().activeSpaceId).toBe("s1"); // refreshSpaces fell back to the first; deleteSpace keeps that choice
  });

  it("deleteSpace of the active space drops a pending debounced persist instead of saving a deleted layout", async () => {
    const store = createAppStore(api); await store.getState().boot();
    await store.getState().newTerminal(); await store.getState().applyPreset("two-col");
    const splitId = store.getState().layout!.id;
    const before = api.calls.filter((c) => c.startsWith("setLayout:s1")).length;
    store.getState().resizeSplit(splitId, [10, 90]); // schedules a persist
    await store.getState().deleteSpace("s1");
    await new Promise((r) => setTimeout(r, PERSIST_DEBOUNCE_MS + 50));
    expect(api.calls.filter((c) => c.startsWith("setLayout:s1")).length).toBe(before);
    expect(store.getState().activeSpaceId).toBe("s2");
  });

  it("refreshSpaces falls back to the first space when the active one disappeared", async () => {
    const store = createAppStore(api); await store.getState().boot();
    await store.getState().selectSpace("s2");
    api.data.spaces = api.data.spaces.filter((s) => s.id !== "s2");
    await store.getState().refreshSpaces();
    expect(store.getState().activeSpaceId).toBe("s1");
    expect(store.getState().items.map((i) => i.id)).toEqual(["i1"]);
  });

  it("themePref persists", async () => {
    const set: string[] = []; const store = createAppStore({ ...api, setSetting: async (k, v) => { set.push(`${k}=${v}`); } });
    await store.getState().boot(); await store.getState().setThemePref("dark");
    expect(store.getState().themePref).toBe("dark"); expect(set).toContain("ui.theme=dark");
  });

  it("updateItem merges the returned item (pin/rename)", async () => {
    const store = createAppStore(api); await store.getState().boot();
    await store.getState().updateItem({ id: "i1", pinned: true, title: "GitHub" });
    expect(store.getState().items[0]).toMatchObject({ id: "i1", pinned: true, title: "GitHub" });
  });

  it("palette and sheet flags toggle", async () => {
    const store = createAppStore(api);
    store.getState().setPaletteOpen(true); expect(store.getState().paletteOpen).toBe(true);
    store.getState().openSheet({ kind: "space-settings", spaceId: "s1" });
    expect(store.getState().sheet).toEqual({ kind: "space-settings", spaceId: "s1" });
    store.getState().closeSheet(); expect(store.getState().sheet).toBeNull();
  });

  it("newTerminal creates the item, opens it into the focused leaf, persists layout", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().newTerminal();
    const s = store.getState();
    expect(s.items).toHaveLength(2);
    expect(api.calls.some((c) => c.startsWith("setLayout:s1"))).toBe(true);
    const created = s.items.find((i) => i.id !== "i1")!.id;
    expect(allItems(s.layout!)).toEqual([created]); // opened once; i1 stays unopened
    expect(s.focusedLeafId).toBe(findLeafOfItem(s.layout!, created)!.id);
  });

  it("persist merges the returned Space so a later selectSpace seeds from the newest layout", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().newTerminal();
    const { activeSpaceId, layout, spaces } = store.getState();
    expect(spaces.find((s) => s.id === activeSpaceId)!.layout).toEqual(layout);
  });

  it("deleteItem deletes the item (server closes the pty), removes it from the layout, disposes the local terminal", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i1");
    await store.getState().splitFocused("row");
    await store.getState().newTerminal(); // a second pane, so this delete is not a close-to-empty
    const before = api.calls.filter((c) => c.startsWith("setLayout:s1")).length;
    await store.getState().deleteItem("i1");
    expect(store.getState().items.map((i) => i.id)).not.toContain("i1");
    expect(allItems(store.getState().layout!)).not.toContain("i1");
    expect(api.calls).toContain("deleteItem:i1");
    expect(api.disposed).toEqual(["i1"]);
    // deleteItem delegates the layout write entirely to closeFromLayout — exactly one persist, not two.
    expect(api.calls.filter((c) => c.startsWith("setLayout:s1")).length).toBe(before + 1);
  });

  it("closeFromLayout removes the item from the layout only — no server delete, no dispose, item kept", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i1");
    await store.getState().splitFocused("row");
    await store.getState().newTerminal(); // a second pane, so this close is not a close-to-empty
    expect(allItems(store.getState().layout!)).toContain("i1");
    const persists = api.calls.filter((c) => c.startsWith("setLayout:s1")).length;
    await store.getState().closeFromLayout("i1");
    expect(allItems(store.getState().layout!)).not.toContain("i1");
    expect(store.getState().items.map((i) => i.id)).toContain("i1"); // back in the SPACE group
    expect(api.calls.filter((c) => c.startsWith("deleteItem"))).toEqual([]);
    expect(api.disposed).toEqual([]);
    expect(api.calls.filter((c) => c.startsWith("setLayout:s1")).length).toBe(persists + 1); // the close itself persisted
  });

  describe("closing the last pane", () => {
    it("opens a fresh session rather than leaving an empty layout", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      await store.getState().openItem("i1");
      await store.getState().closeFromLayout("i1");
      // The closed item is gone from the layout but a new session took its place.
      const open = allItems(store.getState().layout!);
      expect(open).toHaveLength(1);
      expect(open).not.toContain("i1");
      expect(api.calls.filter((c) => c.startsWith("createSession"))).toHaveLength(1);
      expect(store.getState().items.map((i) => i.id)).toContain("i1"); // close is not delete
    });

    it("uses the last-used agent, like every other create path", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      await store.getState().setDefaultAgent("codex");
      await store.getState().openItem("i1");
      await store.getState().closeFromLayout("i1");
      expect(api.calls).toContain("createSession:codex");
    });

    it("deleting the last item also lands in a fresh session", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      await store.getState().openItem("i1");
      await store.getState().deleteItem("i1");
      expect(allItems(store.getState().layout!)).toHaveLength(1);
      expect(api.calls.filter((c) => c.startsWith("createSession"))).toHaveLength(1);
    });

    it("closing a pane that is not the last one creates nothing", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      await store.getState().openItem("i1");
      await store.getState().splitFocused("row");
      await store.getState().newTerminal();
      await store.getState().closeFromLayout("i1");
      expect(api.calls.filter((c) => c.startsWith("createSession"))).toEqual([]);
    });

    it("a reconcile that empties the layout does not manufacture a session", async () => {
      // The guard that matters: reconcileLayout prunes items the server no longer reports, and a
      // hiccup there must not spawn sessions. Only the deliberate close path creates.
      const store = createAppStore(api);
      await store.getState().boot();
      await store.getState().openItem("i1");
      api.data.items["s1"] = [];               // the item vanished server-side
      await store.getState().refreshItems();
      expect(allItems(store.getState().layout!)).toEqual([]);
      expect(api.calls.filter((c) => c.startsWith("createSession"))).toEqual([]);
    });
  });

  it("applyPreset rebuilds layout, refocuses the first leaf, and persists", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().newTerminal();
    const staleFocus = store.getState().focusedLeafId; // leaf id from the pre-preset layout
    await store.getState().applyPreset("two-col");
    expect(store.getState().layout?.type).toBe("split");
    expect(store.getState().focusedLeafId).toBe(firstLeaf(store.getState().layout!).id);
    expect(store.getState().focusedLeafId).not.toBe(staleFocus); // gridPreset mints fresh leaf ids
  });

  it("linkProject adds a project to the active space", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().linkProject("/tmp/versed");
    expect(store.getState().projects.map((p) => p.name)).toEqual(["versed"]);
  });

  it("pickAndLinkProject uses the picker; a cancelled picker links nothing", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().pickAndLinkProject();
    expect(store.getState().projects.map((p) => p.rootPath)).toEqual(["/tmp/picked-repo"]);
    api.pickFolder = async () => null;
    await store.getState().pickAndLinkProject();
    expect(store.getState().projects).toHaveLength(1);
  });

  describe("create race: items.changed refresh lands before terminals.create resolves", () => {
    it("newTerminal after splitFocused lands the item exactly once, in the fresh leaf", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      await store.getState().openItem("i1");
      const originalLeaf = store.getState().focusedLeafId!;
      await store.getState().splitFocused("row");
      const freshLeaf = store.getState().focusedLeafId!;
      api.delays["createTerminal"] = 20;
      // The event handler refreshes items before create resolves; prune-only reconcile must not force-open.
      api.onCreateTerminal = () => { void store.getState().refreshItems(); };
      await store.getState().newTerminal();
      const l = store.getState().layout!;
      expect(l.type).toBe("split");
      const newId = store.getState().items.find((i) => i.id !== "i1")!.id;
      expect(allItems(l).filter((t) => t === newId)).toHaveLength(1);
      expect(findLeafOfItem(l, newId)!.id).toBe(freshLeaf);
      expect(findLeafOfItem(l, "i1")!.id).toBe(originalLeaf);
    });

    it("newTerminal into a target leaf still opens the item exactly once, there", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      await store.getState().newTerminal();
      await store.getState().applyPreset("two-col");
      const l0 = store.getState().layout!; if (l0.type !== "split") throw new Error();
      const secondLeaf = l0.children[1]!.id;
      api.delays["createTerminal"] = 20;
      api.onCreateTerminal = () => { void store.getState().refreshItems(); };
      await store.getState().newTerminal(secondLeaf);
      const l = store.getState().layout!;
      const newId = store.getState().items.at(-1)!.id;
      expect(allItems(l).filter((t) => t === newId)).toHaveLength(1);
      expect(findLeafOfItem(l, newId)!.id).toBe(secondLeaf);
      expect(store.getState().focusedLeafId).toBe(secondLeaf);
    });
  });

  describe("staleness guards", () => {
    it("select A then B quickly: final state is B's data only (items, projects)", async () => {
      api.data.items["s2"] = [item("i2", "s2")];
      const store = createAppStore(api);
      await store.getState().boot();
      api.delays["listItems:s1"] = 30; api.delays["listProjects:s1"] = 30;
      const a = store.getState().selectSpace("s1");
      const b = store.getState().selectSpace("s2");
      await Promise.all([a, b]);
      await new Promise((r) => setTimeout(r, 60));
      const s = store.getState();
      expect(s.activeSpaceId).toBe("s2");
      expect(s.items.map((i) => i.id)).toEqual(["i2"]);
      expect(allItems(s.layout!)).toEqual([]); // nothing force-opened
    });

    it("selectSpace A then B: slow A responses are dropped", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      await store.getState().createSpace({ name: "Second", icon: "folder", profileId: "p1" });
      const s2id = store.getState().activeSpaceId!;
      api.delays["listItems:s1"] = 30; api.delays["listProjects:s1"] = 30;
      const a = store.getState().selectSpace("s1");
      const b = store.getState().selectSpace(s2id);
      await Promise.all([a, b]);
      await new Promise((r) => setTimeout(r, 60));
      expect(store.getState().activeSpaceId).toBe(s2id);
      expect(store.getState().items).toEqual([]);
      expect(allItems(store.getState().layout!)).toEqual([]);
    });
  });

  describe("stale reconcile / spontaneous persist guards", () => {
    /** Replace listItems for one call with a promise that snapshots the space's items NOW (like a real
     *  server serializing at query time) but resolves only when released — an out-of-order response. */
    const gateNextListItems = () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const base = api.listItems;
      let first = true;
      api.listItems = async (sid) => {
        if (!first) return base(sid);
        first = false;
        const snap = [...(api.data.items[sid] ?? [])];
        await gate;
        return snap;
      };
      return release;
    };

    it("a stale listItems response resolving after newTerminal opened the item does not prune it", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      await store.getState().openItem("i1");
      await store.getState().splitFocused("row");
      // An items refresh is in flight (e.g. items.changed handler); its response predates the terminal
      // creation and — the Api makes no ordering promise — resolves after adoptItem opened the new item.
      const release = gateNextListItems();
      const stale = store.getState().refreshItems(); // snapshots [i1]
      await store.getState().newTerminal();          // creates + opens the new item via a fresh fetch
      const fresh = store.getState().items.map((i) => i.id);
      const newId = fresh.find((id) => id !== "i1")!;
      expect(allItems(store.getState().layout!)).toContain(newId);
      release(); await stale; await tick();
      // The stale response must be dropped: nothing pruned, items not rolled back.
      expect(allItems(store.getState().layout!)).toContain(newId);
      expect(allItems(store.getState().layout!)).toContain("i1");
      expect(store.getState().items.map((i) => i.id)).toEqual(fresh);
    });

    it("an older listItems response resolving after a newer one is dropped (newest fetch wins)", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      const release = gateNextListItems();
      const stale = store.getState().refreshItems(); // snapshots [i1]
      api.data.items.s1!.push(item("i2", "s1"));     // server-side change (items.changed follows)
      await store.getState().refreshItems();         // newer fetch applies [i1, i2]
      await store.getState().openItem("i2");
      release(); await stale; await tick();
      expect(store.getState().items.map((i) => i.id)).toEqual(["i1", "i2"]);
      expect(allItems(store.getState().layout!)).toEqual(["i2"]); // not pruned by the stale response
    });

    it("a mount-time onLayout size echo before the space's items load never persists", async () => {
      // The space's persisted layout has stored sizes that react-resizable-panels will normalize at
      // mount, firing onLayout → resizeSplit with different sizes before any user action.
      api.data.spaces[0]!.layout = {
        type: "split", id: "sp", dir: "col", sizes: [40, 80],
        children: [leaf("l1", "i1"), leaf("l2", null)],
      };
      api.delays["listItems:s1"] = 30;
      const store = createAppStore(api);
      const booting = store.getState().boot();
      while (!store.getState().layout) await tick(); // selectSpace seeded; items still loading
      store.getState().resizeSplit("sp", [33.33, 66.67]); // the mount echo
      await booting;
      await new Promise((r) => setTimeout(r, PERSIST_DEBOUNCE_MS + 50));
      expect(api.calls.filter((c) => c.startsWith("setLayout"))).toEqual([]); // no action → no write
      const l = store.getState().layout!; if (l.type !== "split") throw new Error("expected split");
      expect(l.sizes).toEqual([33.33, 66.67]); // echo still applied locally
    });

    it("a user resize after the space's items have loaded still persists", async () => {
      api.data.spaces[0]!.layout = {
        type: "split", id: "sp", dir: "col", sizes: [40, 80],
        children: [leaf("l1", "i1"), leaf("l2", null)],
      };
      const store = createAppStore(api);
      await store.getState().boot();
      store.getState().resizeSplit("sp", [25, 75]);
      await new Promise((r) => setTimeout(r, PERSIST_DEBOUNCE_MS + 50));
      expect(api.calls.filter((c) => c.startsWith("setLayout:s1"))).toHaveLength(1);
    });
  });

  describe("resizeSplit", () => {
    it("updates sizes functionally, ignores unchanged sizes, and persists once after the debounce", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      await store.getState().newTerminal();
      await store.getState().applyPreset("two-col");
      const splitId = store.getState().layout!.id;
      const before = api.calls.filter((c) => c.startsWith("setLayout")).length;
      vi.useFakeTimers();
      store.getState().resizeSplit(splitId, [50, 50]); // initial onLayout with unchanged sizes → no-op
      expect(api.calls.filter((c) => c.startsWith("setLayout")).length).toBe(before);
      store.getState().resizeSplit(splitId, [40, 60]);
      store.getState().resizeSplit(splitId, [30, 70]);
      store.getState().resizeSplit(splitId, [20, 80]);
      const l = store.getState().layout!; if (l.type !== "split") throw new Error();
      expect(l.sizes).toEqual([20, 80]);
      expect(api.calls.filter((c) => c.startsWith("setLayout")).length).toBe(before); // not yet
      await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS + 10);
      expect(api.calls.filter((c) => c.startsWith("setLayout")).length).toBe(before + 1);
    });

    it("a pending debounced persist is flushed before switching space", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      await store.getState().newTerminal();
      await store.getState().applyPreset("two-col");
      const splitId = store.getState().layout!.id;
      const before = api.calls.filter((c) => c.startsWith("setLayout:s1")).length;
      store.getState().resizeSplit(splitId, [10, 90]);
      await store.getState().selectSpace("s2");
      expect(api.calls.filter((c) => c.startsWith("setLayout:s1")).length).toBe(before + 1);
    });

    it("flushPersist writes a pending debounced persist immediately (pagehide seam, A-M4) and no-ops when idle", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      await store.getState().newTerminal();
      await store.getState().applyPreset("two-col");
      const splitId = store.getState().layout!.id;
      const count = () => api.calls.filter((c) => c.startsWith("setLayout:s1")).length;
      const before = count();
      await store.getState().flushPersist(); // nothing pending → no write
      expect(count()).toBe(before);
      store.getState().resizeSplit(splitId, [10, 90]); // debounce armed, not yet persisted
      expect(count()).toBe(before);
      await store.getState().flushPersist();
      expect(count()).toBe(before + 1);
      const saved = store.getState().layout!; if (saved.type !== "split") throw new Error();
      expect(saved.sizes).toEqual([10, 90]);
    });
  });

  it("run() surfaces action errors and clearError resets", async () => {
    const store = createAppStore(api);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    store.getState().run(async () => { throw new Error("boom"); });
    await tick();
    expect(store.getState().error).toBe("boom");
    expect(spy).toHaveBeenCalled();
    store.getState().clearError();
    expect(store.getState().error).toBeNull();
    spy.mockRestore();
  });

  describe("sessions", () => {
    const stored = (sessionId: string, seq: number, event: StoredSessionEvent["event"]): StoredSessionEvent => ({ seq, sessionId, event });
    const seed = () => fakeApi({
      items: { s1: [item("i1", "s1", { title: "Terminal" }), item("i2", "s1", { kind: "session", refId: "se1", title: "Fake agent session" })] },
      sessions: [session("se1", "s1", { status: "running" }), session("se9", "s2")],
      sessionEvents: { se1: [
        stored("se1", 1, sessionEvent("user_message", { text: "hi", attachments: [] })),
        stored("se1", 2, sessionEvent("assistant_text", { messageId: "m1", text: "hello" })),
      ] },
    });

    it("selectSpace loads the space's sessions and their statuses", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      expect(Object.keys(store.getState().sessions)).toEqual(["se1"]);
      expect(store.getState().sessionStatus.se1).toBe("running");
      await store.getState().selectSpace("s2");
      expect(Object.keys(store.getState().sessions)).toEqual(["se9"]);
      expect(store.getState().sessionStatus.se1).toBe("running"); // statuses are global (sidebar dots survive switching)
    });

    it("openSession fetches events after the known seq and reduces them; a second open only fetches the tail", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      await store.getState().openSession("se1");
      const e = store.getState().transcripts.se1!;
      expect(e.lastSeq).toBe(2);
      expect(e.t.blocks.map((b) => b.kind)).toEqual(["user", "assistant"]);
      expect(api.calls).toContain("sessionEvents:se1:0");
      api.data.sessionEvents.se1!.push(stored("se1", 3, sessionEvent("error", { message: "x" })));
      await store.getState().openSession("se1");
      expect(api.calls).toContain("sessionEvents:se1:2");
      expect(store.getState().transcripts.se1!.t.blocks.map((b) => b.kind)).toEqual(["user", "assistant", "error"]);
      expect(api.calls.filter((c) => c.startsWith("getSession:"))).toEqual([]);
    });

    it("openSession pages through long histories until a short page arrives", async () => {
      api = seed();
      api.data.sessionEvents.se1 = Array.from({ length: 2500 }, (_, i) => stored("se1", i + 1, sessionEvent("assistant_text", { messageId: `m${i}`, text: String(i) })));
      const store = createAppStore(api); await store.getState().boot();
      await store.getState().openSession("se1");
      const e = store.getState().transcripts.se1!;
      expect(e.lastSeq).toBe(2500);
      expect(e.t.blocks).toHaveLength(2500);
      expect(api.calls.filter((c) => c.startsWith("sessionEvents:se1:"))).toEqual(["sessionEvents:se1:0", "sessionEvents:se1:1000", "sessionEvents:se1:2000"]);
    });

    it("openSession for a session outside the loaded space fetches the session too", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      await store.getState().openSession("se9");
      expect(api.calls).toContain("getSession:se9");
      expect(store.getState().sessions.se9?.id).toBe("se9");
      expect(store.getState().sessionStatus.se9).toBe("idle");
    });

    it("applySessionEvent appends persisted events once (by seq), applies ephemeral deltas, ignores unopened sessions", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      store.getState().applySessionEvent({ ...stored("se1", 5, sessionEvent("error", { message: "early" })), ephemeral: false });
      expect(store.getState().transcripts.se1).toBeUndefined();
      await store.getState().openSession("se1");
      store.getState().applySessionEvent({ ...stored("se1", 2, sessionEvent("assistant_text", { messageId: "m1", text: "dup" })), ephemeral: false });
      expect(store.getState().transcripts.se1!.t.blocks).toHaveLength(2);
      store.getState().applySessionEvent({ ...stored("se1", -1, sessionEvent("assistant_delta", { messageId: "m2", delta: "st" })), ephemeral: true });
      store.getState().applySessionEvent({ ...stored("se1", -1, sessionEvent("assistant_delta", { messageId: "m2", delta: "ream" })), ephemeral: true });
      expect(store.getState().transcripts.se1!.t.blocks.at(-1)).toMatchObject({ kind: "assistant", text: "stream", streaming: true });
      expect(store.getState().transcripts.se1!.lastSeq).toBe(2);
      store.getState().applySessionEvent({ ...stored("se1", 3, sessionEvent("assistant_text", { messageId: "m2", text: "stream" })), ephemeral: false });
      expect(store.getState().transcripts.se1!.t.blocks.at(-1)).toMatchObject({ kind: "assistant", text: "stream", streaming: false });
      expect(store.getState().transcripts.se1!.lastSeq).toBe(3);
    });

    it("events arriving while openSession is fetching are applied after the fetched ones, in order", async () => {
      api = seed(); api.delays["sessionEvents:se1"] = 20;
      const store = createAppStore(api); await store.getState().boot();
      const p = store.getState().openSession("se1");
      store.getState().applySessionEvent({ ...stored("se1", 3, sessionEvent("error", { message: "live" })), ephemeral: false });
      store.getState().applySessionEvent({ ...stored("se1", -1, sessionEvent("assistant_delta", { messageId: "zz", delta: "dropped" })), ephemeral: true });
      await p;
      const t = store.getState().transcripts.se1!;
      expect(t.lastSeq).toBe(3);
      expect(t.t.blocks.map((b) => b.kind)).toEqual(["user", "assistant", "error"]);
    });

    it("applySessionStatus updates the status map and the cached session", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      store.getState().applySessionStatus("se1", "waiting_permission");
      expect(store.getState().sessionStatus.se1).toBe("waiting_permission");
      expect(store.getState().sessions.se1?.status).toBe("waiting_permission");
      store.getState().applySessionStatus("unknown", "idle");
      expect(store.getState().sessionStatus.unknown).toBe("idle");
    });

    it("newSession creates, opens the item into the focused leaf, persists, and opens the transcript", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      await store.getState().newSession({ agentKind: "fake", model: "fake" });
      const s = store.getState();
      expect(api.calls).toContain("createSession:fake");
      const created = Object.values(s.sessions).find((x) => x.id !== "se1")!;
      expect(created.model).toBe("fake");
      expect(s.items.some((i) => i.kind === "session" && i.refId === created.id)).toBe(true);
      const createdItemId = s.items.find((i) => i.refId === created.id)!.id;
      expect(allItems(s.layout!)).toContain(createdItemId);
      expect(s.focusedLeafId).toBe(findLeafOfItem(s.layout!, createdItemId)!.id);
      expect(api.calls.some((c) => c.startsWith("setLayout:s1"))).toBe(true);
      expect(s.transcripts[created.id]).toEqual({ lastSeq: 0, t: expect.objectContaining({ blocks: [] }) });
    });

    it("newSessionInstant asks nothing: last-used agent when there is one, Claude when there is not", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      await store.getState().newSessionInstant();
      expect(api.calls).toContain("createSession:claude"); // no memory yet → FALLBACK_AGENT
      expect(store.getState().sheet).toBeNull();
      // Creating remembers, and the memory — not the fallback — decides the next one.
      await store.getState().newSession({ agentKind: "codex" });
      expect(store.getState().lastAgentKind).toBe("codex");
      await store.getState().newSessionInstant();
      expect(api.calls.filter((c) => c === "createSession:codex")).toHaveLength(2);
      expect(api.calls.filter((c) => c === "createSession:claude")).toHaveLength(1);
      // Persisted, so it survives a relaunch rather than resetting to Claude every morning.
      expect(api.data.settings["ui.lastAgentKind"]).toBe("codex");
      const relaunched = createAppStore(api); await relaunched.getState().boot();
      expect(relaunched.getState().lastAgentKind).toBe("codex");
    });

    it("a junk ui.lastAgentKind setting degrades to the fallback instead of creating an unregistered kind", async () => {
      api = fakeApi({ settings: { "ui.lastAgentKind": "gpt-9" } });
      const store = createAppStore(api); await store.getState().boot();
      expect(store.getState().lastAgentKind).toBeNull();
      await store.getState().newSessionInstant();
      expect(api.calls).toContain("createSession:claude");
    });

    it("setSessionAgent merges the server's session back and becomes the new last-used agent", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      await store.getState().setSessionAgent("se1", "codex");
      expect(api.calls).toContain("setSessionAgent:se1=codex");
      expect(store.getState().sessions.se1?.agentKind).toBe("codex");
      expect(store.getState().lastAgentKind).toBe("codex");
      expect(api.data.settings["ui.lastAgentKind"]).toBe("codex");
    });

    it("sendMessage / interrupt / respondPermission / setSessionOptions call the api; options merge into the session", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      await store.getState().sendMessage("se1", "go");
      await store.getState().interruptSession("se1");
      await store.getState().respondPermission("se1", "r1", "allow_always");
      await store.getState().setSessionOptions("se1", { permissionMode: "plan" });
      expect(api.calls).toEqual(expect.arrayContaining(["sendMessage:se1=go", "interrupt:se1", "respondPermission:se1:r1:allow_always", "setSessionOptions:se1"]));
      expect(store.getState().sessions.se1?.permissionMode).toBe("plan");
    });

    it("probeAgents stores the probe; deleteItem on a session drops its transcript, status and session", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      await store.getState().probeAgents();
      expect(store.getState().agentProbe).toEqual([expect.objectContaining({ kind: "fake", available: true })]);
      await store.getState().openSession("se1");
      await store.getState().openItem("i2");
      await store.getState().deleteItem("i2");
      expect(store.getState().transcripts.se1).toBeUndefined();
      expect(store.getState().sessionStatus.se1).toBeUndefined();
      expect(store.getState().sessions.se1).toBeUndefined();
      expect(allItems(store.getState().layout!)).not.toContain("i2"); // last pane closed → a fresh session took the leaf
      expect(api.calls).toContain("deleteItem:i2");
    });

    it("closeFromLayout on a session item keeps the item, its transcript, session and status", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      await store.getState().openItem("i2");
      await store.getState().openSession("se1");
      await store.getState().closeFromLayout("i2");
      expect(allItems(store.getState().layout!)).not.toContain("i2"); // last pane closed → a fresh session took the leaf
      expect(store.getState().items.some((i) => i.id === "i2")).toBe(true);
      expect(store.getState().transcripts.se1).toBeDefined();
      expect(store.getState().sessions.se1).toBeDefined();
      expect(store.getState().sessionStatus.se1).toBe("running");
      expect(api.calls.filter((c) => c.startsWith("deleteItem"))).toEqual([]);
    });

    it("deleting the item while openSession is fetching leaves no transcript behind", async () => {
      api = seed(); api.delays["sessionEvents:se1"] = 20;
      const store = createAppStore(api); await store.getState().boot();
      const p = store.getState().openSession("se1");
      await store.getState().deleteItem("i2");
      await p;
      expect(store.getState().transcripts.se1).toBeUndefined();
    });

    it("refreshSessions rebuilds statuses from the list (a deleted session's status disappears)", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      store.getState().applySessionStatus("se1", "running");
      api.data.sessions = api.data.sessions.filter((s) => s.id !== "se1");
      await store.getState().refreshSessions();
      expect(store.getState().sessionStatus.se1).toBeUndefined();
      expect(store.getState().sessions.se1).toBeUndefined();
    });
  });

  describe("drafts (A-M9)", () => {
    it("setDraft stores per session id — never under another id — and survives layout close/reopen", async () => {
      const store = createAppStore(api); await store.getState().boot();
      store.getState().setDraft("se1", "half-typed thought");
      store.getState().setDraft("se2", "other");
      expect(store.getState().drafts.se1).toBe("half-typed thought");
      expect(store.getState().drafts.se2).toBe("other"); // keyed by its own id, not overwriting se1's
      // Layout-only close + reopen never touches drafts (that is the whole point of store ownership).
      store.setState({ layout: leaf("L1", "i1"), focusedLeafId: "L1" });
      await store.getState().closeFromLayout("i1");
      await store.getState().openItem("i1");
      expect(store.getState().drafts.se1).toBe("half-typed thought");
    });

    it("deleteItem on a session drops its draft; other drafts stay", async () => {
      api = fakeApi({
        items: { s1: [item("i2", "s1", { kind: "session", refId: "se1", title: "Sess" })] },
        sessions: [session("se1", "s1")],
      });
      const store = createAppStore(api); await store.getState().boot();
      store.getState().setDraft("se1", "doomed");
      store.getState().setDraft("se9", "kept");
      await store.getState().deleteItem("i2");
      expect(store.getState().drafts.se1).toBeUndefined();
      expect(store.getState().drafts.se9).toBe("kept");
    });
  });

  describe("pending attachments", () => {
    const MB = 1024 * 1024;
    const picked = (path: string, over: Partial<{ mime: string; name: string; size: number }> = {}) =>
      ({ path, mime: over.mime ?? "image/png", name: over.name ?? path.split("/").pop()!, size: over.size ?? 10 });
    /** A drop hands over real Files whose path Electron can resolve; a paste hands over one that has none. */
    const dropped = (path: string, size = 10, type = "image/png") =>
      Object.assign(new File([new Uint8Array(size)], path.split("/").pop()!, { type }), { path }) as unknown as File;
    // jsdom's File has no arrayBuffer(); the store reads one to hand the bytes to the main process.
    const pasted = (name: string, size = 10, type = "image/png") =>
      Object.assign(new File([new Uint8Array(size)], name, { type }),
        { arrayBuffer: async () => new ArrayBuffer(size) }) as unknown as File;

    const withSess = () => fakeApi({
      items: { s1: [item("i2", "s1", { kind: "session", refId: "se1", title: "Sess" })] },
      sessions: [session("se1", "s1")],
    });

    it("the picker's files land on the session that asked, keyed like drafts", async () => {
      const a = withSess();
      a.data.pickFiles = [picked("/x/a.png"), picked("/x/b.pdf", { mime: "application/pdf" })];
      const store = createAppStore(a); await store.getState().boot();
      await store.getState().attachFromPicker("se1");
      expect(store.getState().pendingAttachments.se1!.map((x) => x.path)).toEqual(["/x/a.png", "/x/b.pdf"]);
      expect(store.getState().pendingAttachments.se2).toBeUndefined();
    });

    it("a dropped file is attached by its real path; a pasted one is written out first", async () => {
      const a = withSess();
      const store = createAppStore(a); await store.getState().boot();
      await store.getState().attachFiles("se1", [dropped("/Users/me/shot.png"), pasted("image.png", 4)]);
      const paths = store.getState().pendingAttachments.se1!.map((x) => x.path);
      expect(paths[0]).toBe("/Users/me/shot.png");
      expect(paths[1]).toBe("/realm-home/tmp/attachments/aa-image.png");
      // Only the pathless one costs a write — a drop must never copy the user's file.
      expect(a.calls.filter((c) => c.startsWith("saveTempAttachment"))).toEqual(["saveTempAttachment:image.png"]);
    });

    it("refuses a file over MAX_ATTACHMENT_BYTES in the UI, naming the file and the limit", async () => {
      const a = withSess();
      a.data.pickFiles = [picked("/x/huge.png", { size: 21 * MB }), picked("/x/ok.png", { size: 3 })];
      const store = createAppStore(a); await store.getState().boot();
      await store.getState().attachFromPicker("se1");
      expect(store.getState().pendingAttachments.se1!.map((x) => x.path)).toEqual(["/x/ok.png"]);
      expect(store.getState().error).toContain("huge.png");
      expect(store.getState().error).toContain("20 MB");
      // …and it never reaches the adapter, which is where it would have thrown mid-turn.
      await store.getState().sendMessage("se1", "look");
      expect(a.sent[0]!.attachments.map((x) => x.path)).toEqual(["/x/ok.png"]);
    });

    it("accepts a file exactly at the cap — the ceiling is inclusive", async () => {
      const a = withSess();
      a.data.pickFiles = [picked("/x/edge.png", { size: 20 * MB })];
      const store = createAppStore(a); await store.getState().boot();
      await store.getState().attachFromPicker("se1");
      expect(store.getState().pendingAttachments.se1).toHaveLength(1);
      expect(store.getState().error).toBeNull();
    });

    it("the same file attached twice is one attachment", async () => {
      const a = withSess();
      const store = createAppStore(a); await store.getState().boot();
      await store.getState().attachFiles("se1", [dropped("/x/a.png")]);
      await store.getState().attachFiles("se1", [dropped("/x/a.png"), dropped("/x/b.png")]);
      expect(store.getState().pendingAttachments.se1!.map((x) => x.path)).toEqual(["/x/a.png", "/x/b.png"]);
    });

    it("a removed attachment is not sent", async () => {
      const a = withSess();
      const store = createAppStore(a); await store.getState().boot();
      await store.getState().attachFiles("se1", [dropped("/x/keep.png"), dropped("/x/drop.png")]);
      store.getState().removeAttachment("se1", "/x/drop.png");
      expect(store.getState().pendingAttachments.se1!.map((x) => x.path)).toEqual(["/x/keep.png"]);
      await store.getState().sendMessage("se1", "hi");
      expect(a.sent[0]!.attachments).toEqual([{ path: "/x/keep.png", mime: "image/png" }]);
    });

    it("removeAttachment touches only the session it names", async () => {
      const a = withSess();
      const store = createAppStore(a); await store.getState().boot();
      await store.getState().attachFiles("se1", [dropped("/x/a.png")]);
      await store.getState().attachFiles("se2", [dropped("/x/a.png")]);
      store.getState().removeAttachment("se1", "/x/a.png");
      expect(store.getState().pendingAttachments.se1).toEqual([]);
      expect(store.getState().pendingAttachments.se2).toHaveLength(1);
    });

    it("sends path+mime only, and clears the row once the send lands", async () => {
      const a = withSess();
      a.data.pickFiles = [picked("/x/a.png"), picked("/x/b.pdf", { mime: "application/pdf" })];
      const store = createAppStore(a); await store.getState().boot();
      await store.getState().attachFromPicker("se1");
      await store.getState().sendMessage("se1", "review these");
      expect(a.sent[0]).toEqual({ id: "se1", text: "review these", attachments: [
        { path: "/x/a.png", mime: "image/png" }, { path: "/x/b.pdf", mime: "application/pdf" },
      ] });
      expect(store.getState().pendingAttachments.se1).toEqual([]);
      // The NEXT message must not re-send them.
      await store.getState().sendMessage("se1", "and now");
      expect(a.sent[1]!.attachments).toEqual([]);
    });

    it("keeps the row when the send fails — the user still needs to know what they attached", async () => {
      const a = withSess();
      const store = createAppStore(a); await store.getState().boot();
      await store.getState().attachFiles("se1", [dropped("/x/a.png")]);
      a.sendMessage = async () => { throw new Error("offline"); };
      await expect(store.getState().sendMessage("se1", "hi")).rejects.toThrow("offline");
      expect(store.getState().pendingAttachments.se1!.map((x) => x.path)).toEqual(["/x/a.png"]);
    });

    it("a file attached while the send was in flight survives it", async () => {
      const a = withSess();
      const store = createAppStore(a); await store.getState().boot();
      await store.getState().attachFiles("se1", [dropped("/x/first.png")]);
      let release!: () => void;
      a.sendMessage = async (id, text, attachments) => {
        a.sent.push({ id, text, attachments });
        await new Promise<void>((r) => { release = r; });
      };
      const p = store.getState().sendMessage("se1", "hi");
      await tick();
      await store.getState().attachFiles("se1", [dropped("/x/late.png")]);
      release(); await p;
      expect(a.sent[0]!.attachments.map((x) => x.path)).toEqual(["/x/first.png"]);
      expect(store.getState().pendingAttachments.se1!.map((x) => x.path)).toEqual(["/x/late.png"]);
    });

    it("survives a layout close/reopen, exactly like the draft it is part of", async () => {
      const a = withSess();
      const store = createAppStore(a); await store.getState().boot();
      await store.getState().attachFiles("se1", [dropped("/x/a.png")]);
      store.setState({ layout: leaf("L1", "i2"), focusedLeafId: "L1" });
      await store.getState().closeFromLayout("i2");
      await store.getState().openItem("i2");
      expect(store.getState().pendingAttachments.se1!.map((x) => x.path)).toEqual(["/x/a.png"]);
    });

    it("deleteItem on a session drops its attachments; another session's stay", async () => {
      const a = withSess();
      const store = createAppStore(a); await store.getState().boot();
      await store.getState().attachFiles("se1", [dropped("/x/doomed.png")]);
      await store.getState().attachFiles("se9", [dropped("/x/kept.png")]);
      await store.getState().deleteItem("i2");
      expect(store.getState().pendingAttachments.se1).toBeUndefined();
      expect(store.getState().pendingAttachments.se9).toHaveLength(1);
    });
  });

  describe("git context (workspace.gitInfo)", () => {
    const gi = { branch: "main", additions: 2, deletions: 1, dirty: 3, ahead: 0, behind: 0 };
    const seedGit = () => fakeApi({
      items: { s1: [item("i2", "s1", { kind: "session", refId: "se1", title: "Sess" })] },
      sessions: [session("se1", "s1", { status: "running" })],
      gitInfo: { "/tmp": gi },
    });

    it("refreshGitInfo stores the result keyed by cwd; null for a non-repo", async () => {
      api = seedGit(); const store = createAppStore(api); await store.getState().boot();
      await store.getState().refreshGitInfo("/tmp");
      await store.getState().refreshGitInfo("/not-a-repo");
      expect(store.getState().gitInfo["/tmp"]).toEqual(gi);
      expect(store.getState().gitInfo["/not-a-repo"]).toBeNull();
    });

    it("a status transition to idle refreshes the session's cwd; running does not; a repeat of idle does not re-fire", async () => {
      api = seedGit(); const store = createAppStore(api); await store.getState().boot();
      const gitCalls = () => api.calls.filter((c) => c === "gitInfo:/tmp").length;
      const before = gitCalls();
      store.getState().applySessionStatus("se1", "running"); // running → running: not a finish
      await tick();
      expect(gitCalls()).toBe(before);
      store.getState().applySessionStatus("se1", "idle");
      await tick();
      expect(gitCalls()).toBe(before + 1);
      store.getState().applySessionStatus("se1", "idle"); // redundant event: no transition, no refresh
      await tick();
      expect(gitCalls()).toBe(before + 1);
      store.getState().applySessionStatus("se1", "running");
      store.getState().applySessionStatus("se1", "error"); // a crash also lands the working tree
      await tick();
      expect(gitCalls()).toBe(before + 2);
      expect(store.getState().gitInfo["/tmp"]).toEqual(gi);
    });

    it("openSession refreshes the session's cwd", async () => {
      api = seedGit(); const store = createAppStore(api); await store.getState().boot();
      const before = api.calls.filter((c) => c.startsWith("gitInfo:")).length;
      await store.getState().openSession("se1");
      await tick();
      expect(api.calls.filter((c) => c === "gitInfo:/tmp").length).toBe(before + 1);
    });

    it("space activation refreshes git for the focused leaf's session — and only for a session leaf", async () => {
      api = fakeApi({
        spaces: [
          space("s1", "p1", "Versed", { layout: leaf("L1", "i1") }),
          space("s2", "p2", "Homework", { layout: leaf("L2", "i2") }),
        ],
        items: {
          s1: [item("i1", "s1", { title: "Terminal" })],
          s2: [item("i2", "s2", { kind: "session", refId: "se2", title: "Sess" })],
        },
        sessions: [session("se2", "s2", { cwd: "/repo" })],
        gitInfo: { "/repo": gi },
      });
      const store = createAppStore(api); await store.getState().boot(); // boots into s1 (terminal focused)
      expect(api.calls.filter((c) => c.startsWith("gitInfo:"))).toEqual([]);
      await store.getState().selectSpace("s2");
      await tick();
      expect(api.calls.filter((c) => c.startsWith("gitInfo:"))).toEqual(["gitInfo:/repo"]);
      expect(store.getState().gitInfo["/repo"]).toEqual(gi);
    });
  });

  describe("single overlay slot (U-M4/V-F5)", () => {
    it("opening the palette closes any open sheet", async () => {
      const store = createAppStore(api); await store.getState().boot();
      store.getState().openSheet({ kind: "new-space" });
      expect(store.getState().sheet).toEqual({ kind: "new-space" });
      store.getState().setPaletteOpen(true);
      expect(store.getState().paletteOpen).toBe(true);
      expect(store.getState().sheet).toBeNull();
      // Closing the palette must not resurrect or re-close anything.
      store.getState().setPaletteOpen(false);
      expect(store.getState().paletteOpen).toBe(false);
      expect(store.getState().sheet).toBeNull();
    });

    it("opening a sheet closes the palette", async () => {
      const store = createAppStore(api); await store.getState().boot();
      store.getState().setPaletteOpen(true);
      expect(store.getState().paletteOpen).toBe(true);
      store.getState().openSheet({ kind: "new-space" });
      expect(store.getState().sheet).toEqual({ kind: "new-space" });
      expect(store.getState().paletteOpen).toBe(false);
    });
  });

  describe("connection state", () => {
    const stored = (sessionId: string, seq: number, event: StoredSessionEvent["event"]): StoredSessionEvent => ({ seq, sessionId, event });
    const seed = () => fakeApi({
      items: { s1: [item("i2", "s1", { kind: "session", refId: "se1", title: "Fake agent session" })] },
      sessions: [session("se1", "s1", { status: "running" })],
      sessionEvents: { se1: [stored("se1", 1, sessionEvent("user_message", { text: "hi", attachments: [] }))] },
    });

    it("starts connected; going down flips the flag without fetching anything", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      expect(store.getState().connectionState).toBe("connected");
      api.calls.length = 0;
      store.getState().applyConnectionState("reconnecting");
      expect(store.getState().connectionState).toBe("reconnecting");
      await tick();
      expect(api.calls).toEqual([]);
    });

    it("regaining the connection runs the boot-lite refresh and catches open transcripts up from lastSeq", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      await store.getState().openSession("se1");
      expect(store.getState().transcripts.se1!.lastSeq).toBe(1);
      // Events that arrived server-side while the socket was down.
      api.data.sessionEvents.se1!.push(stored("se1", 2, sessionEvent("assistant_text", { messageId: "m1", text: "welcome back" })));
      store.getState().applyConnectionState("reconnecting");
      api.calls.length = 0;
      store.getState().applyConnectionState("connected");
      expect(store.getState().connectionState).toBe("connected");
      await tick(); await tick();
      expect(api.calls).toContain("listSpaces");
      expect(api.calls).toContain("listItems:s1");
      expect(api.calls).toContain("listSessions:s1");
      expect(api.calls).toContain("sessionEvents:se1:1"); // catch-up from lastSeq, not a refetch from 0
      expect(store.getState().transcripts.se1!.lastSeq).toBe(2);
      expect(store.getState().transcripts.se1!.t.blocks.map((b) => b.kind)).toEqual(["user", "assistant"]);
    });

    it("a redundant connected notification does not refetch (refresh only fires on the reconnecting→connected edge)", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      api.calls.length = 0;
      store.getState().applyConnectionState("connected");
      await tick();
      expect(api.calls).toEqual([]);
    });
  });

  describe("arc-true layout slice", () => {
    const twoItems = () => { api.data.items.s1 = [item("i1", "s1"), item("i2", "s1")]; };

    it("reconcile prunes deleted items but never force-opens", async () => {
      twoItems();
      const store = createAppStore(api); await store.getState().boot();
      await store.getState().openItem("i1");
      await store.getState().refreshItems();
      expect(allItems(store.getState().layout!)).toEqual(["i1"]); // i2 stays unopened
      api.data.items.s1 = api.data.items.s1!.filter((i) => i.id !== "i1");
      await store.getState().refreshItems();
      expect(allItems(store.getState().layout!)).toEqual([]); // i1's leaf emptied
      expect(store.getState().items.map((i) => i.id)).toEqual(["i2"]); // i2 kept, still unopened
    });

    it("openItem replaces the focused leaf's item and focuses the leaf", async () => {
      twoItems();
      const store = createAppStore(api); await store.getState().boot();
      await store.getState().openItem("i1");
      const leafId = findLeafOfItem(store.getState().layout!, "i1")!.id;
      expect(store.getState().focusedLeafId).toBe(leafId);
      await store.getState().openItem("i2");
      expect(allItems(store.getState().layout!)).toEqual(["i2"]); // i1 displaced back to SPACE
      expect(findLeafOfItem(store.getState().layout!, "i2")!.id).toBe(leafId);
      expect(store.getState().focusedLeafId).toBe(leafId);
      expect(store.getState().items).toHaveLength(2);
    });

    it("splitFocused creates an empty sibling and focuses it; the next openItem fills it", async () => {
      twoItems();
      const store = createAppStore(api); await store.getState().boot();
      await store.getState().openItem("i1");
      const originalLeaf = store.getState().focusedLeafId!;
      await store.getState().splitFocused("row");
      const l = store.getState().layout!;
      expect(l.type).toBe("split"); if (l.type !== "split") throw new Error();
      expect(l.dir).toBe("row");
      const fresh = store.getState().focusedLeafId!;
      expect(fresh).not.toBe(originalLeaf);
      expect(l.children[1]).toEqual({ type: "leaf", id: fresh, itemId: null });
      expect(findLeafOfItem(l, "i1")!.id).toBe(originalLeaf);
      await store.getState().openItem("i2");
      expect(findLeafOfItem(store.getState().layout!, "i2")!.id).toBe(fresh);
      expect(allItems(store.getState().layout!)).toEqual(["i1", "i2"]);
      expect(api.calls.some((c) => c.startsWith("setLayout:s1"))).toBe(true);
    });

    it("openItem on an already-open item focuses its pane instead of moving it (sidebar/palette click)", async () => {
      twoItems();
      const store = createAppStore(api); await store.getState().boot();
      await store.getState().openItem("i1");
      await store.getState().splitFocused("row");
      await store.getState().openItem("i2"); // fills + focuses the fresh leaf
      const layoutBefore = store.getState().layout!;
      const i1Leaf = findLeafOfItem(layoutBefore, "i1")!.id;
      expect(store.getState().focusedLeafId).not.toBe(i1Leaf);
      const persists = api.calls.filter((c) => c.startsWith("setLayout")).length;
      await store.getState().openItem("i1"); // OPEN row / palette: "go there", not "move it here"
      const s = store.getState();
      expect(s.focusedLeafId).toBe(i1Leaf);
      expect(s.layout).toBe(layoutBefore); // same reference: no layout change
      expect(api.calls.filter((c) => c.startsWith("setLayout")).length).toBe(persists); // no persist
    });

    it("openItemAt center still moves an already-open item to the target leaf (drag keeps move semantics)", async () => {
      twoItems();
      const store = createAppStore(api); await store.getState().boot();
      await store.getState().openItem("i1");
      await store.getState().splitFocused("row");
      await store.getState().openItem("i2");
      const i2Leaf = findLeafOfItem(store.getState().layout!, "i2")!.id;
      await store.getState().openItemAt("i1", i2Leaf, "center");
      const l = store.getState().layout!;
      expect(allItems(l)).toEqual(["i1"]); // i1 moved onto i2's leaf (i2 displaced), old leaf pruned
      expect(findLeafOfItem(l, "i1")!.id).toBe(i2Leaf);
    });

    it("openItemAt center replaces the leaf's item in place", async () => {
      twoItems();
      const store = createAppStore(api); await store.getState().boot();
      await store.getState().openItem("i1");
      const leafId = store.getState().focusedLeafId!;
      await store.getState().openItemAt("i2", leafId, "center");
      const l = store.getState().layout!;
      expect(l.type).toBe("leaf");
      expect(allItems(l)).toEqual(["i2"]);
      expect(store.getState().focusedLeafId).toBe(leafId);
    });

    const edgeCases: { edge: DropEdge; dir: "row" | "col"; droppedFirst: boolean }[] = [
      { edge: "left", dir: "row", droppedFirst: true },
      { edge: "right", dir: "row", droppedFirst: false },
      { edge: "top", dir: "col", droppedFirst: true },
      { edge: "bottom", dir: "col", droppedFirst: false },
    ];
    for (const { edge, dir, droppedFirst } of edgeCases) {
      it(`openItemAt ${edge} splits ${dir} and puts the dropped item ${droppedFirst ? "first" : "second"}`, async () => {
        twoItems();
        const store = createAppStore(api); await store.getState().boot();
        await store.getState().openItem("i1");
        const leafId = store.getState().focusedLeafId!;
        await store.getState().openItemAt("i2", leafId, edge);
        const l = store.getState().layout!;
        expect(l.type).toBe("split"); if (l.type !== "split") throw new Error();
        expect(l.dir).toBe(dir);
        expect(l.children.map((c) => (c.type === "leaf" ? c.itemId : null)))
          .toEqual(droppedFirst ? ["i2", "i1"] : ["i1", "i2"]);
        expect(store.getState().focusedLeafId).toBe(findLeafOfItem(l, "i2")!.id);
        expect(api.calls.some((c) => c.startsWith("setLayout:s1"))).toBe(true);
      });
    }

    it("focusedLeafId falls back to the first leaf when its leaf is closed away", async () => {
      twoItems();
      const store = createAppStore(api); await store.getState().boot();
      await store.getState().openItem("i1");
      await store.getState().splitFocused("row");
      await store.getState().openItem("i2"); // fills + focuses the fresh leaf
      const freshLeaf = store.getState().focusedLeafId!;
      expect(freshLeaf).not.toBe(findLeafOfItem(store.getState().layout!, "i1")!.id);
      await store.getState().closeFromLayout("i2"); // prunes the focused leaf
      const s = store.getState();
      expect(hasLeafIn(s.layout!, freshLeaf)).toBe(false);
      expect(s.focusedLeafId).toBe(firstLeaf(s.layout!).id);
    });

    it("focusedLeafId falls back to the first leaf when reconcile prunes its leaf", async () => {
      twoItems();
      const store = createAppStore(api); await store.getState().boot();
      await store.getState().openItem("i1");
      await store.getState().splitFocused("row");
      await store.getState().openItem("i2");
      const freshLeaf = store.getState().focusedLeafId!;
      api.data.items.s1 = api.data.items.s1!.filter((i) => i.id !== "i2"); // deleted server-side
      await store.getState().refreshItems();
      const s = store.getState();
      expect(hasLeafIn(s.layout!, freshLeaf)).toBe(false);
      expect(s.focusedLeafId).toBe(firstLeaf(s.layout!).id);
    });

    it("openItemAt is a no-op when the item already occupies the target leaf (self-drop)", async () => {
      twoItems();
      const store = createAppStore(api); await store.getState().boot();
      await store.getState().openItem("i1");
      await store.getState().openItemAt("i2", store.getState().focusedLeafId!, "right"); // row[i1, i2]
      const before = store.getState().layout!;
      const focusBefore = store.getState().focusedLeafId;
      const persists = api.calls.filter((c) => c.startsWith("setLayout:s1")).length;
      const i1Leaf = findLeafOfItem(before, "i1")!.id;
      for (const edge of ["left", "center", "right", "top", "bottom"] as const) {
        await store.getState().openItemAt("i1", i1Leaf, edge);
      }
      expect(store.getState().layout).toBe(before); // byte-identical: the very same object, untouched
      expect(store.getState().focusedLeafId).toBe(focusBefore);
      expect(api.calls.filter((c) => c.startsWith("setLayout:s1")).length).toBe(persists); // nothing persisted
    });

    it("focusLeaf sets focusedLeafId", async () => {
      const store = createAppStore(api); await store.getState().boot();
      store.getState().focusLeaf("some-leaf");
      expect(store.getState().focusedLeafId).toBe("some-leaf");
    });
  });

  describe("selectSpace layout seeding", () => {
    it("a legacy {tabs, activeTab} layout from the Space row seeds migrated (client-side skew defense)", async () => {
      const legacy = { type: "leaf", id: "L", tabs: ["L1", "L2"], activeTab: "L2" } as unknown as Layout;
      api.data.spaces.push(space("s3", "p1", "Legacy", { layout: legacy }));
      api.data.items.s3 = [item("L1", "s3"), item("L2", "s3")];
      const store = createAppStore(api); await store.getState().boot();
      await store.getState().selectSpace("s3");
      expect(store.getState().layout).toEqual({ type: "leaf", id: "L", itemId: "L2" }); // collapsed to activeTab
      expect(allItems(store.getState().layout!)).toEqual(["L2"]); // L1 displaced to the SPACE group
      expect(store.getState().items.map((i) => i.id)).toEqual(["L1", "L2"]);
    });

    it("a corrupt layout seeds as null and reconciles to an empty leaf, items intact and unopened", async () => {
      api.data.spaces.push(space("s4", "p1", "Corrupt", { layout: { bogus: true } as unknown as Layout }));
      api.data.items.s4 = [item("C1", "s4")];
      const store = createAppStore(api); await store.getState().boot();
      await store.getState().selectSpace("s4");
      expect(store.getState().layout).toMatchObject({ type: "leaf", itemId: null });
      expect(store.getState().items.map((i) => i.id)).toEqual(["C1"]);
    });
  });

  describe("layout helpers", () => {
    it("hasLeafIn finds leaves at any depth", () => {
      const l = split("s", "row", [leaf("a", "i1"), split("s2", "col", [leaf("b", null), leaf("c", "i2")])]);
      expect(hasLeafIn(l, "a")).toBe(true);
      expect(hasLeafIn(l, "c")).toBe(true);
      expect(hasLeafIn(l, "s2")).toBe(false); // splits are not leaves
      expect(hasLeafIn(l, "zz")).toBe(false);
      expect(hasLeafIn(leaf("only", null), "only")).toBe(true);
    });

    it("findEmptySiblingOf returns the empty leaf next to the given leaf, else null", () => {
      const l = split("s", "row", [leaf("a", "i1"), leaf("b", null)]);
      expect(findEmptySiblingOf(l, "a")).toBe("b");
      expect(findEmptySiblingOf(l, "b")).toBeNull(); // its sibling holds an item
      expect(findEmptySiblingOf(l, "zz")).toBeNull();
      const nested = split("s", "row", [split("s2", "col", [leaf("a", "i1"), leaf("n", null)]), leaf("c", "i2")]);
      expect(findEmptySiblingOf(nested, "a")).toBe("n"); // finds the split that directly contains the leaf
      expect(findEmptySiblingOf(nested, "c")).toBeNull(); // c's sibling is a split, not an empty leaf
    });

    it("swapSplitChildrenOf swaps the two leaf children holding the pair, nothing else", () => {
      const l = split("root", "row", [
        split("other", "col", [leaf("x", "i9"), leaf("y", null)]),
        split("target", "row", [leaf("a", "i1"), leaf("b", "i2")]),
      ]);
      const out = swapSplitChildrenOf(l, "a", "i2");
      if (out.type !== "split") throw new Error();
      expect(out.children[0]).toEqual(split("other", "col", [leaf("x", "i9"), leaf("y", null)])); // grandchildren untouched
      expect(out.children[1]).toEqual(split("target", "row", [leaf("a", "i2"), leaf("b", "i1")]));
    });

    it("swapSplitChildrenOf after nesting applies only at the freshly created all-leaf split", () => {
      // The original leaf's side can itself become a split after nesting; the swap must target the
      // innermost split whose two children are both leaves (always true for a fresh splitLeaf result).
      const l = split("outer", "row", [
        split("inner", "col", [leaf("a", "i1"), leaf("n2", "i3")]),
        leaf("n1", "i2"),
      ]);
      // Swap for the fresh inner split (a + i3): outer's children are not both leaves, so it must recurse.
      const out = swapSplitChildrenOf(l, "a", "i3");
      if (out.type !== "split") throw new Error();
      expect(out.children[0]).toEqual(split("inner", "col", [leaf("a", "i3"), leaf("n2", "i1")]));
      expect(out.children[1]).toEqual(leaf("n1", "i2")); // sibling outside the fresh split untouched
    });

    it("swapSplitChildrenOf is a no-op when no split holds the pair as direct leaf children", () => {
      const l = split("s", "row", [split("s2", "col", [leaf("a", "i1"), leaf("b", null)]), leaf("c", "i2")]);
      expect(swapSplitChildrenOf(l, "a", "i2")).toEqual(l); // i2 is not a's direct sibling
    });
  });
});

describe("the session's terminal side panel (W4)", () => {
  afterEach(() => { vi.useRealTimers(); });
  const withSession = () => fakeApi({
    items: { s1: [item("i9", "s1", { kind: "session", title: "Fake agent session", refId: "se1" })] },
    sessions: [session("se1", "s1")],
  });

  it("is lazy: nothing reaches the server until the panel is actually opened", async () => {
    const a = withSession();
    const store = createAppStore(a);
    await store.getState().boot();
    await store.getState().openSession("se1");
    expect(a.calls.some((c) => c.startsWith("openSessionTerminal"))).toBe(false);
    expect(store.getState().terminalPanel["se1"]).toBeUndefined();
    expect(store.getState().sessionTerminals["se1"]).toBeUndefined();
  });

  it("the first open creates the terminal; closing and reopening never creates a second one", async () => {
    const a = withSession();
    const store = createAppStore(a);
    await store.getState().boot();

    await store.getState().toggleTerminalPanel("se1");
    expect(store.getState().terminalPanel["se1"]).toEqual({ open: true, width: 38 });
    expect(store.getState().sessionTerminals["se1"]).toBe("term-se1");
    expect(a.calls.filter((c) => c === "openSessionTerminal:se1")).toHaveLength(1);

    await store.getState().toggleTerminalPanel("se1");
    expect(store.getState().terminalPanel["se1"]!.open).toBe(false);
    expect(store.getState().sessionTerminals["se1"]).toBe("term-se1"); // the pty is not destroyed by hiding it

    await store.getState().toggleTerminalPanel("se1");
    expect(store.getState().terminalPanel["se1"]!.open).toBe(true);
    expect(a.calls.filter((c) => c === "openSessionTerminal:se1")).toHaveLength(1); // still one
  });

  it("two opens racing (StrictMode double-mount) still create exactly one terminal", async () => {
    const a = withSession();
    a.delays["openSessionTerminal:se1"] = 10;
    const store = createAppStore(a);
    await store.getState().boot();
    await Promise.all([store.getState().ensureSessionTerminal("se1"), store.getState().ensureSessionTerminal("se1")]);
    expect(a.calls.filter((c) => c === "openSessionTerminal:se1")).toHaveLength(1);
  });

  it("open/closed persists immediately; width persists on a trailing debounce", async () => {
    const a = withSession();
    const store = createAppStore(a);
    await store.getState().boot();
    await store.getState().toggleTerminalPanel("se1");
    vi.useFakeTimers();
    expect(a.data.settings["ui.terminalPanel"]).toEqual({ se1: { open: true, width: 38 } });

    store.getState().setTerminalPanelWidth("se1", 55);
    expect(store.getState().terminalPanel["se1"]!.width).toBe(55); // applied at once…
    expect((a.data.settings["ui.terminalPanel"] as Record<string, { width: number }>)["se1"]!.width).toBe(38); // …not yet written
    store.getState().setTerminalPanelWidth("se1", 55.001); // sub-0.01 echo: ignored, timer not re-armed
    await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS + 5);
    expect((a.data.settings["ui.terminalPanel"] as Record<string, { width: number }>)["se1"]!.width).toBe(55);
  });

  it("boot restores the persisted panel state, so reopening a session brings its terminal back", async () => {
    const a = withSession();
    a.data.settings["ui.terminalPanel"] = { se1: { open: true, width: 44 } };
    const store = createAppStore(a);
    await store.getState().boot();
    expect(store.getState().terminalPanel["se1"]).toEqual({ open: true, width: 44 });
    // Restoring state alone must not touch the server — the pane fetches the terminal when it renders.
    expect(a.calls.some((c) => c.startsWith("openSessionTerminal"))).toBe(false);
    await store.getState().ensureSessionTerminal("se1");
    expect(store.getState().sessionTerminals["se1"]).toBe("term-se1");
  });

  it("boot ignores a malformed persisted map instead of trusting it into the layout", async () => {
    const a = withSession();
    a.data.settings["ui.terminalPanel"] = { se1: { open: "yes", width: 44 }, se2: { open: true, width: "wide" }, se3: { open: true, width: 400 }, se4: 7 };
    const store = createAppStore(a);
    await store.getState().boot();
    expect(store.getState().terminalPanel).toEqual({ se2: { open: true, width: 38 }, se3: { open: true, width: 38 } });
  });

  it("deleting the session drops the panel state and disposes the renderer-side terminal", async () => {
    const a = withSession();
    const store = createAppStore(a);
    await store.getState().boot();
    await store.getState().toggleTerminalPanel("se1");
    await store.getState().deleteItem("i9");
    expect(a.disposed).toEqual(["term-se1"]); // the xterm + scrollback go with the session
    expect(store.getState().terminalPanel["se1"]).toBeUndefined();
    expect(store.getState().sessionTerminals["se1"]).toBeUndefined();
    expect(a.data.settings["ui.terminalPanel"]).toEqual({});
  });

  it("closing the session's pane from the layout keeps the terminal — that is what makes reopening a restore", async () => {
    const a = withSession();
    const store = createAppStore(a);
    await store.getState().boot();
    await store.getState().openItem("i9");
    await store.getState().toggleTerminalPanel("se1");
    await store.getState().closeFromLayout("i9");
    expect(a.disposed).toEqual([]);
    expect(store.getState().terminalPanel["se1"]).toEqual({ open: true, width: 38 });
    expect(store.getState().sessionTerminals["se1"]).toBe("term-se1");
  });
});

describe("agent probe + the install card's terminal prefill (W4)", () => {
  const withSession = () => fakeApi({
    items: { s1: [item("i9", "s1", { kind: "session", title: "Fake agent session", refId: "se1" })] },
    sessions: [session("se1", "s1")],
  });

  it("probeAgents passes force through and stores the answer", async () => {
    const a = withSession();
    const store = createAppStore(a);
    await store.getState().boot();
    await store.getState().probeAgents();
    expect(a.calls).toContain("probeAgents:false"); // the cheap, TTL-cached call
    expect(store.getState().agentProbe).toEqual([expect.objectContaining({ kind: "fake", available: true })]);

    a.data.agentProbe = [{ kind: "fake", available: false, version: null, loggedIn: null, reason: "gone" }];
    await store.getState().probeAgents(true);
    expect(a.calls).toContain("probeAgents:true"); // "Check again": past the cache
    expect(store.getState().agentProbe[0]!.available).toBe(false);
  });

  it("collapses a mount storm into one call, but never lets a cheap call satisfy a forced one", async () => {
    const a = withSession();
    a.delays["probeAgents"] = 10;
    const store = createAppStore(a);
    await store.getState().boot();
    await Promise.all([store.getState().probeAgents(), store.getState().probeAgents(), store.getState().probeAgents()]);
    expect(a.calls.filter((c) => c === "probeAgents:false")).toHaveLength(1);

    // A forced probe running alongside cheap ones is its own request — the cheap one in flight may have
    // asked the machine before the user finished installing.
    const both = Promise.all([store.getState().probeAgents(), store.getState().probeAgents(true)]);
    await both;
    expect(a.calls.filter((c) => c === "probeAgents:true")).toHaveLength(1);
    expect(a.calls.filter((c) => c === "probeAgents:false")).toHaveLength(2);
  });

  it("prefillTerminal opens the panel and TYPES the command — with no trailing newline, so nothing runs", async () => {
    const a = withSession();
    const store = createAppStore(a);
    await store.getState().boot();
    await store.getState().prefillTerminal("se1", "npm install -g @anthropic-ai/claude-code");

    expect(store.getState().terminalPanel["se1"]).toEqual({ open: true, width: 38 });
    expect(a.calls).toContain("openSessionTerminal:se1");
    const write = a.calls.find((c) => c.startsWith("prefillTerminal:"))!;
    expect(write).toBe("prefillTerminal:term-se1=npm install -g @anthropic-ai/claude-code");
    // The mutant: a trailing "\n" (or "\r") is what EXECUTES the line. Realm offers; the user presses Return.
    const data = write.slice("prefillTerminal:term-se1=".length);
    expect(data).not.toMatch(/[\r\n]/);
  });

  it("prefillTerminal reuses an already-open panel and its terminal", async () => {
    const a = withSession();
    const store = createAppStore(a);
    await store.getState().boot();
    await store.getState().toggleTerminalPanel("se1");
    a.calls.length = 0;
    await store.getState().prefillTerminal("se1", "codex login");
    expect(a.calls.filter((c) => c === "openSessionTerminal:se1")).toHaveLength(0); // already known
    expect(a.calls).toContain("prefillTerminal:term-se1=codex login");
    expect(store.getState().terminalPanel["se1"]!.open).toBe(true);
  });

  it("prefillTerminal racing the drawer's own restore effect still gets a terminal to write into", async () => {
    // Opening the panel makes TerminalDrawer mount and call ensureSessionTerminal itself. If the dedup
    // guard returned early instead of joining that call, prefillTerminal would resume with no terminal
    // id and silently write nothing — the "Open in terminal" button would do nothing at all.
    const a = withSession();
    a.delays["openSessionTerminal:se1"] = 10;
    const store = createAppStore(a);
    await store.getState().boot();
    const drawerEffect = store.getState().ensureSessionTerminal("se1"); // mounts first, in flight
    await store.getState().prefillTerminal("se1", "codex login");
    await drawerEffect;
    expect(a.calls.filter((c) => c === "openSessionTerminal:se1")).toHaveLength(1);
    expect(a.calls).toContain("prefillTerminal:term-se1=codex login");
  });

  it("setDefaultAgent writes the same setting the prompter's agent chip writes", async () => {
    const a = withSession();
    const store = createAppStore(a);
    await store.getState().boot();
    await store.getState().setDefaultAgent("codex");
    expect(store.getState().lastAgentKind).toBe("codex");
    expect(a.data.settings[SETTING_LAST_AGENT]).toBe("codex");
    // …and it is what the next instant session reaches for.
    await store.getState().newSessionInstant();
    expect(a.calls).toContain("createSession:codex");
  });

  it("booted only flips once boot has finished — onboarding must not flash on a populated home", async () => {
    const a = fakeApi();
    a.delays["listSpaces"] = 5;
    const store = createAppStore(a);
    expect(store.getState().booted).toBe(false);
    const p = store.getState().boot();
    expect(store.getState().booted).toBe(false); // spaces are still [] here — the flash window
    await p;
    expect(store.getState().booted).toBe(true);
    expect(store.getState().spaces).toHaveLength(2);
  });
});

/** Plan 7 W3: the diff pane's own item, and the refreshes that keep it honest. */
describe("diff panes", () => {
  const env: Environment = { id: "env1", spaceId: "s1", path: "/tmp/wt", branch: "realm/x", kind: "worktree", portBlockStart: 41010, createdAt: 0, updatedAt: 0 };
  const withEnv = () => fakeApi({ environments: { s1: [env] }, diffs: { "/tmp/wt": { root: "/tmp/wt", branch: "realm/x", files: [], totalFiles: 0, truncated: false } } });

  it("makes one diff item per environment and goes back to it the second time", async () => {
    const a = withEnv();
    const store = createAppStore(a);
    await store.getState().boot();
    await store.getState().openDiff("env1");
    const created = a.calls.filter((c) => c.startsWith("createItem:"));
    expect(created).toEqual(["createItem:s1|diff|env1"]);
    const itemId = store.getState().items.find((i) => i.kind === "diff")!.id;
    await store.getState().openDiff("env1");
    // A second "show changes" focuses the pane that exists; it does not accumulate panes.
    expect(a.calls.filter((c) => c.startsWith("createItem:"))).toEqual(created);
    expect(store.getState().items.filter((i) => i.kind === "diff").map((i) => i.id)).toEqual([itemId]);
  });

  it("refreshes gitInfo alongside the diff, so the prompter's chips cannot disagree with the pane", async () => {
    const a = withEnv();
    const store = createAppStore(a);
    await store.getState().boot();
    await store.getState().refreshDiff("/tmp/wt");
    expect(a.calls).toContain("diff:/tmp/wt");
    expect(a.calls).toContain("gitInfo:/tmp/wt");
  });

  it("re-reads every held diff on a workspace change, not only the one that was written", async () => {
    const a = fakeApi({ diffs: {
      "/tmp/one": { root: "/tmp/one", branch: "a", files: [], totalFiles: 0, truncated: false },
      "/tmp/two": { root: "/tmp/two", branch: "b", files: [], totalFiles: 0, truncated: false },
    } });
    const store = createAppStore(a);
    await store.getState().boot();
    await Promise.all([store.getState().refreshDiff("/tmp/one"), store.getState().refreshDiff("/tmp/two")]);
    a.calls.length = 0;
    await store.getState().refreshAllDiffs();
    // Two panes may be looking at ONE repository through two cwds; only the server knows they match.
    expect(a.calls.filter((c) => c.startsWith("diff:")).sort()).toEqual(["diff:/tmp/one", "diff:/tmp/two"]);
  });

  it("drops a patch for a file that is no longer changed", async () => {
    const a = withEnv();
    const store = createAppStore(a);
    await store.getState().boot();
    store.setState({ patches: { [patchKey("/tmp/wt", "gone.ts", false)]: {
      path: "gone.ts", oldPath: null, staged: false, binary: false, hunks: [], truncated: false, truncatedReason: null, additions: 0, deletions: 0,
    } } });
    await store.getState().refreshDiff("/tmp/wt"); // the fake's summary has no files
    expect(store.getState().patches).toEqual({});
  });

  it("clears diffs when the space changes, so a pane never opens on the previous space's tree", async () => {
    const a = withEnv();
    const store = createAppStore(a);
    await store.getState().boot();
    await store.getState().refreshDiff("/tmp/wt");
    expect(store.getState().diffs["/tmp/wt"]).not.toBeUndefined();
    await store.getState().selectSpace("s2");
    expect(store.getState().diffs).toEqual({});
    expect(store.getState().patches).toEqual({});
  });
});

describe("@-mentions in the draft (Plan 8 W4)", () => {
  const withSkills = (agentKind: "claude" | "acp:cursor" = "claude") => fakeApi({
    items: { s1: [item("i2", "s1", { kind: "session", refId: "se1", title: "Sess" })] },
    sessions: [session("se1", "s1", { agentKind })],
    skills: { s1: [skillRow("mac"), skillRow("web", { enabled: false }), skillRow("broken", { valid: false, reason: "no `name`" })] },
  });
  const ready = async (agentKind: "claude" | "acp:cursor" = "claude") => {
    const a = withSkills(agentKind);
    const store = createAppStore(a);
    await store.getState().boot();
    await store.getState().openSession("se1"); // the real path that loads the library
    return { a, store };
  };

  it("opening a skills-capable session fetches the space's library; setDraft recognises an exact enabled @id and NOTHING else", async () => {
    const { a, store } = await ready();
    expect(a.calls).toContain("listSkills:s1");
    store.getState().setDraft("se1", "use @mac now");
    expect(store.getState().draftMentions.se1).toEqual(["mac"]);
    // Disabled and invalid skills are not mentionable; neither is an email or a prefix.
    store.getState().setDraft("se1", "@web and @broken and carlton@mac and @mac-extras");
    expect(store.getState().draftMentions.se1).toEqual([]);
  });

  it("sendMessage declares the recognised mentions on the wire, from the FINAL text", async () => {
    const { a, store } = await ready();
    store.getState().setDraft("se1", "use @mac now");
    await store.getState().sendMessage("se1", "use @mac now");
    expect(a.sent[0]).toEqual({ id: "se1", text: "use @mac now", attachments: [], mentions: ["mac"] });
  });

  it("a mention-free message declares nothing — the wire shape older tests assert on is untouched", async () => {
    const { a, store } = await ready();
    await store.getState().sendMessage("se1", "plain");
    expect(a.sent[0]).toEqual({ id: "se1", text: "plain", attachments: [] });
  });

  it("a recognised mention SURVIVES the skill disappearing from the library — degradation is the server's job, not amnesia here", async () => {
    const { a, store } = await ready();
    store.getState().setDraft("se1", "@mac go");
    a.data.skills.s1 = [];
    await store.getState().refreshSkills("s1");
    // Still recognised (its token is still in the text), still declared at send: the server strips
    // the @ and does not resolve, instead of the wire carrying a literal @mac.
    store.getState().setDraft("se1", "@mac go please");
    expect(store.getState().draftMentions.se1).toEqual(["mac"]);
    await store.getState().sendMessage("se1", "@mac go please");
    expect(a.sent[0]!.mentions).toEqual(["mac"]);
  });

  it("editing the token away drops the recognition", async () => {
    const { store } = await ready();
    store.getState().setDraft("se1", "@mac go");
    store.getState().setDraft("se1", "go");
    expect(store.getState().draftMentions.se1).toEqual([]);
  });

  it("recognises nothing for an agent Realm cannot inject skills into — a Cursor draft's @ is just text", async () => {
    const { a, store } = await ready("acp:cursor");
    expect(a.calls).not.toContain("listSkills:s1"); // no picker, no fetch
    // Even with the library somehow loaded, the kind gate holds.
    await store.getState().refreshSkills("s1");
    store.getState().setDraft("se1", "use @mac now");
    expect(store.getState().draftMentions.se1).toEqual([]);
    await store.getState().sendMessage("se1", "use @mac now");
    expect(a.sent[0]).toEqual({ id: "se1", text: "use @mac now", attachments: [] });
  });

  it("deleting the session's item drops its draft mentions with the draft", async () => {
    const { store } = await ready();
    store.getState().setDraft("se1", "@mac go");
    expect(store.getState().draftMentions.se1).toEqual(["mac"]);
    await store.getState().deleteItem("i2");
    expect(store.getState().draftMentions.se1).toBeUndefined();
  });
});
