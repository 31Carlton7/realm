import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { createAppStore, findEmptySiblingOf, hasLeafIn, swapSplitChildrenOf, PERSIST_DEBOUNCE_MS, type DropEdge } from "./store";
import { allItems, findLeafOfItem, firstLeaf, sessionEvent, type Layout, type StoredSessionEvent } from "@realm/contracts";
import { fakeApi, item, session, space, type FakeApi } from "./store.test-fakes";

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
    await store.getState().deleteItem("i1");
    expect(store.getState().items).toHaveLength(0);
    expect(store.getState().layout).toEqual(expect.objectContaining({ type: "leaf", itemId: null }));
    expect(api.calls).toContain("deleteItem:i1");
    expect(api.disposed).toEqual(["i1"]);
  });

  it("closeFromLayout removes the item from the layout only — no server delete, no dispose, item kept", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i1");
    expect(allItems(store.getState().layout!)).toEqual(["i1"]);
    const persists = api.calls.filter((c) => c.startsWith("setLayout:s1")).length;
    await store.getState().closeFromLayout("i1");
    expect(allItems(store.getState().layout!)).toEqual([]);
    expect(store.getState().items.map((i) => i.id)).toEqual(["i1"]); // back in the SPACE group
    expect(api.calls.filter((c) => c.startsWith("deleteItem"))).toEqual([]);
    expect(api.disposed).toEqual([]);
    expect(api.calls.filter((c) => c.startsWith("setLayout:s1")).length).toBe(persists + 1); // the close itself persisted
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
      expect(allItems(store.getState().layout!)).toEqual([]);
      expect(api.calls).toContain("deleteItem:i2");
    });

    it("closeFromLayout on a session item keeps the item, its transcript, session and status", async () => {
      api = seed(); const store = createAppStore(api); await store.getState().boot();
      await store.getState().openItem("i2");
      await store.getState().openSession("se1");
      await store.getState().closeFromLayout("i2");
      expect(allItems(store.getState().layout!)).toEqual([]);
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
