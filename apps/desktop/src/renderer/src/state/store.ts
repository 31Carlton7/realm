import { createStore, useStore, type StoreApi } from "zustand";
import {
  allItems, closeItem as layoutClose, emptyLayout, equalizeSplit as layoutEqualize, findLeafOfItem, firstLeaf, gridPreset, itemIdOfLeaf, openItem as layoutOpen, splitLeaf, updateSizes, AgentKindSchema, LayoutSchema, PLAN_PERMISSION_MODE,
  lectureWrapUpPrompt, localDateStamp, sessionEvent,
  activeGroup, activeLayout, addGroup as groupsAdd, reconcileGroups, allGroupItems, detachItemFrom, groupAtOffset, groupOfItem, groupsFromLayout, moveItemToGroup as groupsMoveItem, removeGroup as groupsRemove, renameGroup as groupsRename, setActiveGroup as groupsSetActive, setActiveLayout, SpaceGroupsSchema, toggleZoom as groupsToggleZoom, unzoom as groupsUnzoom, zoomLeaf as groupsZoom,
  canNav, forgetNavItems, navEntry, pushNav, reconcileNav, stepNav,
  AGENT_SKILL_SUPPORT, AGENT_SUPPORTS_PERMISSION_MODES, basenameOf, formatAttachmentSize, MAX_ATTACHMENT_BYTES, mentionIds, mimeForPath, PAGE_REF_IDS,
  DEFAULT_PERMISSION_MODE_KEY, NOTIFICATIONS_DESKTOP_KEY, NOTIFICATIONS_DISABLED_KEY, NOTIFICATION_CATEGORIES, PERMISSION_MODES, MODEL_FAVORITES_KEY, parseSpaceIcon, type ModelInfo,
  type DestinationPageKind, type NotificationCategory, type NavEntry, type PaneHistory, type DocumentEntry, type DocumentKind, type DocumentWorkspace,
  type AgentKind, type Attachment, type BrowserCredential, type BrowserCredentialInput, type Checkpoint, type DiffSummary, type Environment, type FileDiff, type GitInfo, type IconAsset, type ImportApplyParams, type ImportResult, type ImportScan, type Item, type GuideProgress, type Lecture, type PlynnImportResult, type PlynnMeeting, type StartLectureResult, type Layout, type McpCall, type McpOauthStatus, type McpServer, type McpServerStatus, type McpTransport, type MemorySources, type MemoryState, type MethodResult, type Notification, type PaneGroup, type PresetName, type Profile, type Project, type RestorePreview, type RestoreResult, type ReviewResult, type SearchResults, type Session, type SessionMode, type SessionStatus, type Ship, type ShipResult, type Skill, type Space, type SpaceGroups, type StoredSessionEvent, type WorktreeAck, type WorktreeStatus, type SkillSource, type Run, type RunAttempt, type RunState, type UsageBudget, type UsageBucketKind, type UsageSummary,
} from "@realm/contracts";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { SHEET_MIN_WIDTH, complementOf, snapBrowserLeaves } from "./no-overlay";
import type { ThemePref } from "../theme/useTheme";
import { emptyTranscript, reduceTranscript, type Transcript } from "../panes/session/transcript-model";
import { allowlistKey, getBrowserBridges, parseAllowlist } from "../panes/browser/browser-client";

export type CreateSpaceInput = { name: string; icon: string; profileId: string; color?: string };
export type UpdateSpaceInput = { id: string; name?: string; icon?: string; color?: string; profileId?: string };
export type UpdateItemInput = { id: string; title?: string; pinned?: boolean; archived?: boolean };
export type CreateSessionInput = { spaceId: string; agentKind: AgentKind; projectId?: string | null; environmentId?: string | null; model?: string | null; effort?: string | null; permissionMode?: string; title?: string;
  /** Plan 13 W2 (⌘⇧↩): record `dispatchedBy: { kind: "user-dispatch" }` on the row — the Tasks
   *  lens's seam. The only origin a client may claim; the agent origins are server-recorded. */
  userDispatched?: boolean };
/** `mcp.add` params, minus the wire's own defaulting — undefined fields simply aren't sent. */
export type AddMcpServerInput = {
  spaceId: string | null; name: string; transport: McpTransport;
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>;
};
/** `mcp.update` params. `spaceId` is only so the result can report `enabled` for the space the editor
 *  is open in — passing it never changes which spaces have this server enabled. */
export type UpdateMcpServerInput = {
  id: string; spaceId?: string | null; name?: string; transport?: McpTransport;
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>;
};
export type SessionOptions = { model?: string; effort?: string; permissionMode?: string };
/** A pending attachment as the prompter holds it. `path`/`mime` are the wire fields; `name` labels the
 *  chip and `size` is what the MAX_ATTACHMENT_BYTES check reads — neither is transmitted. */
export type PickedAttachment = Attachment & { name: string; size: number };
/** Agent a session is created with when the user never said (first run, or a wiped setting). */
export const FALLBACK_AGENT: AgentKind = "claude";
export type PermissionDecision = "allow" | "allow_always" | "deny";
/** Where a sidebar row was dropped on a pane: an edge splits there, center replaces the pane's item.
 *  Canonical home of this type — PaneHost imports it from here. */
export type DropEdge = "left" | "right" | "top" | "bottom" | "center";
/** Live css-pixel rect where one browser pane's NATIVE view paints (Plan 11 W2), keyed by the
 *  browser ITEM id. What the no-overlay primitives avoid. */
export type BrowserRect = { itemId: string; x: number; y: number; width: number; height: number };
/** One settled agent action on a browser (W4's ticker line): the permission system's attributed
 *  description, whether it succeeded, and when it settled. */
export type BrowserActionTick = { text: string; ok: boolean; ts: number };
/** How many recent actions the per-browser ring buffer keeps — the ticker shows the latest; the
 *  hover reveal shows the rest. Small on purpose: this is a glance, not a transcript. */
export const BROWSER_ACTIONS_MAX = 8;
export type AgentProbe = MethodResult<"agents.probe">[number];
/** `mcp.test`'s answer: reached or not, and one sentence saying why. Built server-side from things that
 *  cannot be secrets (see live-check.ts), so a UI may render `detail` verbatim. */
export type McpTestResult = { reached: boolean; detail: string };
/** A `session.event` broadcast: persisted rows carry their seq; ephemeral ones (deltas) have seq -1. */
export type LiveSessionEvent = StoredSessionEvent & { ephemeral: boolean };
export type TranscriptEntry = { lastSeq: number; t: Transcript };

/** Everything the store needs from the outside world: realm-server RPC plus the two platform
 *  seams (native folder picker, local terminal disposal). Tests substitute a fake. */
/** What main reports about the secret store itself. `available`: macOS will encrypt (no store
 *  without it). `canPromptTouchID`: this Mac can satisfy a fill — Settings says so plainly rather
 *  than letting the user enroll a password and find out at a sign-in prompt. */
export type CredentialStatus = { available: boolean; canPromptTouchID: boolean; presenceTtlMs: number };

export type Api = {
  listProfiles(): Promise<Profile[]>;
  /** Icon/color are server defaults (`user` / grey) — the sheet only asks for a name. */
  createProfile(name: string): Promise<Profile>;
  /** Global list across all profiles, in user sort order. */
  listSpaces(): Promise<Space[]>;
  listItems(spaceId: string): Promise<Item[]>;
  /** Every item across every space, newest-updated first (command palette search). */
  listAllItems(): Promise<Item[]>;
  /** `search.query` — deep search over ONE profile's transcripts, item titles, skills and memory
   *  (Plan 16 W2). Profile scoping is the server's; the client only names which profile it is in. */
  search(profileId: string, query: string): Promise<SearchResults>;
  listProjects(spaceId: string): Promise<Project[]>;
  /** Every checkout the space knows about: its primary, plus any worktree Realm made (W2). */
  listEnvironments(spaceId: string): Promise<Environment[]>;
  /** `environments.createWorktree` — makes the worktree on disk AND its row, as one operation. */
  createWorktree(spaceId: string, title: string | null): Promise<Environment>;
  createSpace(input: CreateSpaceInput): Promise<Space>;
  updateSpace(input: UpdateSpaceInput): Promise<Space>;
  reorderSpaces(ids: string[]): Promise<void>;
  deleteSpace(id: string): Promise<void>;
  createProject(spaceId: string, name: string, rootPath: string): Promise<Project>;
  setLayout(spaceId: string, layout: Layout): Promise<Space>;
  /** `spaces.setGroups` — the whole group set (membership, names, active pointer, per-group zoom) in
   *  one write. Every layout persist goes through this now; `setLayout` survives only for the fakes
   *  and for callers that genuinely mean "just the active group's tree". */
  setGroups(spaceId: string, groups: SpaceGroups): Promise<Space>;
  createTerminal(spaceId: string): Promise<{ terminalId: string; itemId: string }>;
  /** `browsers.create` — row + item; the native view is the pane's own business (Plan 11 W1). */
  createBrowser(spaceId: string): Promise<{ browserId: string; itemId: string; url: string }>;
  /** Plan 17 W1. `environmentId` omitted roots the workspace at the space's primary checkout. */
  createDocuments(spaceId: string, environmentId?: string): Promise<{ documentsId: string; itemId: string }>;
  getDocuments(documentsId: string): Promise<DocumentWorkspace>;
  setDocumentTabs(documentsId: string, openPaths: string[], activePath: string | null): Promise<DocumentWorkspace>;
  detachDocuments(documentsId: string): Promise<void>;
  listDocumentEntries(documentsId: string, dir: string): Promise<DocumentEntry[]>;
  readDocument(documentsId: string, path: string): Promise<{ text: string; hash: string }>;
  writeDocument(documentsId: string, path: string, text: string, baseHash: string | null):
    Promise<{ ok: true; hash: string } | { ok: false; currentText: string; currentHash: string }>;
  createDocumentFile(documentsId: string, path: string, kind: DocumentKind, title: string): Promise<{ path: string; hash: string }>;
  renameDocumentFile(documentsId: string, from: string, to: string): Promise<{ path: string }>;
  /** Plan 22 (school workflows): previews, guide progress, lectures, the Plynn handoff. */
  previewInfo(): Promise<{ port: number; token: string }>;
  openDocumentPath(spaceId: string, path: string, environmentId?: string): Promise<{ documentsId: string; itemId: string; environmentId: string }>;
  readGuideProgress(documentsId: string, path: string): Promise<GuideProgress>;
  recordGuideAttempt(documentsId: string, path: string, topic: string, correct: number, total: number): Promise<GuideProgress>;
  startLecture(spaceId: string, title: string): Promise<StartLectureResult>;
  listLectures(spaceId: string): Promise<Lecture[]>;
  plynnList(): Promise<{ available: boolean; folder: string; meetings: PlynnMeeting[] }>;
  plynnImport(spaceId: string, files: string[]): Promise<PlynnImportResult>;
  updateItem(input: UpdateItemInput): Promise<Item>;
  /** Deleting a terminal item closes its pty server-side. */
  deleteItem(id: string): Promise<void>;
  getSetting(key: string): Promise<unknown>;
  setSetting(key: string, value: unknown): Promise<void>;
  /** `system.info` — the under-strip's display-only machine label (Plan 12 W1) and the person's
   *  first name for the hero greeting. One call: boot wants both labels at the same moment. */
  systemInfo(): Promise<{ machineName: string; userName: string }>;
  /** Native folder picker; resolves null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Native multi-select file picker; resolves [] when cancelled. */
  pickFiles(): Promise<PickedAttachment[]>;
  /** The filesystem path behind a dropped File. "" when it has none — a pasted image, which has to be
   *  written out with `saveTempAttachment` before any adapter can be given a path. */
  pathForFile(file: File): string;
  /** Write a pathless (pasted) file under Realm's home so it HAS a path. `mime` is what the browser
   *  reported for the clipboard item; the main process falls back to the extension when it is empty. */
  saveTempAttachment(name: string, mime: string, bytes: Uint8Array): Promise<PickedAttachment>;
  /** Drop the renderer-side xterm instance/scrollback for a closed terminal. */
  disposeTerminal(terminalId: string): void;
  /** The space icon picker's per-profile library (`iconAssets.*`). */
  listIconAssets(profileId: string): Promise<IconAsset[]>;
  /** One-shot Claude call; can take a few seconds. Throws `ICON_INVALID`/`ICON_TOO_LARGE` on a
   *  response that failed the server's structural check. */
  generateIconAsset(profileId: string, prompt: string): Promise<IconAsset>;
  /** Native single-image picker for an icon upload; null when cancelled. */
  pickIconImage(): Promise<PickedFile | null>;
  uploadIconAsset(profileId: string, path: string): Promise<IconAsset>;
  deleteIconAsset(id: string): Promise<void>;
  listSessions(spaceId: string): Promise<Session[]>;
  /** Every session across every space (sessionId→spaceId map for cross-space badges). */
  listAllSessions(): Promise<Session[]>;
  getSession(id: string): Promise<Session>;
  createSession(input: CreateSessionInput): Promise<{ session: Session; itemId: string }>;
  /** `sessions.fork` (Plan 16 W3): a new worktree restored to the checkpoint + a new session carrying
   *  the ancestor transcript as text. The ancestor is untouched. */
  forkSession(checkpointId: string): Promise<{ session: Session; itemId: string; environment: Environment }>;
  /** `skills.list` for a space: the library folder and every skill in it, valid or not — the mention
   *  picker (W4) reads the skills, the settings panel (W5) also shows the root and the invalid rows. */
  listSkills(spaceId: string): Promise<{ root: string; skills: Skill[] }>;
  /** `skills.sources` — the directories the scan reads for this space, and what each contributed. */
  listSkillSources(spaceId: string): Promise<{ sources: SkillSource[] }>;
  /** `skills.addScanRoot` / `skills.removeScanRoot` — the user's own extra directories. Machine-global. */
  addSkillScanRoot(path: string): Promise<void>;
  removeSkillScanRoot(path: string): Promise<void>;
  /** `skills.setEnabled` — one skill, one SPACE. The store is a per-space disabled set. */
  setSkillEnabled(spaceId: string, id: string, enabled: boolean): Promise<void>;
  /** `skills.promote` — move a skill's defining scope from space level into `spaceId`'s profile (W2
   *  RPC, W4 UI). Effective-set neutral at the moment it runs; what changes is reach. */
  promoteSkill(spaceId: string, id: string): Promise<void>;
  /** `skills.demote` — pin a profile-scoped skill to `spaceId` alone. */
  demoteSkill(spaceId: string, id: string): Promise<void>;
  /** `mcp.test` — a live connection attempt from realm-server; resolves reached/failed with a sentence.
   *  The rest of the MCP surface is declared with the gateway methods further down. */
  testMcpServer(id: string): Promise<McpTestResult>;
  /** `memory.get` — this space's Realm memory document and its AGENTS.md state. */
  getMemory(spaceId: string): Promise<MemoryState>;
  /** `memory.set` — replaces the document; the server refuses past MEMORY_DOC_MAX rather than truncate. */
  setMemory(spaceId: string, doc: string): Promise<MemoryState>;
  /** `memory.setAgentsFile` — the one permitted write outside Realm's home; refused off primary folders. */
  setAgentsFile(spaceId: string, enabled: boolean): Promise<MemoryState>;
  /** `memory.sources` — what one session's agent actually loads, on the best authority per agent. */
  memorySources(sessionId: string): Promise<MemorySources>;
  /** `mentions` are the skill ids the draft's `@`-tokens were recognised as; the server re-validates
   *  and resolves them so a raw `@name` never reaches an agent (contracts/mentions.ts). */
  sendMessage(id: string, text: string, attachments: Attachment[], mentions: string[]): Promise<void>;
  interruptSession(id: string): Promise<void>;
  respondPermission(id: string, requestId: string, decision: PermissionDecision, answers?: Record<string, string>): Promise<void>;
  setSessionOptions(id: string, o: SessionOptions): Promise<Session>;
  /** `sessions.setAgent` — rejected by the server once the session has any event. */
  setSessionAgent(id: string, agentKind: AgentKind): Promise<Session>;
  /** `sessions.setEnvironment` — same guard: rejected once the session has any event. */
  setSessionEnvironment(id: string, environmentId: string): Promise<Session>;
  /** `sessions.moveToSpace` — same guard as setAgent/setEnvironment: rejected once the session has any event. */
  moveSessionToSpace(id: string, spaceId: string): Promise<Session>;
  /** Persisted events with seq > afterSeq, ascending, at most `limit`. */
  sessionEvents(id: string, afterSeq: number, limit: number): Promise<StoredSessionEvent[]>;
  /** `sessions.openTerminal` — get-or-create the session's terminal side panel. The FIRST call is what
   *  spawns the pty, so this must only ever be called when the panel is actually being shown. */
  openSessionTerminal(sessionId: string): Promise<{ terminalId: string; itemId: string }>;
  /** `terminals.write` — raw bytes into a pty. A trailing "\n" is what RUNS the line, so callers that
   *  are only offering a command (the install card) must not send one. */
  writeTerminal(terminalId: string, data: string): Promise<void>;
  /** Type a command into a terminal once its shell goes quiet; never appends a newline. */
  prefillTerminal(terminalId: string, command: string): Promise<void>;
  /** `force` bypasses the server's probe cache (the install card's retry / focus refresh). */
  probeAgents(force: boolean): Promise<AgentProbe[]>;
  /** `models.catalog` — prices, context windows and reasoning efforts for the picker. Never rejects
   *  on a dead network: the server answers with its cache, or with nothing. */
  modelCatalog(force: boolean): Promise<ModelInfo[]>;
  /** `usage.summary` — the whole Usage tab for one range in one call, so no two numbers on the page
   *  can disagree about which slice they describe. */
  usageSummary(p: { from: number; to: number; bucket: UsageBucketKind; spaceId: string | null; profileId: string | null }): Promise<UsageSummary>;
  /** `usage.setBudget`. Answers the STORED budget (thresholds normalized), which is what the panel
   *  then renders — so a threshold the server dropped never lingers on screen as if it had stuck. */
  setUsageBudget(budget: UsageBudget): Promise<UsageBudget>;
  /** `import.scan` — everything the agent CLIs have on disk, matched to spaces. A pure read: it
   *  creates nothing, so it is safe to call on mount and on every "Re-scan" click. */
  importScan(): Promise<ImportScan>;
  /** `import.apply` — the only writer. Takes the targets the USER settled on in the preview, which
   *  is why the panel passes them back explicitly instead of letting the server re-match. */
  importApply(selection: ImportApplyParams): Promise<ImportResult>;
  /** The macOS Permissions tab's rows (Plan 12 W6) — main-process IPC, not RPC. Honest by
   *  construction: the probe behind it never triggers a TCC prompt (see main/tcc.ts). */
  tccProbe(): Promise<TccRow[]>;
  /**
   * Settings → Sign-ins (main's `secret-store.ts`). Note the absence of a read: `credentialAdd`
   * takes a value and answers with `BrowserCredential`, which has no field for one. The renderer
   * cannot read a saved credential back and neither can anything it talks to.
   */
  credentialList(): Promise<BrowserCredential[]>;
  credentialStatus(): Promise<CredentialStatus>;
  credentialAdd(input: BrowserCredentialInput): Promise<BrowserCredential>;
  credentialRemove(id: string): Promise<boolean>;
  credentialSetPresenceTtl(ms: number): Promise<number>;
  /** Deep-link one permission row's System Settings pane. Takes the ROW id; main owns the URLs. */
  openTccPane(pane: string): Promise<void>;
  /** `mac doctor` through main — the prompt-free audit behind the "Apps on this Mac" rows. */
  macAccessStatus(): Promise<MacAccessStatus>;
  /** Raise ONE capability's macOS prompt and resolve the re-read audit. Unlike every other Api
   *  method this one is expected to sit pending: the child blocks in the consent dialog until the
   *  user clicks. Takes a CAPABILITY id; main owns the command. */
  macAccessGrant(id: string): Promise<MacAccessStatus>;
  macAccessOpenSettings(id: string): Promise<void>;
  /** Select Realm's .app in Finder — the start of the drag into Full Disk Access. */
  macAccessRevealApp(): Promise<void>;
  /** The Updates row's state (Plan 15 W1) — main-process IPC. The gate lives in main (updater.ts):
   *  a gated build answers `disabled` with its reason, and `checkUpdates` on such a build returns
   *  that same state rather than pretending to check. */
  updateStatus(): Promise<UpdateStatus>;
  checkUpdates(): Promise<UpdateStatus>;
  /** Quit-and-install; main ignores it unless an update is actually downloaded. */
  installUpdate(): Promise<void>;
  /** Ask main to post an OS toast for a surfaced feed row. Answers whether one was actually shown —
   *  main suppresses it while the Realm window is focused, and that call is main's to make. */
  showDesktopNotification(input: { id: string; title: string; body: string | null }): Promise<boolean>;
  /** Push the dock badge. Every unread change goes through here; 0 clears it. */
  setBadgeCount(count: number): Promise<void>;
  /** `workspace.gitInfo`: null when cwd is not a git repo (server caches ~3s). */
  gitInfo(cwd: string): Promise<GitInfo | null>;
  /** `workspace.diff` — the changed-file list. Null when cwd is not a repo. */
  diff(cwd: string): Promise<DiffSummary | null>;
  /** `workspace.fileDiff` — one file's patch, one side of the index. */
  fileDiff(cwd: string, path: string, staged: boolean): Promise<FileDiff>;
  stagePaths(cwd: string, paths: string[]): Promise<void>;
  unstagePaths(cwd: string, paths: string[]): Promise<void>;
  /** `workspace.ship` — commit, push and open a PR as one call. */
  ship(input: ShipInput): Promise<ShipResult>;
  /** `items.create` — used only for the diff pane's item, whose refId is an ENVIRONMENT id. */
  createItem(spaceId: string, kind: Item["kind"], title: string, refId: string): Promise<Item>;
  /** `environments.worktreeStatus` — what removal would cost, asked of git right now. */
  worktreeStatus(environmentId: string): Promise<WorktreeStatus>;
  /** `environments.removeWorktree`. The acknowledgement must equal what the server reads at the
   *  moment it runs, or it refuses — see `confirmRemoveWorktree`. */
  removeWorktree(environmentId: string, acknowledge: WorktreeAck): Promise<void>;
  /** `checkpoints.list` — a session's turns, or the whole checkout's when `sessionId` is null (W4). */
  listCheckpoints(environmentId: string, sessionId: string | null): Promise<Checkpoint[]>;
  /** `checkpoints.capture` — take one now, because the user asked. */
  captureCheckpoint(environmentId: string, sessionId: string | null): Promise<Checkpoint>;
  /** `checkpoints.preview` — what restoring would cost, asked of git right now. */
  previewCheckpoint(id: string): Promise<RestorePreview>;
  /** `checkpoints.restore`. The acknowledgement must equal what the server re-reads, or it refuses. */
  restoreCheckpoint(id: string, acknowledge: { filesChanged: number; commitsRolledBack: number }): Promise<RestoreResult>;
  /** `mcp.list` — every server Realm knows about, carrying this space's own enable flag + allowlist. */
  listMcpServers(spaceId: string): Promise<{ servers: McpServer[]; secretNote: string }>;
  addMcpServer(input: AddMcpServerInput): Promise<McpServer>;
  updateMcpServer(input: UpdateMcpServerInput): Promise<McpServer>;
  removeMcpServer(id: string): Promise<void>;
  setMcpEnabled(spaceId: string, id: string, enabled: boolean): Promise<void>;
  /** `mcp.promote` / `mcp.demote` — move a server's defining scope (W2 RPCs, W4 UI). */
  promoteMcpServer(spaceId: string, id: string): Promise<void>;
  demoteMcpServer(spaceId: string, id: string): Promise<void>;
  /** `mcp.providers.list` — the gateway's Realm-native toolsets with THIS space's switch state (W4). */
  listMcpProviders(spaceId: string): Promise<{ name: string; enabled: boolean }[]>;
  /** `mcp.setProviderEnabled` — providers default ON (Realm's own code); this is the per-space off switch. */
  setMcpProviderEnabled(spaceId: string, name: string, enabled: boolean): Promise<void>;
  /** `memory.getProfile` / `memory.setProfile` — the profile doc at its DEFINING scope; a save applies
   *  to every space of the profile, which is why the editor for it must say so (W4's Library page). */
  getProfileMemory(profileId: string): Promise<ProfileMemoryDoc>;
  setProfileMemory(profileId: string, doc: string): Promise<ProfileMemoryDoc>;
  /** `memory.setProfileDocEnabled` — THIS space's inheritance override for the profile doc, never a
   *  write to the doc itself. */
  setProfileDocEnabled(spaceId: string, enabled: boolean): Promise<MemoryState>;
  /** `mcp.tools.list` — triggers a lazy connect. A connect failure comes back as `error`, not a throw:
   *  the list is still a renderable result. */
  mcpToolsList(id: string): Promise<{ tools: McpServer["tools"]; error: string | null }>;
  /** `null` = every cached tool allowed. */
  setMcpAllowedTools(spaceId: string, id: string, tools: string[] | null): Promise<void>;
  /** `mcp.oauth.start` — the renderer opens the returned URL itself (`window.open`). */
  startMcpOauth(id: string): Promise<{ authUrl: string }>;
  disconnectMcpOauth(id: string): Promise<void>;
  /** `mcp.retry` — closes a tripped circuit breaker and drops the stale client. */
  retryMcpServer(id: string): Promise<void>;
  /** `mcp.calls.list` — Realm's own call log (Activity), newest first. `before` pages backward by the
   *  composite `{ ts, id }` cursor (W1 amendment); omitted, it starts from the top. */
  mcpCallsList(params: McpCallsFilter & { before?: { ts: number; id: string }; limit?: number }): Promise<{ calls: McpCall[] }>;
  /** `ships.list` (Plan 14 W1): one page of a space's durable ship log, newest first. */
  listShips(spaceId: string, cursor?: string | null, limit?: number): Promise<{ ships: Ship[]; nextCursor: string | null }>;
  /** `runs.list` (durable runs): one page of a space's runs, newest first. `states` narrows; an
   *  empty array means every state. */
  listRuns(spaceId: string, states?: RunState[], cursor?: string | null, limit?: number): Promise<{ runs: Run[]; nextCursor: string | null }>;
  /** `runs.create` — queue a durable run. Returns the row plus whether it was newly created (a
   *  `dedupeKey` collision returns the live run instead of a second one). */
  createRun(input: { spaceId: string; goal: string; title?: string }): Promise<{ run: Run; created: boolean }>;
  /** `runs.get` — one run plus its full attempt log. Null when the run is gone. */
  getRun(id: string): Promise<{ run: Run; attempts: RunAttempt[] } | null>;
  /** `runs.cancel` / `runs.retry` / `runs.approve` — the three writes the lens offers. Each returns
   *  the fresh row; the server also broadcasts `runs.changed`, so the reply is belt-and-braces. */
  cancelRun(id: string): Promise<Run>;
  retryRun(id: string): Promise<Run>;
  approveRun(id: string, approved: boolean, note: string | null): Promise<Run>;
  /** `notifications.list` (Plan 12 W5): one page of the global feed, plus the server's unread count —
   *  the ONE source every unread badge renders. */
  listNotifications(cursor: string | null, limit?: number): Promise<{ notifications: Notification[]; nextCursor: string | null; unread: number }>;
  /** `notifications.markRead` — named ids, or the whole (global) feed. */
  markNotificationsRead(input: { ids?: string[]; all?: boolean }): Promise<{ ok: true; unread: number }>;
  /** `review.request` (Plan 13 W3): spawn the read-only reviewer over this environment. Returns as
   *  soon as the reviewer session exists; the verdict arrives as a `review.changed` broadcast. */
  requestReview(environmentId: string): Promise<{ sessionId: string; itemId: string }>;
  /** `review.get` — the environment's persisted verdict, or null. */
  getReview(environmentId: string): Promise<{ review: ReviewResult | null }>;
  /** `review.dismiss` — clear the persisted verdict (server-side, so every window's pane hears it). */
  dismissReview(environmentId: string): Promise<void>;
};

