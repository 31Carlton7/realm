import { createStore, useStore, type StoreApi } from "zustand";
import {
  addTab, allTabs, emptyLayout, gridPreset, removeTab, setActiveTab, splitLeaf, updateSizes,
  type AgentKind, type Item, type Layout, type MethodResult, type PresetName, type Profile, type Project, type Session, type SessionStatus, type Space, type StoredSessionEvent,
} from "@realm/contracts";
import { createContext, useContext } from "react";
import type { ThemePref } from "../theme/useTheme";
import { emptyTranscript, reduceTranscript, type Transcript } from "../panes/session/transcript-model";

export type CreateSpaceInput = { name: string; icon: string; profileId: string; color?: string };
export type UpdateSpaceInput = { id: string; name?: string; icon?: string; color?: string; profileId?: string };
export type UpdateItemInput = { id: string; title?: string; pinned?: boolean };
export type CreateSessionInput = { spaceId: string; agentKind: AgentKind; projectId?: string | null; model?: string | null; effort?: string | null; permissionMode?: string; title?: string };
export type SessionOptions = { model?: string; effort?: string; permissionMode?: string };
export type PermissionDecision = "allow" | "allow_always" | "deny";
export type AgentProbe = MethodResult<"agents.probe">[number];
/** A `session.event` broadcast: persisted rows carry their seq; ephemeral ones (deltas) have seq -1. */
export type LiveSessionEvent = StoredSessionEvent & { ephemeral: boolean };
export type TranscriptEntry = { lastSeq: number; t: Transcript };

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
  listSessions(spaceId: string): Promise<Session[]>;
  getSession(id: string): Promise<Session>;
  createSession(input: CreateSessionInput): Promise<{ session: Session; itemId: string }>;
  sendMessage(id: string, text: string): Promise<void>;
  interruptSession(id: string): Promise<void>;
  respondPermission(id: string, requestId: string, decision: PermissionDecision): Promise<void>;
  setSessionOptions(id: string, o: SessionOptions): Promise<Session>;
  /** Persisted events with seq > afterSeq, ascending, at most `limit`. */
  sessionEvents(id: string, afterSeq: number, limit: number): Promise<StoredSessionEvent[]>;
  probeAgents(): Promise<AgentProbe[]>;
};

