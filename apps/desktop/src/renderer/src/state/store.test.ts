import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { createAppStore, PERSIST_DEBOUNCE_MS, type Api } from "./store";
import { emptyLayout, allTabs, findLeafOfTab, type Profile, type Space, type Item, type Project } from "@realm/contracts";

const P = (id: string, name: string): Profile => ({ id, name, icon: "user", color: "#000", sortOrder: 0, createdAt: 0, updatedAt: 0 });
const S = (id: string, profileId: string, name: string): Space => ({ id, profileId, name, icon: "folder", color: "#7c6cff", sortOrder: 0, folderPath: "/tmp", layout: null, activeItemId: null, createdAt: 0, updatedAt: 0 });
const I = (id: string, spaceId: string): Item => ({ id, spaceId, kind: "terminal", title: "t", sortOrder: 0, pinned: false, refId: id, createdAt: 0, updatedAt: 0 });
const tick = () => new Promise((r) => setTimeout(r, 0));

type Fake = Api & { calls: string[]; disposed: string[]; delays: Record<string, number>; onCreateTerminal: (() => void) | null };
function fakeApi(): Fake {
  const calls: string[] = [];
  const disposed: string[] = [];
  const profiles = [P("p1", "Work"), P("p2", "School")];
  const spaces: Record<string, Space[]> = { p1: [S("s1", "p1", "Versed")], p2: [S("s2", "p2", "Homework")] };
  const items: Record<string, Item[]> = { s1: [I("i1", "s1")], s2: [I("i2", "s2")] };
  const projects: Record<string, Project[]> = {};
  let n = 100;
  const api: Fake = {
    calls, disposed, delays: {}, onCreateTerminal: null,
    listProfiles: async () => { calls.push("listProfiles"); return profiles; },
    listSpaces: async () => { calls.push("listSpaces"); await wait("listSpaces"); return Object.values(spaces).flat(); },
    listItems: async (sid) => { calls.push(`listItems:${sid}`); await wait(`listItems:${sid}`); return items[sid] ?? []; },
    listProjects: async (sid) => { calls.push(`listProjects:${sid}`); await wait(`listProjects:${sid}`); return projects[sid] ?? []; },
    createProfile: async (name) => { const p = P(`p${profiles.length + 1}`, name); profiles.push(p); return p; },
    createSpace: async (pid, name) => { const s = S(`s${++n}`, pid, name); (spaces[pid] ??= []).push(s); return s; },
    createProject: async (spaceId, name, rootPath) => { const pr: Project = { id: `pr${++n}`, spaceId, name, rootPath, defaultBranch: "main", createdAt: 0, updatedAt: 0 }; (projects[spaceId] ??= []).push(pr); return pr; },
    setLayout: async (sid, layout) => { calls.push(`setLayout:${sid}`); return { ...S(sid, "p1", "x"), layout }; },
    createTerminal: async (sid) => { const it = I(`i${++n}`, sid); (items[sid] ??= []).push(it); api.onCreateTerminal?.(); await wait("createTerminal"); return { terminalId: it.refId, itemId: it.id }; },
    deleteItem: async (id) => { calls.push(`deleteItem:${id}`); for (const k of Object.keys(items)) items[k] = items[k]!.filter((i) => i.id !== id); },
    pickFolder: async () => "/tmp/picked-repo",
    disposeTerminal: (id) => { disposed.push(id); },
  };
  const wait = (key: string) => new Promise<void>((r) => setTimeout(r, api.delays[key] ?? 0));
  return api;
}