/** The two narrowing dimensions Activity's chips apply — `undefined` means "not filtering by this". */
export type McpCallsFilter = { sessionId?: string; serverId?: string };

/** `memory.getProfile`'s shape: the profile doc at its defining scope — no per-space fields, because
 *  the defining scope has none (`enabledHere` belongs to `MemoryState.profile`, a space's view). */
export type ProfileMemoryDoc = { profileId: string; path: string; doc: string };

/** One Realm-native gateway toolset as `mcp.providers.list` reports it for a space (W4). */
export type McpProvider = { name: string; enabled: boolean };

/** Item titles for the destination pages (W4). Static like the space page's "Overview": the page
 *  header renders the live copy, so a snapshot in the item row has nothing to go stale against. */
export const DESTINATION_PAGE_TITLES: Record<DestinationPageKind, string> = {
  "library-page": "Library",
  "connections-page": "Connections",
  "notifications-page": "Notifications",
  "settings-page": "Settings",
  // Static like the rest: the page header renders the live profile name; the item row's title has
  // nothing to go stale against (Plan 14 W2).
  "profile-page": "Profile",
};

/**
 * Where an activated destination page lands.
 *
 * `reuse` is the plain click: one page per space, so a second activation goes to the pane that already
 * holds it — including one in a pane group that is not on screen, which the plain click will switch to.
 * `here` overrides that homing and moves the page into the focused pane instead.
 *
 * They only differ once the page is open somewhere else. A page that does not exist yet is created in
 * the focused pane under either placement, which is why the surfaces offering `here` gate on
 * `destinationPageElsewhere` rather than advertising a choice that has one outcome.
 */
export type DestinationPlacement = "reuse" | "here";

/** Feed page size (W5). Modest: the page is a glance at what waited, not an archive browser —
 *  "Load more" pages further on the server's cursor. */
export const NOTIFICATIONS_PAGE = 50;

/** What the diff pane sends to `workspace.ship`. `cwd` is the environment's checkout. */
export type ShipInput = { cwd: string; commit: boolean; message: string; push: boolean; setUpstream: boolean; openPr: boolean;
  /** The pane's environment — the durable log's attribution (Plan 14 W1). The diff pane always has
   *  one (its item's refId IS the environment id), so every pane-driven ship names it. */
  environmentId: string };

/**
 * One file's patch, keyed by which side of the index it is. Two sides of one path are two entries:
 * they are genuinely different patches.
 *
 * NUL separates the parts, because it is the one byte a path cannot contain — a space would make
 * `a/b c.ts` and the pair (`a/b`, `c.ts`) the same key. Spelled as the escape `\u0000` and never as
 * a literal byte: a source file containing one is "binary" to grep, which then silently finds
 * nothing in it.
 */
export const patchKey = (cwd: string, path: string, staged: boolean) => `${cwd}\u0000${path}\u0000${staged ? "s" : "u"}`;

/** Which key sends the composer draft. "enter" (default): plain Enter sends, Shift+Enter inserts a
 *  newline. "cmdEnter": plain Enter inserts a newline, only ⌘/Ctrl+Enter sends. */
export type SubmitKey = "enter" | "cmdEnter";

export const PERSIST_DEBOUNCE_MS = 300;
export const SETTING_ACTIVE_SPACE = "ui.activeSpaceId";
export const SETTING_THEME = "ui.theme";
/** Agent of the most recent session the user created or switched to — what "+"/⌘N reach for next. */
export const SETTING_LAST_AGENT = "ui.lastAgentKind";
const SETTING_SWIPE_INVERT = "ui.swipeInvert";
const SETTING_SUBMIT_KEY = "ui.submitKey";
/** Whether the sidebar is collapsed to the top rail. Persisted so a collapsed window stays
 *  collapsed across launches — the whole point of collapsing is reclaiming the 280px for good. */
const SETTING_SIDEBAR_COLLAPSED = "ui.sidebarCollapsed";
/** Per-session terminal-panel state (open + width), keyed by session id. */
export const SETTING_TERMINAL_PANEL = "ui.terminalPanel";
export const EVENTS_PAGE = 1000;
/** Activity's page size — matches `mcp.calls.list`'s own default, so "fewer than a page came back"
 *  (the "Load more" hide condition) means the same thing on both sides of the wire. */
export const MCP_CALLS_PAGE = 50;
/** Ceiling on `mcpCalls` while the sheet is open and live events are prepending (W7 plan: "cap the
 *  in-memory list... so a chatty agent can't grow it unboundedly"). Only the live-prepend path
 *  (`applyMcpCall`) enforces this — `loadMoreMcpCalls` is a page the user explicitly asked for, and
 *  trimming it would make "Load more" lie about what it just fetched. */
export const MCP_CALLS_LIVE_CAP = 500;
/** Plan 6 W4: the session's terminal panel takes 38% of the session pane the first time it opens. */
export const TERMINAL_PANEL_WIDTH = 38;

/** One session's terminal side panel: whether it is showing, and its share (%) of the session pane. */
export type TerminalPanel = { open: boolean; width: number };

/** Settings are `unknown` on the wire and the file is user-editable, so the persisted panel map is
 *  validated field by field; anything malformed is dropped rather than trusted into the layout. */
export function parseTerminalPanels(raw: unknown): Record<string, TerminalPanel> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TerminalPanel> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const { open, width } = v as { open?: unknown; width?: unknown };
    if (typeof open !== "boolean") continue;
    out[id] = { open, width: typeof width === "number" && width > 0 && width < 100 ? width : TERMINAL_PANEL_WIDTH };
  }
  return out;
}

/** The space page's tab rail (Plan 12 W3). "connections" is what the retired sheet called "mcp" —
 *  openers that used `tab: "mcp"` (the plus-menu's "Manage connections…") map to it. */
export type SpacePageTab = "general" | "memory" | "skills" | "connections" | "sessions" | "tasks" | "history";
/** The profile page's rail (Plan 14 W2). */
export type ProfilePageTab = "skills" | "connections" | "memory";

/** Sessions are never created through a sheet (W3): "+"/⌘N/palette create one instantly and every
 *  choice lives on the prompter's chips. What remains here is genuinely form-shaped. */
export type Sheet =
  /** Space settings retired from this union (Plan 12 W3): a space is a PAGE now — a `space-page` item
   *  in the layout, opened via `openSpacePage` — not a modal. */
  | { kind: "new-space" }
  /** Removing a worktree: the one destructive confirm in Plan 7, which must name what would be lost
   *  and pass an acknowledgement it re-read at the moment of confirming (W3). */
  | { kind: "remove-worktree"; environmentId: string }
  /** A checkout's checkpoints, and the confirm for restoring one (W4). One sheet in two states: the
   *  list, and — once `selected` is set — the confirmation naming exactly what restoring would cost. */
  | { kind: "checkpoints"; environmentId: string; sessionId: string | null }
  /** Realm's log of every proxied MCP call (W7), global across spaces/sessions — see `openActivity`.
   *  Opened from McpSection ("Activity") or the palette ("MCP Activity"); replaces whatever sheet was
   *  open (the one-slot ruling — see the sheet-plumbing note above), including space settings itself. */
  | { kind: "activity" }
  /** Plan 22: start a lecture (title prompt), wrap one up (pick which), import Plynn recordings. */
  | { kind: "new-lecture" }
  | { kind: "wrap-up-lecture" }
  | { kind: "plynn-import" };

