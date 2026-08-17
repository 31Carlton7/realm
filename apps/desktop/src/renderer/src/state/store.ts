import { createStore, useStore, type StoreApi } from "zustand";
import {
  addTab, allTabs, emptyLayout, gridPreset, removeTab, setActiveTab, splitLeaf, updateSizes,
  type Item, type Layout, type PresetName, type Profile, type Project, type Space,
} from "@realm/contracts";
import { createContext, useContext } from "react";

/** Everything the store needs from the outside world: realm-server RPC plus the two platform
 *  seams (native folder picker, local terminal disposal). Tests substitute a fake. */
export type Api = {
  listProfiles(): Promise<Profile[]>;
  listSpaces(profileId: string): Promise<Space[]>;
  listItems(spaceId: string): Promise<Item[]>;
  listProjects(spaceId: string): Promise<Project[]>;
  createProfile(name: string): Promise<Profile>;
  createSpace(profileId: string, name: string): Promise<Space>;
  createProject(spaceId: string, name: string, rootPath: string): Promise<Project>;
  setLayout(spaceId: string, layout: Layout): Promise<Space>;
  createTerminal(spaceId: string): Promise<{ terminalId: string; itemId: string }>;
  /** Deleting a terminal item closes its pty server-side. */
  deleteItem(id: string): Promise<void>;
  /** Native folder picker; resolves null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Drop the renderer-side xterm instance/scrollback for a closed terminal. */
  disposeTerminal(terminalId: string): void;
};


export const PERSIST_DEBOUNCE_MS = 300;

export type AppState = {
  profiles: Profile[]; activeProfileId: string | null;
  spaces: Space[]; activeSpaceId: string | null;
  items: Item[]; layout: Layout | null;
  projects: Project[];
  error: string | null;
  boot(): Promise<void>;
  selectProfile(id: string): Promise<void>;
  selectSpace(id: string): Promise<void>;
  createProfile(name: string): Promise<void>;
  createSpace(name: string): Promise<void>;
  refreshSpaces(): Promise<void>;
  refreshItems(): Promise<void>;
  refreshProjects(): Promise<void>;
  linkProject(rootPath: string): Promise<void>;
  pickAndLinkProject(): Promise<void>;
  newTerminal(targetLeafId?: string | null): Promise<void>;
  closeItem(itemId: string): Promise<void>;
  activateTab(itemId: string): Promise<void>;
  splitWithNewTerminal(leafId: string, dir: "row" | "col"): Promise<void>;
  applyPreset(name: PresetName): Promise<void>;
  /** Functional sizes update for one split; persisted with a trailing debounce. No-op if unchanged. */
  resizeSplit(splitId: string, sizes: number[]): void;
  setLayoutLocal(layout: Layout): void;
  persistLayout(): Promise<void>;
  /** Run an action, surfacing any rejection in `error` (and console.error). Use at UI call sites. */
  run(action: () => Promise<unknown>): void;
  clearError(): void;
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

function findSplitSizes(l: Layout, splitId: string): number[] | null {
  if (l.type === "leaf") return null;
  if (l.id === splitId) return l.sizes;
  for (const c of l.children) { const s = findSplitSizes(c, splitId); if (s) return s; }
  return null;
}
const sameSizes = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) < 0.01);

