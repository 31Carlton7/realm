/** Shared in-memory Api fake for renderer tests (store, sidebar, palette). Not a test file itself. */
import type { GitInfo, Item, Profile, Project, Session, Space, StoredSessionEvent } from "@realm/contracts";
import type { AgentProbe, Api } from "./store";

export const profile = (id: string, name: string, extra: Partial<Profile> = {}): Profile =>
  ({ id, name, icon: "user", color: "#000000", sortOrder: 0, createdAt: 0, updatedAt: 0, ...extra });
export const space = (id: string, profileId: string, name: string, extra: Partial<Space> = {}): Space =>
  ({ id, profileId, name, icon: "folder", color: "#7c6cff", sortOrder: 0, folderPath: "/tmp", layout: null, activeItemId: null, createdAt: 0, updatedAt: 0, ...extra });
export const item = (id: string, spaceId: string, extra: Partial<Item> = {}): Item =>
  ({ id, spaceId, kind: "terminal", title: "t", sortOrder: 0, pinned: false, refId: id, createdAt: 0, updatedAt: 0, ...extra });
export const session = (id: string, spaceId: string, extra: Partial<Session> = {}): Session =>
  ({ id, spaceId, projectId: null, agentKind: "fake", model: null, effort: null, permissionMode: "default", environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", cwd: "/tmp", status: "idle",
    providerSessionId: null, title: "Fake agent session", lastEventSeq: 0, terminalItemId: null, createdAt: 0, updatedAt: 0, ...extra });

export type FakeData = {
  profiles?: Profile[]; spaces?: Space[];
  items?: Record<string, Item[]>; projects?: Record<string, Project[]>;
  settings?: Record<string, unknown>;
  sessions?: Session[]; sessionEvents?: Record<string, StoredSessionEvent[]>;
  /** Terminals already created for a session (sessionId → the trio openSessionTerminal returns). */
  sessionTerminals?: Record<string, { terminalId: string; itemId: string }>;
  /** By cwd; absent cwd = not a repo (null). */
  gitInfo?: Record<string, GitInfo | null>;
  /** What `agents.probe` answers. Mutate `api.data.agentProbe` between calls to simulate the user
   *  installing (or logging into) a CLI while the install card is up. */
  agentProbe?: AgentProbe[];
};

export type FakeApi = Api & {
  /** Method-call log, e.g. `listItems:s1`, `setLayout:s1`, `setSetting:ui.theme=dark`. */
  calls: string[];
  disposed: string[];
  /** Per-call artificial latency in ms, keyed like `calls` entries (used by race tests). */
  delays: Record<string, number>;
  onCreateTerminal: (() => void) | null;
  /** Live views of the fake's data (mutable). */
  data: Required<FakeData>;
};

/** Defaults: profiles p1 "Work" / p2 "School"; spaces s1 "Versed" (p1, #7c6cff) / s2 "Homework" (p2, #3ddc97);
 *  items: s1 has one terminal (i1). Pass `overrides` to replace any of these. */