export const PERSIST_DEBOUNCE_MS = 300;
export const SETTING_ACTIVE_SPACE = "ui.activeSpaceId";
export const SETTING_THEME = "ui.theme";
export const EVENTS_PAGE = 1000;

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
  /** Sessions of the active space, by id. */
  sessions: Record<string, Session>;
  sessionStatus: Record<string, SessionStatus>;
  /** Transcripts by session id, kept across space switches (cheap, and a session pane may be revisited). */
  transcripts: Record<string, TranscriptEntry>;
  agentProbe: AgentProbe[];
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
  refreshSessions(): Promise<void>;
  /** Load (or catch up) a session's transcript: fetch events after the last known seq and reduce them. */
  openSession(id: string): Promise<void>;
  applySessionEvent(ev: LiveSessionEvent): void;
  applySessionStatus(sessionId: string, status: SessionStatus): void;
  /** Create a session in the active space, add its tab, and open its transcript. */
  newSession(input: Omit<CreateSessionInput, "spaceId">, targetLeafId?: string | null): Promise<void>;
  sendMessage(id: string, text: string): Promise<void>;
  interruptSession(id: string): Promise<void>;
  respondPermission(id: string, requestId: string, decision: PermissionDecision): Promise<void>;
  setSessionOptions(id: string, o: SessionOptions): Promise<void>;
  probeAgents(): Promise<void>;
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
    const mergeSession = (s: Session) => set({ sessions: { ...get().sessions, [s.id]: s }, sessionStatus: { ...get().sessionStatus, [s.id]: s.status } });
    /** Persisted events that arrive while openSession is fetching; replayed after the fetch so order is kept. */
    const loading = new Map<string, StoredSessionEvent[]>();
    const setTranscript = (id: string, entry: TranscriptEntry) => set({ transcripts: { ...get().transcripts, [id]: entry } });
    const dropTranscript = (id: string) => { const { [id]: _gone, ...rest } = get().transcripts; set({ transcripts: rest }); };
    /** Add a freshly created item's tab (or split) and persist; mirrors newTerminal. */
    const adoptItem = async (sid: string, itemId: string, targetLeafId: string | null) => {
      const items = await api.listItems(sid);
      if (!isSpace(sid)) return;
      // Read layout only now: an items.changed refresh may already have reconciled the item in.
      const layout = addTab(get().layout ?? emptyLayout(), targetLeafId, itemId);
      set({ items, layout: reconcileLayout(layout, items) });
      await persist();
    };

    return {
      profiles: [], spaces: [], activeSpaceId: null, themePref: "system", items: [], layout: null, projects: [], error: null,
      paletteOpen: false, sheet: null,
      sessions: {}, sessionStatus: {}, transcripts: {}, agentProbe: [],

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
        set({ activeSpaceId: id, layout: space?.layout ?? null, items: [], projects: [], sessions: {}, error: null });
        get().run(() => api.setSetting(SETTING_ACTIVE_SPACE, id));
        await Promise.all([get().refreshProjects(), get().refreshItems(), get().refreshSessions()]);
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
        // Decide the successor before awaiting so a concurrent spaces.changed refresh can't move the goalposts.
        const before = get().spaces; const idx = before.findIndex((s) => s.id === id);
        const wasActive = get().activeSpaceId === id;
        const neighbor = before.filter((s) => s.id !== id)[Math.max(0, idx - 1)] ?? null;
        // A pending debounced persist would setLayout on a space that is about to be gone.
        if (wasActive && persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
        await api.deleteSpace(id);
        set({ spaces: get().spaces.filter((s) => s.id !== id) });
        if (!wasActive) return;
        // refreshSpaces (spaces.changed) may already have moved the selection; keep its choice.
        if (get().activeSpaceId !== id) return;
        if (neighbor && get().spaces.some((s) => s.id === neighbor.id)) await get().selectSpace(neighbor.id);
        else if (get().spaces[0]) await get().selectSpace(get().spaces[0]!.id);
        else set({ activeSpaceId: null, items: [], layout: null, projects: [] });
      },
      async reorderSpaces(ids) {
        const prev = get().spaces;
        const byId = new Map(prev.map((s) => [s.id, s]));
        const ordered = ids.map((id) => byId.get(id)).filter((s): s is Space => !!s);
        const rest = prev.filter((s) => !ids.includes(s.id));
        set({ spaces: [...ordered, ...rest] }); // optimistic; the server broadcasts spaces.changed only on success
        try { await api.reorderSpaces(ids); }
        catch (e) { set({ spaces: prev }); throw e; }
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
        await adoptItem(sid, itemId, targetLeafId);
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
        if (it?.kind === "session") {
          dropTranscript(it.refId); loading.delete(it.refId);
          const { [it.refId]: _st, ...sessionStatus } = get().sessionStatus; const { [it.refId]: _se, ...sessions } = get().sessions;
          set({ sessionStatus, sessions });
        }
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
      async refreshSessions() {
        const sid = get().activeSpaceId; if (!sid) return;
        const list = await api.listSessions(sid);
        if (!isSpace(sid)) return;
        // Statuses are rebuilt from the list: entries for other spaces are kept only if still known there.
        const sessions: Record<string, Session> = {}; const sessionStatus: Record<string, SessionStatus> = {};
        for (const [id, st] of Object.entries(get().sessionStatus)) if (!(id in get().sessions)) sessionStatus[id] = st;
        for (const s of list) { sessions[s.id] = s; sessionStatus[s.id] = s.status; }
        set({ sessions, sessionStatus });
      },
      async openSession(id) {
        if (loading.has(id)) return;
        loading.set(id, []);
        try {
          const prev = get().transcripts[id] ?? { lastSeq: 0, t: emptyTranscript() };
          const fetchAll = async () => {
            const all: StoredSessionEvent[] = []; let after = prev.lastSeq;
            for (;;) {
              const page = await api.sessionEvents(id, after, EVENTS_PAGE);
              all.push(...page);
              if (page.length < EVENTS_PAGE || !loading.has(id)) return all;
              after = page.at(-1)!.seq;
            }
          };
          const [session, events] = await Promise.all([get().sessions[id] ? null : api.getSession(id), fetchAll()]);
          if (!loading.has(id)) return; // item closed mid-fetch
          if (session) mergeSession(session);
          let { lastSeq, t } = get().transcripts[id] ?? prev;
          for (const e of [...events, ...(loading.get(id) ?? [])]) if (e.seq > lastSeq) { t = reduceTranscript(t, e.event); lastSeq = e.seq; }
          setTranscript(id, { lastSeq, t });
        } finally { loading.delete(id); }
      },
      applySessionEvent(ev) {
        const buf = loading.get(ev.sessionId);
        if (buf) { if (!ev.ephemeral) buf.push(ev); return; } // deltas are dropped while loading; the final text is persisted anyway
        const cur = get().transcripts[ev.sessionId];
        if (!cur) return; // not opened yet: openSession fetches everything later
        if (ev.ephemeral) { setTranscript(ev.sessionId, { lastSeq: cur.lastSeq, t: reduceTranscript(cur.t, ev.event) }); return; }
        if (ev.seq <= cur.lastSeq) return;
        setTranscript(ev.sessionId, { lastSeq: ev.seq, t: reduceTranscript(cur.t, ev.event) });
      },
      applySessionStatus(sessionId, status) {
        const s = get().sessions[sessionId];
        set({ sessionStatus: { ...get().sessionStatus, [sessionId]: status }, ...(s ? { sessions: { ...get().sessions, [sessionId]: { ...s, status } } } : {}) });
      },
      async newSession(input, targetLeafId = null) {
        const sid = get().activeSpaceId; if (!sid) return;
        const { session, itemId } = await api.createSession({ ...input, spaceId: sid });
        if (isSpace(sid)) mergeSession(session);
        await adoptItem(sid, itemId, targetLeafId);
        await get().openSession(session.id);
      },
      async sendMessage(id, text) { await api.sendMessage(id, text); },
      async interruptSession(id) { await api.interruptSession(id); },
      async respondPermission(id, requestId, decision) { await api.respondPermission(id, requestId, decision); },
      async setSessionOptions(id, o) { mergeSession(await api.setSessionOptions(id, o)); },
      async probeAgents() { set({ agentProbe: await api.probeAgents() }); },
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