export function createAppStore(api: Api): StoreApi<AppState> {
  return createStore<AppState>((set, get) => {
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    const persist = async () => {
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
      const { activeSpaceId, layout } = get();
      if (!activeSpaceId || !layout) return;
      const saved = await api.setLayout(activeSpaceId, layout);
      // Keep the cached Space current so a later selectSpace seeds from the newest layout.
      set({ spaces: get().spaces.map((x) => (x.id === saved.id ? saved : x)) });
    };
    const schedulePersist = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => { persistTimer = null; get().run(persist); }, PERSIST_DEBOUNCE_MS);
    };
    /** Flush a pending debounced persist before the active space changes (persist reads the current space). */
    const flushPersist = async () => { if (persistTimer) await persist(); };
    const isSpace = (sid: string) => get().activeSpaceId === sid;

    return {
      profiles: [], activeProfileId: null, spaces: [], activeSpaceId: null, items: [], layout: null, projects: [], error: null,

      async boot() {
        const profiles = await api.listProfiles();
        set({ profiles });
        if (profiles[0]) await get().selectProfile(profiles[0].id);
      },
      async selectProfile(id) {
        await flushPersist();
        set({ activeProfileId: id, activeSpaceId: null, items: [], layout: null, projects: [], error: null });
        await get().refreshSpaces();
        if (get().activeProfileId !== id) return; // superseded by a later selection
        const first = get().spaces[0];
        if (first) await get().selectSpace(first.id);
      },
      async selectSpace(id) {
        await flushPersist();
        const space = get().spaces.find((s) => s.id === id);
        set({ activeSpaceId: id, layout: space?.layout ?? null, items: [], projects: [], error: null });
        await Promise.all([get().refreshProjects(), get().refreshItems()]);
      },
      async refreshSpaces() {
        const pid = get().activeProfileId; if (!pid) return;
        const spaces = await api.listSpaces(pid);
        if (get().activeProfileId === pid) set({ spaces });
      },
      async refreshItems() {
        const sid = get().activeSpaceId; if (!sid) return;
        const items = await api.listItems(sid);
        if (!isSpace(sid)) return;
        set({ items, layout: reconcileLayout(get().layout, items) });
      },
      async refreshProjects() {
        const sid = get().activeSpaceId; if (!sid) return;
        const projects = await api.listProjects(sid);
        if (isSpace(sid)) set({ projects });
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
      async linkProject(rootPath) {
        const sid = get().activeSpaceId; if (!sid) return;
        const name = rootPath.replace(/\/+$/, "").split("/").pop() || rootPath;
        await api.createProject(sid, name, rootPath);
        await get().refreshProjects();
      },
      async pickAndLinkProject() {
        const path = await api.pickFolder();
        if (path) await get().linkProject(path);
      },
      async newTerminal(targetLeafId = null) {
        const sid = get().activeSpaceId; if (!sid) return;
        const { itemId } = await api.createTerminal(sid);
        const items = await api.listItems(sid);
        if (!isSpace(sid)) return;
        // Read layout only now: an items.changed refresh may already have reconciled the item in.
        const layout = addTab(get().layout ?? emptyLayout(), targetLeafId, itemId);
        set({ items, layout: reconcileLayout(layout, items) });
        await persist();
      },
      async splitWithNewTerminal(leafId, dir) {
        const sid = get().activeSpaceId; if (!sid) return;
        const { itemId } = await api.createTerminal(sid);
        const items = await api.listItems(sid);
        if (!isSpace(sid)) return;
        const layout = splitLeaf(get().layout ?? emptyLayout(), leafId, dir, itemId);
        set({ items, layout: reconcileLayout(layout, items) });
        await persist();
      },
      async closeItem(itemId) {
        const it = get().items.find((i) => i.id === itemId);
        await api.deleteItem(itemId); // server closes the pty for terminal items
        const items = get().items.filter((i) => i.id !== itemId);
        set({ items, layout: removeTab(get().layout ?? emptyLayout(), itemId) });
        if (it?.kind === "terminal") api.disposeTerminal(it.refId);
        await persist();
      },
      async activateTab(itemId) {
        set({ layout: setActiveTab(get().layout ?? emptyLayout(), itemId) });
        await persist();
      },
      async applyPreset(name) {
        set({ layout: gridPreset(name, get().items.map((i) => i.id)) });
        await persist();
      },
      resizeSplit(splitId, sizes) {
        const l = get().layout; if (!l) return;
        const current = findSplitSizes(l, splitId);
        if (!current || sameSizes(current, sizes)) return;
        set({ layout: updateSizes(l, splitId, sizes) });
        schedulePersist();
      },
      setLayoutLocal(layout) { set({ layout }); },
      persistLayout: persist,
      run(action) {
        action().catch((e: unknown) => {
          console.error(e);
          set({ error: e instanceof Error ? e.message : String(e) });
        });
      },
      clearError() { set({ error: null }); },
    };
  });
}

export const StoreContext = createContext<StoreApi<AppState> | null>(null);
export function useApp<T>(sel: (s: AppState) => T): T {
  const store = useContext(StoreContext); if (!store) throw new Error("StoreContext missing");
  return useStore(store, sel);
}