export function fakeApi(overrides: FakeData = {}): FakeApi {
  const calls: string[] = [];
  const disposed: string[] = [];
  const data: Required<FakeData> = {
    profiles: overrides.profiles ?? [profile("p1", "Work"), profile("p2", "School")],
    spaces: overrides.spaces ?? [space("s1", "p1", "Versed", { color: "#7c6cff" }), space("s2", "p2", "Homework", { color: "#3ddc97" })],
    items: overrides.items ?? { s1: [item("i1", "s1", { title: "Terminal" })] },
    projects: overrides.projects ?? {},
    settings: overrides.settings ?? {},
    sessions: overrides.sessions ?? [],
    sessionEvents: overrides.sessionEvents ?? {},
    sessionTerminals: overrides.sessionTerminals ?? {},
    gitInfo: overrides.gitInfo ?? {},
    agentProbe: overrides.agentProbe ?? [{ kind: "fake", available: true, version: "fake", loggedIn: true, reason: null }],
  };
  let n = 100;
  const findSpace = (id: string) => { const s = data.spaces.find((x) => x.id === id); if (!s) throw new Error(`no space ${id}`); return s; };
  const api: FakeApi = {
    calls, disposed, delays: {}, onCreateTerminal: null, data,
    listProfiles: async () => { calls.push("listProfiles"); return data.profiles; },
    createProfile: async (name) => {
      calls.push(`createProfile:${name}`);
      const p = profile(`p${++n}`, name, { icon: "user", color: "#6b7280", sortOrder: data.profiles.length });
      data.profiles.push(p); return p;
    },
    listSpaces: async () => { calls.push("listSpaces"); await wait("listSpaces"); return [...data.spaces]; },
    listItems: async (sid) => { calls.push(`listItems:${sid}`); await wait(`listItems:${sid}`); return data.items[sid] ?? []; },
    listAllItems: async () => {
      calls.push("listAllItems");
      return Object.values(data.items).flat().slice().sort((a, b) => b.updatedAt - a.updatedAt);
    },
    listProjects: async (sid) => { calls.push(`listProjects:${sid}`); await wait(`listProjects:${sid}`); return data.projects[sid] ?? []; },
    createSpace: async (input) => {
      const s = space(`s${++n}`, input.profileId, input.name, { icon: input.icon, color: input.color ?? "#ffb454", sortOrder: data.spaces.length });
      data.spaces.push(s); return s;
    },
    updateSpace: async (input) => {
      const i = data.spaces.findIndex((x) => x.id === input.id); if (i < 0) throw new Error(`no space ${input.id}`);
      const { id: _id, ...patch } = input;
      const s = { ...data.spaces[i]!, ...patch }; data.spaces[i] = s; return s;
    },
    reorderSpaces: async (ids) => {
      calls.push(`reorderSpaces:${ids.join(",")}`);
      data.spaces.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    },
    deleteSpace: async (id) => { calls.push(`deleteSpace:${id}`); data.spaces = data.spaces.filter((s) => s.id !== id); },
    createProject: async (spaceId, name, rootPath) => {
      const pr: Project = { id: `pr${++n}`, spaceId, name, rootPath, defaultBranch: "main", createdAt: 0, updatedAt: 0 };
      (data.projects[spaceId] ??= []).push(pr); return pr;
    },
    setLayout: async (sid, layout) => {
      calls.push(`setLayout:${sid}`);
      const i = data.spaces.findIndex((x) => x.id === sid);
      const s = { ...(i >= 0 ? data.spaces[i]! : findSpace(sid)), layout };
      if (i >= 0) data.spaces[i] = s;
      return s;
    },
    createTerminal: async (sid) => {
      const it = item(`i${++n}`, sid, { title: "Terminal" }); (data.items[sid] ??= []).push(it);
      api.onCreateTerminal?.(); await wait("createTerminal");
      return { terminalId: it.refId, itemId: it.id };
    },
    updateItem: async (input) => {
      for (const list of Object.values(data.items)) {
        const i = list.findIndex((x) => x.id === input.id);
        if (i >= 0) { const { id: _id, ...patch } = input; const it = { ...list[i]!, ...patch }; list[i] = it; return it; }
      }
      throw new Error(`no item ${input.id}`);
    },
    deleteItem: async (id) => { calls.push(`deleteItem:${id}`); for (const k of Object.keys(data.items)) data.items[k] = data.items[k]!.filter((i) => i.id !== id); },
    getSetting: async (key) => { calls.push(`getSetting:${key}`); return data.settings[key] ?? null; },
    setSetting: async (key, value) => { calls.push(`setSetting:${key}=${String(value)}`); data.settings[key] = value; },
    pickFolder: async () => "/tmp/picked-repo",
    disposeTerminal: (id) => { disposed.push(id); },
    listSessions: async (sid) => { calls.push(`listSessions:${sid}`); return data.sessions.filter((s) => s.spaceId === sid); },
    listAllSessions: async () => { calls.push("listAllSessions"); await wait("listAllSessions"); return [...data.sessions]; },
    getSession: async (id) => { calls.push(`getSession:${id}`); const s = data.sessions.find((x) => x.id === id); if (!s) throw new Error(`no session ${id}`); return s; },
    createSession: async (input) => {
      const s = session(`se${++n}`, input.spaceId, { agentKind: input.agentKind, projectId: input.projectId ?? null, model: input.model ?? null, effort: input.effort ?? null, permissionMode: input.permissionMode ?? "default", title: input.title ?? "Fake agent session" });
      data.sessions.push(s);
      const it = item(`i${++n}`, input.spaceId, { kind: "session", title: s.title, refId: s.id }); (data.items[input.spaceId] ??= []).push(it);
      calls.push(`createSession:${input.agentKind}`);
      return { session: s, itemId: it.id };
    },
    sendMessage: async (id, text) => { calls.push(`sendMessage:${id}=${text}`); },
    interruptSession: async (id) => { calls.push(`interrupt:${id}`); },
    respondPermission: async (id, requestId, decision) => { calls.push(`respondPermission:${id}:${requestId}:${decision}`); },
    setSessionOptions: async (id, o) => {
      calls.push(`setSessionOptions:${id}`);
      const i = data.sessions.findIndex((x) => x.id === id); if (i < 0) throw new Error(`no session ${id}`);
      const s = { ...data.sessions[i]!, ...o }; data.sessions[i] = s; return s;
    },
    setSessionAgent: async (id, agentKind) => {
      calls.push(`setSessionAgent:${id}=${agentKind}`);
      const i = data.sessions.findIndex((x) => x.id === id); if (i < 0) throw new Error(`no session ${id}`);
      // Mirrors the server: a started session refuses, and a switch clears the old kind's model.
      if (data.sessions[i]!.lastEventSeq > 0) throw new Error("this session has already run; its agent can no longer be changed");
      const s = { ...data.sessions[i]!, agentKind, model: null }; data.sessions[i] = s; return s;
    },
    sessionEvents: async (id, afterSeq, limit) => { calls.push(`sessionEvents:${id}:${afterSeq}`); await wait(`sessionEvents:${id}`); return (data.sessionEvents[id] ?? []).filter((e) => e.seq > afterSeq).slice(0, limit); },
    // Mirrors the server: get-or-create, so a second call for the same session returns the same trio —
    // and the hidden item never joins `data.items` (it is not a sidebar item).
    openSessionTerminal: async (id) => {
      calls.push(`openSessionTerminal:${id}`);
      await wait(`openSessionTerminal:${id}`);
      const known = data.sessionTerminals[id];
      if (known) return known;
      const made = { terminalId: `term-${id}`, itemId: `titem-${id}` };
      data.sessionTerminals[id] = made;
      const i = data.sessions.findIndex((s) => s.id === id);
      if (i >= 0) data.sessions[i] = { ...data.sessions[i]!, terminalItemId: made.itemId };
      return made;
    },
    writeTerminal: async (terminalId, data) => { calls.push(`writeTerminal:${terminalId}=${data}`); },
    prefillTerminal: async (terminalId, command) => { calls.push(`prefillTerminal:${terminalId}=${command}`); },
    probeAgents: async (force) => {
      calls.push(`probeAgents:${force}`);
      await wait("probeAgents");
      return data.agentProbe;
    },
    gitInfo: async (cwd) => { calls.push(`gitInfo:${cwd}`); await wait(`gitInfo:${cwd}`); return data.gitInfo[cwd] ?? null; },
  };
  const wait = (key: string) => new Promise<void>((r) => setTimeout(r, api.delays[key] ?? 0));
  return api;
}
