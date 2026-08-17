import { createStore, useStore, type StoreApi } from "zustand";
import {
  addTab, allTabs, emptyLayout, gridPreset, removeTab, setActiveTab, splitLeaf,
  type Item, type Layout, type PresetName, type Profile, type Space,
} from "@realm/contracts";
import { rpc } from "../rpc/client";
import { createContext, useContext } from "react";

export type Api = {
  listProfiles(): Promise<Profile[]>;
  listSpaces(profileId: string): Promise<Space[]>;
  listItems(spaceId: string): Promise<Item[]>;
  createProfile(name: string): Promise<Profile>;
  createSpace(profileId: string, name: string): Promise<Space>;
  setLayout(spaceId: string, layout: Layout): Promise<Space>;
  createTerminal(spaceId: string): Promise<{ terminalId: string; itemId: string }>;
  deleteItem(id: string): Promise<void>;
  closeTerminal(terminalId: string): Promise<void>;
};

export const liveApi = (): Api => ({
  listProfiles: () => rpc().call("profiles.list", {}),
  listSpaces: (profileId) => rpc().call("spaces.list", { profileId }),
  listItems: (spaceId) => rpc().call("items.list", { spaceId }),
  createProfile: (name) => rpc().call("profiles.create", { name }),
  createSpace: (profileId, name) => rpc().call("spaces.create", { profileId, name }),
  setLayout: (id, layout) => rpc().call("spaces.setLayout", { id, layout }),
  createTerminal: (spaceId) => rpc().call("terminals.create", { spaceId }),
  deleteItem: async (id) => { await rpc().call("items.delete", { id }); },
  closeTerminal: async (terminalId) => { await rpc().call("terminals.close", { terminalId }); },
});

export type AppState = {
  profiles: Profile[]; activeProfileId: string | null;
  spaces: Space[]; activeSpaceId: string | null;
  items: Item[]; layout: Layout | null;
  boot(): Promise<void>;
  selectProfile(id: string): Promise<void>;
  selectSpace(id: string): Promise<void>;
  createProfile(name: string): Promise<void>;
  createSpace(name: string): Promise<void>;
  refreshSpaces(): Promise<void>;
  refreshItems(): Promise<void>;
  newTerminal(targetLeafId?: string | null): Promise<void>;
  closeItem(itemId: string): Promise<void>;
  activateTab(itemId: string): Promise<void>;
  splitWithNewTerminal(leafId: string, dir: "row" | "col"): Promise<void>;
  applyPreset(name: PresetName): Promise<void>;
  setLayoutLocal(layout: Layout): void;
  persistLayout(): Promise<void>;
};

/** Ensure every item is present in the layout exactly once and no stale tabs remain. */
export function reconcileLayout(layout: Layout | null, items: Item[]): Layout {
  let l: Layout = layout ?? emptyLayout();
  const ids = new Set(items.map((i) => i.id));
  for (const t of allTabs(l)) if (!ids.has(t)) l = removeTab(l, t);
  const present = new Set(allTabs(l));
  for (const it of items) if (!present.has(it.id)) l = addTab(l, null, it.id);
  return l;
}

export function createAppStore(api: Api): StoreApi<AppState> {
  return createStore<AppState>((set, get) => {
    const persist = async () => { const { activeSpaceId, layout } = get(); if (activeSpaceId && layout) await api.setLayout(activeSpaceId, layout); };
    return {
      profiles: [], activeProfileId: null, spaces: [], activeSpaceId: null, items: [], layout: null,

      async boot() {
        const profiles = await api.listProfiles();
        set({ profiles });
        if (profiles[0]) await get().selectProfile(profiles[0].id);
      },
      async selectProfile(id) {
        set({ activeProfileId: id, activeSpaceId: null, items: [], layout: null });
        await get().refreshSpaces();
        const first = get().spaces[0];
        if (first) await get().selectSpace(first.id);
      },
      async selectSpace(id) {
        const space = get().spaces.find((s) => s.id === id);
        set({ activeSpaceId: id, layout: space?.layout ?? null, items: [] });
        await get().refreshItems();
      },
      async refreshSpaces() {
        const pid = get().activeProfileId; if (!pid) return;
        set({ spaces: await api.listSpaces(pid) });
      },
      async refreshItems() {
        const sid = get().activeSpaceId; if (!sid) return;
        const items = await api.listItems(sid);
        const layout = reconcileLayout(get().layout, items);
        set({ items, layout });
      },
      async createProfile(name) {
        const p = await api.createProfile(name);
        set({ profiles: [...get().profiles, p] });
        await get().selectProfile(p.id);
      },
      async createSpace(name) {
        const pid = get().activeProfileId; if (!pid) return;
        const s = await api.createSpace(pid, name);
        set({ spaces: [...get().spaces, s] });
        await get().selectSpace(s.id);
      },
      async newTerminal(targetLeafId = null) {
        const sid = get().activeSpaceId; if (!sid) return;
        const { itemId } = await api.createTerminal(sid);
        const items = await api.listItems(sid);
        const layout = addTab(get().layout ?? emptyLayout(), targetLeafId, itemId);
        set({ items, layout: reconcileLayout(layout, items) });
        await persist();
      },
      async closeItem(itemId) {
        const it = get().items.find((i) => i.id === itemId);
        if (it?.kind === "terminal") await api.closeTerminal(it.refId);
        await api.deleteItem(itemId);
        const items = get().items.filter((i) => i.id !== itemId);
        set({ items, layout: removeTab(get().layout ?? emptyLayout(), itemId) });
        await persist();
      },
      async activateTab(itemId) {
        set({ layout: setActiveTab(get().layout ?? emptyLayout(), itemId) });
        await persist();
      },
      async splitWithNewTerminal(leafId, dir) {
        const sid = get().activeSpaceId; if (!sid) return;
        const { itemId } = await api.createTerminal(sid);
        const items = await api.listItems(sid);
        set({ items, layout: splitLeaf(get().layout ?? emptyLayout(), leafId, dir, itemId) });
        await persist();
      },
      async applyPreset(name) {
        set({ layout: gridPreset(name, get().items.map((i) => i.id)) });
        await persist();
      },
      setLayoutLocal(layout) { set({ layout }); },
      persistLayout: persist,
    };
  });
}

export const StoreContext = createContext<StoreApi<AppState> | null>(null);
export function useApp<T>(sel: (s: AppState) => T): T {
  const store = useContext(StoreContext); if (!store) throw new Error("StoreContext missing");
  return useStore(store, sel);
}
