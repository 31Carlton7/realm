import { createStore, useStore, type StoreApi } from "zustand";
import {
  allItems, closeItem as layoutClose, emptyLayout, findLeafOfItem, firstLeaf, gridPreset, itemIdOfLeaf, openItem as layoutOpen, splitLeaf, updateSizes, AgentKindSchema, LayoutSchema, PLAN_PERMISSION_MODE,
  basenameOf, formatAttachmentSize, MAX_ATTACHMENT_BYTES, mimeForPath,
  type AgentKind, type Attachment, type Checkpoint, type DiffSummary, type Environment, type FileDiff, type GitInfo, type Item, type Layout, type MethodResult, type PresetName, type Profile, type Project, type RestorePreview, type RestoreResult, type Session, type SessionMode, type SessionStatus, type ShipResult, type Space, type StoredSessionEvent, type WorktreeAck, type WorktreeStatus,
} from "@realm/contracts";
import { createContext, useContext } from "react";
import type { ThemePref } from "../theme/useTheme";
import { emptyTranscript, reduceTranscript, type Transcript } from "../panes/session/transcript-model";

export type CreateSpaceInput = { name: string; icon: string; profileId: string; color?: string };
export type UpdateSpaceInput = { id: string; name?: string; icon?: string; color?: string; profileId?: string };
export type UpdateItemInput = { id: string; title?: string; pinned?: boolean };
export type CreateSessionInput = { spaceId: string; agentKind: AgentKind; projectId?: string | null; environmentId?: string | null; model?: string | null; effort?: string | null; permissionMode?: string; title?: string };
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
export type AgentProbe = MethodResult<"agents.probe">[number];
/** A `session.event` broadcast: persisted rows carry their seq; ephemeral ones (deltas) have seq -1. */
export type LiveSessionEvent = StoredSessionEvent & { ephemeral: boolean };
export type TranscriptEntry = { lastSeq: number; t: Transcript };

/** Everything the store needs from the outside world: realm-server RPC plus the two platform
 *  seams (native folder picker, local terminal disposal). Tests substitute a fake. */
export type Api = {
  listProfiles(): Promise<Profile[]>;
  /** Icon/color are server defaults (`user` / grey) — the sheet only asks for a name. */
  createProfile(name: string): Promise<Profile>;
  /** Global list across all profiles, in user sort order. */
  listSpaces(): Promise<Space[]>;
  listItems(spaceId: string): Promise<Item[]>;
  /** Every item across every space, newest-updated first (command palette search). */
  listAllItems(): Promise<Item[]>;
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
  createTerminal(spaceId: string): Promise<{ terminalId: string; itemId: string }>;
  updateItem(input: UpdateItemInput): Promise<Item>;
  /** Deleting a terminal item closes its pty server-side. */
  deleteItem(id: string): Promise<void>;
  getSetting(key: string): Promise<unknown>;
  setSetting(key: string, value: unknown): Promise<void>;
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
  listSessions(spaceId: string): Promise<Session[]>;
  /** Every session across every space (sessionId→spaceId map for cross-space badges). */
  listAllSessions(): Promise<Session[]>;
  getSession(id: string): Promise<Session>;
  createSession(input: CreateSessionInput): Promise<{ session: Session; itemId: string }>;
  sendMessage(id: string, text: string, attachments: Attachment[]): Promise<void>;
  interruptSession(id: string): Promise<void>;
  respondPermission(id: string, requestId: string, decision: PermissionDecision): Promise<void>;
  setSessionOptions(id: string, o: SessionOptions): Promise<Session>;
  /** `sessions.setAgent` — rejected by the server once the session has any event. */
  setSessionAgent(id: string, agentKind: AgentKind): Promise<Session>;
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
};

/** What the diff pane sends to `workspace.ship`. `cwd` is the environment's checkout. */
export type ShipInput = { cwd: string; commit: boolean; message: string; push: boolean; setUpstream: boolean; openPr: boolean };

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

export const PERSIST_DEBOUNCE_MS = 300;
export const SETTING_ACTIVE_SPACE = "ui.activeSpaceId";
export const SETTING_THEME = "ui.theme";
/** Agent of the most recent session the user created or switched to — what "+"/⌘N reach for next. */
export const SETTING_LAST_AGENT = "ui.lastAgentKind";
const SETTING_SWIPE_INVERT = "ui.swipeInvert";
/** Per-session terminal-panel state (open + width), keyed by session id. */
export const SETTING_TERMINAL_PANEL = "ui.terminalPanel";
export const EVENTS_PAGE = 1000;
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

