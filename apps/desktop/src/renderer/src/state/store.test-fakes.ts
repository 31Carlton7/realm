/** Shared in-memory Api fake for renderer tests (store, sidebar, palette). Not a test file itself. */
import { activeLayout, setActiveLayout, MCP_SECRET_STORAGE_NOTE, MEMORY_DOC_MAX } from "@realm/contracts";
import type { AgentsFileState, Attachment, Checkpoint, DiffSummary, Environment, FileDiff, GitInfo, IconAsset, ImportApplyParams, ImportResult, ImportScan, Item, McpCall, McpServer, McpTool, MemorySources, MemoryState, Notification, Profile, Project, RestorePreview, ReviewResult, Session, Ship, ShipResult, Skill, Space, StoredSessionEvent, WorktreeStatus } from "@realm/contracts";
import type { AddMcpServerInput, AgentProbe, Api, McpTestResult, PickedAttachment, UpdateMcpServerInput } from "./store";
import type { SearchResults } from "@realm/contracts";

export const profile = (id: string, name: string, extra: Partial<Profile> = {}): Profile =>
  ({ id, name, icon: "user", color: "#000000", sortOrder: 0, createdAt: 0, updatedAt: 0, ...extra });
export const space = (id: string, profileId: string, name: string, extra: Partial<Space> = {}): Space =>
  ({ id, profileId, name, icon: "folder", color: "#7c6cff", sortOrder: 0, folderPath: "/tmp", groups: null, layout: null, activeItemId: null, createdAt: 0, updatedAt: 0, ...extra });
export const item = (id: string, spaceId: string, extra: Partial<Item> = {}): Item =>
  ({ id, spaceId, kind: "terminal", title: "t", sortOrder: 0, pinned: false, archived: false, refId: id, createdAt: 0, updatedAt: 0, ...extra });
export const session = (id: string, spaceId: string, extra: Partial<Session> = {}): Session =>
  ({ id, spaceId, projectId: null, agentKind: "fake", model: null, effort: null, permissionMode: "default", environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", cwd: "/tmp", status: "idle",
    providerSessionId: null, title: "Fake agent session", lastEventSeq: 0, terminalItemId: null, dispatchedBy: null, createdAt: 0, updatedAt: 0, ...extra });

export const skillRow = (id: string, extra: Partial<Skill> = {}): Skill =>
  ({ id, name: id, description: `does ${id}`, path: `/realm-home/skills/${id}/SKILL.md`, enabled: true, valid: true, reason: null,
    scope: { kind: "space", spaceId: null }, ...extra });

export const agentsFileState = (extra: Partial<AgentsFileState> = {}): AgentsFileState =>
  ({ enabled: false, path: "/realm-home/spaces/s1/AGENTS.md", exists: false, managedByRealm: false, writable: true, reason: null, ...extra });

export const checkpoint = (id: string, environmentId: string, extra: Partial<Checkpoint> = {}): Checkpoint =>
  ({ id, environmentId, sessionId: null, kind: "turn", label: "a turn", ref: `refs/realm/checkpoints/${environmentId}/${id}`,
    commitSha: `sha-${id}`, headSha: "head", headRef: "refs/heads/main", createdAt: 0, ...extra });
export const preview = (id: string, environmentId: string, extra: Partial<RestorePreview> = {}): RestorePreview =>
  ({ checkpointId: id, environmentId, path: "/tmp", label: "a turn", createdAt: 0, filesChanged: 0, commitsRolledBack: 0,
    headMovable: true, headReason: null, intact: true, rewindsConversation: false, ...extra });

/** A single-space simplification (the real row's `enabled`/`allowedTools` are per-space; these fakes
 *  only ever exercise one space at a time, so a flat field is enough). */
export const mcpServer = (id: string, extra: Partial<McpServer> = {}): McpServer =>
  ({ id, name: `srv-${id}`, transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"], url: "",
    envKeys: [], headerKeys: [], authKind: "none", oauthStatus: "unconfigured", status: "idle", tools: [], allowedTools: null,
    enabled: false, scope: { kind: "space", spaceId: null }, createdAt: 0, ...extra });
export const mcpTool = (name: string, description = ""): McpTool => ({ name, description });
/** A logged call (W7). `serverName: ""` + `tool` holding the full namespaced string is the
 *  blocked-attribution shape (plan amendment); tests that need it pass that combination explicitly. */
export const mcpCall = (id: string, sessionId: string, extra: Partial<McpCall> = {}): McpCall =>
  ({ id, sessionId, serverId: "mcp1", serverName: "srv1", tool: "echo", argsJson: "{}", resultSummary: "ok",
    ok: true, durationMs: 120, ts: 0, ...extra });

/** A durable ship-log row (Plan 14 W1). */
export const shipRow = (id: string, spaceId: string, extra: Partial<Ship> = {}): Ship =>
  ({ id, environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", spaceId, branch: "main", sha: `sha-${id}`,
    subject: `shipped ${id}`, prUrl: null, pushState: "pushed", createdAt: 0, ...extra });

/** A feed row (W5). Defaults to an unread, already-acted session_done; ids must sort as ULIDs do. */
export const notification = (id: string, extra: Partial<Notification> = {}): Notification =>
  ({ id, category: "session_done", spaceId: "s1", sessionId: null, refId: null, title: "a session",
    body: "Finished a turn", createdAt: 0, readAt: null, actedAt: 0, ...extra });

export const iconAsset = (id: string, profileId: string, extra: Partial<IconAsset> = {}): IconAsset =>
  ({ id, profileId, kind: "generated", mime: "image/svg+xml", dataText: `<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg>`,
    prompt: "a circle", createdAt: 0, ...extra });

/** One "Apps on this Mac" row, with the derived flags set the way main/mac-access.ts sets them:
 *  Full Disk Access never has a command, a granted row has nothing left to offer, and a DENIED row
 *  offers System Settings but NOT a prompt — denials are sticky, so a Grant button there could not
 *  work. Tests that assert on those flags are asserting on this rule. */
export const macRow = (id: string, label: string, group: MacAccessRow["group"], state: MacAccessState): MacAccessRow => {
  const hasCommand = group !== "disk";
  return {
    id, label, group, state, detail: `${label}: ${state}`,
    grantCommand: hasCommand ? `mac ${label.toLowerCase()} list --json` : null,
    canPrompt: hasCommand && state !== "granted" && state !== "denied",
    needsSettings: state !== "granted" && (!hasCommand || state === "denied" || state === "writeOnly"),
    launchesApp: group === "automation",
  };
};

