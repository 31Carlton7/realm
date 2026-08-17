import { createStore, useStore, type StoreApi } from "zustand";
import {
  addTab, allTabs, emptyLayout, gridPreset, removeTab, setActiveTab, splitLeaf, updateSizes,
  type Item, type Layout, type PresetName, type Profile, type Project, type Space,
} from "@realm/contracts";
import { createContext, useContext } from "react";
import type { ThemePref } from "../theme/useTheme";

export type CreateSpaceInput = { name: string; icon: string; profileId: string; color?: string };
export type UpdateSpaceInput = { id: string; name?: string; icon?: string; color?: string; profileId?: string };
export type UpdateItemInput = { id: string; title?: string; pinned?: boolean };

/** Everything the store needs from the outside world: realm-server RPC plus the two platform
 *  seams (native folder picker, local terminal disposal). Tests substitute a fake. */
export type Api = {
  listProfiles(): Promise<Profile[]>;
  /** Global list across all profiles, in user sort order. */
  listSpaces(): Promise<Space[]>;
  listItems(spaceId: string): Promise<Item[]>;
  listProjects(spaceId: string): Promise<Project[]>;
  createSpace(input: CreateSpaceInput): Promise<Space>;
  updateSpace(input: UpdateSpaceInput): Promise<Space>;
  reorderSpaces(ids: string[]): Promise<void>;
  deleteSpace(id: string): Promise<void>;
  createProject(spaceId: string, name: string, rootPath: string): Promise<Project>;
  setLayout(spaceId: string, layout: Layout): Promise<Space>;
  createTerminal(spaceId: string): Promise<{ terminalId: string; itemId: string }>;
  updateItem(input: UpdateItemInput): Promise<Item>;
  /** Deleting a terminal item closes its pty server-side. */
  deleteItem(id: string): Promise<void>;
  getSetting(key: string): Promise<unknown>;
  setSetting(key: string, value: unknown): Promise<void>;
  /** Native folder picker; resolves null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Drop the renderer-side xterm instance/scrollback for a closed terminal. */
  disposeTerminal(terminalId: string): void;
};

export const PERSIST_DEBOUNCE_MS = 300;
export const SETTING_ACTIVE_SPACE = "ui.activeSpaceId";
export const SETTING_THEME = "ui.theme";

export type Sheet =
  | { kind: "space-settings"; spaceId: string }
  | { kind: "new-space" }
  | { kind: "new-session" };