describe("app store", () => {
  let api: Fake;
  beforeEach(() => { api = fakeApi(); });
  afterEach(() => { vi.useRealTimers(); });

  it("boot loads profiles, selects first, loads its spaces and first space's items", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    const s = store.getState();
    expect(s.profiles.map((p) => p.name)).toEqual(["Work", "School"]);
    expect(s.activeProfileId).toBe("p1");
    expect(s.spaces.map((x) => x.name)).toEqual(["Versed"]);
    expect(s.activeSpaceId).toBe("s1");
    expect(s.items.map((i) => i.id)).toEqual(["i1"]);
    // a null layout is materialized with all items as tabs
    expect(s.layout?.type).toBe("leaf");
  });

  it("selectProfile switches spaces list", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().selectProfile("p2");
    expect(store.getState().spaces.map((s) => s.id)).toEqual(["s2"]);
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(store.getState().items.map((i) => i.id)).toEqual(["i2"]);
  });

  it("newTerminal creates item, adds tab to layout, persists layout", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().newTerminal();
    const s = store.getState();
    expect(s.items).toHaveLength(2);
    expect(api.calls.some((c) => c.startsWith("setLayout:s1"))).toBe(true);
    expect(s.layout && s.layout.type === "leaf" ? s.layout.tabs.length : 0).toBe(2);
  });

  it("persist merges the returned Space so a later selectSpace seeds from the newest layout", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().newTerminal();
    const { activeSpaceId, layout, spaces } = store.getState();
    expect(spaces.find((s) => s.id === activeSpaceId)!.layout).toEqual(layout);
  });

  it("closeItem deletes the item (server closes the pty), removes the tab, disposes the local terminal", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().closeItem("i1");
    expect(store.getState().items).toHaveLength(0);
    expect(store.getState().layout).toEqual(expect.objectContaining({ type: "leaf", tabs: [] }));
    expect(api.calls).toContain("deleteItem:i1");
    expect(api.disposed).toEqual(["i1"]);
  });

  it("applyPreset rebuilds layout and persists", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().newTerminal();
    await store.getState().applyPreset("two-col");
    expect(store.getState().layout?.type).toBe("split");
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

  describe("split race: items.changed refresh lands before terminals.create resolves", () => {
    it("splitWithNewTerminal puts the tab exactly once, in the new leaf", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      api.delays["createTerminal"] = 20;
      // The event handler refreshes items (and reconciles the new item into the first leaf) before create resolves.
      api.onCreateTerminal = () => { void store.getState().refreshItems(); };
      const rootLeafId = store.getState().layout!.id;
      await store.getState().splitWithNewTerminal(rootLeafId, "row");
      const l = store.getState().layout!;
      expect(l.type).toBe("split");
      if (l.type !== "split") throw new Error();
      const newId = store.getState().items.find((i) => i.id !== "i1")!.id;
      expect(allTabs(l).filter((t) => t === newId)).toHaveLength(1);
      expect(l.children[0]).toMatchObject({ id: rootLeafId, tabs: ["i1"] });
      expect(l.children[1]).toMatchObject({ tabs: [newId], activeTab: newId });
      expect(findLeafOfTab(l, newId)!.id).not.toBe(rootLeafId);
    });

    it("newTerminal into a target leaf still yields a single tab", async () => {
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
      expect(allTabs(l).filter((t) => t === newId)).toHaveLength(1);
      expect(findLeafOfTab(l, newId)!.id).toBe(secondLeaf);
    });
  });

  describe("staleness guards", () => {
    it("select A then B quickly: final state is B's data only (spaces, items, projects)", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      api.delays["listSpaces"] = 30; api.delays["listItems:s1"] = 30; api.delays["listProjects:s1"] = 30;
      const a = store.getState().selectProfile("p1");
      const b = store.getState().selectProfile("p2");
      await Promise.all([a, b]);
      await new Promise((r) => setTimeout(r, 60));
      const s = store.getState();
      expect(s.activeProfileId).toBe("p2");
      expect(s.spaces.map((x) => x.id)).toEqual(["s2"]);
      expect(s.activeSpaceId).toBe("s2");
      expect(s.items.map((i) => i.id)).toEqual(["i2"]);
      expect(allTabs(s.layout!)).toEqual(["i2"]);
    });

    it("selectSpace A then B: slow A responses are dropped", async () => {
      const store = createAppStore(api);
      await store.getState().boot();
      await store.getState().createSpace("Second"); // s? under p1
      const s2id = store.getState().activeSpaceId!;
      api.delays["listItems:s1"] = 30; api.delays["listProjects:s1"] = 30;
      const a = store.getState().selectSpace("s1");
      const b = store.getState().selectSpace(s2id);
      await Promise.all([a, b]);
      await new Promise((r) => setTimeout(r, 60));
      expect(store.getState().activeSpaceId).toBe(s2id);
      expect(store.getState().items).toEqual([]);
      expect(allTabs(store.getState().layout!)).toEqual([]);
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
      await store.getState().selectProfile("p2");
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

  void emptyLayout;
});