export type FakeData = {
  profiles?: Profile[]; spaces?: Space[];
  items?: Record<string, Item[]>; projects?: Record<string, Project[]>;
  /** By space id. `createWorktree` appends one, as the server's createWorktree does. */
  environments?: Record<string, Environment[]>;
  settings?: Record<string, unknown>;
  sessions?: Session[]; sessionEvents?: Record<string, StoredSessionEvent[]>;
  importScan?: ImportScan; importResult?: ImportResult;
  /** Terminals already created for a session (sessionId → the trio openSessionTerminal returns). */
  sessionTerminals?: Record<string, { terminalId: string; itemId: string }>;
  /** By cwd; absent cwd = not a repo (null). */
  gitInfo?: Record<string, GitInfo | null>;
  /** `workspace.diff` by cwd; absent = not a repo (null). */
  diffs?: Record<string, DiffSummary | null>;
  /** `workspace.fileDiff` by `${cwd}|${path}|${staged}`. */
  patches?: Record<string, FileDiff>;
  /** What `workspace.ship` answers next. Replace between calls to walk a flow. */
  shipResult?: ShipResult;
  /** `environments.worktreeStatus` by environment id. Mutate between calls to simulate the tree
   *  changing under an open confirmation. */
  worktreeStatus?: Record<string, WorktreeStatus>;
  /** `checkpoints.list` by environment id (W4). */
  checkpoints?: Record<string, Checkpoint[]>;
  /** `ships.list` by space id (Plan 14 W1). Unordered on the way in — the fake sorts newest-first
   *  like the real store. */
  ships?: Record<string, Ship[]>;
  /** `checkpoints.preview` by checkpoint id. Mutate between calls to simulate the checkout moving
   *  under an open confirmation, which is exactly what the acknowledgement exists to catch. */
  checkpointPreview?: Record<string, RestorePreview>;
  /** `skills.list` by space id — what the prompter's @-mention picker offers (W4). Toggles via
   *  `setSkillEnabled` are applied per space on top of these rows, mirroring the disabled-set store. */
  skills?: Record<string, Skill[]>;
  /** The library folder `skills.list` reports. */
  skillsRoot?: string;
  /** What `mcp.test` answers, by server id. Absent id → reached false, "no test result configured". */
  mcpTest?: Record<string, McpTestResult>;
  /** Realm memory documents by space id. */
  memoryDocs?: Record<string, string>;
  /** AGENTS.md state by space id (default: a writable primary-folder state, disabled). */
  agentsFiles?: Record<string, AgentsFileState>;
  /** `memory.sources` by session id. */
  memorySources?: Record<string, MemorySources>;
  /** What the next `pickFiles()` answers with; consumed by the call (queue, not a constant). */
  pickFiles?: PickedAttachment[];
  /** What `agents.probe` answers. Mutate `api.data.agentProbe` between calls to simulate the user
   *  installing (or logging into) a CLI while the install card is up. */
  agentProbe?: AgentProbe[];
  /** What the main-process TCC probe answers (W6's Permissions tab). Defaults to the two honest
   *  can't-check rows plus three probed ones, mirroring main/tcc.ts's shape. */
  tccRows?: TccRow[];
  /** What `mac doctor` answers through main (the "Apps on this Mac" rows). Defaults to a machine
   *  mid-setup: Calendar granted, Mail never asked, Reminders denied, Full Disk denied. */
  macAccess?: MacAccessStatus;
  /** How the user "answers" each capability's macOS dialog during a grant, by id. Anything not
   *  named here is answered Allow — the fake's default is the happy path, and a test that cares
   *  about a refusal says so. */
  macGrantAnswers?: Record<string, "granted" | "denied">;
  /** What main's gated updater reports (Plan 15 W1). Defaults to today's shipped truth: a packaged
   *  local build is unsigned, so the row is disabled as "unsigned". Mutate between calls to script
   *  an enabled build's states. */
  updateStatus?: UpdateStatus;
  /** MCP servers `mcp.list` answers with (W6). One flat list — see `mcpServer`'s doc comment. */
  mcpServers?: McpServer[];
  /** What the next `mcp.tools.list` answers for a given server id, if scripted; otherwise the fake
   *  echoes back the server's own cached `tools`. Consumed once like `pickFiles`... except it is NOT
   *  consumed — tests mutate it between calls to simulate a live upstream tool list. */
  mcpToolsResult?: Record<string, McpTool[]>;
  /** What `mcp.tools.list` answers as `error` for a server id, if set — a connect failure is a result,
   *  never a throw (see the Api doc comment). */
  mcpToolsError?: Record<string, string | null>;
  /** The full call log `mcp.calls.list` pages over (W7). Unordered on the way in — the fake sorts and
   *  filters like the real store does, so a test can just append in whatever order it likes. */
  mcpCalls?: McpCall[];
  /** Realm-native providers `mcp.providers.list` answers with (W4). Flat like `mcpServers`: these
   *  fakes exercise one space at a time. */
  mcpProviders?: { name: string; enabled: boolean }[];
  /** Profile memory docs by profile id (W4's Library page). */
  profileMemoryDocs?: Record<string, string>;
  /** Per-space disable override for the inherited profile doc — mirrors the server's polarity
   *  (absent = inherited ON). */
  profileDocDisabled?: Record<string, boolean>;
  /** The notifications feed `notifications.list` pages over (W5). Unordered on the way in — the fake
   *  sorts (createdAt DESC, id DESC) and pages like the real store, so tests just append. */
  notifications?: Notification[];
  /** Persisted review verdicts by environment id (Plan 13 W3) — what `review.get` answers. */
  reviews?: Record<string, ReviewResult | null>;
  /** What `search.query` answers (Plan 16 W2), regardless of query — palette tests script the groups.
   *  Delay it with `delays["search"]` to hold results in flight. */
  searchResults?: SearchResults;
  /** `iconAssets.list` by profile id — the space icon picker's "Generated"/"Uploaded" library. */
  iconAssets?: Record<string, IconAsset[]>;
  /** What `pickIconImage()` answers with. Defaults to null (cancelled) — a test opts in by setting
   *  it, and mutates `api.data.pickIconImage` between calls to change the answer (not consumed). */
  pickIconImage?: PickedFile | null;
};