export type AppState = {
  /** False until `boot()` has finished once. First-run onboarding keys off "no spaces" — which is also
   *  what an unbooted store looks like, so without this the sheet would flash on every launch. */
  booted: boolean;
  profiles: Profile[];
  /** All spaces across profiles, in user sort order. Exactly one is active at a time. */
  spaces: Space[]; activeSpaceId: string | null;
  themePref: ThemePref;
  /** Invert the two-finger swipe direction (default: fingers-left → next space, like Arc/Spaces). */
  swipeInvert: boolean;
  submitKey: SubmitKey;
  /** Sidebar hidden, its toggle moved to the top rail. The toggle is rendered in BOTH states —
   *  a collapse with no way back is a trap — which is why this is one boolean and not a mode. */
  sidebarCollapsed: boolean;
  items: Item[];
  /** The active space's pane groups — several named split arrangements, exactly one of them active.
   *  Null only before a space is selected. This is the source of truth; `layout` mirrors it. */
  groups: SpaceGroups | null;
  /** The ACTIVE group's layout, mirrored out of `groups` on every write (see `writeGroups`). Kept as
   *  its own field so every reader that only ever wanted "what is on screen" — the pane host, the
   *  sidebar glyph, `focusIn`, the hotkeys — is untouched by groups existing. Never set alone. */
  layout: Layout | null;
  /** Items across every space (palette search); refreshed when the palette opens. */
  allItems: Item[];
  /** Agent of the last session created or switched to, persisted across launches; null until one exists
   *  (then instant-create falls back to FALLBACK_AGENT). */
  lastAgentKind: AgentKind | null;
  /** Arms the inline rename of the pane showing this item (palette → PanelBar seam). */
  renamingItemId: string | null;
  /** Arms the inline rename of a pane group's tab and sidebar header (group menu → header seam) —
   *  the same idiom as `renamingItemId`, for the one piece of a space's structure that is not an Item. */
  renamingGroupId: string | null;
  /** The leaf pane that has focus (pane clicks, open/split target). Reset to the first leaf whenever the
   *  layout no longer contains it. */
  focusedLeafId: string | null;
  /** Per-pane back/forward trails, keyed by leaf id (see `PaneHistory`). Written in exactly one place —
   *  `writeGroups`, which reconciles it against the layout on every structural write — plus the two
   *  explicit actions (`navigateInPane`, `stepPaneNav`) and the item prune in `refreshItems`. */
  paneHistory: PaneHistory;
  /** The notifications page's selected row, or null for the bare list. USER-level, not per space and
   *  not per item: the feed is one global thing, so the page's vantage into it is too — opening
   *  Notifications from any space lands on the row you were reading. Panes record moves into their own
   *  leaf's trail, so Back retraces them; the selection itself has no other home. */
  notificationsSelectedId: string | null;
  projects: Project[];
  /** The active space's environments, by id — what tells the prompter a session is in a worktree.
   *  Sparse by design: a space that has never run anything has none until one is created. */
  environments: Record<string, Environment>;
  error: string | null;
  /** Socket health, mirrored from RpcClient.onStatusChange. "reconnecting" shows the banner. */
  connectionState: "connected" | "reconnecting";
  paletteOpen: boolean;
  /** The space overview (⌘⇧Space): every space across every profile, sectioned. Its own flag rather
   *  than a `Sheet`, for the same reason `paletteOpen` is — it must toggle from its own hotkey while
   *  open, which the sheet guard in hotkeys.ts forbids. */
  spacesOpen: boolean;
  /** profileId → the space that profile was last on, THIS RUN. Not persisted: it is the memory of a
   *  session's back-and-forth, and a restart legitimately starts from the saved active space. */
  lastSpaceByProfile: Record<string, string>;
  sheet: Sheet | null;
  /** Every visible browser view's rect, reference-stable between real changes (W2). */
  browserRects: BrowserRect[];
  /** W4: recent settled agent actions per browserId (ring, newest last, `BROWSER_ACTIONS_MAX` deep) —
   *  the pane chrome's ticker. Kept across space switches like sessionStatus: broadcasts fire for
   *  every space and a ticker that forgets on switch would lie by omission. */
  browserActions: Record<string, BrowserActionTick[]>;
  /** W4: browserIds an agent act/batch step is CURRENTLY in flight on — the "agent is driving" dot
   *  on the sidebar row and pane chrome. Every set is cleared by the matching settle broadcast. */
  browserDriving: Record<string, boolean>;
  /** W2.4: the pre-snap layout while a sheet forced the browser leaf to a ≤50% split. Non-null
   *  exactly while a snap is active; the layout to restore when the sheet actually closes. */
  sheetSnap: { saved: Layout; spaceId: string | null } | null;
  /** Sessions of the active space, by id. */
  sessions: Record<string, Session>;
  /** Statuses across spaces: seeded by refreshAllSessions, kept current by session.status broadcasts
   *  (which fire for every space) — entries survive space switches. */
  sessionStatus: Record<string, SessionStatus>;
  /** sessionId → spaceId for EVERY known session. session.status broadcasts carry only a sessionId;
   *  this map is what lets an inactive space's strip button wear its badge. */
  sessionSpace: Record<string, string>;
  /** Transcripts by session id, kept across space switches (cheap, and a session pane may be revisited). */
  transcripts: Record<string, TranscriptEntry>;
  /** The fetched slice of the GLOBAL notifications feed (W5), newest first — what the page renders.
   *  Empty until the page (or a broadcast) loads it; broadcasts prepend surfaced rows. */
  notifications: Notification[];
  /** The whole feed's unread count, applied VERBATIM from `notifications.list`/`notifications.changed`
   *  — never derived by counting `notifications`, which only holds the pages fetched so far. One
   *  derivation site (the server's store), one number everywhere. */
  notificationsUnread: number;
  /** `nextCursor` of the last page fetched; null = end reached (or nothing fetched yet). */
  notificationsCursor: string | null;
  /** Whether the feed is allowed to reach the OS — toasts and the dock badge (`NOTIFICATIONS_DESKTOP_KEY`,
   *  default-on). Held HERE rather than inside `settingsPrefs` because it is needed from the moment
   *  the first broadcast can arrive, and `settingsPrefs` stays null until the Settings page mounts —
   *  a toast that only worked after a visit to Settings would be a toast that does not work. */
  desktopNotifications: boolean;
  agentProbe: AgentProbe[];
  /** The Settings page's App-tab preferences (Plan 12 W6), read from the server's settings rows:
   *  which notification categories are switched OFF (`NOTIFICATIONS_DISABLED_KEY` — default-on
   *  polarity, matching the service), and the permission mode new sessions start in
   *  (`DEFAULT_PERMISSION_MODE_KEY`). Null until the page first loads them — the page fetches on
   *  mount, and a null renders as loading rather than as every-toggle-on lies. */
  settingsPrefs: { disabledCategories: NotificationCategory[]; defaultPermissionMode: string } | null;
  /** Canonical model keys the user has starred (`MODEL_FAVORITES_KEY`), for the model picker's
   *  favourites tab, its favourites-first ordering and its 1…9 shortcuts. Empty rather than null
   *  before it loads: unlike the settings page, an unstarred picker is a perfectly honest picker,
   *  so there is nothing to hold back while the read is in flight. */
  modelFavorites: string[];
  /** The model catalog, keyed by canonical model key — what the picker's detail pane reads for a
   *  model's price, context window and reasoning efforts. Empty before the first load AND on a dead
   *  network, which are the same thing as far as the picker is concerned: rows render without
   *  prices rather than waiting for them. */
  modelInfo: Record<string, ModelInfo>;
  /** The Permissions tab's TCC rows, exactly as main's prompt-free probe reported them; null until
   *  the tab first probes. Never synthesised client-side — a row with no probe basis says so. */
  tccRows: TccRow[] | null;
  /** Enrolled sign-ins; null until first load. Metadata only — see `credentialList`. */
  credentials: BrowserCredential[] | null;
  credentialStatus: CredentialStatus | null;
  /** The `mac` CLI's access, exactly as `mac doctor` reported it through main; null until the
   *  Permissions tab first asks. Never synthesised client-side: an audit that could not run comes
   *  back with every row `unknown`, which is what "we don't know" looks like. */
  macAccess: MacAccessStatus | null;
  /** The capability whose macOS dialog is up right now (a "Grant all" run walks these one at a
   *  time), or null. Drives the row spinner AND the interlock that stops a second prompt racing the
   *  first — macOS shows one consent dialog at a time, and two in flight lose an answer. */
  macGranting: string | null;
  /** The ids a "Grant all" run still has to reach, so the page can say "3 of 11" honestly rather
   *  than showing an unattributed spinner. Empty when no run is in flight. */
  macGrantQueue: string[];
  /** The Updates row's state (Plan 15 W1), exactly as main's gated updater reported it; null until
   *  the App tab first asks. A disabled state renders its reason — never a dead button. */
  updateStatus: UpdateStatus | null;
  /** Composer drafts by session id — store-owned so layout reshapes/pane remounts never lose typed
   *  text (A-M9). Never persisted; dropped when the session's item is deleted. */
  drafts: Record<string, string>;
  /** Pending attachments by session id. Store-owned for exactly the reason drafts are: they are part of
   *  the draft, and a pane remount must not silently drop the file the user just dragged in. Cleared by
   *  a successful send, and with the session's item. */
  pendingAttachments: Record<string, PickedAttachment[]>;
  /** Skill ids the draft's `@`-tokens have been recognised as, per session (W4). Store-owned like the
   *  draft itself, and maintained by `setDraft`: an id stays recognised while its token stays in the
   *  text — which is what lets a skill disabled or DELETED after typing still degrade to plain text at
   *  send (the server strips the `@`) instead of going out as a literal `@name`. */
  draftMentions: Record<string, string[]>;
  /** The skills library by space id (`skills.list`) — what the mention picker offers. Refreshed when a
   *  skills-capable session opens and on `skills.changed`. */
  spaceSkills: Record<string, Skill[]>;
  /** Per-space scan sources, for the skills panel's "where these come from" section. */
  spaceSkillSources: Record<string, SkillSource[]>;
  /** Where the library lives on disk (`skills.list` root) — the settings panel's "drop a folder here"
   *  hint. Global, not per-space; "" until the first fetch. */
  skillsRoot: string;
  /** `memory.get` by space id — the memory panel's document + AGENTS.md state. */
  spaceMemory: Record<string, MemoryState>;
  /** `iconAssets.list` by profile id — the space icon picker's "Generated"/"Uploaded" library. One
   *  set per profile (never per-space): a generated or uploaded icon is reusable by every space
   *  under that profile, the same posture the built-in icon list already has. */
  iconAssets: Record<string, IconAsset[]>;
  /** `memory.sources` by session id — fetched when the memory panel asks about a session. */
  sessionMemorySources: Record<string, MemorySources>;
  /** The permission mode a session was on when it entered Plan, by session id — see `setSessionMode`.
   *  Not persisted: after a restart a session already in Plan returns to `default`, which is the safe
   *  direction to be wrong in. */
  planReturn: Record<string, string>;
  /** Git working-tree summaries by cwd; null = known non-repo. Refreshed event-driven only (session
   *  status transitions to idle/error, space activation, session open) — never polled. */
  gitInfo: Record<string, GitInfo | null>;
  /** `workspace.diff` by checkout path; null = known non-repo, absent = never asked (W3). */
  diffs: Record<string, DiffSummary | null>;
  /** Checkouts with a diff fetch in flight — the pane's only spinner. */
  diffLoading: Record<string, boolean>;
  /** Patches by `patchKey(cwd, path, staged)`. Fetched on expansion, never with the list: the
   *  truncation policy in git-diff.ts is only affordable because of this. */
  patches: Record<string, FileDiff>;
  /** The commit message being typed, per checkout. Store-owned like `drafts`, for the same reason:
   *  a pane remount must not eat it. */
  commitMessages: Record<string, string>;
  /** The last `workspace.ship` outcome per checkout — what the pane turns into an explained state. */
  shipResults: Record<string, ShipResult>;
  /** Checkouts with a ship in flight, so the button can refuse to fire twice. */
  shipping: Record<string, boolean>;
  /** The latest persisted review verdict per ENVIRONMENT id (Plan 13 W3) — the diff pane's `review`
   *  section. null = known none (dismissed, shipped, or never reviewed); absent = never asked. */
  reviews: Record<string, ReviewResult | null>;
  /** Environments whose review is in flight — set on request, cleared when the verdict's
   *  `review.changed` lands. Client-side convenience only; the server owns the real in-flight guard. */
  reviewing: Record<string, boolean>;
  /** `environments.worktreeStatus` by environment id — what the removal sheet shows. */
  worktreeStatuses: Record<string, WorktreeStatus>;
  /** Set when a confirmed removal's re-read disagreed with the numbers the user was shown: the sheet
   *  says the tree moved and asks again rather than acknowledging a count nobody saw. */
  worktreeAckStale: string | null;
  /** `checkpoints.list` by environment id (W4). Absent = never asked. */
  checkpoints: Record<string, Checkpoint[]>;
  /** `ships.list` first page by space id (Plan 14 W1) — the History tab's other half. Absent = never
   *  asked; the `ships.changed` handler only refreshes spaces already held here. */
  ships: Record<string, Ship[]>;
  /** `runs.list` first page by space id — the Tasks lens's run half. Absent = never asked, which is
   *  what keeps `runs.changed` from fetching for a space nobody is looking at. */
  runs: Record<string, Run[]>;
  /** Which run the Tasks lens has selected, PER SPACE — the same posture as `spacePageTab`, so two
   *  space pages open side by side do not fight over one selection. */
  selectedRunId: Record<string, string | null>;
  /** The selected run's attempt log, by run id. Fetched on selection (`runs.get`); the list rows
   *  carry the run itself, so this holds only what a row cannot. */
  runAttempts: Record<string, RunAttempt[]>;
  /** The checkpoint the sheet is asking about, as the preview it is showing. Null = the list state;
   *  the preview carries its own `checkpointId`, so there is nothing else to remember. */
  checkpointPreview: RestorePreview | null;
  /** Set when a confirmed restore's re-read disagreed with the preview the user was shown. */
  checkpointAckStale: boolean;
  /** The last restore's outcome, so the sheet can say what happened and name the undo. */
  restoreResult: RestoreResult | null;
  /** Terminal side panel per session id (W4). Absent = never opened, which is also what keeps the pty
   *  unspawned: nothing reaches the server until an entry turns `open`. Persisted as one setting. */
  terminalPanel: Record<string, TerminalPanel>;
  /** sessionId → the terminal id backing its panel; filled by the first openSessionTerminal. */
  sessionTerminals: Record<string, string>;
  /** `system.info.machineName` (Plan 12 W1) — the under-strip's machine label. Display only: Realm runs
   *  agents on this Mac and no other, so there is no selector to back. "" until boot's fetch answers
   *  (the strip renders nothing rather than a wrong name). */
  machineName: string;
  /** `system.info.userName` — the account's first name, for the hero prompter's greeting. "" when the
   *  host reports no real name (or before boot's fetch answers), which the greeting reads as "greet
   *  the space, not the person" rather than as a blank to print. */
  userName: string;
  /** The prompter's Connectors submenu source (Plan 12 W1), by space id: the same `mcp.list` projection
   *  the settings sheet reads, cached HERE so the menu shows LAST KNOWN state — `mcp.list` reads rows
   *  and the hub's held status, it dials nothing, so refreshing on menu open never probes a server.
   *  `mcp.serverStatus` broadcasts patch it live; absent = never fetched, rendered as such. */
  connectors: Record<string, McpServer[]>;
  /** The per-space browser origin allowlist (Plan 14 W4), by space id — `browser.allowedOrigins:<id>`
   *  as last fetched. null = no list = allow everything (W1's default posture); absent = never
   *  fetched. The Connections tab's Browser origins section reads and writes this. */
  browserAllowlists: Record<string, string[] | null>;
  /** MCP servers for the space whose Connections tab is currently mounted (W6) — `mcp.list`'s
   *  per-space projection. Empty until `refreshMcpServers` runs; McpSection fetches on mount. */
  mcpServers: McpServer[];
  /** Realm-native gateway providers for that same mounted space (W4) — fetched alongside
   *  `mcpServers`, under the same `mcpPanelSpaceId` guard, cleared with them. */
  mcpProviders: McpProvider[];
  /** Profile memory docs at their defining scope, by profile id (W4: the Library page's
   *  "Edit in profile" editor). Absent = never fetched. */
  profileMemory: Record<string, ProfileMemoryDoc>;
  /** Which space's Connections panel (McpSection) is mounted right now, null when none is. Set
   *  synchronously by `clearMcpServers` on mount/unmount; it is the guard that keeps a slow
   *  `mcp.list` response — or an `mcp.changed` refetch — from clobbering another space's list
   *  (Plan 12 W3: the sheet whose open/closed state used to be this guard is gone). */
  mcpPanelSpaceId: string | null;
  /** The space page's selected tab, PER SPACE (Plan 12 W3): switching spaces must never carry one
   *  space's tab — and with it another space's data fetch — onto a different space's page. Absent =
   *  "general". */
  spacePageTab: Record<string, SpacePageTab>;
  /** The profile page's tab, per PROFILE id (Plan 14 W2) — in the store, not component state, because
   *  openers land on a section ("Edit in profile" on an MCP row lands on Connections; the memory
   *  row's on Memory) whether or not the page is already open. */
  profilePageTab: Record<string, ProfilePageTab>;
  /** The last `mcp.tools.list` error per server id, `null` once a refresh succeeds. A RESULT, not an
   *  exception (see the Api doc comment) — kept apart from `error` so it renders inline on the row that
   *  caused it instead of stealing the app's one error banner. */
  mcpToolsError: Record<string, string | null>;
  /** Activity's loaded page(s), newest first (W7). Empty until `openActivity`/`refreshMcpCalls` runs. */
  mcpCalls: McpCall[];
  /** Activity's active narrowing — both `undefined` is "everything" (binding rule 5: the sheet shows
   *  every space/session by default). Read by `refreshMcpCalls`/`loadMoreMcpCalls` and by the live
   *  `mcp.call` matcher in `applyMcpCall`. */
  mcpCallsFilter: McpCallsFilter;
  /** False once a fetch (initial or "Load more") returns fewer rows than it asked for — the signal
   *  ActivitySheet uses to hide the button rather than offering a page that would come back empty. */
  mcpCallsHasMore: boolean;
  activeSpace(): Space | undefined;
  activeIndex(): number;
  /** The active space's profile — the only thing that decides which spaces the strip and the swiper
   *  show. Null before boot (and only then): every space has a profile. */
  activeProfileId(): string | null;
  /** The ACTIVE PROFILE's spaces, in the global sort order. `spaces` stays the whole list — the
   *  palette, the overview and cross-space badges all still want it — but the sidebar is scoped:
   *  a profile is the separator, so a strip of one profile's spaces is a strip that fits. */
  profileSpaces(): Space[];
  boot(): Promise<void>;
  selectSpace(id: string): Promise<void>;
  /** Switch profiles: land on the space that profile was last on this run, else its first. The
   *  strip's profile chip and the overview's cross-profile rows both come through here. */
  selectProfile(profileId: string): Promise<void>;
  /** Step within the ACTIVE PROFILE, never across it — the swiper, ⌃Tab and ⌘1…9 all page over the
   *  same bounded set the strip shows. Crossing profiles is a deliberate act (chip, or overview). */
  nextSpace(): Promise<void>;
  prevSpace(): Promise<void>;
  /** Create a profile and merge it into `profiles`; returns it so callers can select it. */
  createProfile(name: string): Promise<Profile>;
  createSpace(input: CreateSpaceInput): Promise<void>;
  updateSpace(input: UpdateSpaceInput): Promise<void>;
  deleteSpace(id: string): Promise<void>;
  reorderSpaces(ids: string[]): Promise<void>;
  setThemePref(pref: ThemePref): Promise<void>;
  setSwipeInvert(v: boolean): Promise<void>;
  /** Flip the sidebar between full column and top rail, and persist it. */
  toggleSidebar(): Promise<void>;
  setSubmitKey(v: SubmitKey): Promise<void>;
  refreshSpaces(): Promise<void>;
  refreshItems(): Promise<void>;
  refreshAllItems(): Promise<void>;
  /** Deep search scoped to the ACTIVE space's profile (Plan 16 W2). Returns results for the palette
   *  to append below its instant rows — deliberately not stored in state: the palette owns the
   *  debounce and the stale-response guard, and nothing else reads these. Null with no active space
   *  (no profile to scope by — an unscoped search would be the leak W1 exists to prevent). */
  searchDeep(query: string): Promise<SearchResults | null>;
  refreshProjects(): Promise<void>;
  refreshEnvironments(): Promise<void>;
  linkProject(rootPath: string): Promise<void>;
  pickAndLinkProject(): Promise<void>;
  newTerminal(targetLeafId?: string | null): Promise<void>;
  /** New browser pane in the active space (opens into the target/focused leaf). */
  newBrowser(targetLeafId?: string | null): Promise<void>;
  updateItem(input: UpdateItemInput): Promise<void>;
  /** Shelve (or restore) a row. Archiving closes the pane first — a hidden row whose pane is still on
   *  screen is the one state the sidebar could not explain — so this is `updateItem` plus that close,
   *  in that order; unarchiving only clears the flag and leaves the item unopened in the SPACE group. */
  archiveItem(itemId: string, archived: boolean): Promise<void>;
  /** Open an item into `leafId` ?? the focused leaf ?? the first leaf, replacing what it held (the
   *  replaced item returns to the SPACE group); focuses that leaf. With no explicit `leafId`, an
   *  already-open item is only focused (click = go there) — layout untouched, nothing persisted. */
  openItem(itemId: string, leafId?: string | null): Promise<void>;
  /** Agent-opened panes: open beside the focused pane (split right), never replacing it. */
  openItemBeside(itemId: string): Promise<void>;
  /** `openItemBeside` minus the focus move (Plan 13 W2's dispatch): the pane appears beside — or
   *  fills the focused-but-empty leaf — and `focusedLeafId` is NOT touched, because the whole point
   *  of dispatching is that the user keeps typing where they are. An already-open item is left
   *  entirely alone (no "go there": that would be a focus steal by another name). */
  openItemBesideQuiet(itemId: string): Promise<void>;
  /** Layout-only close: the item leaves the layout but keeps existing (SPACE group). Never deletes. */
  closeFromLayout(itemId: string): Promise<void>;
  /** Destructive: closes from the layout, deletes the item server-side (kills ptys), and drops local
   *  terminal/session state. */
  deleteItem(itemId: string): Promise<void>;
  /** Split the focused leaf (or first leaf) with an empty sibling and focus the new leaf. */
  splitFocused(dir: "row" | "col"): Promise<void>;
  /** Drag-to-split: center replaces the leaf's item; an edge splits in that direction, the dropped item
   *  landing on the near side. */
  openItemAt(itemId: string, leafId: string, edge: DropEdge): Promise<void>;
  focusLeaf(leafId: string): void;

  // ——— Per-pane back/forward (the PanelBar arrows) ———
  /** Record a move WITHIN a pane — a notification selected, a page tab switched — on the trail of the
   *  leaf currently showing `itemId`. Item swaps record themselves (see writeGroups); this is for the
   *  second coordinate a pane navigates on, which no layout write can see. A no-op when the item is
   *  not on screen: there is no pane, so there is no trail to write to. */
  navigateInPane(itemId: string, view: string | null): void;
  /** Step one pane `delta` stops along its own trail (`-1` back, `+1` forward) and put it back exactly
   *  as it stood — item AND in-pane view. No-op at either end. */
  stepPaneNav(leafId: string, delta: number): Promise<void>;
  /** Is there a stop `delta` steps from where `leafId` stands? What greys the arrows out. */
  canPaneNav(leafId: string | null, delta: number): boolean;
  /** Move pane focus to the structural neighbor in that direction (see neighborLeafId); no-op without one. */
  focusNeighbor(dir: FocusDir): void;
  applyPreset(name: PresetName): Promise<void>;
  /** Functional sizes update for one split; persisted with a trailing debounce. No-op if unchanged.
   *  Until the active space's items have loaded, sizes apply locally but never persist — PanelGroup
   *  fires onLayout at mount with normalized sizes, and that echo is not a user action. */
  resizeSplit(splitId: string, sizes: number[]): void;
  /** Double-click-a-divider: give every child of one split the same share again. No-op (nothing set,
   *  nothing persisted) when the split was never dragged off its equal shares. */
  equalizeSplit(splitId: string): void;

  // ——— Pane groups (several named split arrangements per space, one on screen) ———
  /** The group currently on screen, or null before a space is selected. */
  activePaneGroup(): PaneGroup | null;
  /** The active group's zoomed leaf, or null when the group is showing its full split. */
  zoomedLeafId(): string | null;
  /** Add an empty group and switch to it. */
  newPaneGroup(name?: string): Promise<void>;
  /** Rename a group; a blank name is ignored. */
  renamePaneGroup(groupId: string, name: string): Promise<void>;
  /** Remove a group. Its panes are NOT deleted — they return to the SPACE list, exactly as closing
   *  each one would have done. Refused for the last remaining group. */
  removePaneGroup(groupId: string): Promise<void>;
  /** Put a group on screen. Pane focus moves to a leaf of that group's layout. */
  activatePaneGroup(groupId: string): Promise<void>;
  /** The group `delta` steps along, clamped at the ends — ⌘⇧] / ⌘⇧[ and the group bar's arrows. */
  stepPaneGroup(delta: number): Promise<void>;
  /** Move an item into `groupId` (opening it there), out of whatever group held it before. */
  moveItemToPaneGroup(itemId: string, groupId: string): Promise<void>;
  /** Focus a pane: `leafId` fills the whole pane host while the rest of the group stays exactly as it
   *  is — nothing is closed, moved, or removed from the group, and `unfocusPane` puts it all back. */
  focusPaneFull(leafId: string): Promise<void>;
  /** Clear the active group's focus, restoring the split. No-op when nothing is focused. */
  unfocusPane(): Promise<void>;
  /** Focus `leafId` (default: the focused leaf) unless it already is, in which case unfocus. */
  toggleFocusPane(leafId?: string | null): Promise<void>;
  /** Flush a pending debounced layout persist immediately — wired to `pagehide` (A-M4): a resize inside
   *  the debounce window of quitting would otherwise never reach the server. No-op when nothing is pending. */
  flushPersist(): Promise<void>;
  /** On the reconnecting→connected edge, runs a boot-lite refresh (spaces/items/sessions) and catches
   *  every open transcript up from its lastSeq — the events missed while the socket was down. */
  applyConnectionState(state: "connected" | "reconnecting"): void;
  setPaletteOpen(open: boolean): void;
  setSpacesOpen(open: boolean): void;
  openSheet(sheet: Sheet): void;
  closeSheet(): void;
  /** Each browser pane reports the rect its native view paints; null when it stops (unmount, no
   *  page). The registration point for W2's no-overlay invariant. */
  setBrowserRect(itemId: string, rect: { x: number; y: number; width: number; height: number } | null): void;
  /** W4 broadcasts: one settled action for the ticker's ring buffer / the driving flag flip. */
  applyBrowserAction(p: { browserId: string; text: string; ok: boolean; ts: number }): void;
  applyBrowserDriving(p: { browserId: string; driving: boolean }): void;
  refreshSessions(): Promise<void>;
  /** Seed sessionSpace + statuses for every space (boot, reconnect, unknown-session broadcasts). */
  refreshAllSessions(): Promise<void>;
  /** Put a waiting_permission session's pane in front of the user — switching space if needed — which
   *  is what surfaces its card, since Transcript autofocuses the first pending permission of a focused
   *  pane. With no argument it chooses one (the active space first); a permission notification passes
   *  the session its own row names. False when there was nothing to land on. */
  jumpToPermission(sessionId?: string | null): Promise<boolean>;
  /** Load (or catch up) a session's transcript: fetch events after the last known seq and reduce them. */
  /** Bring a session's pane to the front, switching space first when it lives in another one.
   *  Shared by the notifications feed and the Usage tab's leaderboard so "go to session" means the
   *  same thing from both — including the space switch, which is the half that is easy to forget.
   *  False when the space holds no item for that session, so a caller with a fallback can take it. */
  revealSession(sessionId: string, spaceId: string | null): Promise<boolean>;
  openSession(id: string): Promise<void>;
  /** Persisted events apply at once; ephemeral `assistant_delta`s are buffered and land on the next
   *  painted frame — see `pendingDeltas` for why that is where the app's power goes. */
  applySessionEvent(ev: LiveSessionEvent): void;
  /** Write every buffered delta into its transcript now. Scheduled per frame by `applySessionEvent`;
   *  called directly only where a caller must see the stream's current text without waiting. */
  flushSessionDeltas(): void;
  applySessionStatus(sessionId: string, status: SessionStatus): void;
  /** Create a session in the active space, open its item, and open its transcript. When `edge` is
   *  supplied with a target leaf, use the same split placement as an existing-item drag. */
  newSession(input: Omit<CreateSessionInput, "spaceId">, targetLeafId?: string | null, edge?: DropEdge): Promise<void>;
  /** The one instant-create path behind "+", ⌘N and the palette's plain "New session" (W3): no
   *  questions — last-used agent (else FALLBACK_AGENT), the space's own folder, adapter-default model
   *  and permission mode. Everything else is changed on the prompter's chips afterwards. */
  newSessionInstant(targetLeafId?: string | null, edge?: DropEdge): Promise<void>;
  /** Make a fresh `git worktree` and open a session in it (W2), rather than in the space folder.
   *  Fails loudly when the space is not a git repository — there is no worktree to fall back to,
   *  and silently landing in the space folder would be the collision the user asked to avoid. */
  newSessionInWorktree(targetLeafId?: string | null): Promise<void>;
  /** Arm (or with null, disarm) inline rename for the pane holding this item. */
  requestRename(itemId: string | null): void;
  /** Arm (or clear, with null) the inline rename of a pane group. */
  requestGroupRename(groupId: string | null): void;
  sendMessage(id: string, text: string): Promise<void>;
  /** ⌘⇧↩ "dispatch" (Plan 13 W2): ONE gesture = create a session that inherits the composer's whole
   *  setup (agent, model, effort, permission mode, and the environment the under-strip currently
   *  names — a worktree if that is what the selector shows), send the draft + attachments + mentions
   *  to it, record the `user-dispatch` origin, and bring its pane in BESIDE without focusing it.
   *  The draft clears exactly as a normal send; an empty draft is a no-op. */
  dispatchDraft(sessionId: string): Promise<void>;
  interruptSession(id: string): Promise<void>;
  respondPermission(id: string, requestId: string, decision: PermissionDecision, answers?: Record<string, string>): Promise<void>;
  setSessionOptions(id: string, o: SessionOptions): Promise<void>;
  /** Move a session between Build and Plan (the prompter's mode chip), parking and restoring the
   *  permission mode around the trip. See the implementation for why the parking is necessary. */
  setSessionMode(id: string, mode: SessionMode): Promise<void>;
  /** Switch an unstarted session's agent (prompter model picker). The server refuses once events exist —
   *  cross-agent rows go unavailable there, so this is only ever called while it is legal. */
  setSessionAgent(id: string, agentKind: AgentKind): Promise<void>;
  /** Move an unstarted session to another of its space's environments (the under-strip's workspace
   *  selector, Plan 12 W1). Same server guard as the agent switch — after the first event the chip is a
   *  label, so this is only ever called while it is legal. */
  setSessionEnvironment(id: string, environmentId: string): Promise<void>;
  /** The selector's "New worktree…": make the worktree (titled from the draft's first words, or the
   *  server's "session" default) AND move the session into it — one action, so creating without
   *  selecting cannot happen. */
  moveSessionToNewWorktree(sessionId: string): Promise<void>;
  /** Sidebar's "Move to space…" (item context menu). Same server guard as the agent/environment
   *  switches — closes the item out of the current space's layout first, then re-homes it; any open
   *  terminal panel for the session is torn down client-side to match the server's teardown. */
  moveSessionToSpace(sessionId: string, spaceId: string): Promise<void>;
  /** Fetch a space's servers into `connectors` (plus-menu open, `mcp.changed`). */
  refreshConnectors(spaceId: string): Promise<void>;
  /** Fetch a space's browser origin allowlist into `browserAllowlists` (Connections tab mount). */
  refreshBrowserAllowlist(spaceId: string): Promise<void>;
  /** Persist a space's browser origin allowlist AND push it into every live browser view of that
   *  space, so the fence moves without a pane reopen (Plan 14 W4). null = back to allow-all. */
  setBrowserAllowlist(spaceId: string, allowlist: string[] | null): Promise<void>;
  /** Refresh `agentProbe`. Unforced calls (prompter mount, onboarding) ride the server's TTL cache and
   *  are deduped here too; `force` is the install card's "Check again" and its window-focus refresh. */
  probeAgents(force?: boolean): Promise<void>;
  /** The Usage tab's read. Returns rather than stores, for the same reason `importScan` does: it is
   *  a range's worth of rows that only one panel ever looks at, and parking it globally would keep
   *  it alive for every pane that never opens Settings. */
  usageSummary(p: { from: number; to: number; bucket: UsageBucketKind; spaceId: string | null; profileId: string | null }): Promise<UsageSummary>;
  setUsageBudget(budget: UsageBudget): Promise<UsageBudget>;
  /** Scan the agent CLIs' stores. Returns the answer rather than storing it: a scan is hundreds of
   *  candidates the Import panel holds while the user edits targets, and parking that in the global
   *  store would keep it alive for every pane that never opens the panel. */
  importScan(): Promise<ImportScan>;
  /** Apply a selection, then refresh the surfaces it may have changed (spaces, items and the skills
   *  library all move under an import) so the sidebar reflects it without a reconnect. */
  importApply(selection: ImportApplyParams): Promise<ImportResult>;
  /** Remember the agent a fresh session should use (onboarding's default-agent pick). Same setting the
   *  prompter's agent chip writes, so the two never disagree. */
  setDefaultAgent(kind: AgentKind): Promise<void>;
  /** Show the session's terminal panel and TYPE `command` into it, without a trailing newline: Realm
   *  offers the command, the user presses Return. Nothing here ever runs an installer. */
  prefillTerminal(sessionId: string, command: string): Promise<void>;
  setDraft(sessionId: string, text: string): void;
  /** Fetch a space's skills library into `spaceSkills` (session open, `skills.changed`). */
  refreshSkills(spaceId: string): Promise<void>;
  /** Fetch the scan sources into `spaceSkillSources`. Separate from `refreshSkills` because the panel
   *  wants it and the composer never does — a session open should not pay for it. */
  refreshSkillSources(spaceId: string): Promise<void>;
  /** Add/remove a user scan directory, then re-read this space's list and sources. */
  addSkillScanRoot(spaceId: string, path: string): Promise<void>;
  removeSkillScanRoot(spaceId: string, path: string): Promise<void>;
  /** The native folder picker, then `addSkillScanRoot` — the same two-step `pickAndLinkProject` uses,
   *  so the panel never has to reach past the store for a dialog. */
  pickAndAddSkillScanRoot(spaceId: string): Promise<void>;
  /** Toggle one skill for ONE space (the settings panel), then re-read that space's library. */
  setSkillEnabled(spaceId: string, id: string, enabled: boolean): Promise<void>;
  /** Move a skill's defining scope into `spaceId`'s profile (W4's "Move to profile"), then re-read. */
  promoteSkill(spaceId: string, id: string): Promise<void>;
  /** Pin a profile-scoped skill to `spaceId` alone (W4's "Move to this space"), then re-read. */
  demoteSkill(spaceId: string, id: string): Promise<void>;
  /** `mcp.test`, resolved to the caller: the result is per-click UI state, not store state. The rest of
   *  the MCP actions live with the gateway slice below (`refreshMcpServers` and friends). */
  testMcpServer(id: string): Promise<McpTestResult>;
  /** Fetch a space's memory document + AGENTS.md state into `spaceMemory`. */
  refreshMemory(spaceId: string): Promise<void>;
  /** Replace the memory document. The caller must already be under MEMORY_DOC_MAX — the panel refuses
   *  to send an over-cap doc rather than let the server truncate or reject it invisibly. */
  saveMemoryDoc(spaceId: string, doc: string): Promise<void>;
  /** Turn the managed AGENTS.md on/off. The server refuses outside Realm-created folders; the panel
   *  never offers the toggle there, so a refusal here is a real race, surfaced via `run`. */
  setAgentsFile(spaceId: string, enabled: boolean): Promise<void>;
  /** Fetch what one session's agent actually loads into `sessionMemorySources`. */
  refreshMemorySources(sessionId: string): Promise<void>;
  /** Fetch a profile's icon asset library into `iconAssets`. */
  refreshIconAssets(profileId: string): Promise<void>;
  /** Ask Claude for an SVG icon from a description, save it, and prepend it into `iconAssets`. Can
   *  take a few seconds (a real model call) — callers show a spinner, not an optimistic result. */
  generateIcon(profileId: string, prompt: string): Promise<IconAsset>;
  /** The icon picker's "Uploaded" tab: native single-image picker, then upload; null if cancelled. */
  uploadIconImage(profileId: string): Promise<IconAsset | null>;
  /** Remove a generated/uploaded icon from the library. Any space still pointing at it degrades to
   *  the folder glyph (`SpaceIcon`'s missing-asset fallback) — the caller is responsible for warning
   *  if a space in view uses it. */
  deleteIconAsset(profileId: string, id: string): Promise<void>;
  /** Attach dropped or pasted Files. A dropped file already has a path; a pasted one does not, and is
   *  written under Realm's home first (see main/attachments.ts). */
  attachFiles(sessionId: string, files: readonly File[]): Promise<void>;
  /** The prompter's attach button — the native multi-select picker. */
  attachFromPicker(sessionId: string): Promise<void>;
  /** Drop one pending attachment (its chip's ×). Keyed by path, which is unique within the row. */
  removeAttachment(sessionId: string, path: string): void;
  /** Show/hide the session's terminal panel (pane-header toggle, ⌘J). Opening it is the one and only
   *  thing that creates the terminal — and only the first time. */
  toggleTerminalPanel(sessionId: string): Promise<void>;
  /** Get-or-create the terminal behind an already-open panel (restore path after a reload). No-op once
   *  known, so a session whose panel stays shut never reaches the server. */
  ensureSessionTerminal(sessionId: string): Promise<void>;
  /** Panel width (% of the session pane) from a resize drag; persisted with a trailing debounce. */
  setTerminalPanelWidth(sessionId: string, width: number): void;
  refreshGitInfo(cwd: string): Promise<void>;
  /** Re-read one checkout's changed-file list. Also refreshes `gitInfo` for it, so the prompter's
   *  chips and the diff pane can never disagree about the same tree. */
  refreshDiff(cwd: string): Promise<void>;
  /** Re-read every checkout the client currently holds a diff for. What a `workspace.changed`
   *  broadcast triggers: two panes may be looking at one repository through two different cwds, and
   *  only the server knows they are the same tree. */
  refreshAllDiffs(): Promise<void>;
  /** Fetch one file's patch, if it is not already held. */
  loadPatch(cwd: string, path: string, staged: boolean): Promise<void>;
  stagePaths(cwd: string, paths: string[]): Promise<void>;
  unstagePaths(cwd: string, paths: string[]): Promise<void>;
  setCommitMessage(cwd: string, text: string): void;
  /** Commit, push and open a PR as one action; stores the outcome for the pane to explain. */
  ship(input: ShipInput): Promise<void>;
  /** Open (or focus) the diff pane for an environment. The pane's item has the ENVIRONMENT's id as
   *  its refId, so it survives the session that opened it and cannot show another checkout's tree. */
  openDiff(environmentId: string, targetLeafId?: string | null): Promise<void>;
  /** Open (or focus) the document workspace for an environment — the `openDiff` gesture, for files.
   *  `environmentId` omitted uses the space's primary checkout, which is the sidebar's "Documents". */
  openDocuments(environmentId?: string | null, targetLeafId?: string | null): Promise<void>;
  /**
   * Plan 22. Put one file on screen: the server adds it to the workspace's tab strip (creating the
   * workspace when needed) and the item comes into the layout. `documents.openRequested` — which
   * the server broadcasts for this AND for an agent's `docs_open` — is what a mounted pane opens
   * the tab on; `applyDocumentOpenRequested` is the store's half, and it leaves an item that is
   * already on screen alone.
   */
  openDocumentPath(path: string, environmentId?: string | null): Promise<void>;
  applyDocumentOpenRequested(p: { spaceId: string; environmentId: string; documentsId: string; itemId: string; path: string }): Promise<void>;
  /** Start a lecture: a fresh pane group named for today, the dated notes file open in the documents
   *  pane, and a session beside it to ask things during class. Nothing is sent to the session. */
  startLecture(title: string): Promise<void>;
  /** Wrap a lecture up: a new session beside the focused pane, sent the wrap-up prompt. */
  wrapUpLecture(lecture: Lecture): Promise<void>;
  listLectures(): Promise<Lecture[]>;
  /** The preview frame's ingredients and the guide progress bridge (PreviewFrame). Passthroughs. */
  previewInfo(): Promise<{ port: number; token: string }>;
  readGuideProgress(documentsId: string, path: string): Promise<GuideProgress>;
  recordGuideAttempt(documentsId: string, path: string, topic: string, correct: number, total: number): Promise<GuideProgress>;
  plynnList(): Promise<{ available: boolean; folder: string; meetings: PlynnMeeting[] }>;
  /** Import into the ACTIVE space; the server opens the first imported file, so the pane follows. */
  plynnImport(files: string[]): Promise<PlynnImportResult>;
  /** Thin pass-throughs to the document RPCs. Panes never hold `api` themselves (it is the store's
   *  test seam), so every server call a document pane makes arrives here. */
  getDocuments(documentsId: string): Promise<DocumentWorkspace>;
  setDocumentTabs(documentsId: string, openPaths: string[], activePath: string | null): Promise<DocumentWorkspace>;
  detachDocuments(documentsId: string): Promise<void>;
  listDocumentEntries(documentsId: string, dir: string): Promise<DocumentEntry[]>;
  readDocument(documentsId: string, path: string): Promise<{ text: string; hash: string }>;
  writeDocument(documentsId: string, path: string, text: string, baseHash: string | null):
    Promise<{ ok: true; hash: string } | { ok: false; currentText: string; currentHash: string }>;
  createDocumentFile(documentsId: string, path: string, kind: DocumentKind, title: string): Promise<{ path: string; hash: string }>;
  renameDocumentFile(documentsId: string, from: string, to: string): Promise<{ path: string }>;
  /** "Request review" (Plan 13 W3): spawn the read-only reviewer over this environment. Marks it
   *  `reviewing` until the verdict's `review.changed` lands; the reviewer's pane arrives via the
   *  server's `session.agentOpened`. */
  requestReview(environmentId: string): Promise<void>;
  /** Fetch the environment's persisted verdict into `reviews` (diff pane mount/env change). */
  refreshReview(environmentId: string): Promise<void>;
  /** The review section's ✕ — server-side clear, then the local slice. */
  dismissReview(environmentId: string): Promise<void>;
  /** The `review.changed` handler: apply the payload directly (no refetch race) and clear the
   *  in-flight flag. */
  applyReviewChanged(payload: { environmentId: string; review: ReviewResult | null }): void;
  /** Open the space's PAGE (Plan 12 W3) — a `space-page` item whose refId is the space id, one per
   *  space (the diff pane's dedup precedent). `tab` lands the page on a section — the plus-menu's
   *  "Manage connections…" passes "connections"; omitted keeps whatever tab the page last showed. */
  openSpacePage(spaceId: string, tab?: SpacePageTab): Promise<void>;
  /** The page's tab, per space — see `spacePageTab`. */
  setSpacePageTab(spaceId: string, tab: SpacePageTab): void;
  /** Open (or focus) the ACTIVE space's profile page (Plan 14 W2) — a `profile-page` destination item
   *  (sentinel refId; the page derives its profile live from the item's space). `tab` lands the page
   *  on a section — the retargeted "Edit in profile" affordances pass one. */
  openProfilePage(tab?: ProfilePageTab): Promise<void>;
  /** The profile page's tab, per profile — see `profilePageTab`. */
  setProfilePageTab(profileId: string, tab: ProfilePageTab): void;
  /** Open (or focus) a sidebar destination page (Plan 12 W4: Library, Connections) in the ACTIVE
   *  space's layout. One page item per space, deduped by KIND — the refId is the kind's well-known
   *  sentinel (`PAGE_REF_IDS`), and the item's `spaceId` is the vantage its scope groups read from.
   *  Returns the page item's id — null only when there is no active space to put it in — which is what
   *  a caller needs to then address something INSIDE the page it just opened. */
  openDestinationPage(kind: DestinationPageKind, placement?: DestinationPlacement): Promise<string | null>;
  /** True when `kind`'s page is open in a pane that is not the focused one: the only case in which a
   *  `here` placement does something the plain click does not. */
  destinationPageElsewhere(kind: DestinationPageKind): boolean;
  /** Read both Settings-page preference keys into `settingsPrefs` (Plan 12 W6). Junk in a row —
   *  an unknown category, a mode PERMISSION_MODES doesn't name — is dropped/defaulted here, once,
   *  so the page never renders a state the server would not honor. */
  refreshSettingsPrefs(): Promise<void>;
  /** Read `MODEL_FAVORITES_KEY` into `modelFavorites`. Junk in the row — a non-array, a non-string
   *  element — is dropped here rather than surviving into the picker's ordering. */
  refreshModelFavorites(): Promise<void>;
  /** Read the model catalog into `modelInfo`. Cheap and idempotent: the server holds a day-long
   *  cache, so every session pane calling this on mount costs one round trip. */
  refreshModelCatalog(): Promise<void>;
  /** Star or un-star ONE model by canonical key, persisting the whole list. Recomputed from the held
   *  list so a double-click can't write a duplicate, and so only THIS key ever moves. */
  toggleModelFavorite(key: string): Promise<void>;
  /** Flip ONE category's off switch and persist the whole disabled set under
   *  `NOTIFICATIONS_DISABLED_KEY`. Disabling stops NEW rows only — the service's contract. */
  setNotificationCategoryEnabled(category: NotificationCategory, enabled: boolean): Promise<void>;
  /** Persist the default permission mode for new sessions (`DEFAULT_PERMISSION_MODE_KEY`) —
   *  consumed server-side at `sessions.create`. The bypass confirm lives in the page, not here:
   *  by the time this runs the user has already said it twice. */
  setDefaultPermissionMode(mode: string): Promise<void>;
  /** Re-run the main-process TCC probe (prompt-free by construction) into `tccRows`. */
  refreshTcc(): Promise<void>;
  /** Load the enrolled sign-ins and the store's own state (encryption available, Touch ID usable). */
  refreshCredentials(): Promise<void>;
  addCredential(input: BrowserCredentialInput): Promise<void>;
  removeCredential(id: string): Promise<void>;
  setCredentialPresenceTtl(ms: number): Promise<void>;
  /** Deep-link a permission row's System Settings pane (by row id; main owns the URLs). */
  openTccPane(pane: string): Promise<void>;
  /** Re-run `mac doctor` into `macAccess`. Prompt-free, so the tab may call it freely. */
  refreshMacAccess(): Promise<void>;
  /** Raise ONE capability's prompt. A no-op while another prompt is up (macOS shows one dialog at
   *  a time) and on any row that cannot be prompted — the page never asks for what cannot be asked. */
  grantMacAccess(id: string): Promise<void>;
  /** Walk every promptable row in order, one dialog at a time. Granted, denied and prompt-less rows
   *  are skipped — asking there is impossible or guaranteed to fail — and the page names what was
   *  left for System Settings rather than letting a short run read as full coverage. */
  grantAllMacAccess(): Promise<void>;
  openMacAccessPane(id: string): Promise<void>;
  revealRealmApp(): Promise<void>;
  /** Fetch the Updates row's current state from main's gated updater into `updateStatus`. */
  refreshUpdateStatus(): Promise<void>;
  /** Run a real update check (or receive the disabled state unchanged — main's gate decides).
   *  The interim `checking` shown is main's genuine in-flight state, not renderer theatre. */
  checkForUpdates(): Promise<void>;
  /** Restart into a downloaded update; a no-op in main unless one is actually downloaded. */
  installUpdate(): Promise<void>;
  /** Fetch the feed's first page (replacing what is held — sized to cover at least what was showing,
   *  so a refetch triggered by `notifications.changed` never shrinks the visible list). */
  refreshNotifications(): Promise<void>;
  /** Page further on the held cursor; no-op at the end of the feed. */
  loadMoreNotifications(): Promise<void>;
  /** Mark rows read — named ids, or the whole global feed ("all"). Applies the server's returned
   *  unread count; the broadcast that follows carries the same number. */
  markNotificationsRead(ids: string[] | "all"): Promise<void>;
  /** The `notifications.changed` handler: applies the server's unread count, folds a surfaced row into
   *  the held feed, and auto-reads a `session_done` for the session pane the user is looking at (the
   *  renderer is the one honest holder of focus — see the server service's doc comment). */
  applyNotificationsChanged(payload: { notification: Notification | null; unread: number }): void;
  /** Land on the thing the notification is ABOUT, and mark the row read — it has, by definition, been
   *  seen. A row naming a session lands on that session's pane (a `permission` through
   *  jumpToPermission, whose focus move is what pops the card); every other row — an MCP server, a
   *  probe, a budget ceiling — has no pane of its own, so it lands on the feed page with the row
   *  selected, which is also where a session whose item is gone ends up. Either way the landing is a
   *  stop on the pane's trail, exactly as clicking the row inside the page would leave it. */
  openNotificationTarget(n: Notification): Promise<void>;
  /** A clicked OS toast, by row id (main knows nothing but the id). Resolves the row from the held
   *  feed — refetching once if the page was never opened — and lands on it like any other jump. */
  activateDesktopNotification(id: string): Promise<void>;
  /** The Settings→App desktop switch. Writes `NOTIFICATIONS_DESKTOP_KEY` and immediately pushes the
   *  badge the new answer implies, so switching off clears the dock rather than freezing a number. */
  setDesktopNotifications(enabled: boolean): Promise<void>;
  /** Select a feed row into the page's detail column (null = back to the bare list). Records the move
   *  on the trail of the pane showing `pageItemId`, so the arrows retrace it, and marks the row read —
   *  opening a notification is the definition of having seen it. */
  selectNotification(pageItemId: string, id: string | null): Promise<void>;
  /** Open the removal confirmation for a worktree, reading its cost first. */
  askRemoveWorktree(environmentId: string): Promise<void>;
  /** Confirm it: re-read the cost, and remove ONLY if it still matches what the user was shown. */
  confirmRemoveWorktree(environmentId: string): Promise<void>;
  /** Open the checkpoint sheet for a checkout, listing that session's turns (or all of them). */
  openCheckpoints(environmentId: string, sessionId?: string | null): Promise<void>;
  /** Re-list without opening anything — what the `checkpoints.changed` broadcast triggers. */
  refreshCheckpoints(environmentId: string, sessionId: string | null): Promise<void>;
  /** Re-fetch one space's ship log (first page — the History tab's glance, not an archive browser);
   *  what the History tab mounts and the `ships.changed` broadcast triggers for held spaces. */
  refreshShips(spaceId: string): Promise<void>;
  /** Re-fetch one space's runs (first page). What the Tasks tab mounts and what `runs.changed`
   *  triggers for spaces already held. */
  refreshRuns(spaceId: string): Promise<void>;
  /** Queue a durable run in this space and select it, so the lens lands on the thing just made. */
  createRun(spaceId: string, goal: string, title?: string): Promise<void>;
  /** Select a run in the Tasks lens and load its attempt log. `null` clears the selection. */
  selectRun(spaceId: string, runId: string | null): Promise<void>;
  /** The three run writes. Each applies the returned row AND re-reads the attempt log, because every
   *  one of them opens or closes an attempt. */
  cancelRun(id: string): Promise<void>;
  retryRun(id: string): Promise<void>;
  approveRun(id: string, approved: boolean, note: string | null): Promise<void>;
  /** The `runs.changed` handler: folds the fresh row into a held space's list in place (no refetch
   *  race), and re-reads the attempt log when the changed run is the selected one. */
  applyRunsChanged(payload: { spaceId: string; run: Run | null }): void;
  /** Move the sheet from its list state into its confirm state, with a freshly read preview. */
  askRestoreCheckpoint(id: string): Promise<void>;
  /** Back to the list, forgetting the preview. */
  cancelRestoreCheckpoint(): void;
  confirmRestoreCheckpoint(id: string): Promise<void>;
  /** `checkpoints.capture` — a point the user asked for, next to the ones every turn takes. */
  captureCheckpoint(environmentId: string, sessionId: string | null): Promise<void>;
  /** "Fork from here" (Plan 16 W3): server makes worktree + session; this adopts the new pane and
   *  closes the sheet. The ancestor session and its checkout are untouched — workspace fork only. */
  forkFromCheckpoint(checkpointId: string): Promise<void>;
  /** Re-fetch this space's MCP servers. Called on `McpSection` mount (sheet open) and on `mcp.changed`
   *  while that space's settings sheet is the one showing. Applies the result only if the sheet is
   *  still open for this exact space — a slow response after the user closed or switched must not
   *  clobber whatever the sheet is showing now. */
  refreshMcpServers(spaceId: string): Promise<void>;
  /** Drop whatever `mcpServers`/`mcpToolsError` currently hold and record which space's panel is
   *  mounted (`mcpPanelSpaceId` — null on unmount). Called synchronously when `McpSection` mounts
   *  (or re-mounts for a different space) — BEFORE `refreshMcpServers` kicks off its fetch — so
   *  opening the Connections tab for a different space never flashes the previous space's rows (or a
   *  tools error belonging to a server not even shown here) while the new list is in flight. */
  clearMcpServers(spaceId: string | null): void;
  addMcpServer(input: AddMcpServerInput): Promise<McpServer>;
  updateMcpServer(input: UpdateMcpServerInput): Promise<McpServer>;
  removeMcpServer(id: string): Promise<void>;
  setMcpEnabled(spaceId: string, id: string, enabled: boolean): Promise<void>;
  /** Move a server's defining scope into `spaceId`'s profile, then re-read (guarded like any refresh). */
  promoteMcpServer(spaceId: string, id: string): Promise<void>;
  /** Pin a profile-scoped server to `spaceId` alone, then re-read. */
  demoteMcpServer(spaceId: string, id: string): Promise<void>;
  /** Flip one Realm-native provider for ONE space (providers default ON — this is the off switch). */
  setMcpProviderEnabled(spaceId: string, name: string, enabled: boolean): Promise<void>;
  /** Fetch one profile's memory doc at its defining scope into `profileMemory` (the Library page's
   *  "Edit in profile" editor). */
  refreshProfileMemory(profileId: string): Promise<void>;
  /** Replace the PROFILE doc — every space of the profile sees the change; callers must have said so.
   *  Patches every `spaceMemory` snapshot that inherits this doc, so no open panel goes stale. */
  saveProfileMemoryDoc(profileId: string, doc: string): Promise<void>;
  /** THIS space's inheritance override for the profile doc — never a write to the doc itself. */
  setProfileDocEnabled(spaceId: string, enabled: boolean): Promise<void>;
  /** Narrow (or, with `null`, reset) this space's allowlist for one server. */
  setMcpAllowedTools(spaceId: string, id: string, tools: string[] | null): Promise<void>;
  /** Refresh one server's cached tools. Never throws for a connect failure — that lands in
   *  `mcpToolsError`, a result the row renders inline, per `mcp.tools.list`'s contract. */
  refreshMcpTools(id: string): Promise<void>;
  /** Close a tripped circuit breaker; the next call (including the next tools refresh) tries again. */
  retryMcpServer(id: string): Promise<void>;
  /** Begin the OAuth dance; the caller (the row/form) opens the returned URL itself. */
  startMcpOauth(id: string): Promise<{ authUrl: string }>;
  disconnectMcpOauth(id: string): Promise<void>;
  /** Patch one server's live status from an `mcp.serverStatus` broadcast. Idempotent: applying the same
   *  payload twice (the event can repeat, and can arrive without a matching `mcp.changed`) leaves the
   *  same state, and a server not currently in `mcpServers` is a no-op rather than an error. */
  applyMcpServerStatus(payload: { id: string; status: McpServerStatus; oauthStatus: McpOauthStatus }): void;
  /** Open the Activity sheet (McpSection's "Activity" button, the palette's "MCP Activity"): resets any
   *  filter left over from a previous visit — Activity always opens showing everything, per binding
   *  rule 5 — and loads the first page. Replaces whatever sheet was open (ruling 4: one sheet slot). */
  openActivity(): Promise<void>;
  /** Re-fetch Activity's first page with the current filter, replacing `mcpCalls` outright (never a
   *  merge — a filter change can drop rows the old page had and add ones it didn't). */
  refreshMcpCalls(): Promise<void>;
  /** Fetch the next page after the last loaded row's `{ ts, id }` (W1's composite cursor) and append. */
  loadMoreMcpCalls(): Promise<void>;
  /** Narrow (or, with `null`, clear) Activity's session or server filter and re-fetch. Only the given
   *  key changes — passing `{ sessionId: null }` leaves any active server filter exactly as it was. */
  setMcpCallsFilter(patch: { sessionId?: string | null; serverId?: string | null }): Promise<void>;
  /** Apply one `mcp.call` broadcast (App.tsx's live wiring, W7): prepended only while the sheet is open
   *  AND the row matches the active filter, and only once per id — the event can repeat (binding rule
   *  6), and a resend must not duplicate the row. */
  applyMcpCall(call: McpCall): void;
  /** Run an action, surfacing any rejection in `error` (and console.error). Use at UI call sites. */
  run(action: () => Promise<unknown>): void;
  clearError(): void;
};