/** Sessions are never created through a sheet (W3): "+"/⌘N/palette create one instantly and every
 *  choice lives on the prompter's chips. What remains here is genuinely form-shaped. */
export type Sheet =
  | { kind: "space-settings"; spaceId: string }
  | { kind: "new-space" }
  /** Removing a worktree: the one destructive confirm in Plan 7, which must name what would be lost
   *  and pass an acknowledgement it re-read at the moment of confirming (W3). */
  | { kind: "remove-worktree"; environmentId: string }
  /** A checkout's checkpoints, and the confirm for restoring one (W4). One sheet in two states: the
   *  list, and — once `selected` is set — the confirmation naming exactly what restoring would cost. */
  | { kind: "checkpoints"; environmentId: string; sessionId: string | null };

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
  items: Item[]; layout: Layout | null;
  /** Items across every space (palette search); refreshed when the palette opens. */
  allItems: Item[];
  /** Agent of the last session created or switched to, persisted across launches; null until one exists
   *  (then instant-create falls back to FALLBACK_AGENT). */
  lastAgentKind: AgentKind | null;
  /** Arms the inline rename of the pane showing this item (palette → PanelBar seam). */
  renamingItemId: string | null;
  /** The leaf pane that has focus (pane clicks, open/split target). Reset to the first leaf whenever the
   *  layout no longer contains it. */
  focusedLeafId: string | null;
  projects: Project[];
  /** The active space's environments, by id — what tells the prompter a session is in a worktree.
   *  Sparse by design: a space that has never run anything has none until one is created. */
  environments: Record<string, Environment>;
  error: string | null;
  /** Socket health, mirrored from RpcClient.onStatusChange. "reconnecting" shows the banner. */
  connectionState: "connected" | "reconnecting";
  paletteOpen: boolean;
  sheet: Sheet | null;
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
  agentProbe: AgentProbe[];
  /** Composer drafts by session id — store-owned so layout reshapes/pane remounts never lose typed
   *  text (A-M9). Never persisted; dropped when the session's item is deleted. */
  drafts: Record<string, string>;
  /** Pending attachments by session id. Store-owned for exactly the reason drafts are: they are part of
   *  the draft, and a pane remount must not silently drop the file the user just dragged in. Cleared by
   *  a successful send, and with the session's item. */
  pendingAttachments: Record<string, PickedAttachment[]>;
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
  /** `environments.worktreeStatus` by environment id — what the removal sheet shows. */
  worktreeStatuses: Record<string, WorktreeStatus>;
  /** Set when a confirmed removal's re-read disagreed with the numbers the user was shown: the sheet
   *  says the tree moved and asks again rather than acknowledging a count nobody saw. */
  worktreeAckStale: string | null;
  /** `checkpoints.list` by environment id (W4). Absent = never asked. */
  checkpoints: Record<string, Checkpoint[]>;
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
  activeSpace(): Space | undefined;
  activeIndex(): number;
  boot(): Promise<void>;
  selectSpace(id: string): Promise<void>;
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
  refreshSpaces(): Promise<void>;
  refreshItems(): Promise<void>;
  refreshAllItems(): Promise<void>;
  refreshProjects(): Promise<void>;
  refreshEnvironments(): Promise<void>;
  linkProject(rootPath: string): Promise<void>;
  pickAndLinkProject(): Promise<void>;
  newTerminal(targetLeafId?: string | null): Promise<void>;
  updateItem(input: UpdateItemInput): Promise<void>;
  /** Open an item into `leafId` ?? the focused leaf ?? the first leaf, replacing what it held (the
   *  replaced item returns to the SPACE group); focuses that leaf. With no explicit `leafId`, an
   *  already-open item is only focused (click = go there) — layout untouched, nothing persisted. */
  openItem(itemId: string, leafId?: string | null): Promise<void>;
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
  /** Move pane focus to the structural neighbor in that direction (see neighborLeafId); no-op without one. */
  focusNeighbor(dir: FocusDir): void;
  applyPreset(name: PresetName): Promise<void>;
  /** Functional sizes update for one split; persisted with a trailing debounce. No-op if unchanged.
   *  Until the active space's items have loaded, sizes apply locally but never persist — PanelGroup
   *  fires onLayout at mount with normalized sizes, and that echo is not a user action. */
  resizeSplit(splitId: string, sizes: number[]): void;
  /** Flush a pending debounced layout persist immediately — wired to `pagehide` (A-M4): a resize inside
   *  the debounce window of quitting would otherwise never reach the server. No-op when nothing is pending. */
  flushPersist(): Promise<void>;
  /** On the reconnecting→connected edge, runs a boot-lite refresh (spaces/items/sessions) and catches
   *  every open transcript up from its lastSeq — the events missed while the socket was down. */
  applyConnectionState(state: "connected" | "reconnecting"): void;
  setPaletteOpen(open: boolean): void;
  openSheet(sheet: Sheet): void;
  closeSheet(): void;
  refreshSessions(): Promise<void>;
  /** Seed sessionSpace + statuses for every space (boot, reconnect, unknown-session broadcasts). */
  refreshAllSessions(): Promise<void>;
  /** Jump to a waiting_permission session anywhere: switch space if needed, open its item, focus it. */
  jumpToPermission(): Promise<void>;
  /** Load (or catch up) a session's transcript: fetch events after the last known seq and reduce them. */
  openSession(id: string): Promise<void>;
  applySessionEvent(ev: LiveSessionEvent): void;
  applySessionStatus(sessionId: string, status: SessionStatus): void;
  /** Create a session in the active space, open its item, and open its transcript. */
  newSession(input: Omit<CreateSessionInput, "spaceId">, targetLeafId?: string | null): Promise<void>;
  /** The one instant-create path behind "+", ⌘N and the palette's plain "New session" (W3): no
   *  questions — last-used agent (else FALLBACK_AGENT), the space's own folder, adapter-default model
   *  and permission mode. Everything else is changed on the prompter's chips afterwards. */
  newSessionInstant(targetLeafId?: string | null): Promise<void>;
  /** Make a fresh `git worktree` and open a session in it (W2), rather than in the space folder.
   *  Fails loudly when the space is not a git repository — there is no worktree to fall back to,
   *  and silently landing in the space folder would be the collision the user asked to avoid. */
  newSessionInWorktree(targetLeafId?: string | null): Promise<void>;
  /** Arm (or with null, disarm) inline rename for the pane holding this item. */
  requestRename(itemId: string | null): void;
  sendMessage(id: string, text: string): Promise<void>;
  interruptSession(id: string): Promise<void>;
  respondPermission(id: string, requestId: string, decision: PermissionDecision): Promise<void>;
  setSessionOptions(id: string, o: SessionOptions): Promise<void>;
  /** Move a session between Build and Plan (the prompter's mode chip), parking and restoring the
   *  permission mode around the trip. See the implementation for why the parking is necessary. */
  setSessionMode(id: string, mode: SessionMode): Promise<void>;
  /** Switch an unstarted session's agent (prompter model picker). The server refuses once events exist —
   *  cross-agent rows go unavailable there, so this is only ever called while it is legal. */
  setSessionAgent(id: string, agentKind: AgentKind): Promise<void>;
  /** Refresh `agentProbe`. Unforced calls (prompter mount, onboarding) ride the server's TTL cache and
   *  are deduped here too; `force` is the install card's "Check again" and its window-focus refresh. */
  probeAgents(force?: boolean): Promise<void>;
  /** Remember the agent a fresh session should use (onboarding's default-agent pick). Same setting the
   *  prompter's agent chip writes, so the two never disagree. */
  setDefaultAgent(kind: AgentKind): Promise<void>;
  /** Show the session's terminal panel and TYPE `command` into it, without a trailing newline: Realm
   *  offers the command, the user presses Return. Nothing here ever runs an installer. */
  prefillTerminal(sessionId: string, command: string): Promise<void>;
  setDraft(sessionId: string, text: string): void;
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
  /** Open the removal confirmation for a worktree, reading its cost first. */
  askRemoveWorktree(environmentId: string): Promise<void>;
  /** Confirm it: re-read the cost, and remove ONLY if it still matches what the user was shown. */
  confirmRemoveWorktree(environmentId: string): Promise<void>;
  /** Open the checkpoint sheet for a checkout, listing that session's turns (or all of them). */
  openCheckpoints(environmentId: string, sessionId?: string | null): Promise<void>;
  /** Re-list without opening anything — what the `checkpoints.changed` broadcast triggers. */
  refreshCheckpoints(environmentId: string, sessionId: string | null): Promise<void>;
  /** Move the sheet from its list state into its confirm state, with a freshly read preview. */
  askRestoreCheckpoint(id: string): Promise<void>;
  /** Back to the list, forgetting the preview. */
  cancelRestoreCheckpoint(): void;
  confirmRestoreCheckpoint(id: string): Promise<void>;
  /** `checkpoints.capture` — a point the user asked for, next to the ones every turn takes. */
  captureCheckpoint(environmentId: string, sessionId: string | null): Promise<void>;
  /** Run an action, surfacing any rejection in `error` (and console.error). Use at UI call sites. */
  run(action: () => Promise<unknown>): void;
  clearError(): void;
};

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