export type FakeApi = Api & {
  /** Method-call log, e.g. `listItems:s1`, `setLayout:s1`, `setSetting:ui.theme=dark`. */
  calls: string[];
  disposed: string[];
  /** Every `sendMessage`, with the attachments that actually went on the wire. `mentions` is present
   *  only when non-empty, so mention-free assertions stay byte-for-byte what they always were. */
  sent: { id: string; text: string; attachments: Attachment[]; mentions?: string[] }[];
  /** Every `mcp.add`/`mcp.update` input exactly as sent — what the secrecy tests read: an update that
   *  should have omitted `env` is caught here, not inferred from state. */
  mcpWrites: (AddMcpServerInput | UpdateMcpServerInput)[];
  /** Every `import.apply` selection exactly as sent — what the Import panel's tests read, so a
   *  filtered-out or re-pointed row is caught on the wire rather than inferred from state. */
  importApplied: ImportApplyParams[];
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
  const sent: { id: string; text: string; attachments: Attachment[]; mentions?: string[] }[] = [];
  const data: Required<FakeData> = {
    profiles: overrides.profiles ?? [profile("p1", "Work"), profile("p2", "School")],
    spaces: overrides.spaces ?? [space("s1", "p1", "Versed", { color: "#7c6cff" }), space("s2", "p2", "Homework", { color: "#3ddc97" })],
    items: overrides.items ?? { s1: [item("i1", "s1", { title: "Terminal" })] },
    projects: overrides.projects ?? {},
    environments: overrides.environments ?? {},
    settings: overrides.settings ?? {},
    sessions: overrides.sessions ?? [],
    sessionEvents: overrides.sessionEvents ?? {},
    sessionTerminals: overrides.sessionTerminals ?? {},
    gitInfo: overrides.gitInfo ?? {},
    diffs: overrides.diffs ?? {},
    patches: overrides.patches ?? {},
    shipResult: overrides.shipResult ?? {
      commit: { state: "committed", sha: "abc1234", subject: "a commit", reason: null },
      push: { state: "pushed", remote: "origin", branch: "main", reason: null },
      pr: { state: "created", url: "https://github.com/acme/widgets/pull/1", reason: null },
    },
    worktreeStatus: overrides.worktreeStatus ?? {},
    checkpoints: overrides.checkpoints ?? {},
    ships: overrides.ships ?? {},
    checkpointPreview: overrides.checkpointPreview ?? {},
    skills: overrides.skills ?? {},
    skillsRoot: overrides.skillsRoot ?? "/realm-home/skills",
    mcpTest: overrides.mcpTest ?? {},
    memoryDocs: overrides.memoryDocs ?? {},
    agentsFiles: overrides.agentsFiles ?? {},
    memorySources: overrides.memorySources ?? {},
    pickFiles: overrides.pickFiles ?? [],
    agentProbe: overrides.agentProbe ?? [{ kind: "fake", available: true, version: "fake", loggedIn: true, reason: null }],
    importScan: overrides.importScan ?? { sessions: [], memories: [], skills: [], sources: [] },
    importResult: overrides.importResult ?? { sessions: [], memories: [], skills: [], spacesCreated: [] },
    tccRows: overrides.tccRows ?? [
      { id: "filesAndFolders", label: "Files & Folders", state: "unknown", detail: "Can't be checked until used — macOS only reveals these grants by asking." },
      { id: "automation", label: "Automation", state: "unknown", detail: "Can't be checked until used — grants are per-app-pair." },
      { id: "screenRecording", label: "Screen Recording", state: "denied", detail: "macOS reports the grant as refused." },
      { id: "accessibility", label: "Accessibility", state: "granted", detail: "macOS reports Realm as a trusted accessibility client." },
      { id: "fullDisk", label: "Full Disk Access", state: "denied", detail: "macOS refused Realm a file only Full Disk Access unlocks." },
    ],
    macAccess: overrides.macAccess ?? {
      cli: { present: true, path: "/opt/homebrew/bin/mac", version: "0.6.0" },
      host: { name: "Realm", bundlePath: "/Applications/Realm.app", packaged: true },
      rows: [
        macRow("calendar", "Calendar", "data", "granted"),
        macRow("reminders", "Reminders", "data", "denied"),
        macRow("automation:Mail", "Mail", "automation", "notRequested"),
        macRow("fullDiskAccess", "Full Disk Access", "disk", "denied"),
      ],
    },
    macGrantAnswers: overrides.macGrantAnswers ?? {},
    updateStatus: overrides.updateStatus ?? { version: "0.0.1", state: { kind: "disabled", reason: "unsigned" } },
    mcpServers: overrides.mcpServers ?? [],
    mcpToolsResult: overrides.mcpToolsResult ?? {},
    mcpToolsError: overrides.mcpToolsError ?? {},
    mcpCalls: overrides.mcpCalls ?? [],
    mcpProviders: overrides.mcpProviders ?? [{ name: "realm-browser", enabled: true }],
    profileMemoryDocs: overrides.profileMemoryDocs ?? {},
    profileDocDisabled: overrides.profileDocDisabled ?? {},
    notifications: overrides.notifications ?? [],
    reviews: overrides.reviews ?? {},
    searchResults: overrides.searchResults ?? { sessions: [], items: [], skills: [], memory: [] },
    iconAssets: overrides.iconAssets ?? {},
    pickIconImage: overrides.pickIconImage ?? null,
  };
  let n = 100;
  const findSpace = (id: string) => { const s = data.spaces.find((x) => x.id === id); if (!s) throw new Error(`no space ${id}`); return s; };
  const mcpWrites: FakeApi["mcpWrites"] = [];
  const importApplied: FakeApi["importApplied"] = [];
  const memState = (spaceId: string): MemoryState => {
    // The inherited profile doc rides along as the real `memory.get` reports it (W2/W4): the space's
    // own profile, ON unless this space disabled it. Null only when the space is unknown.
    const profileId = data.spaces.find((s) => s.id === spaceId)?.profileId ?? null;
    return {
      path: `/realm-home/memory/${spaceId}.md`, doc: data.memoryDocs[spaceId] ?? "",
      agentsFile: data.agentsFiles[spaceId] ?? agentsFileState(),
      profile: profileId === null ? null : {
        profileId, path: `/realm-home/memory/profile-${profileId}.md`,
        doc: data.profileMemoryDocs[profileId] ?? "", enabledHere: !data.profileDocDisabled[spaceId],
      },
    };
  };
  const api: FakeApi = {
    calls, disposed, sent, mcpWrites, importApplied, delays: {}, onCreateTerminal: null, data,
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
      // Mirrors the server (ItemsStore.listAll): archived rows are not offered to the palette.
      return Object.values(data.items).flat().filter((i) => !i.archived).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    search: async (profileId, query) => {
      calls.push(`search:${profileId}:${query}`);
      await wait("search");
      return data.searchResults;
    },
    listProjects: async (sid) => { calls.push(`listProjects:${sid}`); await wait(`listProjects:${sid}`); return data.projects[sid] ?? []; },
    listEnvironments: async (sid) => { calls.push(`listEnvironments:${sid}`); await wait(`listEnvironments:${sid}`); return data.environments[sid] ?? []; },
    createWorktree: async (sid, title) => {
      calls.push(`createWorktree:${sid}`);
      const slug = (title ?? "session").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const env: Environment = { id: `env${++n}`, spaceId: sid, path: `/tmp/worktrees/${sid}/${slug}`, branch: `realm/${slug}`,
        kind: "worktree", portBlockStart: 41000 + 10 * (data.environments[sid] ?? []).length, createdAt: 0, updatedAt: 0 };
      (data.environments[sid] ??= []).push(env); return env;
    },
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
      const cur = i >= 0 ? data.spaces[i]! : findSpace(sid);
      const groups = cur.groups ? setActiveLayout(cur.groups, layout) : null;
      const s = { ...cur, groups, layout };
      if (i >= 0) data.spaces[i] = s;
      return s;
    },
    // Mirrors the server (apps/server/src/store/spaces.ts): `groups` is stored, `layout` is DERIVED
    // from the active group — a test that reads the returned space's `layout` gets what the real one
    // would return, so a store bug that persists the wrong active group shows up here rather than
    // silently round-tripping.
    setGroups: async (sid, groups) => {
      calls.push(`setGroups:${sid}`);
      const i = data.spaces.findIndex((x) => x.id === sid);
      const s = { ...(i >= 0 ? data.spaces[i]! : findSpace(sid)), groups, layout: activeLayout(groups) };
      if (i >= 0) data.spaces[i] = s;
      return s;
    },
    createTerminal: async (sid) => {
      const it = item(`i${++n}`, sid, { title: "Terminal" }); (data.items[sid] ??= []).push(it);
      api.onCreateTerminal?.(); await wait("createTerminal");
      return { terminalId: it.refId, itemId: it.id };
    },
    createBrowser: async (sid) => {
      calls.push(`createBrowser:${sid}`);
      const it = item(`i${++n}`, sid, { kind: "browser", title: "Browser" }); (data.items[sid] ??= []).push(it);
      await wait("createBrowser");
      return { browserId: it.refId, itemId: it.id, url: "" };
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
    machineName: async () => { calls.push("machineName"); return "Carlton's M4 MacBook Pro"; },
    pickFolder: async () => "/tmp/picked-repo",
    // Whatever a test parks in `data.pickFiles` is what the native picker "returns".
    pickFiles: async () => { calls.push("pickFiles"); return data.pickFiles.splice(0, data.pickFiles.length); },
    listIconAssets: async (profileId) => { calls.push(`listIconAssets:${profileId}`); return data.iconAssets[profileId] ?? []; },
    generateIconAsset: async (profileId, prompt) => {
      calls.push(`generateIconAsset:${profileId}:${prompt}`);
      await wait("generateIconAsset");
      const a = iconAsset(`ia${++n}`, profileId, { prompt });
      (data.iconAssets[profileId] ??= []).unshift(a); return a;
    },
    pickIconImage: async () => { calls.push("pickIconImage"); return data.pickIconImage; },
    uploadIconAsset: async (profileId, path) => {
      calls.push(`uploadIconAsset:${profileId}:${path}`);
      const a = iconAsset(`ia${++n}`, profileId, { kind: "image", mime: "image/png", dataText: "data:image/png;base64,ZmFrZQ==", prompt: null });
      (data.iconAssets[profileId] ??= []).unshift(a); return a;
    },
    deleteIconAsset: async (id) => {
      calls.push(`deleteIconAsset:${id}`);
      for (const k of Object.keys(data.iconAssets)) data.iconAssets[k] = data.iconAssets[k]!.filter((a) => a.id !== id);
    },
    // Electron hands a dropped File its real path; a pasted one has none, which is how attachFiles
    // tells the two apart. Tests set `path` on the fake File to say which it is.
    pathForFile: (file) => (file as File & { path?: string }).path ?? "",
    saveTempAttachment: async (name, mime, bytes) => {
      calls.push(`saveTempAttachment:${name}`);
      return { path: `/realm-home/tmp/attachments/aa-${name}`, mime: mime || "application/octet-stream", name, size: bytes.byteLength };
    },
    disposeTerminal: (id) => { disposed.push(id); },
    listSessions: async (sid) => { calls.push(`listSessions:${sid}`); return data.sessions.filter((s) => s.spaceId === sid); },
    listAllSessions: async () => { calls.push("listAllSessions"); await wait("listAllSessions"); return [...data.sessions]; },
    getSession: async (id) => { calls.push(`getSession:${id}`); const s = data.sessions.find((x) => x.id === id); if (!s) throw new Error(`no session ${id}`); return s; },
    createSession: async (input) => {
      // `cwd` is derived from the environment server-side (W1), so the fake derives it too — a
      // session pinned to a worktree that still reported the space folder would make the
      // prompter's environment chip untestable.
      const env = input.environmentId ? (data.environments[input.spaceId] ?? []).find((e) => e.id === input.environmentId) : undefined;
      const s = session(`se${++n}`, input.spaceId, { agentKind: input.agentKind, projectId: input.projectId ?? null, model: input.model ?? null, effort: input.effort ?? null, permissionMode: input.permissionMode ?? "default", title: input.title ?? "Fake agent session",
        // Mirrors the server: `userDispatched` records the one client-claimable origin (Plan 13 W2).
        ...(input.userDispatched ? { dispatchedBy: { kind: "user-dispatch" as const, sessionId: null } } : {}),
        ...(env ? { environmentId: env.id, cwd: env.path } : {}) });
      data.sessions.push(s);
      const it = item(`i${++n}`, input.spaceId, { kind: "session", title: s.title, refId: s.id }); (data.items[input.spaceId] ??= []).push(it);
      calls.push(`createSession:${input.agentKind}`);
      return { session: s, itemId: it.id };
    },
    sendMessage: async (id, text, attachments, mentions) => {
      calls.push(`sendMessage:${id}=${text}${attachments.length ? ` +[${attachments.map((a) => `${a.path}:${a.mime}`).join(",")}]` : ""}`);
      sent.push({ id, text, attachments, ...(mentions.length ? { mentions } : {}) });
    },
    forkSession: async (checkpointId) => {
      calls.push(`forkSession:${checkpointId}`);
      await wait("forkSession");
      const cp = Object.values(data.checkpoints).flat().find((c) => c.id === checkpointId);
      if (!cp?.sessionId) throw new Error("FORK_NO_SESSION");
      const ancestor = data.sessions.find((x) => x.id === cp.sessionId);
      const spaceId = ancestor?.spaceId ?? "s1";
      const env: Environment = { id: `env${++n}`, spaceId, path: `/tmp/worktrees/${spaceId}/fork`, branch: "realm/fork",
        kind: "worktree", portBlockStart: null, createdAt: 0, updatedAt: 0 };
      (data.environments[spaceId] ??= []).push(env);
      const sess = session(`se${++n}`, spaceId, { environmentId: env.id, cwd: env.path,
        title: `Fork: ${ancestor?.title ?? "session"}`, dispatchedBy: { kind: "fork", sessionId: cp.sessionId } });
      data.sessions.push(sess);
      const it = item(`i${n}`, spaceId, { kind: "session", refId: sess.id, title: sess.title });
      (data.items[spaceId] ??= []).push(it);
      return { session: sess, itemId: it.id, environment: env };
    },
    listSkills: async (spaceId) => { calls.push(`listSkills:${spaceId}`); return { root: data.skillsRoot, skills: [...(data.skills[spaceId] ?? [])] }; },
    setSkillEnabled: async (spaceId, id, enabled) => {
      calls.push(`setSkillEnabled:${spaceId}:${id}=${enabled}`);
      // Applied to THIS space's rows and no other's — the per-space disabled set, as the server keys it.
      const rows = data.skills[spaceId] ?? [];
      const i = rows.findIndex((s) => s.id === id);
      if (i >= 0) rows[i] = { ...rows[i]!, enabled };
    },
    promoteSkill: async (spaceId, id) => {
      calls.push(`promoteSkill:${spaceId}:${id}`);
      // Mirrors the server: the defining scope becomes the VANTAGE space's profile — one scope map,
      // so the row flips in every space of that profile that lists it.
      const profileId = findSpace(spaceId).profileId;
      for (const [sid, rows] of Object.entries(data.skills)) {
        if (data.spaces.find((s) => s.id === sid)?.profileId !== profileId) continue;
        const i = rows.findIndex((s) => s.id === id);
        if (i >= 0) rows[i] = { ...rows[i]!, scope: { kind: "profile", profileId } };
      }
    },
    demoteSkill: async (spaceId, id) => {
      calls.push(`demoteSkill:${spaceId}:${id}`);
      // Mirrors the server: pinned to this space; profile siblings stop listing it.
      for (const [sid, rows] of Object.entries(data.skills)) {
        const i = rows.findIndex((s) => s.id === id);
        if (i < 0) continue;
        if (sid === spaceId) rows[i] = { ...rows[i]!, scope: { kind: "space", spaceId } };
        else if (rows[i]!.scope.kind === "profile") rows.splice(i, 1);
      }
    },
    testMcpServer: async (id) => {
      calls.push(`testMcpServer:${id}`);
      await wait(`testMcpServer:${id}`);
      return data.mcpTest[id] ?? { reached: false, detail: "no test result configured" };
    },
    getMemory: async (spaceId) => { calls.push(`getMemory:${spaceId}`); return memState(spaceId); },
    setMemory: async (spaceId, doc) => {
      calls.push(`setMemory:${spaceId}:${doc.length}`);
      // Mirrors the server: past the cap is refused outright, never truncated.
      if (doc.length > MEMORY_DOC_MAX) throw new Error(`the memory document is capped at ${MEMORY_DOC_MAX} characters`);
      data.memoryDocs[spaceId] = doc;
      return memState(spaceId);
    },
    setAgentsFile: async (spaceId, enabled) => {
      calls.push(`setAgentsFile:${spaceId}=${enabled}`);
      const af = data.agentsFiles[spaceId] ?? agentsFileState();
      // Mirrors the server: turning ON is refused where the folder is not Realm's; turning OFF is safe.
      if (enabled && !af.writable) throw new Error(af.reason ?? "Realm will not write an AGENTS.md here");
      data.agentsFiles[spaceId] = { ...af, enabled, exists: enabled || (af.exists && !af.managedByRealm), managedByRealm: enabled };
      return memState(spaceId);
    },
    getProfileMemory: async (profileId) => {
      calls.push(`getProfileMemory:${profileId}`);
      return { profileId, path: `/realm-home/memory/profile-${profileId}.md`, doc: data.profileMemoryDocs[profileId] ?? "" };
    },
    setProfileMemory: async (profileId, doc) => {
      calls.push(`setProfileMemory:${profileId}:${doc.length}`);
      if (doc.length > MEMORY_DOC_MAX) throw new Error(`the memory document is capped at ${MEMORY_DOC_MAX} characters`);
      data.profileMemoryDocs[profileId] = doc;
      return { profileId, path: `/realm-home/memory/profile-${profileId}.md`, doc };
    },
    setProfileDocEnabled: async (spaceId, enabled) => {
      // The per-space override, exactly as the server keys it — the doc itself is untouched.
      calls.push(`setProfileDocEnabled:${spaceId}=${enabled}`);
      data.profileDocDisabled[spaceId] = !enabled;
      return memState(spaceId);
    },
    memorySources: async (sessionId) => {
      calls.push(`memorySources:${sessionId}`);
      const m = data.memorySources[sessionId];
      if (!m) throw new Error(`no memory sources for ${sessionId}`);
      return m;
    },
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
    setSessionEnvironment: async (id, environmentId) => {
      calls.push(`setSessionEnvironment:${id}=${environmentId}`);
      const i = data.sessions.findIndex((x) => x.id === id); if (i < 0) throw new Error(`no session ${id}`);
      // Mirrors the server: the same one-persisted-event lock as setAgent, and cwd follows the row.
      if (data.sessions[i]!.lastEventSeq > 0) throw new Error("this session has already run; it can no longer move to another checkout");
      const env = Object.values(data.environments).flat().find((e) => e.id === environmentId);
      if (!env) throw new Error(`no environment ${environmentId}`);
      if (env.spaceId !== data.sessions[i]!.spaceId) throw new Error("that environment belongs to another space");
      const s = { ...data.sessions[i]!, environmentId, cwd: env.path }; data.sessions[i] = s; return s;
    },
    moveSessionToSpace: async (id, spaceId) => {
      calls.push(`moveSessionToSpace:${id}=${spaceId}`);
      const i = data.sessions.findIndex((x) => x.id === id); if (i < 0) throw new Error(`no session ${id}`);
      // Mirrors the server: the same one-persisted-event lock as setAgent/setEnvironment.
      if (data.sessions[i]!.lastEventSeq > 0) throw new Error("this session has already run; it can no longer move to another space");
      findSpace(spaceId);
      // The fake has no per-space "primary environment" concept; unlike the real server this leaves
      // environmentId/cwd untouched, so a test asserting on the destination cwd should seed one.
      const s = { ...data.sessions[i]!, spaceId, projectId: null }; data.sessions[i] = s; return s;
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
    tccProbe: async () => { calls.push("tccProbe"); return [...data.tccRows]; },
    openTccPane: async (pane) => { calls.push(`openTccPane:${pane}`); },
    macAccessStatus: async () => { calls.push("macAccessStatus"); return structuredClone(data.macAccess); },
    /** Models the real thing: the prompt goes up, the user answers, and the WHOLE audit is re-read —
     *  so what the store receives is the row's post-answer shape, never a client-side guess. */
    macAccessGrant: async (id) => {
      calls.push(`macAccessGrant:${id}`);
      await wait(`macAccessGrant:${id}`);
      const answer = data.macGrantAnswers[id] ?? "granted";
      const rows = data.macAccess.rows.map((r) => (r.id === id ? macRow(r.id, r.label, r.group, answer) : r));
      data.macAccess = { ...data.macAccess, rows };
      return structuredClone(data.macAccess);
    },
    macAccessOpenSettings: async (id) => { calls.push(`macAccessOpenSettings:${id}`); },
    macAccessRevealApp: async () => { calls.push("macAccessRevealApp"); },
    updateStatus: async () => { calls.push("updateStatus"); return { ...data.updateStatus }; },
    // Mirrors main's gate: a disabled updater answers its state unchanged — the fake never checks.
    checkUpdates: async () => {
      calls.push("checkUpdates");
      await wait("checkUpdates");
      return { ...data.updateStatus };
    },
    installUpdate: async () => { calls.push("installUpdate"); },
    probeAgents: async (force) => {
      calls.push(`probeAgents:${force}`);
      await wait("probeAgents");
      return data.agentProbe;
    },
    importScan: async () => { calls.push("importScan"); await wait("importScan"); return data.importScan; },
    importApply: async (selection) => {
      calls.push(`importApply:${(selection.sessions ?? []).length}|${(selection.memories ?? []).length}|${(selection.skills ?? []).length}`);
      importApplied.push(selection);
      await wait("importApply");
      return data.importResult;
    },
    gitInfo: async (cwd) => { calls.push(`gitInfo:${cwd}`); await wait(`gitInfo:${cwd}`); return data.gitInfo[cwd] ?? null; },
    diff: async (cwd) => { calls.push(`diff:${cwd}`); await wait(`diff:${cwd}`); return data.diffs[cwd] ?? null; },
    fileDiff: async (cwd, path, staged) => {
      calls.push(`fileDiff:${cwd}|${path}|${staged}`);
      await wait(`fileDiff:${path}`);
      return data.patches[`${cwd}|${path}|${staged}`]
        ?? { path, oldPath: null, staged, binary: false, hunks: [], truncated: false, truncatedReason: null, additions: 0, deletions: 0 };
    },
    stagePaths: async (cwd, paths) => { calls.push(`stage:${cwd}|${paths.join(",")}`); },
    unstagePaths: async (cwd, paths) => { calls.push(`unstage:${cwd}|${paths.join(",")}`); },
    ship: async (input) => {
      calls.push(`ship:${input.cwd}|commit=${input.commit}|msg=${input.message}|push=${input.push}|upstream=${input.setUpstream}|pr=${input.openPr}|env=${input.environmentId}`);
      await wait("ship");
      return data.shipResult;
    },
    createItem: async (spaceId, kind, title, refId) => {
      calls.push(`createItem:${spaceId}|${kind}|${refId}`);
      const it = item(`i${++n}`, spaceId, { kind, title, refId });
      (data.items[spaceId] ??= []).push(it);
      return it;
    },
    worktreeStatus: async (id) => {
      calls.push(`worktreeStatus:${id}`);
      const st = data.worktreeStatus[id];
      if (!st) throw new Error(`no worktree status for ${id}`);
      return st;
    },
    removeWorktree: async (id, ack) => {
      calls.push(`removeWorktree:${id}|${ack.dirtyFiles},${ack.unpushedCommits}`);
      const st = data.worktreeStatus[id];
      // Mirrors the server: an acknowledgement that does not match what git says RIGHT NOW is refused.
      if (st && (st.dirtyFiles !== ack.dirtyFiles || st.unpushedCommits !== ack.unpushedCommits)) throw new Error("WORKTREE_UNSAFE");
      delete data.worktreeStatus[id];
      for (const list of Object.values(data.environments)) {
        const i = list.findIndex((e) => e.id === id);
        if (i >= 0) list.splice(i, 1);
      }
    },
    listShips: async (spaceId, cursor = null, limit) => {
      calls.push(`listShips:${spaceId}`);
      const cap = Math.max(1, Math.min(limit ?? 100, 200));
      let rows = [...(data.ships[spaceId] ?? [])].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      if (cursor) {
        const i = cursor.indexOf(":"); const at = Number(cursor.slice(0, i)); const id = cursor.slice(i + 1);
        rows = rows.filter((x) => x.createdAt < at || (x.createdAt === at && x.id < id));
      }
      const page = rows.slice(0, cap);
      return { ships: page, nextCursor: page.length === cap && page.length > 0 ? `${page.at(-1)!.createdAt}:${page.at(-1)!.id}` : null };
    },
    listCheckpoints: async (environmentId, sessionId) => {
      calls.push(`listCheckpoints:${environmentId}|${sessionId ?? "*"}`);
      const all = data.checkpoints[environmentId] ?? [];
      // A COPY, like every real response: returning the stored array would hand the store the same
      // reference it already holds, and a selector comparing by identity would never re-render.
      return sessionId ? all.filter((c) => c.sessionId === sessionId) : [...all];
    },
    captureCheckpoint: async (environmentId, sessionId) => {
      calls.push(`captureCheckpoint:${environmentId}|${sessionId ?? "*"}`);
      const cp = checkpoint(`cp${++n}`, environmentId, { kind: "manual", sessionId, label: "Manual checkpoint", createdAt: Date.now() });
      (data.checkpoints[environmentId] ??= []).unshift(cp);
      return cp;
    },
    previewCheckpoint: async (id) => {
      calls.push(`previewCheckpoint:${id}`);
      const p = data.checkpointPreview[id];
      if (!p) throw new Error(`no preview for ${id}`);
      return p;
    },
    restoreCheckpoint: async (id, ack) => {
      calls.push(`restoreCheckpoint:${id}|${ack.filesChanged},${ack.commitsRolledBack}`);
      const p = data.checkpointPreview[id];
      if (!p) throw new Error(`no preview for ${id}`);
      // Mirrors the server: an acknowledgement that does not match what git says RIGHT NOW is refused.
      if (p.filesChanged !== ack.filesChanged || p.commitsRolledBack !== ack.commitsRolledBack) throw new Error("RESTORE_UNSAFE");
      const undo = checkpoint(`cp-undo-${id}`, p.environmentId, { kind: "pre-restore", label: `Before restoring \u201c${p.label}\u201d` });
      (data.checkpoints[p.environmentId] ??= []).unshift(undo);
      return { environmentId: p.environmentId, path: p.path, undoCheckpointId: undo.id,
        headMoved: p.headMovable, filesChanged: p.filesChanged, commitsRolledBack: p.headMovable ? p.commitsRolledBack : 0,
        filesRemoved: 0, conversationRewound: false };
    },
    listMcpServers: async (spaceId) => {
      calls.push(`listMcpServers:${spaceId}`);
      await wait(`listMcpServers:${spaceId}`);
      return { servers: data.mcpServers.map((s) => ({ ...s })), secretNote: MCP_SECRET_STORAGE_NOTE };
    },
    addMcpServer: async (input: AddMcpServerInput) => {
      calls.push(`addMcpServer:${input.name}`);
      mcpWrites.push(input);
      const keys = Object.keys(input.transport === "stdio" ? input.env ?? {} : input.headers ?? {});
      const s = mcpServer(`mcp${++n}`, {
        name: input.name, transport: input.transport,
        command: input.command ?? "", args: input.args ?? [], url: input.url ?? "",
        envKeys: input.transport === "stdio" ? keys : [], headerKeys: input.transport === "stdio" ? [] : keys,
        authKind: keys.length > 0 ? "secrets" : "none",
        enabled: input.spaceId !== null,
      });
      data.mcpServers.push(s);
      return s;
    },
    updateMcpServer: async (input: UpdateMcpServerInput) => {
      calls.push(`updateMcpServer:${input.id}`);
      mcpWrites.push(input);
      const i = data.mcpServers.findIndex((x) => x.id === input.id);
      if (i < 0) throw new Error(`no mcp server ${input.id}`);
      const cur = data.mcpServers[i]!;
      const transport = input.transport ?? cur.transport;
      const sameTransport = transport === cur.transport;
      const envKeys = input.env ? Object.keys(input.env) : sameTransport ? cur.envKeys : [];
      const headerKeys = input.headers ? Object.keys(input.headers) : sameTransport ? cur.headerKeys : [];
      const secretKeys = transport === "stdio" ? envKeys : headerKeys;
      const s: McpServer = {
        ...cur, name: input.name ?? cur.name, transport,
        command: input.command ?? (sameTransport ? cur.command : ""),
        args: input.args ?? (sameTransport ? cur.args : []),
        url: input.url ?? (sameTransport ? cur.url : ""),
        envKeys: transport === "stdio" ? envKeys : [], headerKeys: transport === "stdio" ? [] : headerKeys,
        // Mirrors toContract: oauth beats secrets beats none, and a URL/transport change on an
        // oauth-connected row clears the connection (binding note 3) — the fake drops it the same way.
        authKind: cur.authKind === "oauth" && sameTransport && (input.url ?? cur.url) === cur.url ? "oauth" : secretKeys.length > 0 ? "secrets" : "none",
        oauthStatus: cur.authKind === "oauth" && sameTransport && (input.url ?? cur.url) === cur.url ? cur.oauthStatus : "unconfigured",
      };
      data.mcpServers[i] = s;
      return s;
    },
    removeMcpServer: async (id) => { calls.push(`removeMcpServer:${id}`); data.mcpServers = data.mcpServers.filter((s) => s.id !== id); },
    setMcpEnabled: async (spaceId, id, enabled) => {
      calls.push(`setMcpEnabled:${spaceId}:${id}=${enabled}`);
      const i = data.mcpServers.findIndex((x) => x.id === id); if (i < 0) throw new Error(`no mcp server ${id}`);
      data.mcpServers[i] = { ...data.mcpServers[i]!, enabled };
    },
    promoteMcpServer: async (spaceId, id) => {
      calls.push(`promoteMcpServer:${spaceId}:${id}`);
      const i = data.mcpServers.findIndex((x) => x.id === id); if (i < 0) throw new Error(`no mcp server ${id}`);
      data.mcpServers[i] = { ...data.mcpServers[i]!, scope: { kind: "profile", profileId: findSpace(spaceId).profileId } };
    },
    demoteMcpServer: async (spaceId, id) => {
      calls.push(`demoteMcpServer:${spaceId}:${id}`);
      const i = data.mcpServers.findIndex((x) => x.id === id); if (i < 0) throw new Error(`no mcp server ${id}`);
      data.mcpServers[i] = { ...data.mcpServers[i]!, scope: { kind: "space", spaceId } };
    },
    listMcpProviders: async (spaceId) => { calls.push(`listMcpProviders:${spaceId}`); return data.mcpProviders.map((p) => ({ ...p })); },
    setMcpProviderEnabled: async (spaceId, name, enabled) => {
      calls.push(`setMcpProviderEnabled:${spaceId}:${name}=${enabled}`);
      const i = data.mcpProviders.findIndex((p) => p.name === name); if (i < 0) throw new Error(`no provider ${name}`);
      data.mcpProviders[i] = { ...data.mcpProviders[i]!, enabled };
    },
    mcpToolsList: async (id) => {
      calls.push(`mcpToolsList:${id}`);
      const err = data.mcpToolsError[id] ?? null;
      if (err) return { tools: [], error: err };
      const i = data.mcpServers.findIndex((x) => x.id === id); if (i < 0) throw new Error(`no mcp server ${id}`);
      const tools = data.mcpToolsResult[id] ?? data.mcpServers[i]!.tools;
      data.mcpServers[i] = { ...data.mcpServers[i]!, tools };
      return { tools, error: null };
    },
    setMcpAllowedTools: async (spaceId, id, tools) => {
      calls.push(`setMcpAllowedTools:${spaceId}:${id}=${tools === null ? "null" : tools.join(",")}`);
      const i = data.mcpServers.findIndex((x) => x.id === id); if (i < 0) throw new Error(`no mcp server ${id}`);
      data.mcpServers[i] = { ...data.mcpServers[i]!, allowedTools: tools };
    },
    startMcpOauth: async (id) => { calls.push(`startMcpOauth:${id}`); return { authUrl: `https://oauth.example/authorize?server=${id}` }; },
    disconnectMcpOauth: async (id) => {
      calls.push(`disconnectMcpOauth:${id}`);
      const i = data.mcpServers.findIndex((x) => x.id === id); if (i < 0) throw new Error(`no mcp server ${id}`);
      data.mcpServers[i] = { ...data.mcpServers[i]!, oauthStatus: "unconfigured" };
    },
    retryMcpServer: async (id) => {
      calls.push(`retryMcpServer:${id}`);
      const i = data.mcpServers.findIndex((x) => x.id === id); if (i < 0) throw new Error(`no mcp server ${id}`);
      data.mcpServers[i] = { ...data.mcpServers[i]!, status: "idle" };
    },
    // Mirrors McpCallLogStore.list (apps/server/src/store/mcp.ts): newest first (ts DESC, id DESC — the
    // same total order the composite cursor relies on to resume a same-millisecond boundary without
    // skipping or repeating a row), filtered by sessionId/serverId equality, paged by the `{ ts, id }`
    // cursor rather than a plain `ts <` — see that store's doc comment for why a plain cursor is wrong.
    mcpCallsList: async (params) => {
      const key = `mcpCallsList:${params.sessionId ?? "*"}:${params.serverId ?? "*"}:${params.before ? `${params.before.ts},${params.before.id}` : "-"}:${params.limit ?? "-"}`;
      calls.push(key);
      await wait(key); // lets a test park a delay on `api.delays[key]` — the supersession-guard tests need this
      const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
      let rows = [...data.mcpCalls];
      if (params.sessionId !== undefined) rows = rows.filter((c) => c.sessionId === params.sessionId);
      if (params.serverId !== undefined) rows = rows.filter((c) => c.serverId === params.serverId);
      if (params.before) {
        const b = params.before;
        rows = rows.filter((c) => c.ts < b.ts || (c.ts === b.ts && c.id < b.id));
      }
      rows.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      return { calls: rows.slice(0, limit) };
    },
    // Mirrors NotificationsStore.list (apps/server/src/store/notifications.ts): created_at DESC, id
    // DESC, `${createdAt}:${id}` cursor — and the unread count comes from the whole set, never the
    // page, because the pill's number is the SERVER's derivation on the real wire too.
    listNotifications: async (cursor, limit) => {
      calls.push(`listNotifications:${cursor ?? "-"}:${limit ?? "-"}`);
      const cap = Math.max(1, Math.min(limit ?? 100, 200));
      let rows = [...data.notifications].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      if (cursor) {
        const i = cursor.indexOf(":"); const at = Number(cursor.slice(0, i)); const id = cursor.slice(i + 1);
        rows = rows.filter((x) => x.createdAt < at || (x.createdAt === at && x.id < id));
      }
      const page = rows.slice(0, cap);
      return { notifications: page, nextCursor: page.length === cap && page.length > 0 ? `${page.at(-1)!.createdAt}:${page.at(-1)!.id}` : null,
        unread: data.notifications.filter((x) => x.readAt === null).length };
    },
    markNotificationsRead: async (input) => {
      calls.push(`markNotificationsRead:${input.all ? "all" : (input.ids ?? []).join(",")}`);
      const t = Date.now();
      for (const x of data.notifications) {
        if (x.readAt === null && (input.all || (input.ids ?? []).includes(x.id))) x.readAt = t;
      }
      return { ok: true as const, unread: data.notifications.filter((x) => x.readAt === null).length };
    },
    requestReview: async (environmentId) => {
      calls.push(`requestReview:${environmentId}`);
      return { sessionId: "01ARZ3NDEKTSV4RRFFQ69G5RVW", itemId: "01ARZ3NDEKTSV4RRFFQ69G5RVI" };
    },
    getReview: async (environmentId) => { calls.push(`getReview:${environmentId}`); return { review: data.reviews[environmentId] ?? null }; },
    dismissReview: async (environmentId) => { calls.push(`dismissReview:${environmentId}`); data.reviews[environmentId] = null; },
  };
  const wait = (key: string) => new Promise<void>((r) => setTimeout(r, api.delays[key] ?? 0));
  return api;
}