export type AppState = {
  profiles: Profile[];
  /** All spaces across profiles, in user sort order. Exactly one is active at a time. */
  spaces: Space[]; activeSpaceId: string | null;
  themePref: ThemePref;
  items: Item[]; layout: Layout | null;
  projects: Project[];
  error: string | null;
  paletteOpen: boolean;
  sheet: Sheet | null;
  activeSpace(): Space | undefined;
  activeIndex(): number;
  boot(): Promise<void>;
  selectSpace(id: string): Promise<void>;
  nextSpace(): Promise<void>;
  prevSpace(): Promise<void>;
  createSpace(input: CreateSpaceInput): Promise<void>;
  updateSpace(input: UpdateSpaceInput): Promise<void>;
  deleteSpace(id: string): Promise<void>;
  reorderSpaces(ids: string[]): Promise<void>;
  setThemePref(pref: ThemePref): Promise<void>;
  refreshSpaces(): Promise<void>;
  refreshItems(): Promise<void>;
  refreshProjects(): Promise<void>;
  linkProject(rootPath: string): Promise<void>;
  pickAndLinkProject(): Promise<void>;
  newTerminal(targetLeafId?: string | null): Promise<void>;
  updateItem(input: UpdateItemInput): Promise<void>;
  closeItem(itemId: string): Promise<void>;
  activateTab(itemId: string): Promise<void>;
  splitWithNewTerminal(leafId: string, dir: "row" | "col"): Promise<void>;
  applyPreset(name: PresetName): Promise<void>;
  /** Functional sizes update for one split; persisted with a trailing debounce. No-op if unchanged. */
  resizeSplit(splitId: string, sizes: number[]): void;
  setLayoutLocal(layout: Layout): void;
  persistLayout(): Promise<void>;
  setPaletteOpen(open: boolean): void;
  openSheet(sheet: Sheet): void;
  closeSheet(): void;
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
const isThemePref = (x: unknown): x is ThemePref => x === "system" || x === "light" || x === "dark";

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
    const mergeSpace = (s: Space) => set({ spaces: get().spaces.map((x) => (x.id === s.id ? s : x)) });

    return {
      profiles: [], spaces: [], activeSpaceId: null, themePref: "system", items: [], layout: null, projects: [], error: null,
      paletteOpen: false, sheet: null,

      activeSpace() { const id = get().activeSpaceId; return id ? get().spaces.find((s) => s.id === id) : undefined; },
      activeIndex() { const id = get().activeSpaceId; return id ? get().spaces.findIndex((s) => s.id === id) : -1; },

      async boot() {
        const [profiles, spaces, saved, theme] = await Promise.all([
          api.listProfiles(), api.listSpaces(), api.getSetting(SETTING_ACTIVE_SPACE), api.getSetting(SETTING_THEME),
        ]);
        set({ profiles, spaces, themePref: isThemePref(theme) ? theme : "system" });
        const target = spaces.find((s) => s.id === saved) ?? spaces[0];
        if (target) await get().selectSpace(target.id);
      },
      async selectSpace(id) {
        await flushPersist();
        const space = get().spaces.find((s) => s.id === id);
        set({ activeSpaceId: id, layout: space?.layout ?? null, items: [], projects: [], error: null });
        get().run(() => api.setSetting(SETTING_ACTIVE_SPACE, id));
        await Promise.all([get().refreshProjects(), get().refreshItems()]);
      },
      async nextSpace() {
        const { spaces } = get(); const i = get().activeIndex();
        const n = spaces[i + 1]; if (i >= 0 && n) await get().selectSpace(n.id);
      },
      async prevSpace() {
        const { spaces } = get(); const i = get().activeIndex();
        const p = spaces[i - 1]; if (i > 0 && p) await get().selectSpace(p.id);
      },
      async refreshSpaces() {
        const spaces = await api.listSpaces();
        set({ spaces });
        const active = get().activeSpaceId;
        // The active space vanished (deleted elsewhere): fall back to the first one, if any.
        if (active && !spaces.some((s) => s.id === active)) {
          const first = spaces[0];
          if (first) await get().selectSpace(first.id);
          else set({ activeSpaceId: null, items: [], layout: null, projects: [] });
        }
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
      async createSpace(input) {
        const s = await api.createSpace(input);
        set({ spaces: [...get().spaces.filter((x) => x.id !== s.id), s] });
        await get().selectSpace(s.id);
      },
      async updateSpace(input) {
        mergeSpace(await api.updateSpace(input));
      },
      async deleteSpace(id) {
        await api.deleteSpace(id);
        const before = get().spaces; const idx = before.findIndex((s) => s.id === id);
        const spaces = before.filter((s) => s.id !== id);
        set({ spaces });
        if (get().activeSpaceId !== id) return;
        const neighbor = spaces[Math.max(0, idx - 1)];
        if (neighbor) await get().selectSpace(neighbor.id);
        else set({ activeSpaceId: null, items: [], layout: null, projects: [] });
      },
      async reorderSpaces(ids) {
        const byId = new Map(get().spaces.map((s) => [s.id, s]));
        const ordered = ids.map((id) => byId.get(id)).filter((s): s is Space => !!s);
        const rest = get().spaces.filter((s) => !ids.includes(s.id));
        set({ spaces: [...ordered, ...rest] }); // optimistic; spaces.changed re-syncs from the server
        await api.reorderSpaces(ids);
      },
      async setThemePref(pref) {
        set({ themePref: pref });
        await api.setSetting(SETTING_THEME, pref);
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
      async updateItem(input) {
        const sid = get().activeSpaceId;
        const it = await api.updateItem(input);
        if (sid && isSpace(sid)) set({ items: get().items.map((x) => (x.id === it.id ? it : x)) });
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
      setPaletteOpen(open) { set({ paletteOpen: open }); },
      openSheet(sheet) { set({ sheet }); },
      closeSheet() { set({ sheet: null }); },
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
/** The raw store, for imperative access (hotkeys, event subscriptions). */
export function useAppStore(): StoreApi<AppState> {
  const store = useContext(StoreContext); if (!store) throw new Error("StoreContext missing");
  return store;
}