/** The id of the empty leaf sitting next to `leafId` in its immediate split, if any — i.e. the leaf a
 *  fresh `splitLeaf(..., null)` just created. Only direct siblings count. */
export function findEmptySiblingOf(l: Layout, leafId: string): string | null {
  if (l.type === "leaf") return null;
  if (l.children.some((c) => c.type === "leaf" && c.id === leafId)) {
    const empty = l.children.find((c) => c.type === "leaf" && c.id !== leafId && c.itemId === null);
    return empty?.id ?? null;
  }
  for (const c of l.children) { const f = findEmptySiblingOf(c, leafId); if (f) return f; }
  return null;
}

/** After `splitLeaf` created a split whose two children are leaves — the original `leafId` and the leaf
 *  now holding `itemId` — swap the two children's itemIds (drag-to-split onto the near edge). Applies
 *  only to a split whose direct children are both leaves matching the pair, which is always true for a
 *  freshly created split; grandchildren and unrelated splits are never touched. */
export function swapSplitChildrenOf(l: Layout, leafId: string, itemId: string): Layout {
  if (l.type === "leaf") return l;
  const [a, b] = l.children;
  if (l.children.length === 2 && a?.type === "leaf" && b?.type === "leaf" &&
      ((a.id === leafId && b.itemId === itemId) || (b.id === leafId && a.itemId === itemId))) {
    return { ...l, children: [{ ...a, itemId: b.itemId }, { ...b, itemId: a.itemId }] };
  }
  return { ...l, children: l.children.map((c) => swapSplitChildrenOf(c, leafId, itemId)) };
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

function findSplitSizes(l: Layout, splitId: string): number[] | null {
  if (l.type === "leaf") return null;
  if (l.id === splitId) return l.sizes;
  for (const c of l.children) { const s = findSplitSizes(c, splitId); if (s) return s; }
  return null;
}
const sameSizes = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) < 0.01);
const isThemePref = (x: unknown): x is ThemePref => x === "system" || x === "light" || x === "dark";