/** The title "New worktree…" sends (Plan 12 W1): the draft's first few words — enough to recognise the
 *  branch by — or null, which the server names "session". Slugging is the server's job (slugifyBranch);
 *  this only decides what the worktree is ABOUT. */
export function worktreeTitleFrom(draft: string): string | null {
  const words = draft.trim().split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
  return words ? words.slice(0, 40) : null;
}

/** Prune-only: drop ids that no longer exist. Never adds — unopened items live in the SPACE group. */
export function reconcileLayout(layout: Layout | null, items: Item[]): Layout {
  let l: Layout = layout ?? emptyLayout();
  const ids = new Set(items.map((i) => i.id));
  for (const t of allItems(l)) if (!ids.has(t)) l = layoutClose(l, t);
  return l;
}

/** True when a leaf with this id exists anywhere in the layout (splits don't count). */
export function hasLeafIn(l: Layout, leafId: string): boolean {
  return l.type === "leaf" ? l.id === leafId : l.children.some((c) => hasLeafIn(c, leafId));
}

/** The one status a space's strip button wears, from all its sessions. Priority: a permission is a
 *  question for the user (most urgent), an error needs eyes, running is just progress (U-H3). */
export function spaceBadge(
  sessionStatus: Record<string, SessionStatus>, sessionSpace: Record<string, string>, spaceId: string,
): "waiting_permission" | "error" | "running" | null {
  let error = false, running = false;
  for (const [id, st] of Object.entries(sessionStatus)) {
    if (sessionSpace[id] !== spaceId) continue;
    if (st === "waiting_permission") return "waiting_permission";
    if (st === "error") error = true;
    else if (st === "running") running = true;
  }
  return error ? "error" : running ? "running" : null;
}

export type FocusDir = "left" | "right" | "up" | "down";

/**
 * The leaf you land on moving `dir` from `leafId` — structurally, not geometrically: leaf rects are
 * not in the store, so this walks the tree instead. From the leaf, climb toward the root; the first
 * ancestor split whose axis matches the direction (row for left/right, col for up/down) and that has
 * a sibling on that side wins. Descend into that sibling to the "nearest" leaf: at splits along the
 * movement axis take the near edge (moving right → leftmost child, moving up → bottom child); at
 * cross-axis splits take the first child — an approximation, since the true nearest child would
 * depend on the origin leaf's cross-axis position, which the tree does not encode. Null = no
 * neighbor that way (callers no-op).
 */
export function neighborLeafId(l: Layout, leafId: string, dir: FocusDir): string | null {
  const axis = dir === "left" || dir === "right" ? "row" : "col";
  const forward = dir === "right" || dir === "down";
  // Path from the leaf up to the root (pushed post-recursion, so index 0 is the innermost split).
  const path: { split: Extract<Layout, { type: "split" }>; index: number }[] = [];
  const find = (n: Layout): boolean => {
    if (n.type === "leaf") return n.id === leafId;
    for (let i = 0; i < n.children.length; i++) {
      if (find(n.children[i]!)) { path.push({ split: n, index: i }); return true; }
    }
    return false;
  };
  if (!find(l)) return null;
  const descend = (n: Layout): string => {
    if (n.type === "leaf") return n.id;
    const pick = n.dir === axis ? (forward ? n.children[0]! : n.children.at(-1)!) : n.children[0]!;
    return descend(pick);
  };
  for (const { split, index } of path) {
    if (split.dir !== axis) continue;
    const sibling = split.children[index + (forward ? 1 : -1)];
    if (sibling) return descend(sibling);
  }
  return null;
}

/** The id of the empty leaf sitting IMMEDIATELY next to `leafId` in its own split — i.e. the leaf a
 *  fresh `splitLeaf(..., null)` just created. Adjacency, not "any empty leaf in the split", matters
 *  since splitLeaf grows an existing same-direction split instead of nesting: a row can hold several
 *  empty leaves, and only the one the split just put beside `leafId` is the new one. splitLeaf appends
 *  after the target (`before` is a drop-edge concern, never splitFocused's), so the following slot wins
 *  a tie. */
export function findEmptySiblingOf(l: Layout, leafId: string): string | null {
  if (l.type === "leaf") return null;
  const at = l.children.findIndex((c) => c.type === "leaf" && c.id === leafId);
  if (at >= 0) {
    for (const c of [l.children[at + 1], l.children[at - 1]]) {
      if (c && c.type === "leaf" && c.itemId === null) return c.id;
    }
    return null;
  }
  for (const c of l.children) { const f = findEmptySiblingOf(c, leafId); if (f) return f; }
  return null;
}

/** Space RPC results are not zod-parsed on the client (the rpc envelope leaves `result` untouched), so a
 *  legacy-shaped layout from an older server would arrive unmigrated. Today's server migrates on read
 *  (LayoutSchema in apps/server store/spaces.ts); parsing again here is version-skew defense. Corrupt
 *  input degrades to null rather than breaking the space, mirroring the server. */
function seedLayout(layout: Layout | null): Layout | null {
  if (!layout) return null;
  const p = LayoutSchema.safeParse(layout);
  return p.success ? p.data : null;
}

/**
 * The group set to activate a space with. Same version-skew posture as `seedLayout`: a server that
 * predates groups sends `groups: undefined` and only a `layout`, which becomes the single "Main" group
 * — the identical arrangement the user last saw, just addressed as a group. Corrupt group JSON falls
 * back the same way rather than blanking the space.
 */
export function seedGroups(space: { id?: string; groups?: SpaceGroups | null; layout?: Layout | null } | undefined): SpaceGroups {
  if (space?.groups) {
    const p = SpaceGroupsSchema.safeParse(space.groups);
    if (p.success) return p.data;
  }
  // Same deterministic default id the server derives (spaces.ts): re-selecting a space that has never
  // persisted groups must land on the same group id, not mint a new one each visit.
  return groupsFromLayout(seedLayout(space?.layout ?? null), space?.id);
}

function findSplitSizes(l: Layout, splitId: string): number[] | null {
  if (l.type === "leaf") return null;
  if (l.id === splitId) return l.sizes;
  for (const c of l.children) { const s = findSplitSizes(c, splitId); if (s) return s; }
  return null;
}
const sameSizes = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) < 0.01);
const isThemePref = (x: unknown): x is ThemePref => x === "system" || x === "light" || x === "dark";
const isSubmitKey = (x: unknown): x is SubmitKey => x === "enter" || x === "cmdEnter";

/** Forget both sides of every named path in one checkout — what staging or unstaging invalidates. */
function dropPatches(patches: Record<string, FileDiff>, cwd: string, paths: string[]): Record<string, FileDiff> {
  const doomed = new Set(paths.flatMap((p) => [patchKey(cwd, p, true), patchKey(cwd, p, false)]));
  return Object.fromEntries(Object.entries(patches).filter(([k]) => !doomed.has(k)));
}

/** Run `fn` on the next frame the window actually paints. rAF and not a timer, and the distinction is
 *  the whole point: a timer keeps firing into a window nobody can see, while Chromium simply stops
 *  servicing frame callbacks for one that is minimised, on another Space or fully covered. Falls back
 *  to a timer only where there is no frame clock at all (tests under jsdom). */
const scheduleFrame = (fn: () => void): number =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : (setTimeout(fn, 16) as unknown as number);

