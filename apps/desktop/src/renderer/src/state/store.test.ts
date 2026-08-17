import { describe, expect, it, beforeEach } from "vitest";
import { createAppStore, type Api } from "./store";
import { emptyLayout, type Profile, type Space, type Item } from "@realm/contracts";

const P = (id: string, name: string): Profile => ({ id, name, icon: "user", color: "#000", sortOrder: 0, createdAt: 0, updatedAt: 0 });
const S = (id: string, profileId: string, name: string): Space => ({ id, profileId, name, icon: "folder", sortOrder: 0, folderPath: "/tmp", layout: null, activeItemId: null, createdAt: 0, updatedAt: 0 });
const I = (id: string, spaceId: string): Item => ({ id, spaceId, kind: "terminal", title: "t", sortOrder: 0, pinned: false, refId: id, createdAt: 0, updatedAt: 0 });

function fakeApi(): Api & { calls: string[] } {
  const calls: string[] = [];
  const profiles = [P("p1", "Work"), P("p2", "School")];
  const spaces: Record<string, Space[]> = { p1: [S("s1", "p1", "Versed")], p2: [] };
  const items: Record<string, Item[]> = { s1: [I("i1", "s1")] };
  return {
    calls,
    listProfiles: async () => { calls.push("listProfiles"); return profiles; },
    listSpaces: async (pid) => { calls.push(`listSpaces:${pid}`); return spaces[pid] ?? []; },
    listItems: async (sid) => { calls.push(`listItems:${sid}`); return items[sid] ?? []; },
    createProfile: async (name) => { const p = P(`p${profiles.length + 1}`, name); profiles.push(p); return p; },
    createSpace: async (pid, name) => { const s = S(`s${Date.now()}`, pid, name); (spaces[pid] ??= []).push(s); return s; },
    setLayout: async (sid, layout) => { calls.push(`setLayout:${sid}`); return { ...S(sid, "p1", "x"), layout }; },
    createTerminal: async (sid) => { const it = I(`i${Date.now()}`, sid); (items[sid] ??= []).push(it); return { terminalId: it.refId, itemId: it.id }; },
    deleteItem: async (id) => { for (const k of Object.keys(items)) items[k] = items[k]!.filter((i) => i.id !== id); },
    closeTerminal: async () => {},
  };
}

describe("app store", () => {
  let api: ReturnType<typeof fakeApi>;
  beforeEach(() => { api = fakeApi(); });

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
    expect(store.getState().spaces).toEqual([]);
    expect(store.getState().activeSpaceId).toBeNull();
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

  it("closeItem removes item and tab", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().closeItem("i1");
    expect(store.getState().items).toHaveLength(0);
    expect(store.getState().layout).toEqual(expect.objectContaining({ type: "leaf", tabs: [] }));
  });

  it("applyPreset rebuilds layout and persists", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().newTerminal();
    await store.getState().applyPreset("two-col");
    expect(store.getState().layout?.type).toBe("split");
  });

  void emptyLayout;
});