/** Forget both sides of every named path in one checkout — what staging or unstaging invalidates. */
function dropPatches(patches: Record<string, FileDiff>, cwd: string, paths: string[]): Record<string, FileDiff> {
  const doomed = new Set(paths.flatMap((p) => [patchKey(cwd, p, true), patchKey(cwd, p, false)]));
  return Object.fromEntries(Object.entries(patches).filter(([k]) => !doomed.has(k)));
}

export function createAppStore(api: Api): StoreApi<AppState> {
  return createStore<AppState>((set, get) => {
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    /** Monotonic id for fetches of the active space's items. Reconcile is destructive (it prunes open
     *  items missing from the list), so only the newest-started fetch may apply: the Api makes no
     *  ordering promise, and a response snapshotted before a concurrent item creation would otherwise
     *  prune the just-opened item and collapse its splits. Bumped by selectSpace so responses from a
     *  previous activation die even when the same space is re-selected. */
    let itemsFetchSeq = 0;
    /** False from selectSpace until the space's items have loaded and reconciled once. While false,
     *  resizeSplit applies sizes locally but must not persist: react-resizable-panels fires onLayout at
     *  mount with normalized sizes, and that echo is not a user action — persisting it would write the
     *  layout mid-boot (and cement whatever transient state the layout is in). */
    let layoutHydrated = false;
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
    /** Flush a pending debounced persist before the active space changes (persist reads the current space). */
    const flushPersist = async () => {
      if (panelTimer) await persistPanels();
      if (persistTimer) await persist();
    };
    const isSpace = (sid: string) => get().activeSpaceId === sid;
    const mergeSpace = (s: Space) => set({ spaces: get().spaces.map((x) => (x.id === s.id ? s : x)) });
    const mergeSession = (s: Session) => set({ sessions: { ...get().sessions, [s.id]: s }, sessionStatus: { ...get().sessionStatus, [s.id]: s.status } });
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
    const dropTranscript = (id: string) => { const { [id]: _gone, ...rest } = get().transcripts; set({ transcripts: rest }); };
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
    /** Focus keeps its leaf while the layout still has it; otherwise it resets to the first leaf. */
    const focusIn = (layout: Layout) => {
      const f = get().focusedLeafId;
      return f && hasLeafIn(layout, f) ? f : firstLeaf(layout).id;
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
    const adoptItem = async (sid: string, itemId: string, targetLeafId: string | null) => {
      const seq = ++itemsFetchSeq;
      const items = await api.listItems(sid);
      if (!isSpace(sid)) return;
      if (seq === itemsFetchSeq) set({ items }); // superseded by a newer fetch? its list is newer — keep it
      await get().openItem(itemId, targetLeafId);
    };

    return {
      booted: false,
      profiles: [], spaces: [], activeSpaceId: null, themePref: "system", swipeInvert: false, items: [], layout: null, focusedLeafId: null, projects: [], environments: {}, error: null,
      allItems: [], lastAgentKind: null, renamingItemId: null,
      connectionState: "connected",
      paletteOpen: false, sheet: null,
      sessions: {}, sessionStatus: {}, sessionSpace: {}, transcripts: {}, agentProbe: [], drafts: {}, pendingAttachments: {}, planReturn: {}, gitInfo: {},
      diffs: {}, diffLoading: {}, patches: {}, commitMessages: {}, shipResults: {}, shipping: {},
      worktreeStatuses: {}, worktreeAckStale: null,
      checkpoints: {}, checkpointPreview: null, checkpointAckStale: false, restoreResult: null,
      terminalPanel: {}, sessionTerminals: {},

      activeSpace() { const id = get().activeSpaceId; return id ? get().spaces.find((s) => s.id === id) : undefined; },
      activeIndex() { const id = get().activeSpaceId; return id ? get().spaces.findIndex((s) => s.id === id) : -1; },

      async boot() {
        const [profiles, spaces, saved, theme, swipeInvert, lastAgent, panels] = await Promise.all([
          api.listProfiles(), api.listSpaces(), api.getSetting(SETTING_ACTIVE_SPACE), api.getSetting(SETTING_THEME), api.getSetting(SETTING_SWIPE_INVERT), api.getSetting(SETTING_LAST_AGENT),
          api.getSetting(SETTING_TERMINAL_PANEL),
        ]);
        const agent = AgentKindSchema.safeParse(lastAgent);
        set({ profiles, spaces, themePref: isThemePref(theme) ? theme : "system", swipeInvert: swipeInvert === true, lastAgentKind: agent.success ? agent.data : null,
          terminalPanel: parseTerminalPanels(panels) });
        const target = spaces.find((s) => s.id === saved) ?? spaces[0];
        if (target) await get().selectSpace(target.id);
        // Cross-space badges need every session's space + status, not just the active space's.
        await get().refreshAllSessions();
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
        set({ activeSpaceId: id, layout: seedLayout(space?.layout ?? null), focusedLeafId: null, items: [], projects: [], environments: {}, sessions: {}, error: null,
          diffs: {}, diffLoading: {}, patches: {} });
        get().run(() => api.setSetting(SETTING_ACTIVE_SPACE, id));
        await Promise.all([get().refreshProjects(), get().refreshEnvironments(), get().refreshItems(), get().refreshSessions()]);
        // Space activation refreshes git context for the focused pane's session, if any.
        const focusedItem = get().items.find((i) => i.id === itemIdOfLeaf(get().layout, get().focusedLeafId));
        if (focusedItem?.kind === "session") refreshGitFor(focusedItem.refId);
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
          else set({ activeSpaceId: null, items: [], layout: null, focusedLeafId: null, projects: [] });
        }
      },
      async refreshItems() {
        const sid = get().activeSpaceId; if (!sid) return;
        const seq = ++itemsFetchSeq;
        const items = await api.listItems(sid);
        if (!isSpace(sid) || seq !== itemsFetchSeq) return; // space changed, or a newer fetch owns the truth
        const layout = reconcileLayout(get().layout, items);
        layoutHydrated = true;
        set({ items, layout, focusedLeafId: focusIn(layout) });
      },
      async refreshAllItems() {
        set({ allItems: await api.listAllItems() });
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
        else set({ activeSpaceId: null, items: [], layout: null, focusedLeafId: null, projects: [] });
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
      async updateItem(input) {
        const sid = get().activeSpaceId;
        const it = await api.updateItem(input);
        if (sid && isSpace(sid)) set({ items: get().items.map((x) => (x.id === it.id ? it : x)) });
      },
      async openItem(itemId, leafId = null) {
        const current = get().layout ?? emptyLayout();
        // Activation without an explicit target (sidebar OPEN row, palette, pinned grid) of an item
        // that is already open means "go there": focus its pane, touch nothing, persist nothing.
        // Move semantics belong to gestures that name a leaf — drag-to-center via openItemAt.
        if (leafId === null) {
          const open = findLeafOfItem(current, itemId);
          if (open) { set({ focusedLeafId: open.id }); return; }
        }
        const target = leafId ?? get().focusedLeafId;
        const layout = layoutOpen(current, target, itemId);
        const leaf = findLeafOfItem(layout, itemId);
        set({ layout, focusedLeafId: leaf?.id ?? null });
        await persist();
      },
      async closeFromLayout(itemId) {
        const layout = layoutClose(get().layout ?? emptyLayout(), itemId);
        set({ layout, focusedLeafId: focusIn(layout) });
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
        set({ items: get().items.filter((i) => i.id !== itemId) });
        if (it?.kind === "terminal") api.disposeTerminal(it.refId);
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
          set({ sessionStatus, sessions, drafts, pendingAttachments, planReturn, sessionSpace, terminalPanel, sessionTerminals });
          if (termId || _tp) get().run(persistPanels); // the panel map just lost an entry
        }
      },
      async splitFocused(dir) {
        const l = get().layout ?? emptyLayout();
        const target = focusIn(l);
        const layout = splitLeaf(l, target, dir, null);
        const fresh = findEmptySiblingOf(layout, target);
        set({ layout, focusedLeafId: fresh ?? target });
        await persist();
      },
      async openItemAt(itemId, leafId, edge) {
        // Self-drop: the item already occupies the target leaf. Splitting would first close the item
        // (pruning that very leaf) and teleport it to the far side; replacing is a no-op anyway.
        if (findLeafOfItem(get().layout ?? emptyLayout(), itemId)?.id === leafId) return;
        if (edge === "center") return get().openItem(itemId, leafId);
        const dir = edge === "left" || edge === "right" ? "row" : "col";
        let layout = splitLeaf(get().layout ?? emptyLayout(), leafId, dir, itemId);
        if (edge === "left" || edge === "top") layout = swapSplitChildrenOf(layout, leafId, itemId);
        const leaf = findLeafOfItem(layout, itemId);
        set({ layout, focusedLeafId: leaf?.id ?? null });
        await persist();
      },
      focusLeaf(leafId) { set({ focusedLeafId: leafId }); },
      focusNeighbor(dir) {
        const { layout, focusedLeafId } = get();
        if (!layout || !focusedLeafId) return;
        const next = neighborLeafId(layout, focusedLeafId, dir);
        if (next) set({ focusedLeafId: next });
      },
      async applyPreset(name) {
        const layout = gridPreset(name, get().items.map((i) => i.id));
        set({ layout, focusedLeafId: firstLeaf(layout).id });
        await persist();
      },
      resizeSplit(splitId, sizes) {
        const l = get().layout; if (!l) return;
        const current = findSplitSizes(l, splitId);
        if (!current || sameSizes(current, sizes)) return;
        set({ layout: updateSizes(l, splitId, sizes) });
        if (layoutHydrated) schedulePersist(); // pre-hydration resizes are mount echoes, not user actions
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
      setPaletteOpen(open) { set(open ? { paletteOpen: true, sheet: null } : { paletteOpen: false }); },
      openSheet(sheet) { set({ sheet, paletteOpen: false }); },
      closeSheet() { set({ sheet: null }); },
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
      async jumpToPermission() {
        const waiting = Object.entries(get().sessionStatus).filter(([, st]) => st === "waiting_permission").map(([id]) => id);
        if (waiting.length === 0) return;
        // Prefer one in the active space (no context switch); otherwise the first known anywhere.
        const active = get().activeSpaceId;
        const sid = waiting.find((id) => (get().sessionSpace[id] ?? get().sessions[id]?.spaceId) === active) ?? waiting[0]!;
        const spaceId = get().sessionSpace[sid] ?? get().sessions[sid]?.spaceId;
        if (spaceId && spaceId !== get().activeSpaceId) await get().selectSpace(spaceId);
        const item = get().items.find((i) => i.kind === "session" && i.refId === sid);
        if (item) await get().openItem(item.id); // opens into the focused leaf and focuses it
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
          refreshGitFor(id); // opening a session refreshes its cwd's git context
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
        const prev = get().sessionStatus[sessionId];
        const s = get().sessions[sessionId];
        set({ sessionStatus: { ...get().sessionStatus, [sessionId]: status }, ...(s ? { sessions: { ...get().sessions, [sessionId]: { ...s, status } } } : {}) });
        // A broadcast for a session we can't place (created in another window/space since the last
        // list): fetch the map so its space can wear the badge.
        if (!get().sessionSpace[sessionId]) get().run(() => get().refreshAllSessions());
        // A turn just finished (or died): the working tree likely changed, so refresh git context.
        if (prev !== status && (status === "idle" || status === "error")) refreshGitFor(sessionId);
      },
      async newSession(input, targetLeafId = null) {
        const sid = get().activeSpaceId; if (!sid) return;
        const { session, itemId } = await api.createSession({ ...input, spaceId: sid });
        rememberAgent(input.agentKind);
        if (isSpace(sid)) mergeSession(session);
        await adoptItem(sid, itemId, targetLeafId);
        await get().openSession(session.id);
      },
      async newSessionInstant(targetLeafId = null) {
        await get().newSession({ agentKind: get().lastAgentKind ?? FALLBACK_AGENT }, targetLeafId);
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
      /**
       * The one path attachments travel. The prompter never passes them in — it cannot forget to, and
       * cannot pass a chip the user already removed, because the list is read here from the same state
       * the chip row renders.
       */
      async sendMessage(id, text) {
        const pending = get().pendingAttachments[id] ?? [];
        await api.sendMessage(id, text, pending.map(({ path, mime }) => ({ path, mime })));
        // Only AFTER the send lands, and only the ones that went: a rejected send that also emptied the
        // chip row would leave the user with no record of what they had attached, and a file dragged in
        // while the request was in flight was never part of this message.
        if (pending.length === 0) return;
        const sent = new Set(pending.map((a) => a.path));
        const left = (get().pendingAttachments[id] ?? []).filter((a) => !sent.has(a.path));
        set({ pendingAttachments: { ...get().pendingAttachments, [id]: left } });
      },
      async interruptSession(id) { await api.interruptSession(id); },
      async respondPermission(id, requestId, decision) { await api.respondPermission(id, requestId, decision); },
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
        if (mode === "plan") {
          if (inPlan) return;
          set({ planReturn: { ...get().planReturn, [id]: s.permissionMode } });
          await get().setSessionOptions(id, { permissionMode: PLAN_PERMISSION_MODE });
        } else {
          if (!inPlan) return;
          const back = get().planReturn[id] ?? "default";
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
      setDraft(sessionId, text) { set({ drafts: { ...get().drafts, [sessionId]: text } }); },
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
        if (existing) { await get().openItem(existing.id, targetLeafId); return; }
        const title = env.branch ?? env.path.replace(/\/+$/, "").split("/").pop() ?? "Changes";
        const created = await api.createItem(sid, "diff", `Changes · ${title}`, environmentId);
        await adoptItem(sid, created.id, targetLeafId);
      },
      async askRemoveWorktree(environmentId) {
        const status = await api.worktreeStatus(environmentId);
        set({ worktreeStatuses: { ...get().worktreeStatuses, [environmentId]: status }, worktreeAckStale: null,
          sheet: { kind: "remove-worktree", environmentId }, paletteOpen: false });
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
        set({ worktreeStatuses, worktreeAckStale: null, sheet: null });
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
          sheet: { kind: "checkpoints", environmentId, sessionId }, paletteOpen: false,
        });
      },
      async refreshCheckpoints(environmentId, sessionId) {
        const list = await api.listCheckpoints(environmentId, sessionId);
        set({ checkpoints: { ...get().checkpoints, [environmentId]: list } });
      },
      async captureCheckpoint(environmentId, sessionId) {
        await api.captureCheckpoint(environmentId, sessionId);
        await get().refreshCheckpoints(environmentId, sessionId);
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