export function createAppStore(api: Api): StoreApi<AppState> {
  return createStore<AppState>((set, get) => {
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    /** Monotonic id for fetches of the active space's items. Reconcile is destructive (it prunes open
     *  items missing from the list), so only the newest-started fetch may apply: the Api makes no
     *  ordering promise, and a response snapshotted before a concurrent item creation would otherwise
     *  prune the just-opened item and collapse its splits. Bumped by selectSpace so responses from a
     *  previous activation die even when the same space is re-selected. */
    let itemsFetchSeq = 0;
    /** The ONE place the unread count is written — and therefore the one place the dock badge is
     *  pushed. Five paths change the count (boot, refresh, page, markRead, broadcast); a badge each
     *  of them had to remember separately is a badge that drifts from the pill beside it. Switched
     *  off means ZERO, not "stop pushing": a frozen badge is a number the dock keeps asserting after
     *  the user turned the surface off. */
    const applyUnread = (unread: number) => {
      set({ notificationsUnread: unread });
      void api.setBadgeCount(get().desktopNotifications ? unread : 0).catch(() => {});
    };
    /** Per-profile ordering for icon-library reads and writes. A picker refresh can be in flight when
     *  generation/upload finishes; without these guards its older snapshot can land last and make an
     *  `asset:` space icon fall back to a folder until the next refresh. */
    const iconAssetFetchSeq = new Map<string, number>();
    const iconAssetMutationSeq = new Map<string, number>();
    const fetchIconAssets = async (profileId: string) => {
      const fetchSeq = (iconAssetFetchSeq.get(profileId) ?? 0) + 1;
      const mutationSeq = iconAssetMutationSeq.get(profileId) ?? 0;
      iconAssetFetchSeq.set(profileId, fetchSeq);
      const list = await api.listIconAssets(profileId);
      if (iconAssetFetchSeq.get(profileId) !== fetchSeq || (iconAssetMutationSeq.get(profileId) ?? 0) !== mutationSeq) return;
      set({ iconAssets: { ...get().iconAssets, [profileId]: list } });
    };
    /** Load only libraries needed by unresolved space icons. Awaiting this before publishing a new
     *  spaces snapshot prevents a saved custom icon from flashing—or remaining—as the folder fallback. */
    const hydrateSpaceIcons = async (spaces: Space[]) => {
      const loadedIds = new Set(Object.values(get().iconAssets).flat().map((asset) => asset.id));
      const profileIds = new Set(spaces.flatMap((space) => {
        const ref = parseSpaceIcon(space.icon);
        return ref.kind === "asset" && !loadedIds.has(ref.id) ? [space.profileId] : [];
      }));
      await Promise.allSettled([...profileIds].map(fetchIconAssets));
    };
    const markIconAssetMutation = (profileId: string) => {
      iconAssetMutationSeq.set(profileId, (iconAssetMutationSeq.get(profileId) ?? 0) + 1);
    };
    /** False from selectSpace until the space's items have loaded and reconciled once. While false,
     *  resizeSplit applies sizes locally but must not persist: react-resizable-panels fires onLayout at
     *  mount with normalized sizes, and that echo is not a user action — persisting it would write the
     *  layout mid-boot (and cement whatever transient state the layout is in). */
    let layoutHydrated = false;
    const persist = async () => {
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
      const { activeSpaceId, groups, sheetSnap } = get();
      if (!activeSpaceId || !groups) return;
      // While W2.4's sheet-snap is active the on-screen layout is temporary by definition; what
      // persists is the layout the user actually built (restored on close anyway — a crash or
      // space switch mid-sheet must not cement the snap). Only the ACTIVE group is ever snapped, so
      // substituting the saved tree back into it leaves every other group's arrangement alone.
      const persistable = sheetSnap && sheetSnap.spaceId === activeSpaceId ? setActiveLayout(groups, sheetSnap.saved) : groups;
      const saved = await api.setGroups(activeSpaceId, persistable);
      // Keep the cached Space current so a later selectSpace seeds from the newest groups.
      set({ spaces: get().spaces.map((x) => (x.id === saved.id ? saved : x)) });
    };
    const schedulePersist = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => { persistTimer = null; get().run(persist); }, PERSIST_DEBOUNCE_MS);
    };
    /** Terminal-panel state persists as one settings blob, on its own debounce: a resize drag writes
     *  every frame, but a toggle is a single deliberate act and writes straight through. */
    let panelTimer: ReturnType<typeof setTimeout> | null = null;
    const persistPanels = async () => {
      if (panelTimer) { clearTimeout(panelTimer); panelTimer = null; }
      await api.setSetting(SETTING_TERMINAL_PANEL, get().terminalPanel);
    };
    const schedulePanelPersist = () => {
      if (panelTimer) clearTimeout(panelTimer);
      panelTimer = setTimeout(() => { panelTimer = null; get().run(persistPanels); }, PERSIST_DEBOUNCE_MS);
    };
    const panelOf = (id: string): TerminalPanel => get().terminalPanel[id] ?? { open: false, width: TERMINAL_PANEL_WIDTH };
    const setPanel = (id: string, p: TerminalPanel) => set({ terminalPanel: { ...get().terminalPanel, [id]: p } });
    /** Sessions with an openSessionTerminal call in flight — StrictMode double-mounts and a toggle
     *  racing the restore effect must not spawn two ptys for one session. A Map, not a Set: later
     *  callers JOIN the in-flight call instead of returning early, so `prefillTerminal` (which races the
     *  drawer's own restore effect) still has a terminal id to write into when it resumes. */
    const ensuringTerminal = new Map<string, Promise<void>>();
    /** In-flight `agents.probe` calls, kept apart by force: a forced probe must never be satisfied by a
     *  cheap one already in flight (that one may predate the install the user just ran). */
    const probing: { plain: Promise<void> | null; forced: Promise<void> | null } = { plain: null, forced: null };
    // The catalog's in-flight read, collapsed the same way the probe's is — one round trip per tick
    // however many panes mounted at once.
    let catalogPending: Promise<void> | null = null;
    /** Flush a pending debounced persist before the active space changes (persist reads the current space). */
    const flushPersist = async () => {
      if (panelTimer) await persistPanels();
      if (persistTimer) await persist();
    };
    const isSpace = (sid: string) => get().activeSpaceId === sid;
    const mergeSpace = (s: Space) => set({ spaces: get().spaces.map((x) => (x.id === s.id ? s : x)) });
    const mergeSession = (s: Session) => set({ sessions: { ...get().sessions, [s.id]: s }, sessionStatus: { ...get().sessionStatus, [s.id]: s.status } });
    /** Re-read one run's attempt log. Every run write opens or closes an attempt, so a panel left
     *  holding the old log would misreport the history it exists to show. */
    const loadRunAttempts = async (runId: string) => {
      const detail = await api.getRun(runId);
      if (detail) set({ runAttempts: { ...get().runAttempts, [runId]: detail.attempts } });
    };
    /** Shared tail of cancel/retry/approve: apply the row the call returned, then refresh the log. */
    const afterRunWrite = async (r: Run) => { get().applyRunsChanged({ spaceId: r.spaceId, run: r }); await loadRunAttempts(r.id); };
    /** Last-used agent: applied to state now, persisted best-effort (a failed write only costs the
     *  memory on the next launch, so it must never fail the creation the user just asked for). */
    const rememberAgent = (agentKind: AgentKind) => {
      if (get().lastAgentKind === agentKind) return;
      set({ lastAgentKind: agentKind });
      get().run(() => api.setSetting(SETTING_LAST_AGENT, agentKind));
    };
    /** Persisted events that arrive while openSession is fetching; replayed after the fetch so order is kept. */
    const loading = new Map<string, StoredSessionEvent[]>();
    const setTranscript = (id: string, entry: TranscriptEntry) => set({ transcripts: { ...get().transcripts, [id]: entry } });
    const dropTranscript = (id: string) => { pendingDeltas.delete(id); const { [id]: _gone, ...rest } = get().transcripts; set({ transcripts: rest }); };

    /**
     * Ephemeral `assistant_delta` text that has arrived but not yet been written to the store, per
     * session. Deltas are the only ephemeral event type, so this holds strings rather than events.
     *
     * Applying a delta the moment it lands is what a naive stream does, and it is the app's single
     * largest power cost: each one re-runs the transcript reducer, re-renders the pane, re-parses
     * the whole accumulated message through marked + highlight.js + DOMPurify, rebuilds that
     * message's DOM, and makes the transcript's follow-the-bottom effect read `scrollHeight` — a
     * forced synchronous reflow — before the next delta arrives a few milliseconds later. Streaming
     * one 2.5KB answer that way costs ~36x what rendering the finished answer once costs, per
     * session, and three agents streaming at once is most of a core.
     *
     * So deltas accumulate here and land in ONE store write per animation frame. The frame is the
     * honest cadence: it is the fastest rate the reader can be shown anything, and no faster.
     *
     * The bigger win is what a frame callback does NOT do. Chromium stops servicing rAF for a window
     * that is minimised, on another Space, or fully covered, so an agent streaming while the user is
     * in another app costs nothing here at all — the text piles up as a string and is reduced in a
     * single pass when the window comes back. Dropping the work is safe because deltas are cosmetic:
     * `assistant_delta` is not persisted, and the `assistant_text` that follows carries the whole
     * message and replaces the streaming block outright.
     *
     * Held as the runs the reducer would have built anyway — consecutive deltas for one message
     * concatenated, a new message starting a new run — so a flush replays exactly the block sequence
     * an unbuffered stream produced, and the buffer costs the message's own text rather than one
     * object per token.
     */
    const pendingDeltas = new Map<string, { messageId: string; delta: string; ts: number }[]>();
    let deltaFrame = 0;
    const queueDelta = (sessionId: string, messageId: string, delta: string, ts: number) => {
      let runs = pendingDeltas.get(sessionId);
      if (!runs) pendingDeltas.set(sessionId, (runs = []));
      const open = runs.at(-1);
      if (open && open.messageId === messageId) open.delta += delta;
      else runs.push({ messageId, delta, ts });
      if (!deltaFrame) deltaFrame = scheduleFrame(() => { deltaFrame = 0; get().flushSessionDeltas(); });
    };
    /** Drain one session's pending deltas into a transcript, without touching the store. The caller
     *  owns the write, so a persisted event can fold its own deltas into the same `set`. */
    const drainInto = (sessionId: string, t: Transcript): Transcript => {
      const runs = pendingDeltas.get(sessionId);
      if (!runs) return t;
      pendingDeltas.delete(sessionId);
      for (const r of runs) t = reduceTranscript(t, sessionEvent("assistant_delta", { messageId: r.messageId, delta: r.delta }, r.ts));
      return t;
    };
    /**
     * Append to a session's chip row, refusing anything over the cap and skipping anything already there.
     *
     * The cap is enforced HERE rather than left to the Claude adapter's throw, and it is enforced for
     * every agent kind — see MAX_ATTACHMENT_BYTES. The refusal rides the app's one error channel so it
     * says which file and which ceiling, instead of the file simply not appearing.
     */
    const addAttachments = (sessionId: string, picked: readonly PickedAttachment[]) => {
      const current = get().pendingAttachments[sessionId] ?? [];
      const seen = new Set(current.map((a) => a.path));
      const next = [...current];
      const refused: string[] = [];
      for (const a of picked) {
        if (seen.has(a.path)) continue; // the same file dropped twice is one attachment
        if (a.size > MAX_ATTACHMENT_BYTES) { refused.push(`${a.name} (${formatAttachmentSize(a.size)})`); continue; }
        seen.add(a.path);
        next.push(a);
      }
      set({ pendingAttachments: { ...get().pendingAttachments, [sessionId]: next } });
      if (refused.length > 0) set({ error: `Too large to attach — the limit is ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)}: ${refused.join(", ")}` });
    };
    /**
     * Put a history entry's IN-PANE view back — the half of a stop that no layout write can restore.
     *
     * Each kind owns the meaning of its own `view` string, and each one is written back to the very
     * state the pane already reads, so a step Back is indistinguishable from having clicked there:
     * the notifications page's selected row, the space/profile pages' tab. A kind with no in-pane
     * view (a session, a terminal) has nothing to restore and falls through — its `view` is always
     * null. Junk can't reach here: every view string is one this app minted via `navigateInPane`.
     */
    const applyNavView = (entry: NavEntry) => {
      const item = get().items.find((i) => i.id === entry.itemId);
      if (!item) return;
      if (item.kind === "notifications-page") { set({ notificationsSelectedId: entry.view }); return; }
      if (item.kind === "space-page") {
        // The space page's refId IS its space id — the key `spacePageTab` is already stored under.
        get().setSpacePageTab(item.refId, (entry.view ?? "general") as SpacePageTab);
        return;
      }
      if (item.kind === "profile-page") {
        // The profile is derived live from the vantage space, exactly as the page itself derives it.
        const profileId = get().spaces.find((sp) => sp.id === item.spaceId)?.profileId;
        if (profileId) get().setProfilePageTab(profileId, (entry.view ?? "skills") as ProfilePageTab);
      }
    };
    /** Focus keeps its leaf while the layout still has it; otherwise it resets to the first leaf. */
    const focusIn = (layout: Layout) => {
      const f = get().focusedLeafId;
      return f && hasLeafIn(layout, f) ? f : firstLeaf(layout).id;
    };
    /** The ONE way `groups` is written: `layout` is re-mirrored off the active group in the same set,
     *  so the two fields can never be observed disagreeing — not even for one render. */
    /** Also THE recording site for per-pane history: every structural change — open, split, drop,
     *  preset, group switch — ends here, so reconciling once covers all of them (see reconcileNav).
     *  `extra` still wins, which is what lets `stepPaneNav` seat its own cursor: the reconcile that
     *  runs first then sees the stepped entry already current and records nothing. */
    const writeGroups = (groups: SpaceGroups, extra: Partial<AppState> = {}): Partial<AppState> =>
      ({ groups, layout: activeLayout(groups), paneHistory: reconcileNav(get().paneHistory, groups), ...extra });
    /** The ONE way the active group's layout is written — every split/open/close/resize goes through
     *  here rather than `set({ layout })`, which would leave `groups` holding the pre-edit tree. */
    const writeLayout = (layout: Layout, extra: Partial<AppState> = {}): Partial<AppState> => {
      const gs = get().groups ?? groupsFromLayout(null);
      return writeGroups(setActiveLayout(gs, layout), extra);
    };
    /** Cross-group uniqueness, applied BEFORE any active-group op that opens `itemId`: the layout ops
     *  only ever see one tree, so without this an item open in another group would end up claimed by
     *  two arrangements at once. Returns the group set to build the op on top of. */
    const detached = (itemId: string): SpaceGroups => {
      const gs = get().groups ?? groupsFromLayout(null);
      const next = detachItemFrom(gs, itemId, gs.activeGroupId);
      if (next !== gs) set(writeGroups(next));
      return next;
    };
    /** Apply a group-set edit and persist it, unless nothing actually changed. */
    const commitGroups = async (next: SpaceGroups) => {
      if (next === get().groups) return;
      set(writeGroups(next, { focusedLeafId: focusIn(activeLayout(next)) }));
      await persist();
    };
    /** Adopt a freshly created item: refresh items, then open it into targetLeafId ?? the focused leaf.
     *  (A concurrent items.changed refresh can't have opened it — reconcile is prune-only.) Takes an
     *  itemsFetchSeq slot so any older in-flight refreshItems response is dropped instead of pruning
     *  the item this fetch is about to open. */
    /** Kick an event-driven git refresh for one session's cwd (no-op while the session is unknown). */
    const refreshGitFor = (sessionId: string) => {
      const cwd = get().sessions[sessionId]?.cwd;
      if (cwd) get().run(() => get().refreshGitInfo(cwd));
    };
    /** The skill ids a session's draft may mention RIGHT NOW: enabled + valid in its space, and only
     *  for an agent Realm can inject skills into. Empty for a Cursor (or fake) session — which is what
     *  keeps mentions from ever being offered, or recognised, there (W4). */
    const mentionableIds = (sessionId: string): string[] => {
      const s = get().sessions[sessionId];
      if (!s || AGENT_SKILL_SUPPORT[s.agentKind] !== "injected") return [];
      return (get().spaceSkills[s.spaceId] ?? []).filter((k) => k.enabled && k.valid).map((k) => k.id);
    };
    /**
     * W2.4 — the degenerate case, entry side. Every sheet-opening path calls this: when browser
     * views leave the widest non-browser column too narrow for a sheet (SHEET_MIN_WIDTH), the
     * LAYOUT moves instead of the sheet overlaying — every browser leaf snaps to a ≤50% split for
     * the sheet's lifetime. Lives in the store, not any Sheet component, so it survives re-renders
     * and cannot double-apply: while a snap is active a second openSheet keeps the ORIGINAL saved
     * layout. The snapped layout never persists (see persist()).
     */
    const maybeSnapForSheet = (): Partial<AppState> => {
      if (get().sheetSnap) return {};
      const { browserRects, layout } = get();
      if (browserRects.length === 0 || !layout) return {};
      const win = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
      if (complementOf(win, browserRects).width >= SHEET_MIN_WIDTH) return {};
      const browserIds = new Set(get().items.filter((i) => i.kind === "browser").map((i) => i.id));
      const snapped = snapBrowserLeaves(layout, browserIds);
      if (snapped === layout) return {};
      return writeLayout(snapped, { sheetSnap: { saved: layout, spaceId: get().activeSpaceId } });
    };
    /** W2.4, exit side: restore EXACTLY the pre-snap layout — keyed to the sheet actually closing
     *  in the STORE (closeSheet / palette takeover / confirm flows), never to a Sheet component
     *  unmounting (remounts race). Items deleted while the sheet was open are re-pruned; a snap
     *  from a space that is no longer active is simply dropped (its true layout was what persisted). */
    const restoreSnap = (): Partial<AppState> => {
      const snap = get().sheetSnap;
      if (!snap) return {};
      if (snap.spaceId !== get().activeSpaceId) return { sheetSnap: null };
      return writeLayout(reconcileLayout(snap.saved, get().items), { sheetSnap: null });
    };
    const adoptItem = async (sid: string, itemId: string, targetLeafId: string | null, beside = false, edge?: DropEdge) => {
      const seq = ++itemsFetchSeq;
      const items = await api.listItems(sid);
      if (!isSpace(sid)) return;
      if (seq === itemsFetchSeq) set({ items }); // superseded by a newer fetch? its list is newer — keep it
      if (edge && targetLeafId) { await get().openItemAt(itemId, targetLeafId, edge); return; }
      if (beside && targetLeafId === null) { await get().openItemBeside(itemId); return; }
      await get().openItem(itemId, targetLeafId);
    };

    return {
      booted: false,
      profiles: [], spaces: [], activeSpaceId: null, themePref: "system", swipeInvert: false, submitKey: "enter", sidebarCollapsed: false, items: [], groups: null, layout: null, focusedLeafId: null, projects: [], environments: {}, error: null,
      allItems: [], lastAgentKind: null, renamingItemId: null, renamingGroupId: null,
      connectionState: "connected",
      paletteOpen: false, spacesOpen: false, lastSpaceByProfile: {}, sheet: null, browserRects: [], sheetSnap: null, browserActions: {}, browserDriving: {},
      spacePageTab: {}, profilePageTab: {}, mcpPanelSpaceId: null,
      sessions: {}, sessionStatus: {}, sessionSpace: {}, transcripts: {}, agentProbe: [], settingsPrefs: null, tccRows: null, credentials: null, credentialStatus: null, macAccess: null, macGranting: null, macGrantQueue: [], updateStatus: null, drafts: {}, pendingAttachments: {}, draftMentions: {}, spaceSkills: {}, skillsRoot: "", spaceMemory: {}, sessionMemorySources: {}, planReturn: {}, gitInfo: {}, iconAssets: {}, modelFavorites: [], modelInfo: {}, spaceSkillSources: {},
      diffs: {}, diffLoading: {}, patches: {}, commitMessages: {}, shipResults: {}, shipping: {}, reviews: {}, reviewing: {},
      worktreeStatuses: {}, worktreeAckStale: null,
      checkpoints: {}, ships: {}, runs: {}, selectedRunId: {}, runAttempts: {}, checkpointPreview: null, checkpointAckStale: false, restoreResult: null,
      terminalPanel: {}, sessionTerminals: {},
      machineName: "", userName: "", connectors: {}, browserAllowlists: {},
      mcpServers: [], mcpProviders: [], mcpToolsError: {},
      profileMemory: {},
      mcpCalls: [], mcpCallsFilter: {}, mcpCallsHasMore: false,
      notifications: [], notificationsUnread: 0, notificationsCursor: null, desktopNotifications: true, notificationsSelectedId: null, paneHistory: {},

      activeSpace() { const id = get().activeSpaceId; return id ? get().spaces.find((s) => s.id === id) : undefined; },
      activeProfileId() { return get().activeSpace()?.profileId ?? null; },
      profileSpaces() { const pid = get().activeProfileId(); return pid === null ? [] : get().spaces.filter((s) => s.profileId === pid); },
      activeIndex() { const id = get().activeSpaceId; return id ? get().spaces.findIndex((s) => s.id === id) : -1; },

      async boot() {
        const [profiles, spaces, saved, theme, swipeInvert, submitKey, sidebarCollapsed, lastAgent, panels, system] = await Promise.all([
          api.listProfiles(), api.listSpaces(), api.getSetting(SETTING_ACTIVE_SPACE), api.getSetting(SETTING_THEME), api.getSetting(SETTING_SWIPE_INVERT), api.getSetting(SETTING_SUBMIT_KEY), api.getSetting(SETTING_SIDEBAR_COLLAPSED), api.getSetting(SETTING_LAST_AGENT),
          api.getSetting(SETTING_TERMINAL_PANEL),
          // Labels, not dependencies: a failure here must not take boot down with it — the strip
          // simply shows no machine name, and the greeting no name.
          api.systemInfo().catch(() => ({ machineName: "", userName: "" })),
        ]);
        const agent = AgentKindSchema.safeParse(lastAgent);
        set({ profiles, themePref: isThemePref(theme) ? theme : "system", swipeInvert: swipeInvert === true,
          submitKey: isSubmitKey(submitKey) ? submitKey : "enter", sidebarCollapsed: sidebarCollapsed === true, lastAgentKind: agent.success ? agent.data : null,
          terminalPanel: parseTerminalPanels(panels), machineName: system.machineName, userName: system.userName });
        // AppShell is already mounted during boot: keep spaces unpublished until each saved custom
        // icon can resolve, rather than visibly rendering its folder fallback first.
        await hydrateSpaceIcons(spaces);
        set({ spaces });
        const target = spaces.find((s) => s.id === saved) ?? spaces[0];
        if (target) await get().selectSpace(target.id);
        // Cross-space badges need every session's space + status, not just the active space's.
        await get().refreshAllSessions();
        // The desktop switch, read BEFORE the count lands because the badge push honors it — and read
        // at boot at all because the first broadcast can arrive long before anyone opens Settings.
        // A failed read keeps the default-on answer: a preference nobody could read is not a
        // preference to switch the feature off.
        const desktop = await api.getSetting(NOTIFICATIONS_DESKTOP_KEY).catch(() => null);
        set({ desktopNotifications: desktop !== false });
        // The sidebar's unread pill needs the count before the page is ever opened. One row, not a
        // page — the count rides every list result. A badge, not a dependency: a failure here must
        // not take boot down with it.
        const feed = await api.listNotifications(null, 1).catch(() => null);
        if (feed) applyUnread(feed.unread);
        // Last, so `booted && spaces.length === 0` is only ever true for a genuinely empty home.
        set({ booted: true });
      },
      async selectSpace(id) {
        await flushPersist();
        itemsFetchSeq++; // in-flight item fetches from the previous activation are now stale
        layoutHydrated = false;
        const space = get().spaces.find((s) => s.id === id);
        // Diffs and patches go with the space: they are keyed by checkout path, and every pane that
        // could show one belongs to the space being left. Keeping them would mean a diff pane opening
        // on stale hunks from before the switch.
        set(writeGroups(seedGroups(space), { activeSpaceId: id, focusedLeafId: null, items: [], projects: [], environments: {}, sessions: {}, error: null,
          sheetSnap: null, // a snap belongs to the layout being left; that layout persisted UNsnapped
          diffs: {}, diffLoading: {}, patches: {} }));
        get().run(() => api.setSetting(SETTING_ACTIVE_SPACE, id));
        // Remembered BEFORE the awaits below: the profile chip's "go back to where I was" must be
        // true the moment the switch is committed, not a round trip later.
        if (space) set({ lastSpaceByProfile: { ...get().lastSpaceByProfile, [space.profileId]: id } });
        await Promise.all([get().refreshProjects(), get().refreshEnvironments(), get().refreshItems(), get().refreshSessions()]);
        // Space activation refreshes git context for the focused pane's session, if any.
        const focusedItem = get().items.find((i) => i.id === itemIdOfLeaf(get().layout, get().focusedLeafId));
        if (focusedItem?.kind === "session") refreshGitFor(focusedItem.refId);
      },
      async nextSpace() {
        const list = get().profileSpaces(); const i = list.findIndex((s) => s.id === get().activeSpaceId);
        const n = list[i + 1]; if (i >= 0 && n) await get().selectSpace(n.id);
      },
      async prevSpace() {
        const list = get().profileSpaces(); const i = list.findIndex((s) => s.id === get().activeSpaceId);
        const p = list[i - 1]; if (i > 0 && p) await get().selectSpace(p.id);
      },
      async selectProfile(profileId) {
        if (get().activeProfileId() === profileId) return;
        const remembered = get().lastSpaceByProfile[profileId];
        const target = get().spaces.find((s) => s.id === remembered && s.profileId === profileId)
          ?? get().spaces.find((s) => s.profileId === profileId);
        // A profile with no spaces at all is not switchable-to: there would be nothing to land on,
        // and an activeSpaceId of null is the no-space posture, not a profile.
        if (target) await get().selectSpace(target.id);
      },
      async refreshSpaces() {
        const spaces = await api.listSpaces();
        await hydrateSpaceIcons(spaces);
        set({ spaces });
        const active = get().activeSpaceId;
        // The active space vanished (deleted elsewhere): fall back to the first one, if any.
        if (active && !spaces.some((s) => s.id === active)) {
          const first = spaces[0];
          if (first) await get().selectSpace(first.id);
          else set({ activeSpaceId: null, items: [], groups: null, layout: null, focusedLeafId: null, projects: [] });
        }
      },
      async refreshItems() {
        const sid = get().activeSpaceId; if (!sid) return;
        const seq = ++itemsFetchSeq;
        const items = await api.listItems(sid);
        if (!isSpace(sid) || seq !== itemsFetchSeq) return; // space changed, or a newer fetch owns the truth
        // Prune across every group, not just the one on screen: a deleted item must stop being open
        // in the arrangements the user is not currently looking at too, or switching to one would
        // render a pane for something that no longer exists.
        //
        // Archived items are pruned by the same set even though they still exist. `archiveItem` already
        // closes the pane it can see; this is what carries the close to the groups it cannot — another
        // window's archive, or one taken while a different group was on screen. `items` itself keeps
        // them: the sidebar's Archived section is drawn from the full list.
        const live = new Set(items.filter((i) => !i.archived).map((i) => i.id));
        const groups = reconcileGroups(get().groups ?? groupsFromLayout(get().layout), live);
        const layout = activeLayout(groups);
        layoutHydrated = true;
        // The same prune has to reach the back/forward trails, or Back would offer to return a pane to
        // an item deleted here or in another window. Applied BEFORE writeGroups' reconcile so the
        // layout's own occupants are re-seeded on top of the pruned trails, never the other way round.
        set({ paneHistory: forgetNavItems(get().paneHistory, live) });
        set(writeGroups(groups, { items, focusedLeafId: focusIn(layout) }));
      },
      async refreshAllItems() {
        set({ allItems: await api.listAllItems() });
      },
      async searchDeep(query) {
        const sid = get().activeSpaceId; if (!sid) return null;
        const profileId = get().spaces.find((sp) => sp.id === sid)?.profileId;
        if (!profileId) return null;
        return api.search(profileId, query);
      },
      async refreshProjects() {
        const sid = get().activeSpaceId; if (!sid) return;
        const projects = await api.listProjects(sid);
        if (isSpace(sid)) set({ projects });
      },
      async refreshEnvironments() {
        const sid = get().activeSpaceId; if (!sid) return;
        const list = await api.listEnvironments(sid);
        if (isSpace(sid)) set({ environments: Object.fromEntries(list.map((e) => [e.id, e])) });
      },
      async createProfile(name) {
        const p = await api.createProfile(name);
        set({ profiles: [...get().profiles.filter((x) => x.id !== p.id), p] });
        return p;
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
        else set({ activeSpaceId: null, items: [], groups: null, layout: null, focusedLeafId: null, projects: [] });
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
      async setSwipeInvert(v) {
        set({ swipeInvert: v });
        await api.setSetting(SETTING_SWIPE_INVERT, v);
      },
      async toggleSidebar() {
        const next = !get().sidebarCollapsed;
        set({ sidebarCollapsed: next });
        await api.setSetting(SETTING_SIDEBAR_COLLAPSED, next);
      },
      async setSubmitKey(v) {
        set({ submitKey: v });
        await api.setSetting(SETTING_SUBMIT_KEY, v);
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
      async newBrowser(targetLeafId = null) {
        const sid = get().activeSpaceId; if (!sid) return;
        const { itemId } = await api.createBrowser(sid);
        await adoptItem(sid, itemId, targetLeafId);
      },
      async updateItem(input) {
        const sid = get().activeSpaceId;
        const it = await api.updateItem(input);
        if (sid && isSpace(sid)) set({ items: get().items.map((x) => (x.id === it.id ? it : x)) });
      },
      async archiveItem(itemId, archived) {
        // Close FIRST, then flip the flag — deleteItem's ordering, for deleteItem's reason: a row the
        // sidebar has hidden whose pane is still on screen is the one state neither surface can
        // explain, and doing it in this order means a failure in between leaves the item visible
        // rather than invisible-but-open. Unarchiving touches no layout: the row comes back to the
        // SPACE group unopened, exactly where closing would have left it.
        if (archived) await get().closeFromLayout(itemId);
        await get().updateItem({ id: itemId, archived });
        // Back/forward must not walk into a shelved pane. Same prune deleteItem owes the trails, for
        // the same reason — the difference is only that the item still exists to come back to.
        if (archived) {
          const live = new Set(get().items.filter((i) => !i.archived).map((i) => i.id));
          set({ paneHistory: forgetNavItems(get().paneHistory, live) });
        }
      },
      /** Agent-opened panes arrive BESIDE the user's focused pane, never replacing it. Replacing was a
       *  live-found deadlock: the browser evicted the very session whose permission card the user had to
       *  answer — and eviction destroys an agent's browser view mid-task (close is final for browsers).
       *  If the focused leaf is empty, filling it is fine; otherwise split right and open there. */
      async openItemBeside(itemId) {
        detached(itemId); // the pane may be open in another group; it moves here rather than duplicating
        const current = get().layout ?? emptyLayout();
        const focused = get().focusedLeafId;
        const occupant = focused ? itemIdOfLeaf(current, focused) : null;
        if (focused && occupant !== null && occupant !== itemId && !findLeafOfItem(current, itemId)) {
          const layout = splitLeaf(current, focused, "row", itemId);
          const leaf = findLeafOfItem(layout, itemId);
          set(writeLayout(layout, { focusedLeafId: leaf?.id ?? get().focusedLeafId }));
          await persist();
          return;
        }
        await get().openItem(itemId);
      },
      async openItemBesideQuiet(itemId) {
        // Already open in ANOTHER group: leave it there. Yanking a pane out of an arrangement the user
        // is not looking at is a bigger surprise than the focus steal this variant exists to avoid.
        const gs = get().groups;
        if (gs && groupOfItem(gs, itemId) && groupOfItem(gs, itemId)!.id !== gs.activeGroupId) return;
        const current = get().layout ?? emptyLayout();
        // Already visible: leave it — and the focus — entirely alone. openItem's "go there" focus
        // move is exactly the steal this variant exists to not perform.
        if (findLeafOfItem(current, itemId)) return;
        const focused = get().focusedLeafId;
        const occupant = focused ? itemIdOfLeaf(current, focused) : null;
        if (focused && occupant !== null && occupant !== itemId) {
          // openItemBeside's split, minus its focus move: the pane appears at the side while
          // focusedLeafId — and with it the composer the user is typing in — stays put.
          const layout = splitLeaf(current, focused, "row", itemId);
          set(writeLayout(layout));
          await persist();
          return;
        }
        // The focused leaf is empty (or nothing is focused): fill in place, focus untouched.
        const layout = layoutOpen(current, focused, itemId);
        set(writeLayout(layout));
        await persist();
      },
      async openItem(itemId, leafId = null) {
        // Activation without an explicit target (sidebar row, palette, pinned grid) of an item that is
        // already open means "go there": focus its pane, touch nothing, persist nothing. When the pane
        // lives in ANOTHER group, "go there" means going to that group — switching the arrangement and
        // focusing the pane, still without moving anything. That is the cheap switch the whole feature
        // is for: a click on any row takes you to it, wherever it is.
        if (leafId === null) {
          const gs = get().groups;
          const holder = gs ? groupOfItem(gs, itemId) : null;
          if (holder) {
            const leaf = findLeafOfItem(holder.layout, itemId)!;
            if (holder.id !== gs!.activeGroupId) {
              set(writeGroups(groupsSetActive(gs!, holder.id), { focusedLeafId: leaf.id }));
              await persist();
            } else set({ focusedLeafId: leaf.id });
            return;
          }
        } else detached(itemId); // an explicit target moves the pane INTO the active group
        const current = get().layout ?? emptyLayout();
        const target = leafId ?? get().focusedLeafId;
        const layout = layoutOpen(current, target, itemId);
        const leaf = findLeafOfItem(layout, itemId);
        set(writeLayout(layout, { focusedLeafId: leaf?.id ?? null }));
        await persist();
      },
      async closeFromLayout(itemId) {
        // The pane may be open in a group other than the one on screen (the sidebar lists every
        // group's rows): close it where it actually is, and leave the active arrangement alone.
        const gs = get().groups;
        const holder = gs ? groupOfItem(gs, itemId) : null;
        if (gs && holder && holder.id !== gs.activeGroupId) {
          set(writeGroups(detachItemFrom(gs, itemId, gs.activeGroupId)));
          await persist();
          return;
        }
        const layout = layoutClose(get().layout ?? emptyLayout(), itemId);
        set(writeLayout(layout, { focusedLeafId: focusIn(layout) }));
        await persist();
        // Closing the last pane lands in a fresh prompter, never the empty-state placeholder.
        // Deliberately scoped to this path: reconcileLayout also empties the layout while pruning
        // stale items, and a server hiccup there must not manufacture sessions.
        if (allItems(layout).length === 0) await get().newSessionInstant();
      },
      async deleteItem(itemId) {
        await get().closeFromLayout(itemId);
        // The old destructive close, minus the layout removal handled above.
        const it = get().items.find((i) => i.id === itemId);
        await api.deleteItem(itemId); // server closes the pty for terminal items
        const items = get().items.filter((i) => i.id !== itemId);
        // This path prunes `items` itself rather than going through refreshItems, so it owes the
        // back/forward trails the same prune: an item deleted here must leave no way back to it.
        set({ items, paneHistory: forgetNavItems(get().paneHistory, new Set(items.map((i) => i.id))) });
        if (it?.kind === "terminal") api.disposeTerminal(it.refId);
        if (it?.kind === "browser") {
          // The ticker and driving dot die with the browser — a reused id must start blank.
          const { [it.refId]: _ba, ...browserActions } = get().browserActions;
          const { [it.refId]: _bd, ...browserDriving } = get().browserDriving;
          set({ browserActions, browserDriving });
        }
        if (it?.kind === "session") {
          dropTranscript(it.refId); loading.delete(it.refId);
          // The server killed the pty with the session; drop the renderer half (xterm + scrollback) too.
          const termId = get().sessionTerminals[it.refId];
          if (termId) api.disposeTerminal(termId);
          const { [it.refId]: _st, ...sessionStatus } = get().sessionStatus; const { [it.refId]: _se, ...sessions } = get().sessions;
          const { [it.refId]: _dr, ...drafts } = get().drafts; const { [it.refId]: _sp, ...sessionSpace } = get().sessionSpace;
          const { [it.refId]: _tp, ...terminalPanel } = get().terminalPanel; const { [it.refId]: _tid, ...sessionTerminals } = get().sessionTerminals;
          const { [it.refId]: _pr, ...planReturn } = get().planReturn;
          const { [it.refId]: _at, ...pendingAttachments } = get().pendingAttachments;
          const { [it.refId]: _dm, ...draftMentions } = get().draftMentions; // part of the draft, dropped with it
          set({ sessionStatus, sessions, drafts, pendingAttachments, draftMentions, planReturn, sessionSpace, terminalPanel, sessionTerminals });
          if (termId || _tp) get().run(persistPanels); // the panel map just lost an entry
        }
      },
      async splitFocused(dir) {
        const l = get().layout ?? emptyLayout();
        const target = focusIn(l);
        const layout = splitLeaf(l, target, dir, null);
        const fresh = findEmptySiblingOf(layout, target);
        set(writeLayout(layout, { focusedLeafId: fresh ?? target }));
        await persist();
      },
      async openItemAt(itemId, leafId, edge) {
        // Self-drop: the item already occupies the target leaf. Splitting would first close the item
        // (pruning that very leaf) and teleport it to the far side; replacing is a no-op anyway.
        if (findLeafOfItem(get().layout ?? emptyLayout(), itemId)?.id === leafId) return;
        if (edge === "center") return get().openItem(itemId, leafId);
        detached(itemId); // dropped from another group: it moves here rather than being open twice
        const dir = edge === "left" || edge === "right" ? "row" : "col";
        const layout = splitLeaf(get().layout ?? emptyLayout(), leafId, dir, itemId, edge === "left" || edge === "top");
        const leaf = findLeafOfItem(layout, itemId);
        set(writeLayout(layout, { focusedLeafId: leaf?.id ?? null }));
        await persist();
      },
      focusLeaf(leafId) { set({ focusedLeafId: leafId }); },
      navigateInPane(itemId, view) {
        const leaf = findLeafOfItem(get().layout ?? emptyLayout(), itemId);
        if (!leaf) return;
        set({ paneHistory: pushNav(get().paneHistory, leaf.id, { itemId, view }) });
      },
      canPaneNav(leafId, delta) { return canNav(get().paneHistory, leafId, delta); },
      async stepPaneNav(leafId, delta) {
        const stepped = stepNav(get().paneHistory, leafId, delta);
        if (stepped === get().paneHistory) return; // nowhere to go — no layout write, nothing persisted
        const entry = navEntry(stepped, leafId)!;
        // Seat the cursor FIRST: writeGroups reconciles against whatever `paneHistory` holds, and with
        // the cursor already on `entry` it sees the leaf's new occupant as the stop it is standing on
        // and records nothing. Without this the step would push a duplicate and Back would stall.
        set({ paneHistory: stepped });
        const layout = layoutOpen(get().layout ?? emptyLayout(), leafId, entry.itemId);
        set(writeLayout(layout, { focusedLeafId: leafId }));
        applyNavView(entry);
        await persist();
      },
      focusNeighbor(dir) {
        const { layout, focusedLeafId } = get();
        if (!layout || !focusedLeafId) return;
        const next = neighborLeafId(layout, focusedLeafId, dir);
        if (next) set({ focusedLeafId: next });
      },
      async applyPreset(name) {
        // A preset lays out the items of the ACTIVE group, not every item in the space: the other
        // groups' arrangements are not the user's business when they pick a grid for this one.
        const gs = get().groups;
        const mine = gs ? allItems(activeLayout(gs)) : allItems(get().layout ?? emptyLayout());
        const layout = gridPreset(name, mine);
        set(writeLayout(layout, { focusedLeafId: firstLeaf(layout).id }));
        await persist();
      },
      resizeSplit(splitId, sizes) {
        const l = get().layout; if (!l) return;
        const current = findSplitSizes(l, splitId);
        if (!current || sameSizes(current, sizes)) return;
        set(writeLayout(updateSizes(l, splitId, sizes)));
        if (layoutHydrated) schedulePersist(); // pre-hydration resizes are mount echoes, not user actions
      },
      equalizeSplit(splitId) {
        const l = get().layout; if (!l) return;
        const next = layoutEqualize(l, splitId);
        if (next === l) return; // already equal, or no such split — a double-click that changes nothing
        set(writeLayout(next));
        schedulePersist();
      },

      // ——— Pane groups ———
      activePaneGroup() { const gs = get().groups; return gs ? activeGroup(gs) : null; },
      zoomedLeafId() { const gs = get().groups; return gs ? activeGroup(gs).zoomedLeafId : null; },
      async newPaneGroup(name) {
        const gs = get().groups; if (!gs) return;
        // The new group is empty and active, so focus lands on its one empty leaf — the same state a
        // space with nothing open has, which is exactly what an empty arrangement should feel like.
        await commitGroups(groupsAdd(gs, name));
      },
      async renamePaneGroup(groupId, name) {
        const gs = get().groups; if (!gs) return;
        await commitGroups(groupsRename(gs, groupId, name));
      },
      async removePaneGroup(groupId) {
        const gs = get().groups; if (!gs) return;
        await commitGroups(groupsRemove(gs, groupId));
      },
      async activatePaneGroup(groupId) {
        const gs = get().groups; if (!gs) return;
        await commitGroups(groupsSetActive(gs, groupId));
      },
      async stepPaneGroup(delta) {
        const gs = get().groups; if (!gs) return;
        const next = groupAtOffset(gs, delta);
        if (next) await commitGroups(groupsSetActive(gs, next.id));
      },
      async moveItemToPaneGroup(itemId, groupId) {
        const gs = get().groups; if (!gs) return;
        await commitGroups(groupsMoveItem(gs, itemId, groupId));
      },
      /** Focus/unfocus never touch the layout — see groups.ts. They still persist: a focused pane that
       *  came back split after a restart would read as the app forgetting, not as a transient view. */
      async focusPaneFull(leafId) {
        const gs = get().groups; if (!gs) return;
        const next = groupsZoom(gs, leafId);
        if (next === gs) return;
        // Focus follows the zoom: the pane filling the screen is the one the keyboard should be in.
        set(writeGroups(next, { focusedLeafId: leafId }));
        await persist();
      },
      async unfocusPane() {
        const gs = get().groups; if (!gs) return;
        const next = groupsUnzoom(gs);
        if (next === gs) return;
        set(writeGroups(next));
        await persist();
      },
      async toggleFocusPane(leafId = null) {
        const gs = get().groups; if (!gs) return;
        const target = leafId ?? get().focusedLeafId;
        if (!target) return;
        const next = groupsToggleZoom(gs, target);
        if (next === gs) return;
        set(writeGroups(next, { focusedLeafId: activeGroup(next).zoomedLeafId ? target : get().focusedLeafId }));
        await persist();
      },

      flushPersist: () => flushPersist(),
      applyConnectionState(state) {
        const prev = get().connectionState;
        if (prev === state) return;
        set({ connectionState: state });
        if (state !== "connected") return;
        // The socket was down: change events were lost, so refetch what they would have delivered.
        get().run(() => Promise.all([get().refreshSpaces(), get().refreshItems(), get().refreshSessions(), get().refreshAllSessions()]));
        // openSession fetches events after each transcript's lastSeq — exactly the missed tail.
        for (const id of Object.keys(get().transcripts)) get().run(() => get().openSession(id));
      },
      // One overlay slot (U-M4/V-F5): sheets and the palette never stack — opening either closes the other.
      setPaletteOpen(open) { set(open ? { paletteOpen: true, spacesOpen: false, sheet: null, ...restoreSnap() } : { paletteOpen: false }); },
      // Same one-slot rule the palette and the sheets keep: two overlays are never on screen at once.
      setSpacesOpen(open) { set(open ? { spacesOpen: true, paletteOpen: false, sheet: null, ...restoreSnap() } : { spacesOpen: false }); },
      openSheet(sheet) { set({ sheet, paletteOpen: false, spacesOpen: false, ...maybeSnapForSheet() }); },
      closeSheet() { set({ sheet: null, ...restoreSnap() }); },
      // Reference-stable: an unchanged rect never produces a new array, so the popover/palette/
      // sheet subscribers only re-place on real movement, not on every rAF echo.
      setBrowserRect(itemId, rect) {
        const cur = get().browserRects;
        const idx = cur.findIndex((b) => b.itemId === itemId);
        if (!rect) {
          if (idx !== -1) set({ browserRects: cur.filter((b) => b.itemId !== itemId) });
          return;
        }
        const prev = cur[idx];
        if (prev && prev.x === rect.x && prev.y === rect.y && prev.width === rect.width && prev.height === rect.height) return;
        const next: BrowserRect = { itemId, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        set({ browserRects: idx === -1 ? [...cur, next] : cur.map((b, i) => (i === idx ? next : b)) });
      },
      applyBrowserAction({ browserId, text, ok, ts }) {
        const cur = get().browserActions[browserId] ?? [];
        const next = [...cur, { text, ok, ts }].slice(-BROWSER_ACTIONS_MAX);
        set({ browserActions: { ...get().browserActions, [browserId]: next } });
      },
      applyBrowserDriving({ browserId, driving }) {
        const cur = get().browserDriving;
        if (driving) { set({ browserDriving: { ...cur, [browserId]: true } }); return; }
        if (!(browserId in cur)) return; // clearing what was never set: no churn
        const { [browserId]: _gone, ...rest } = cur;
        set({ browserDriving: rest });
      },
      async refreshSessions() {
        const sid = get().activeSpaceId; if (!sid) return;
        const list = await api.listSessions(sid);
        if (!isSpace(sid)) return;
        // Statuses are rebuilt from the list: entries for other spaces are kept only if still known there.
        const sessions: Record<string, Session> = {}; const sessionStatus: Record<string, SessionStatus> = {};
        const sessionSpace = { ...get().sessionSpace };
        for (const [id, st] of Object.entries(get().sessionStatus)) if (!(id in get().sessions)) sessionStatus[id] = st;
        for (const s of list) { sessions[s.id] = s; sessionStatus[s.id] = s.status; sessionSpace[s.id] = s.spaceId; }
        set({ sessions, sessionStatus, sessionSpace });
      },
      async refreshAllSessions() {
        const all = await api.listAllSessions();
        // The list is the truth for existence and mapping; server-persisted statuses are fresh (they
        // are written before each session.status broadcast), so they simply overwrite.
        const sessionSpace: Record<string, string> = {}; const sessionStatus: Record<string, SessionStatus> = {};
        for (const s of all) { sessionSpace[s.id] = s.spaceId; sessionStatus[s.id] = s.status; }
        set({ sessionSpace, sessionStatus });
      },
      async jumpToPermission(sessionId = null) {
        const spaceOf = (id: string) => get().sessionSpace[id] ?? get().sessions[id]?.spaceId ?? null;
        // Two callers with two different amounts of knowledge. The palette's "Respond to pending
        // permission" names nothing and has to CHOOSE: one in the active space first, so answering a
        // question does not drag the user out of the space they are working in. A permission
        // notification names its own session and skips the choice entirely — including when that
        // session is no longer waiting, because a row whose question was answered in another window
        // still belongs on its own pane rather than on whichever session happens to be waiting now.
        const waiting = Object.entries(get().sessionStatus).filter(([, st]) => st === "waiting_permission").map(([id]) => id);
        const active = get().activeSpaceId;
        const sid = sessionId ?? waiting.find((id) => spaceOf(id) === active) ?? waiting[0] ?? null;
        if (!sid) return false;
        // Landing the pane in the FOCUSED leaf is what surfaces the card: Transcript autofocuses the
        // first pending permission of a focused pane (U-H4). There is nothing further to open.
        return get().revealSession(sid, spaceOf(sid));
      },
      async openSession(id) {
        if (loading.has(id)) return;
        loading.set(id, []);
        // Buffered deltas are discarded rather than replayed onto the transcript this rebuilds: the
        // fetch re-derives it from persisted events, which is the same text those deltas were
        // spelling out, and deltas arriving DURING the fetch are dropped for exactly that reason.
        pendingDeltas.delete(id);
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
          refreshGitFor(id); // opening a session refreshes its cwd's git context
          // …and its space's skills library, when the agent can actually take one — what the prompter's
          // @-mention picker reads. Skipped for Cursor/fake sessions: no picker, no fetch.
          const opened = get().sessions[id];
          if (opened && AGENT_SKILL_SUPPORT[opened.agentKind] === "injected") get().run(() => get().refreshSkills(opened.spaceId));
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
        // Deltas are buffered and land a frame later; see `pendingDeltas`.
        if (ev.ephemeral) { if (ev.event.type === "assistant_delta") queueDelta(ev.sessionId, ev.event.payload.messageId, ev.event.payload.delta, ev.event.ts); return; }
        if (ev.seq <= cur.lastSeq) return;
        // A persisted event is ordered AFTER the deltas still waiting, so it folds them into its own
        // write rather than racing the frame that would have applied them.
        setTranscript(ev.sessionId, { lastSeq: ev.seq, t: reduceTranscript(drainInto(ev.sessionId, cur.t), ev.event) });
      },
      flushSessionDeltas() {
        if (pendingDeltas.size === 0) return;
        // One `set` for every streaming session at once: with several agents running, the alternative
        // is a store notification (and so a render of every subscribed pane) per session per frame.
        const next = { ...get().transcripts };
        let wrote = false;
        for (const sessionId of [...pendingDeltas.keys()]) {
          const cur = next[sessionId];
          if (!cur) { pendingDeltas.delete(sessionId); continue; } // closed while its deltas waited
          next[sessionId] = { lastSeq: cur.lastSeq, t: drainInto(sessionId, cur.t) };
          wrote = true;
        }
        if (wrote) set({ transcripts: next });
      },
      applySessionStatus(sessionId, status) {
        const prev = get().sessionStatus[sessionId];
        const s = get().sessions[sessionId];
        set({ sessionStatus: { ...get().sessionStatus, [sessionId]: status }, ...(s ? { sessions: { ...get().sessions, [sessionId]: { ...s, status } } } : {}) });
        // A broadcast for a session we can't place (created in another window/space since the last
        // list): fetch the map so its space can wear the badge.
        if (!get().sessionSpace[sessionId]) get().run(() => get().refreshAllSessions());
        // A turn just finished (or died): the working tree likely changed, so refresh git context.
        if (prev !== status && (status === "idle" || status === "error")) refreshGitFor(sessionId);
      },
      async newSession(input, targetLeafId = null, edge) {
        const sid = get().activeSpaceId; if (!sid) return;
        const { session, itemId } = await api.createSession({ ...input, spaceId: sid });
        rememberAgent(input.agentKind);
        if (isSpace(sid)) mergeSession(session);
        await adoptItem(sid, itemId, targetLeafId, false, edge);
        await get().openSession(session.id);
      },
      async newSessionInstant(targetLeafId = null, edge) {
        await get().newSession({ agentKind: get().lastAgentKind ?? FALLBACK_AGENT }, targetLeafId, edge);
      },
      async newSessionInWorktree(targetLeafId = null) {
        const sid = get().activeSpaceId; if (!sid) return;
        // The worktree is created FIRST and the session pinned to it. If creating it throws (not a
        // repository, no commits yet) no session is made at all — `run` surfaces the reason.
        const env = await api.createWorktree(sid, null);
        if (isSpace(sid)) set({ environments: { ...get().environments, [env.id]: env } });
        await get().newSession({ agentKind: get().lastAgentKind ?? FALLBACK_AGENT, environmentId: env.id }, targetLeafId);
      },
      requestRename(itemId) { set({ renamingItemId: itemId }); },
      requestGroupRename(groupId) { set({ renamingGroupId: groupId }); },
      /**
       * The one path attachments travel. The prompter never passes them in — it cannot forget to, and
       * cannot pass a chip the user already removed, because the list is read here from the same state
       * the chip row renders.
       */
      async sendMessage(id, text) {
        const pending = get().pendingAttachments[id] ?? [];
        // What travels as `mentions` is a re-scan of the FINAL text against the recognised ids plus
        // whatever is mentionable now — read synchronously, before the prompter clears the draft (and
        // with it `draftMentions`) behind this call. The raw text goes as written; the server owns the
        // rewrite, so the transcript shows the `@` and the wire never does.
        const mentions = mentionIds(text, new Set([...(get().draftMentions[id] ?? []), ...mentionableIds(id)]));
        await api.sendMessage(id, text, pending.map(({ path, mime }) => ({ path, mime })), mentions);
        // Only AFTER the send lands, and only the ones that went: a rejected send that also emptied the
        // chip row would leave the user with no record of what they had attached, and a file dragged in
        // while the request was in flight was never part of this message.
        if (pending.length === 0) return;
        const sent = new Set(pending.map((a) => a.path));
        const left = (get().pendingAttachments[id] ?? []).filter((a) => !sent.has(a.path));
        set({ pendingAttachments: { ...get().pendingAttachments, [id]: left } });
      },
      /**
       * ⌘⇧↩ (Plan 13 W2). The dispatched session inherits the composer's setup VERBATIM — agent,
       * model, effort, permission mode, and `environmentId`, which is how "dispatch into the worktree
       * the under-strip says" works: the selector's current choice IS the source session's
       * environment. The origin is recorded at create (`userDispatched`), the draft travels with its
       * attachments and mentions exactly as `sendMessage` would send them, and the new pane comes in
       * beside WITHOUT focus — the named mutant this kills twice over: a dispatch that steals the
       * pane, and a dispatch that leaves the draft behind to be sent again.
       */
      async dispatchDraft(sessionId) {
        const source = get().sessions[sessionId]; if (!source) return;
        const text = (get().drafts[sessionId] ?? "").trim(); if (!text) return;
        const pending = get().pendingAttachments[sessionId] ?? [];
        // Read synchronously BEFORE anything clears — sendMessage's own idiom, same reason.
        const mentions = mentionIds(text, new Set([...(get().draftMentions[sessionId] ?? []), ...mentionableIds(sessionId)]));
        const { session, itemId } = await api.createSession({
          spaceId: source.spaceId, agentKind: source.agentKind, environmentId: source.environmentId,
          model: source.model, effort: source.effort, permissionMode: source.permissionMode,
          userDispatched: true,
        });
        if (isSpace(source.spaceId)) mergeSession(session);
        // Send FIRST, clear after: a rejected send must leave the draft in the composer (run
        // surfaces the reason), exactly as a failed normal send would.
        await api.sendMessage(session.id, text, pending.map(({ path, mime }) => ({ path, mime })), mentions);
        const sent = new Set(pending.map((a) => a.path));
        const left = (get().pendingAttachments[sessionId] ?? []).filter((a) => !sent.has(a.path));
        set({
          drafts: { ...get().drafts, [sessionId]: "" },
          draftMentions: { ...get().draftMentions, [sessionId]: [] },
          pendingAttachments: { ...get().pendingAttachments, [sessionId]: left },
        });
        // The new pane arrives beside, quietly. Items are refetched first (the server created the
        // sidebar item) with the same supersession guard adoptItem uses.
        const seq = ++itemsFetchSeq;
        const items = await api.listItems(source.spaceId);
        if (isSpace(source.spaceId) && seq === itemsFetchSeq) set({ items });
        await get().openItemBesideQuiet(itemId);
      },
      async interruptSession(id) { await api.interruptSession(id); },
      async respondPermission(id, requestId, decision, answers) { await api.respondPermission(id, requestId, decision, answers); },
      async setSessionOptions(id, o) { mergeSession(await api.setSessionOptions(id, o)); },
      /**
       * Build ⇄ Plan.
       *
       * Build and Plan are their own axis in the prompter, but Plan still travels on the wire as
       * `permissionMode: "plan"` (the only channel Claude and Codex read it on). So a session in Plan
       * has nowhere left to hold the permission the user actually chose — entering Plan parks it here,
       * and leaving Plan puts it back.
       *
       * Without the park, every round trip through Plan would quietly demote a session from
       * "Full access" to "Ask", or strand it on a `permissionMode` the picker can no longer name.
       * `default` is the fallback only when there is nothing parked (a session that was already in
       * Plan when the app started).
       */
      async setSessionMode(id, mode) {
        const s = get().sessions[id];
        if (!s) return;
        const inPlan = s.permissionMode === PLAN_PERMISSION_MODE;
        // The park is for agents whose Plan REPLACES a real permission axis (Claude, Codex — the
        // kinds Realm can set a permission mode on at all). An ACP agent's Plan is its own mode
        // (Plan 14 W3): there is no chosen permission to preserve, so leaving Plan simply returns
        // the row to its resting "default" — parking would fabricate Claude-shaped semantics on an
        // agent that never had them.
        const parks = AGENT_SUPPORTS_PERMISSION_MODES[s.agentKind];
        if (mode === "plan") {
          if (inPlan) return;
          if (parks) set({ planReturn: { ...get().planReturn, [id]: s.permissionMode } });
          await get().setSessionOptions(id, { permissionMode: PLAN_PERMISSION_MODE });
        } else {
          if (!inPlan) return;
          const back = parks ? get().planReturn[id] ?? "default" : "default";
          const { [id]: _used, ...planReturn } = get().planReturn;
          set({ planReturn });
          await get().setSessionOptions(id, { permissionMode: back });
        }
      },
      async setSessionAgent(id, agentKind) {
        mergeSession(await api.setSessionAgent(id, agentKind));
        rememberAgent(agentKind);
        // The server renames an untouched default title to match the new agent; the sidebar row shows it.
        await get().refreshItems();
      },
      async setSessionEnvironment(id, environmentId) {
        // The id travels verbatim and the merged session is the server's answer — the chip renders
        // what was persisted, never what was hoped.
        mergeSession(await api.setSessionEnvironment(id, environmentId));
        refreshGitFor(id); // a different checkout: the branch/diff chips must describe THAT tree now
      },
      async moveSessionToNewWorktree(sessionId) {
        const s = get().sessions[sessionId]; if (!s) return;
        // Create FIRST; if it throws (not a repo, no commits) the session stays where it was and `run`
        // surfaces the reason — same shape as newSessionInWorktree.
        const env = await api.createWorktree(s.spaceId, worktreeTitleFrom(get().drafts[sessionId] ?? ""));
        if (get().activeSpaceId === s.spaceId) set({ environments: { ...get().environments, [env.id]: env } });
        // …then select it. Creating without selecting is the named mutant this line kills.
        await get().setSessionEnvironment(sessionId, env.id);
      },
      async moveSessionToSpace(sessionId, spaceId) {
        const item = get().items.find((i) => i.kind === "session" && i.refId === sessionId);
        // Drop it from the CURRENT space's layout/persist FIRST, same ordering deleteItem uses.
        if (item) await get().closeFromLayout(item.id);
        const moved = await api.moveSessionToSpace(sessionId, spaceId);
        mergeSession(moved);
        // It now belongs to `spaceId`'s item list, not this one's.
        if (item) set({ items: get().items.filter((i) => i.id !== item.id) });
        set({ sessionSpace: { ...get().sessionSpace, [sessionId]: spaceId } });
        // A session that had RUN carried its checkout across, so its terminal's cwd is unchanged and
        // the server kept the pty — the moved row still names the terminal item. A null column is the
        // server saying it tore the trio down (the cwd moved), and only then does the renderer drop
        // its xterm handle to match, the same client-side half deleteItem does.
        const termId = get().sessionTerminals[sessionId];
        if (termId && moved.terminalItemId === null) {
          api.disposeTerminal(termId);
          const { [sessionId]: _tid, ...sessionTerminals } = get().sessionTerminals;
          const { [sessionId]: _tp, ...terminalPanel } = get().terminalPanel;
          set({ sessionTerminals, terminalPanel });
        }
      },
      async refreshConnectors(spaceId) {
        const { servers } = await api.listMcpServers(spaceId);
        set({ connectors: { ...get().connectors, [spaceId]: servers } });
      },
      async refreshBrowserAllowlist(spaceId) {
        const list = parseAllowlist(await api.getSetting(allowlistKey(spaceId)));
        set({ browserAllowlists: { ...get().browserAllowlists, [spaceId]: list } });
      },
      async setBrowserAllowlist(spaceId, allowlist) {
        await api.setSetting(allowlistKey(spaceId), allowlist);
        set({ browserAllowlists: { ...get().browserAllowlists, [spaceId]: allowlist } });
        // The live half of the write (Plan 14 W4): every open browser view of THIS space is re-fenced
        // now — new panes read the setting at create, but a pane already open would otherwise keep
        // enforcing the old list until it was closed and reopened. Open panes always belong to the
        // active space's layout, so another space's rows have no views to re-point (and this space's
        // items would be the wrong list to consult).
        if (get().activeSpaceId !== spaceId) return;
        const { host } = getBrowserBridges();
        for (const it of get().items) {
          if (it.kind === "browser") void host.setAllowlist(it.refId, allowlist);
        }
      },
      usageSummary(p) { return api.usageSummary(p); },
      setUsageBudget(budget) { return api.setUsageBudget(budget); },
      importScan() { return api.importScan(); },
      async importApply(selection) {
        const result = await api.importApply(selection);
        // An import can create spaces, sessions and items, and can add library skills that reach
        // every space. The server broadcasts all of that, but a refresh here makes the panel's own
        // "done" state and the sidebar agree in the same tick rather than one event-loop later.
        await get().refreshSpaces();
        await get().refreshItems();
        return result;
      },
      async probeAgents(force = false) {
        // Mount-storm guard: a split of four session panes asks four times in the same tick. The server
        // holds the TTL cache (probe-cache.ts); this only collapses the round trips.
        const pending = probing[force ? "forced" : "plain"];
        if (pending) { await pending; return; }
        const p = api.probeAgents(force)
          .then((agentProbe) => { set({ agentProbe }); })
          .finally(() => { probing[force ? "forced" : "plain"] = null; });
        probing[force ? "forced" : "plain"] = p;
        await p;
      },
      async setDefaultAgent(kind) {
        set({ lastAgentKind: kind });
        await api.setSetting(SETTING_LAST_AGENT, kind);
      },
      async prefillTerminal(sessionId, command) {
        if (!panelOf(sessionId).open) {
          setPanel(sessionId, { ...panelOf(sessionId), open: true });
          await persistPanels();
        }
        await get().ensureSessionTerminal(sessionId);
        const terminalId = get().sessionTerminals[sessionId];
        if (!terminalId) return; // the shell never came up; the card still shows the command to copy
        // NO trailing newline, ever: the command is offered, not run. The user presses Return.
        // Goes through prefill (not write) so the server holds it until the shell stops printing its
        // startup — otherwise the leading characters get eaten by that output.
        await api.prefillTerminal(terminalId, command);
      },
      setDraft(sessionId, text) {
        // Re-scan mentions on every edit, against the union of what is mentionable NOW and what was
        // already recognised: a recognised id survives while its `@token` stays in the text (so a skill
        // deleted after typing still degrades at send instead of going literal), and drops the moment
        // the token is edited away. Nothing here is fuzzy — `mentionIds` only ever exact-matches.
        const prev = get().draftMentions[sessionId] ?? [];
        const mentions = mentionIds(text, new Set([...mentionableIds(sessionId), ...prev]));
        set({ drafts: { ...get().drafts, [sessionId]: text }, draftMentions: { ...get().draftMentions, [sessionId]: mentions } });
      },
      async refreshSkills(spaceId) {
        const { root, skills } = await api.listSkills(spaceId);
        set({ spaceSkills: { ...get().spaceSkills, [spaceId]: skills }, skillsRoot: root });
      },
      async refreshSkillSources(spaceId) {
        const { sources } = await api.listSkillSources(spaceId);
        set({ spaceSkillSources: { ...get().spaceSkillSources, [spaceId]: sources } });
      },
      async addSkillScanRoot(spaceId, path) {
        await api.addSkillScanRoot(path);
        await Promise.all([get().refreshSkills(spaceId), get().refreshSkillSources(spaceId)]);
      },
      async removeSkillScanRoot(spaceId, path) {
        await api.removeSkillScanRoot(path);
        await Promise.all([get().refreshSkills(spaceId), get().refreshSkillSources(spaceId)]);
      },
      async pickAndAddSkillScanRoot(spaceId) {
        const path = await api.pickFolder();
        if (path) await get().addSkillScanRoot(spaceId, path);
      },
      async setSkillEnabled(spaceId, id, enabled) {
        // The spaceId travels verbatim: the store is a per-space disabled set, and writing any other
        // space's key is the named mutant this exists to kill. Re-read rather than patched locally, so
        // what the panel shows is what the server persisted.
        await api.setSkillEnabled(spaceId, id, enabled);
        await get().refreshSkills(spaceId);
      },
      async promoteSkill(spaceId, id) {
        // Same rule as setSkillEnabled: the VANTAGE space id travels verbatim — the server resolves
        // the profile from it. Passing anything else moves the skill into the wrong profile.
        await api.promoteSkill(spaceId, id);
        await get().refreshSkills(spaceId);
      },
      async demoteSkill(spaceId, id) {
        await api.demoteSkill(spaceId, id);
        await get().refreshSkills(spaceId);
      },
      testMcpServer: (id) => api.testMcpServer(id),
      async refreshMemory(spaceId) {
        const state = await api.getMemory(spaceId);
        set({ spaceMemory: { ...get().spaceMemory, [spaceId]: state } });
      },
      async saveMemoryDoc(spaceId, doc) {
        const state = await api.setMemory(spaceId, doc);
        set({ spaceMemory: { ...get().spaceMemory, [spaceId]: state } });
      },
      async setAgentsFile(spaceId, enabled) {
        const state = await api.setAgentsFile(spaceId, enabled);
        set({ spaceMemory: { ...get().spaceMemory, [spaceId]: state } });
      },
      async refreshProfileMemory(profileId) {
        const doc = await api.getProfileMemory(profileId);
        set({ profileMemory: { ...get().profileMemory, [profileId]: doc } });
      },
      async saveProfileMemoryDoc(profileId, doc) {
        const saved = await api.setProfileMemory(profileId, doc);
        // Patch every space snapshot that inherits this doc, so an open Memory surface reads what was
        // just written without waiting for its own refetch.
        const spaceMemory = Object.fromEntries(Object.entries(get().spaceMemory).map(([sid, m]) =>
          [sid, m.profile?.profileId === profileId ? { ...m, profile: { ...m.profile, doc: saved.doc } } : m]));
        set({ profileMemory: { ...get().profileMemory, [profileId]: saved }, spaceMemory });
      },
      async setProfileDocEnabled(spaceId, enabled) {
        // The per-space inheritance override — `memory.setProfileDocEnabled`, keyed by SPACE. The one
        // thing this must never do is touch the profile doc itself (the named W4 mutant: an inherited
        // row's toggle writing the defining scope's state).
        const state = await api.setProfileDocEnabled(spaceId, enabled);
        set({ spaceMemory: { ...get().spaceMemory, [spaceId]: state } });
      },
      async refreshMemorySources(sessionId) {
        const sources = await api.memorySources(sessionId);
        set({ sessionMemorySources: { ...get().sessionMemorySources, [sessionId]: sources } });
      },
      async refreshIconAssets(profileId) {
        await fetchIconAssets(profileId);
      },
      async generateIcon(profileId, prompt) {
        const asset = await api.generateIconAsset(profileId, prompt);
        markIconAssetMutation(profileId);
        set({ iconAssets: { ...get().iconAssets, [profileId]: [asset, ...(get().iconAssets[profileId] ?? [])] } });
        return asset;
      },
      async uploadIconImage(profileId) {
        const picked = await api.pickIconImage();
        if (!picked) return null;
        const asset = await api.uploadIconAsset(profileId, picked.path);
        markIconAssetMutation(profileId);
        set({ iconAssets: { ...get().iconAssets, [profileId]: [asset, ...(get().iconAssets[profileId] ?? [])] } });
        return asset;
      },
      async deleteIconAsset(profileId, id) {
        await api.deleteIconAsset(id);
        markIconAssetMutation(profileId);
        set({ iconAssets: { ...get().iconAssets, [profileId]: (get().iconAssets[profileId] ?? []).filter((a) => a.id !== id) } });
      },
      async attachFiles(sessionId, files) {
        const picked: PickedAttachment[] = [];
        for (const f of files) {
          const path = api.pathForFile(f);
          // A dropped file is already on disk. A pasted one is not — and every adapter's contract is a
          // path, so it has to be written out before it can be attached at all.
          if (path) picked.push({ path, mime: f.type || mimeForPath(f.name || path), name: f.name || basenameOf(path), size: f.size });
          else picked.push(await api.saveTempAttachment(f.name || "pasted", f.type, new Uint8Array(await f.arrayBuffer())));
        }
        addAttachments(sessionId, picked);
      },
      async attachFromPicker(sessionId) { addAttachments(sessionId, await api.pickFiles()); },
      removeAttachment(sessionId, path) {
        const left = (get().pendingAttachments[sessionId] ?? []).filter((a) => a.path !== path);
        set({ pendingAttachments: { ...get().pendingAttachments, [sessionId]: left } });
      },
      async ensureSessionTerminal(sessionId) {
        if (get().sessionTerminals[sessionId]) return;
        const pending = ensuringTerminal.get(sessionId);
        if (pending) return pending;
        const p = api.openSessionTerminal(sessionId)
          .then(({ terminalId }) => { set({ sessionTerminals: { ...get().sessionTerminals, [sessionId]: terminalId } }); })
          .finally(() => { ensuringTerminal.delete(sessionId); });
        ensuringTerminal.set(sessionId, p);
        return p;
      },
      async toggleTerminalPanel(sessionId) {
        const next = { ...panelOf(sessionId), open: !panelOf(sessionId).open };
        // Show the panel first, then create: the toggle is instant, and the pane fills in when the
        // shell answers. Closing never destroys anything — the pty and its scrollback wait.
        setPanel(sessionId, next);
        await persistPanels();
        if (next.open) await get().ensureSessionTerminal(sessionId);
      },
      setTerminalPanelWidth(sessionId, width) {
        const cur = panelOf(sessionId);
        if (Math.abs(cur.width - width) < 0.01) return;
        setPanel(sessionId, { ...cur, width });
        schedulePanelPersist();
      },
      async refreshGitInfo(cwd) {
        const info = await api.gitInfo(cwd);
        set({ gitInfo: { ...get().gitInfo, [cwd]: info } });
      },
      async refreshDiff(cwd) {
        set({ diffLoading: { ...get().diffLoading, [cwd]: true } });
        try {
          const summary = await api.diff(cwd);
          // Patches for files that are no longer in the list are dropped here rather than left to
          // rot: a stale patch under a collapsed row is what makes a diff pane lie after a commit.
          const live = new Set((summary?.files ?? []).map((f) => f.path));
          const patches = Object.fromEntries(Object.entries(get().patches).filter(([key, p]) => !key.startsWith(`${cwd}\u0000`) || live.has(p.path)));
          set({ diffs: { ...get().diffs, [cwd]: summary }, patches });
        } finally {
          const { [cwd]: _done, ...rest } = get().diffLoading;
          set({ diffLoading: rest });
        }
        await get().refreshGitInfo(cwd);
      },
      async refreshAllDiffs() {
        await Promise.all(Object.keys(get().diffs).map((cwd) => get().refreshDiff(cwd)));
      },
      async loadPatch(cwd, path, staged) {
        const key = patchKey(cwd, path, staged);
        if (get().patches[key]) return;
        const patch = await api.fileDiff(cwd, path, staged);
        set({ patches: { ...get().patches, [key]: patch } });
      },
      async stagePaths(cwd, paths) {
        if (paths.length === 0) return;
        await api.stagePaths(cwd, paths);
        // Both sides of every touched path are now different patches. Drop them BEFORE refreshing so
        // an expanded row cannot render the pre-staging hunks under the post-staging label.
        set({ patches: dropPatches(get().patches, cwd, paths) });
        await get().refreshDiff(cwd);
      },
      async unstagePaths(cwd, paths) {
        if (paths.length === 0) return;
        await api.unstagePaths(cwd, paths);
        set({ patches: dropPatches(get().patches, cwd, paths) });
        await get().refreshDiff(cwd);
      },
      setCommitMessage(cwd, text) { set({ commitMessages: { ...get().commitMessages, [cwd]: text } }); },
      async ship(input) {
        if (get().shipping[input.cwd]) return; // one ship per checkout; the button is disabled too
        set({ shipping: { ...get().shipping, [input.cwd]: true } });
        try {
          const result = await api.ship(input);
          set({ shipResults: { ...get().shipResults, [input.cwd]: result } });
          // A commit that landed has emptied the index; the message it used has been spent.
          if (result.commit.state === "committed") get().setCommitMessage(input.cwd, "");
        } finally {
          const { [input.cwd]: _done, ...rest } = get().shipping;
          set({ shipping: rest });
        }
        // Unconditional: a rejected push still leaves a commit the pane must stop offering to make.
        await get().refreshDiff(input.cwd);
      },
      async openDiff(environmentId, targetLeafId = null) {
        const sid = get().activeSpaceId; if (!sid) return;
        const env = get().environments[environmentId];
        if (!env) return;
        // One diff pane per environment: a second "show changes" on the same checkout goes to the
        // pane that already exists rather than accumulating identical panes.
        const existing = get().items.find((i) => i.kind === "diff" && i.refId === environmentId);
        // Same eviction bug openItemBeside exists to fix, just triggered by the user instead of an
        // agent: replacing the focused leaf in place stranded the session with no way back. Split
        // beside it instead — unless the caller named an explicit target leaf.
        if (existing) {
          if (targetLeafId === null) { await get().openItemBeside(existing.id); return; }
          await get().openItem(existing.id, targetLeafId);
          return;
        }
        const title = env.branch ?? env.path.replace(/\/+$/, "").split("/").pop() ?? "Changes";
        const created = await api.createItem(sid, "diff", `Changes · ${title}`, environmentId);
        await adoptItem(sid, created.id, targetLeafId, true);
      },
      async openDocuments(environmentId = null, targetLeafId = null) {
        const sid = get().activeSpaceId; if (!sid) return;
        // No local "is it already open?" check, unlike openDiff: the SERVER enforces one workspace per
        // environment and returns the existing pair, so this call is idempotent and already answers
        // the question. Doing it here as well would need the environment id the caller may not have
        // passed (the primary checkout is resolved server-side) plus a cache of workspace rows to
        // resolve it against — two new pieces of state to keep honest, for an answer already in hand.
        const { itemId } = await api.createDocuments(sid, environmentId ?? undefined);
        const layout = get().layout;
        if (layout && findLeafOfItem(layout, itemId)) { await get().openItem(itemId, targetLeafId); return; }
        await adoptItem(sid, itemId, targetLeafId);
      },
      async openDocumentPath(path, environmentId = null) {
        const sid = get().activeSpaceId; if (!sid) return;
        const { itemId } = await api.openDocumentPath(sid, path, environmentId ?? undefined);
        const layout = get().layout;
        if (layout && findLeafOfItem(layout, itemId)) { await get().openItem(itemId); return; }
        await adoptItem(sid, itemId, null);
      },
      async applyDocumentOpenRequested({ spaceId, itemId }) {
        if (spaceId !== get().activeSpaceId) return;
        const layout = get().layout;
        if (layout && findLeafOfItem(layout, itemId)) return; // already on screen; the pane opens the tab itself
        await get().refreshItems();
        await get().openItemBesideQuiet(itemId);
      },
      async startLecture(title) {
        const sid = get().activeSpaceId; if (!sid) return;
        const clean = title.trim();
        const stamp = localDateStamp(new Date());
        // The group first, so the lecture pane lands in its empty leaf rather than replacing whatever
        // the user had focused; a failure after this leaves an empty named group, which is harmless.
        await get().newPaneGroup(clean ? `${clean} · ${stamp}` : `Lecture · ${stamp}`);
        const r = await api.startLecture(sid, clean);
        await adoptItem(sid, r.itemId, null);
        const agentKind = get().lastAgentKind ?? FALLBACK_AGENT;
        const { session, itemId } = await api.createSession({ spaceId: sid, agentKind, title: `Lecture assistant · ${clean || stamp}` });
        rememberAgent(agentKind);
        if (isSpace(sid)) mergeSession(session);
        await adoptItem(sid, itemId, null, true);
        await get().openSession(session.id);
      },
      async wrapUpLecture(lecture) {
        const sid = get().activeSpaceId; if (!sid) return;
        const space = get().spaces.find((sp) => sp.id === sid);
        const agentKind = get().lastAgentKind ?? FALLBACK_AGENT;
        const { session, itemId } = await api.createSession({ spaceId: sid, agentKind, title: `Wrap up · ${lecture.title}` });
        rememberAgent(agentKind);
        if (isSpace(sid)) mergeSession(session);
        await adoptItem(sid, itemId, null, true);
        await get().openSession(session.id);
        await get().sendMessage(session.id, lectureWrapUpPrompt(lecture, { course: space?.name ?? "this course" }));
      },
      async listLectures() {
        const sid = get().activeSpaceId; if (!sid) return [];
        return api.listLectures(sid);
      },
      previewInfo: () => api.previewInfo(),
      readGuideProgress: (documentsId, path) => api.readGuideProgress(documentsId, path),
      recordGuideAttempt: (documentsId, path, topic, correct, total) => api.recordGuideAttempt(documentsId, path, topic, correct, total),
      plynnList: () => api.plynnList(),
      async plynnImport(files) {
        const sid = get().activeSpaceId; if (!sid) throw new Error("no active space");
        const r = await api.plynnImport(sid, files);
        await get().refreshItems();
        return r;
      },
      getDocuments: (documentsId) => api.getDocuments(documentsId),
      setDocumentTabs: (documentsId, openPaths, activePath) => api.setDocumentTabs(documentsId, openPaths, activePath),
      detachDocuments: (documentsId) => api.detachDocuments(documentsId),
      listDocumentEntries: (documentsId, dir) => api.listDocumentEntries(documentsId, dir),
      readDocument: (documentsId, path) => api.readDocument(documentsId, path),
      writeDocument: (documentsId, path, text, baseHash) => api.writeDocument(documentsId, path, text, baseHash),
      createDocumentFile: (documentsId, path, kind, title) => api.createDocumentFile(documentsId, path, kind, title),
      renameDocumentFile: (documentsId, from, to) => api.renameDocumentFile(documentsId, from, to),
      async requestReview(environmentId) {
        if (get().reviewing[environmentId]) return; // the button is disabled too; the server refuses regardless
        set({ reviewing: { ...get().reviewing, [environmentId]: true } });
        try { await api.requestReview(environmentId); }
        catch (e) {
          // The request never started a run — the flag must not stick on a refusal.
          const { [environmentId]: _x, ...reviewing } = get().reviewing;
          set({ reviewing });
          throw e;
        }
        // Stays true until the verdict's review.changed lands (applyReviewChanged clears it).
      },
      async refreshReview(environmentId) {
        const { review } = await api.getReview(environmentId);
        set({ reviews: { ...get().reviews, [environmentId]: review } });
      },
      async dismissReview(environmentId) {
        await api.dismissReview(environmentId);
        // Applied locally too: the broadcast confirms, but the ✕ must not wait a round trip.
        set({ reviews: { ...get().reviews, [environmentId]: null } });
      },
      applyReviewChanged({ environmentId, review }) {
        const { [environmentId]: _done, ...reviewing } = get().reviewing;
        set({ reviews: { ...get().reviews, [environmentId]: review }, reviewing });
      },
      async openSpacePage(spaceId, tab) {
        // The tab lands even when the page item already exists — "Manage connections…" on an
        // already-open page must still end up on Connections.
        if (tab) get().setSpacePageTab(spaceId, tab);
        // Page items live in the layout of the space they describe; every opener is active-space
        // scoped (gear, header, palette, session pane), so a mismatch means the space changed
        // under the click — do nothing rather than adopt an item into the wrong layout.
        if (get().activeSpaceId !== spaceId) return;
        // One page per space, the diff pane's dedup precedent: a second open goes to the pane that
        // already exists rather than accumulating identical pages.
        const existing = get().items.find((i) => i.kind === "space-page" && i.refId === spaceId);
        if (existing) { await get().openItem(existing.id); return; }
        // Title is static ("Overview"), never the space name: the page header renders the live name,
        // and a snapshot in the item row would go stale on rename.
        const created = await api.createItem(spaceId, "space-page", "Overview", spaceId);
        await adoptItem(spaceId, created.id, null);
      },
      async openDestinationPage(kind, placement = "reuse") {
        // The page lives in the ACTIVE space's layout — that space is the vantage its scope groups
        // ("This space" / "From <profile>" / "Everywhere") are computed from. No active space
        // (mid-boot) → no-op, openSpacePage's guard.
        const spaceId = get().activeSpaceId;
        if (!spaceId) return null;
        // One page per space, deduped by KIND (`items` only ever holds the active space's items).
        // The named W4 mutant: a second click accumulating a second Library pane.
        const existing = get().items.find((i) => i.kind === kind);
        if (existing) {
          // Naming the focused leaf is what makes openItem MOVE the pane; passing null is what makes it
          // home to wherever the pane already sits. With nothing focused there is no "here" to mean, so
          // the null falls through to homing on its own rather than needing a second branch.
          await get().openItem(existing.id, placement === "here" ? get().focusedLeafId : null);
          return existing.id;
        }
        // Static title (the page header owns the live copy); refId is the kind's well-known sentinel —
        // there is no row behind these pages, and identity is really the kind (see PAGE_REF_IDS).
        const created = await api.createItem(spaceId, kind, DESTINATION_PAGE_TITLES[kind], PAGE_REF_IDS[kind]);
        await adoptItem(spaceId, created.id, null);
        return created.id;
      },
      destinationPageElsewhere(kind) {
        const it = get().items.find((i) => i.kind === kind);
        if (!it) return false; // no page yet — a plain click already creates it in the focused pane
        const gs = get().groups;
        if (!gs) {
          const leaf = findLeafOfItem(get().layout ?? emptyLayout(), it.id);
          return leaf !== null && leaf.id !== get().focusedLeafId;
        }
        const holder = groupOfItem(gs, it.id);
        if (!holder) return false; // the item exists but no pane holds it: both placements would open one
        // A page held by a group that is not on screen is elsewhere by the strongest reading — the plain
        // click swaps the whole arrangement to reach it.
        if (holder.id !== gs.activeGroupId) return true;
        return findLeafOfItem(holder.layout, it.id)?.id !== get().focusedLeafId;
      },
      setSpacePageTab(spaceId, tab) { set({ spacePageTab: { ...get().spacePageTab, [spaceId]: tab } }); },
      async openProfilePage(tab) {
        // The tab is keyed by PROFILE — resolved from the active space, the same vantage the page
        // itself renders from, so the section the opener lands on is the section the page shows.
        const spaceId = get().activeSpaceId;
        const space = get().spaces.find((x) => x.id === spaceId);
        if (!space) return;
        if (tab) get().setProfilePageTab(space.profileId, tab);
        await get().openDestinationPage("profile-page");
      },
      setProfilePageTab(profileId, tab) { set({ profilePageTab: { ...get().profilePageTab, [profileId]: tab } }); },
      async refreshSettingsPrefs() {
        const [rawDisabled, rawMode, rawDesktop] = await Promise.all([
          api.getSetting(NOTIFICATIONS_DISABLED_KEY), api.getSetting(DEFAULT_PERMISSION_MODE_KEY), api.getSetting(NOTIFICATIONS_DESKTOP_KEY),
        ]);
        const disabledCategories = (Array.isArray(rawDisabled) ? rawDisabled : [])
          .filter((c): c is NotificationCategory => (NOTIFICATION_CATEGORIES as readonly string[]).includes(c as string));
        const defaultPermissionMode = PERMISSION_MODES.some((m) => m.id === rawMode) ? (rawMode as string) : "default";
        set({ settingsPrefs: { disabledCategories, defaultPermissionMode }, desktopNotifications: rawDesktop !== false });
      },
      async refreshModelFavorites() {
        const raw = await api.getSetting(MODEL_FAVORITES_KEY);
        set({ modelFavorites: (Array.isArray(raw) ? raw : []).filter((k): k is string => typeof k === "string") });
      },
      async refreshModelCatalog() {
        // Same mount-storm shape as probeAgents, for the same reason: a four-pane split asks four
        // times in one tick. Failures are swallowed — a picker with no prices is the fallback the
        // whole catalog path is designed around, so there is nothing to report to the user here.
        if (!catalogPending) {
          catalogPending = api.modelCatalog(false)
            .then((rows) => { set({ modelInfo: Object.fromEntries(rows.map((r) => [r.key, r])) }); })
            .catch(() => {})
            .finally(() => { catalogPending = null; });
        }
        await catalogPending;
      },
      async toggleModelFavorite(key) {
        const held = get().modelFavorites;
        // Appended rather than inserted: the favourites list is the SHORTCUT order (1…9), so a newly
        // starred model must not renumber the ones the user has already learned.
        const modelFavorites = held.includes(key) ? held.filter((k) => k !== key) : [...held, key];
        await api.setSetting(MODEL_FAVORITES_KEY, modelFavorites);
        set({ modelFavorites });
      },
      async setNotificationCategoryEnabled(category, enabled) {
        const prefs = get().settingsPrefs; if (!prefs) return; // toggles only exist once prefs loaded
        // Recomputed from the held set so a double-toggle can't write a duplicate, and — the named
        // mutant — only THIS category moves: everything else passes through untouched.
        const disabledCategories = enabled
          ? prefs.disabledCategories.filter((c) => c !== category)
          : [...prefs.disabledCategories.filter((c) => c !== category), category];
        await api.setSetting(NOTIFICATIONS_DISABLED_KEY, disabledCategories);
        set({ settingsPrefs: { ...prefs, disabledCategories } });
      },
      async setDefaultPermissionMode(mode) {
        const prefs = get().settingsPrefs; if (!prefs) return;
        await api.setSetting(DEFAULT_PERMISSION_MODE_KEY, mode);
        set({ settingsPrefs: { ...prefs, defaultPermissionMode: mode } });
      },
      async refreshTcc() { set({ tccRows: await api.tccProbe() }); },
      async refreshCredentials() {
        const [credentials, credentialStatus] = await Promise.all([api.credentialList(), api.credentialStatus()]);
        set({ credentials, credentialStatus });
      },
      // Each of these re-reads rather than patching local state: main clamps the TTL and mints the
      // id, so what it returns is the truth and a locally-patched list would be a guess at it.
      async addCredential(input) { await api.credentialAdd(input); await get().refreshCredentials(); },
      async removeCredential(id) { await api.credentialRemove(id); await get().refreshCredentials(); },
      async setCredentialPresenceTtl(ms) { await api.credentialSetPresenceTtl(ms); await get().refreshCredentials(); },
      async openTccPane(pane) { await api.openTccPane(pane); },

      async refreshMacAccess() { set({ macAccess: await api.macAccessStatus() }); },
      async grantMacAccess(id) {
        // The interlock: macOS puts up one consent dialog at a time, so a second grant fired while
        // the first is pending would either queue invisibly or lose the user's answer.
        if (get().macGranting !== null) return;
        // Only rows that CAN be prompted — a denied row's dialog will never appear (denials are
        // sticky), and Full Disk Access has no dialog at all.
        if (!get().macAccess?.rows.find((r) => r.id === id)?.canPrompt) return;
        set({ macGranting: id });
        try { set({ macAccess: await api.macAccessGrant(id) }); }
        finally { set({ macGranting: null }); }
      },
      async grantAllMacAccess() {
        if (get().macGranting !== null || get().macGrantQueue.length > 0) return;
        // The plan is computed ONCE, from the audit as it stands: each grant re-reads the whole
        // audit, and recomputing from that would let a row that answers "denied" be retried forever.
        const queue = (get().macAccess?.rows ?? []).filter((r) => r.canPrompt).map((r) => r.id);
        set({ macGrantQueue: queue });
        try {
          for (const id of queue) {
            set({ macGranting: id });
            // One failed prompt must not abandon the rest of the walk — the next capability is
            // still worth asking about, and the re-read audit will show what actually happened.
            try { set({ macAccess: await api.macAccessGrant(id) }); } catch { /* recorded in the audit */ }
            set({ macGranting: null });
          }
        } finally { set({ macGranting: null, macGrantQueue: [] }); }
      },
      async openMacAccessPane(id) { await api.macAccessOpenSettings(id); },
      async revealRealmApp() { await api.macAccessRevealApp(); },
      async refreshUpdateStatus() { set({ updateStatus: await api.updateStatus() }); },
      async checkForUpdates() {
        const held = get().updateStatus;
        // A gated build's check answers the disabled state unchanged, so no interim is shown at all;
        // an enabled build's IPC call IS a check in flight in main — "checking" reflects that fact.
        if (held && held.state.kind !== "disabled") set({ updateStatus: { ...held, state: { kind: "checking" } } });
        set({ updateStatus: await api.checkUpdates() });
      },
      async installUpdate() { await api.installUpdate(); },
      async refreshNotifications() {
        // Sized to cover what is already showing: a refetch triggered by a broadcast must not shrink
        // the list the user is scrolled into. Capped at the wire's own limit.
        const limit = Math.min(200, Math.max(NOTIFICATIONS_PAGE, get().notifications.length));
        const page = await api.listNotifications(null, limit);
        set({ notifications: page.notifications, notificationsCursor: page.nextCursor });
        applyUnread(page.unread);
      },
      async loadMoreNotifications() {
        const cursor = get().notificationsCursor; if (!cursor) return;
        const page = await api.listNotifications(cursor, NOTIFICATIONS_PAGE);
        // Guard against a duplicate landing across a refetch that raced this page in.
        const known = new Set(get().notifications.map((n) => n.id));
        set({ notifications: [...get().notifications, ...page.notifications.filter((n) => !known.has(n.id))],
          notificationsCursor: page.nextCursor });
        applyUnread(page.unread);
      },
      async markNotificationsRead(ids) {
        const r = ids === "all" ? await api.markNotificationsRead({ all: true }) : await api.markNotificationsRead({ ids });
        const t = Date.now();
        set({ notifications: get().notifications.map((n) => n.readAt === null && (ids === "all" || ids.includes(n.id)) ? { ...n, readAt: t } : n) });
        applyUnread(r.unread);
      },
      applyNotificationsChanged(payload) {
        applyUnread(payload.unread);
        const n = payload.notification;
        if (n) {
          // A surfaced row lands at the top of whatever slice is held (a reopen moves, not
          // duplicates). An unloaded feed stays unloaded — the page fetches on mount.
          if (get().notifications.length > 0) {
            set({ notifications: [n, ...get().notifications.filter((x) => x.id !== n.id)] });
          }
          // The session_done contract's renderer half: the server writes a row for EVERY settle; the
          // focused pane's settle is one the user is watching, so it is read the moment it exists.
          if (n.category === "session_done" && n.sessionId) {
            const focused = get().items.find((i) => i.id === itemIdOfLeaf(get().layout, get().focusedLeafId));
            if (focused?.kind === "session" && focused.refId === n.sessionId) {
              void get().run(() => get().markNotificationsRead([n.id]));
            }
          }
          // The OS hop. Every SURFACED row is a candidate and nothing is re-filtered here: the server
          // already dropped the categories switched off, and absorbed a repeat of a still-open
          // condition into its existing row without surfacing it — so a flapping MCP server toasts
          // once, for free. Note what is NOT consulted: the read bit. The auto-read above is a rule
          // about which PANE is focused; a turn settling on the focused pane while Realm sits behind
          // another app is exactly the toast worth showing. Whether one appears is main's call
          // (window focus), and a failed toast must never take the feed handler down with it.
          if (get().desktopNotifications) void api.showDesktopNotification({ id: n.id, title: n.title, body: n.body }).catch(() => {});
        } else if (get().notifications.length > 0) {
          // A resolution or a markRead from elsewhere: re-read the held slice so a permission row can
          // never keep rendering "pending" after it was answered in some other pane or window.
          void get().run(() => get().refreshNotifications());
        }
      },
      async revealSession(sessionId, spaceId) {
        // `sessionSpace` is the authority when it has an answer: a session that was MOVED between
        // spaces leaves the caller's remembered id stale, and switching to the old space would open
        // nothing and look like a dead button.
        const target = get().sessionSpace[sessionId] ?? spaceId;
        if (target && target !== get().activeSpaceId) await get().selectSpace(target);
        const item = get().items.find((i) => i.kind === "session" && i.refId === sessionId);
        // A session with no item in the space it claims has no pane to be brought forward — the space
        // switch above already happened, so callers need to hear that the jump did NOT land rather
        // than leave the user somewhere new with nothing opened.
        if (!item) return false;
        await get().openItem(item.id);
        return true;
      },
      async openNotificationTarget(n) {
        // Read first, before anything moves: the row is read because the user clicked it, not because
        // a landing turned out to be reachable. selectNotification below then finds it already read
        // and has nothing left to stamp, so one click is one markRead however many surfaces it
        // passes through.
        if (n.readAt === null) await get().markNotificationsRead([n.id]);
        // A row that names a session is about that session's pane; `permission` goes through
        // jumpToPermission because putting the pane in the focused leaf is what pops its card open.
        const landed = n.sessionId !== null && (n.category === "permission"
          ? await get().jumpToPermission(n.sessionId)
          : await get().revealSession(n.sessionId, n.spaceId));
        if (landed) return;
        // Everything else — an MCP server that fell over, a probe that stopped answering, a budget
        // ceiling — has no pane of its own, and neither does a session whose item is gone. For those
        // the feed row IS the thing the notification is about, so the click lands on the page with the
        // row selected: selectNotification is the in-page click's own path, which is what makes this
        // landing a stop on the pane's trail rather than a jump the arrows cannot retrace.
        const pageItemId = await get().openDestinationPage("notifications-page");
        if (pageItemId) await get().selectNotification(pageItemId, n.id);
      },
      async activateDesktopNotification(id) {
        // Main hands back an id and nothing else. The feed may never have been loaded — a toast is
        // often the FIRST this renderer hears of a row — so a miss refetches once rather than
        // swallowing the click; the row is by construction at the top of the first page.
        let n = get().notifications.find((x) => x.id === id);
        if (!n) {
          await get().refreshNotifications();
          n = get().notifications.find((x) => x.id === id);
        }
        if (n) await get().openNotificationTarget(n);
      },
      async setDesktopNotifications(enabled) {
        await api.setSetting(NOTIFICATIONS_DESKTOP_KEY, enabled);
        set({ desktopNotifications: enabled });
        // Republish the count under the new answer: switching off has to CLEAR the dock, not leave
        // the last number sitting there until something else happens to change it.
        applyUnread(get().notificationsUnread);
      },
      async selectNotification(pageItemId, id) {
        set({ notificationsSelectedId: id });
        get().navigateInPane(pageItemId, id);
        // Read state is stamped by OPENING a row, not by the arrows: `stepPaneNav` only re-seats the
        // selection, so retracing the trail re-shows rows without touching read state (they were read
        // the first time through) and can never spend a markRead on a row the user is walking past.
        const n = id ? get().notifications.find((x) => x.id === id) : null;
        if (n && n.readAt === null) await get().markNotificationsRead([n.id]);
      },
      async askRemoveWorktree(environmentId) {
        const status = await api.worktreeStatus(environmentId);
        set({ worktreeStatuses: { ...get().worktreeStatuses, [environmentId]: status }, worktreeAckStale: null,
          sheet: { kind: "remove-worktree", environmentId }, paletteOpen: false, ...maybeSnapForSheet() });
      },
      /**
       * The acknowledgement is read HERE, not taken from what the sheet is displaying.
       *
       * The server refuses an acknowledgement whose counts do not match what git reports at the
       * moment of removal, and it is right to: an agent that wrote another file since the sheet
       * opened has changed what "yes" means. So this re-reads, and if the numbers moved it shows the
       * new ones and removes nothing — the user says yes to a number they have actually seen.
       */
      async confirmRemoveWorktree(environmentId) {
        const shown = get().worktreeStatuses[environmentId];
        const fresh = await api.worktreeStatus(environmentId);
        set({ worktreeStatuses: { ...get().worktreeStatuses, [environmentId]: fresh } });
        if (!shown || fresh.dirtyFiles !== shown.dirtyFiles || fresh.unpushedCommits !== shown.unpushedCommits) {
          set({ worktreeAckStale: environmentId });
          return;
        }
        await api.removeWorktree(environmentId, { dirtyFiles: fresh.dirtyFiles, unpushedCommits: fresh.unpushedCommits });
        const { [environmentId]: _gone, ...worktreeStatuses } = get().worktreeStatuses;
        set({ worktreeStatuses, worktreeAckStale: null, sheet: null, ...restoreSnap() });
        // The environment is gone; so is anything keyed to its checkout.
        const { [fresh.path]: _d, ...diffs } = get().diffs;
        set({ diffs });
        const item = get().items.find((i) => i.kind === "diff" && i.refId === environmentId);
        if (item) await get().deleteItem(item.id);
        await get().refreshEnvironments();
      },
      async openCheckpoints(environmentId, sessionId = null) {
        const list = await api.listCheckpoints(environmentId, sessionId);
        set({
          checkpoints: { ...get().checkpoints, [environmentId]: list },
          checkpointPreview: null, checkpointAckStale: false, restoreResult: null,
          sheet: { kind: "checkpoints", environmentId, sessionId }, paletteOpen: false, ...maybeSnapForSheet(),
        });
      },
      async refreshCheckpoints(environmentId, sessionId) {
        const list = await api.listCheckpoints(environmentId, sessionId);
        set({ checkpoints: { ...get().checkpoints, [environmentId]: list } });
      },
      async refreshShips(spaceId) {
        const { ships } = await api.listShips(spaceId);
        set({ ships: { ...get().ships, [spaceId]: ships } });
      },
      async refreshRuns(spaceId) {
        const { runs } = await api.listRuns(spaceId);
        set({ runs: { ...get().runs, [spaceId]: runs } });
      },
      async createRun(spaceId, goal, title) {
        const { run: r } = await api.createRun({ spaceId, goal, ...(title ? { title } : {}) });
        get().applyRunsChanged({ spaceId, run: r });
        await get().selectRun(spaceId, r.id);
      },
      async selectRun(spaceId, runId) {
        set({ selectedRunId: { ...get().selectedRunId, [spaceId]: runId } });
        if (!runId) return;
        const detail = await api.getRun(runId);
        // A run deleted under the click clears the selection rather than leaving a panel describing
        // something that is gone.
        if (!detail) { set({ selectedRunId: { ...get().selectedRunId, [spaceId]: null } }); return; }
        set({ runAttempts: { ...get().runAttempts, [runId]: detail.attempts } });
        get().applyRunsChanged({ spaceId: detail.run.spaceId, run: detail.run });
      },
      async cancelRun(id) { await afterRunWrite(await api.cancelRun(id)); },
      async retryRun(id) { await afterRunWrite(await api.retryRun(id)); },
      async approveRun(id, approved, note) { await afterRunWrite(await api.approveRun(id, approved, note)); },
      applyRunsChanged({ spaceId, run }) {
        const held = get().runs[spaceId];
        // Held-only: a space whose runs nobody has asked for has nothing to go stale. A null `run`
        // (a bulk change with no single subject) refetches instead of guessing.
        if (!held) return;
        if (!run) { void get().run(() => get().refreshRuns(spaceId)); return; }
        const i = held.findIndex((r) => r.id === run.id);
        // Newest-first, and a new run is by construction the newest — so an unknown id goes on top
        // rather than triggering a refetch the broadcast already carried the answer for.
        set({ runs: { ...get().runs, [spaceId]: i === -1 ? [run, ...held] : held.map((r) => (r.id === run.id ? run : r)) } });
        if (get().selectedRunId[spaceId] === run.id) void get().run(() => loadRunAttempts(run.id));
      },
      async captureCheckpoint(environmentId, sessionId) {
        await api.captureCheckpoint(environmentId, sessionId);
        await get().refreshCheckpoints(environmentId, sessionId);
      },
      async forkFromCheckpoint(checkpointId) {
        const { session, itemId, environment } = await api.forkSession(checkpointId);
        if (isSpace(session.spaceId)) {
          mergeSession(session);
          set({ environments: { ...get().environments, [environment.id]: environment } });
        }
        // Close the sheet BEFORE adopting: adoptItem rewrites the layout, and the W2.4 snap must be
        // unwound off the pre-sheet layout, not the post-adopt one.
        set({ sheet: null, ...restoreSnap() });
        await adoptItem(session.spaceId, itemId, null);
        await get().openSession(session.id);
      },
      async askRestoreCheckpoint(id) {
        const preview = await api.previewCheckpoint(id);
        set({ checkpointPreview: preview, checkpointAckStale: false, restoreResult: null });
      },
      cancelRestoreCheckpoint() {
        set({ checkpointPreview: null, checkpointAckStale: false });
      },
      /**
       * Same contract as `confirmRemoveWorktree`, for the same reason: the acknowledgement is read
       * HERE, freshly, and never taken from what the sheet happens to be displaying. An agent that
       * wrote another file while the confirm was open has changed what "yes" means, so a moved count
       * shows the new numbers and restores nothing.
       */
      async confirmRestoreCheckpoint(id) {
        const shown = get().checkpointPreview;
        const fresh = await api.previewCheckpoint(id);
        set({ checkpointPreview: fresh });
        if (!shown || fresh.filesChanged !== shown.filesChanged || fresh.commitsRolledBack !== shown.commitsRolledBack) {
          set({ checkpointAckStale: true });
          return;
        }
        const result = await api.restoreCheckpoint(id, { filesChanged: fresh.filesChanged, commitsRolledBack: fresh.commitsRolledBack });
        set({ checkpointPreview: null, checkpointAckStale: false, restoreResult: result });
        // The tree was rewritten and a `pre-restore` checkpoint now exists: both views are stale.
        const sheet = get().sheet;
        await get().refreshCheckpoints(result.environmentId, sheet?.kind === "checkpoints" ? sheet.sessionId : null);
        if (result.path in get().diffs) await get().refreshDiff(result.path);
      },
      async refreshMcpServers(spaceId) {
        // Providers ride along (W4): the Connections surface renders both, and a provider toggled in
        // another surface must not survive a refetch here.
        const [{ servers }, providers] = await Promise.all([api.listMcpServers(spaceId), api.listMcpProviders(spaceId)]);
        // Apply only if this space's panel is STILL the mounted one — a slow response after the user
        // closed the page or switched its space must not clobber what the panel shows now.
        if (get().mcpPanelSpaceId !== spaceId) return;
        set({ mcpServers: servers, mcpProviders: providers });
      },
      clearMcpServers(spaceId) { set({ mcpServers: [], mcpProviders: [], mcpToolsError: {}, mcpPanelSpaceId: spaceId }); },
      async addMcpServer(input) {
        const s = await api.addMcpServer(input);
        // Optimistic: `mcp.changed` will also refetch, but that broadcast round-trip must not be the
        // only reason the row the user just created appears.
        set({ mcpServers: [...get().mcpServers, s] });
        return s;
      },
      async updateMcpServer(input) {
        const s = await api.updateMcpServer(input);
        set({ mcpServers: get().mcpServers.map((x) => (x.id === s.id ? s : x)) });
        return s;
      },
      async removeMcpServer(id) {
        await api.removeMcpServer(id);
        set({ mcpServers: get().mcpServers.filter((x) => x.id !== id) });
      },
      async setMcpEnabled(spaceId, id, enabled) {
        await api.setMcpEnabled(spaceId, id, enabled);
        set({ mcpServers: get().mcpServers.map((x) => (x.id === id ? { ...x, enabled } : x)) });
      },
      // Promote/demote re-read rather than patch: the scope AND the enabled flag can both change
      // shape server-side (demotion retires overrides), and the refresh guard already protects a
      // panel that moved on. Same shape for skills below.
      async promoteMcpServer(spaceId, id) {
        await api.promoteMcpServer(spaceId, id);
        await get().refreshMcpServers(spaceId);
      },
      async demoteMcpServer(spaceId, id) {
        await api.demoteMcpServer(spaceId, id);
        await get().refreshMcpServers(spaceId);
      },
      async setMcpProviderEnabled(spaceId, name, enabled) {
        await api.setMcpProviderEnabled(spaceId, name, enabled);
        set({ mcpProviders: get().mcpProviders.map((p) => (p.name === name ? { ...p, enabled } : p)) });
      },
      async setMcpAllowedTools(spaceId, id, tools) {
        await api.setMcpAllowedTools(spaceId, id, tools);
        set({ mcpServers: get().mcpServers.map((x) => (x.id === id ? { ...x, allowedTools: tools } : x)) });
      },
      async refreshMcpTools(id) {
        const { tools, error } = await api.mcpToolsList(id);
        set({
          // A failed refresh keeps whatever was cached before — the row still has something to show.
          mcpServers: get().mcpServers.map((x) => (x.id === id ? { ...x, tools: error ? x.tools : tools } : x)),
          mcpToolsError: { ...get().mcpToolsError, [id]: error },
        });
      },
      async retryMcpServer(id) {
        await api.retryMcpServer(id);
        // The real status arrives on the next `mcp.serverStatus` broadcast; optimistically clear the
        // breaker here so the Retry button doesn't sit on a stale "circuit_open" until then.
        set({ mcpServers: get().mcpServers.map((x) => (x.id === id ? { ...x, status: "idle" } : x)) });
      },
      async startMcpOauth(id) {
        return api.startMcpOauth(id);
      },
      async disconnectMcpOauth(id) {
        await api.disconnectMcpOauth(id);
        set({ mcpServers: get().mcpServers.map((x) => (x.id === id ? { ...x, oauthStatus: "unconfigured" } : x)) });
      },
      applyMcpServerStatus({ id, status, oauthStatus }) {
        // Both holders of `mcp.list` rows: the settings sheet's list and the plus-menu's per-space
        // cache. One patch for both, or an open Connectors submenu would show yesterday's dot.
        const patch = (x: McpServer) => (x.id === id ? { ...x, status, oauthStatus } : x);
        set({ mcpServers: get().mcpServers.map(patch),
          connectors: Object.fromEntries(Object.entries(get().connectors).map(([sid, list]) => [sid, list.map(patch)])) });
      },
      async openActivity() {
        // Always opens showing everything (binding rule 5) — a filter left over from a previous visit
        // would silently hide rows the user has no reason to expect are being hidden.
        set({ mcpCallsFilter: {}, mcpCalls: [], mcpCallsHasMore: false, sheet: { kind: "activity" }, paletteOpen: false });
        await get().refreshMcpCalls();
      },
      async refreshMcpCalls() {
        // Captured before the await, per refreshMcpServers's isSpace(sid) idiom: `want` is the filter
        // THIS fetch is answering. Reference equality is enough to detect a newer one superseding it —
        // setMcpCallsFilter and openActivity always replace `mcpCallsFilter` with a new object rather
        // than mutating it in place, so two chip clicks in quick succession never share a reference.
        const want = get().mcpCallsFilter;
        const { calls } = await api.mcpCallsList({ ...want, limit: MCP_CALLS_PAGE });
        // The sheet may have closed, or a later filter change may have already started its own fetch,
        // while this one was in flight — a slow response landing after the fact must not clobber
        // whatever the CURRENT filter's fetch put there (or is still waiting to put there).
        if (get().sheet?.kind !== "activity" || get().mcpCallsFilter !== want) return;
        set({ mcpCalls: calls, mcpCallsHasMore: calls.length === MCP_CALLS_PAGE });
      },
      async loadMoreMcpCalls() {
        const last = get().mcpCalls.at(-1);
        if (!last) return; // nothing loaded yet — Load more has nothing to page after
        const want = get().mcpCallsFilter; // same supersession guard as refreshMcpCalls, same reason
        const { calls } = await api.mcpCallsList({ ...want, before: { ts: last.ts, id: last.id }, limit: MCP_CALLS_PAGE });
        if (get().sheet?.kind !== "activity" || get().mcpCallsFilter !== want) return;
        set({ mcpCalls: [...get().mcpCalls, ...calls], mcpCallsHasMore: calls.length === MCP_CALLS_PAGE });
      },
      async setMcpCallsFilter(patch) {
        const next: McpCallsFilter = { ...get().mcpCallsFilter };
        if ("sessionId" in patch) { if (patch.sessionId) next.sessionId = patch.sessionId; else delete next.sessionId; }
        if ("serverId" in patch) { if (patch.serverId) next.serverId = patch.serverId; else delete next.serverId; }
        set({ mcpCallsFilter: next });
        // Paging respects the filter (plan requirement), so a filter change re-fetches from the top
        // rather than filtering the already-loaded page client-side.
        await get().refreshMcpCalls();
      },
      applyMcpCall(call) {
        // Nothing is collecting while the sheet is shut — the next openActivity re-fetches anyway, so
        // growing this array for a view nobody has open is work for nothing (mirrors checkpoints.changed).
        if (get().sheet?.kind !== "activity") return;
        if (get().mcpCalls.some((c) => c.id === call.id)) return; // the event can repeat (binding rule 6)
        const { sessionId, serverId } = get().mcpCallsFilter;
        if (sessionId && call.sessionId !== sessionId) return;
        if (serverId && call.serverId !== serverId) return;
        const next = [call, ...get().mcpCalls];
        // Cap enforced ONLY here — see MCP_CALLS_LIVE_CAP's doc comment for why loadMoreMcpCalls doesn't.
        const trimmed = next.length > MCP_CALLS_LIVE_CAP;
        set({
          mcpCalls: trimmed ? next.slice(0, MCP_CALLS_LIVE_CAP) : next,
          // Trimming the tail evicts real rows from memory, not from the log — they are still fetchable
          // by paging further back. That has to re-arm "Load more" even if the page that loaded them
          // had already reported hasMore:false, or those rows would simply vanish with no way back.
          ...(trimmed ? { mcpCallsHasMore: true } : {}),
        });
      },
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
/** The active profile's spaces, memoised. `profileSpaces()` itself allocates a fresh array on every
 *  call, so passing it straight to `useApp` would hand React a new snapshot on every unrelated store
 *  write; the two inputs it actually depends on are stable. */
export function useProfileSpaces(): Space[] {
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  return useMemo(() => {
    const profileId = spaces.find((s) => s.id === activeSpaceId)?.profileId;
    return profileId === undefined ? [] : spaces.filter((s) => s.profileId === profileId);
  }, [spaces, activeSpaceId]);
}
/** The raw store, for imperative access (hotkeys, event subscriptions). */
export function useAppStore(): StoreApi<AppState> {
  const store = useContext(StoreContext); if (!store) throw new Error("StoreContext missing");
  return store;
}
/** The store or null — for components that unit tests also render bare (Menu, BrowserPane) and
 *  that must degrade to "no store" instead of throwing. */
export function useAppStoreMaybe(): StoreApi<AppState> | null {
  return useContext(StoreContext);
}
const NO_RECTS: BrowserRect[] = [];
/** `browserRects[]` for the two floating-surface primitives; [] outside the provider (bare unit
 *  tests) — which reproduces the pre-W2 placement exactly. */
export function useBrowserRects(): BrowserRect[] {
  const store = useContext(StoreContext);
  const subscribe = useCallback((cb: () => void) => (store ? store.subscribe(cb) : () => {}), [store]);
  return useSyncExternalStore(subscribe, () => (store ? store.getState().browserRects : NO_RECTS));
}
