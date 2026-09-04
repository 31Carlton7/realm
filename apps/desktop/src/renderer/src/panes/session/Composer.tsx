import { AGENT_META, AGENT_SUPPORTS_ASK_MODE, AGENT_SUPPORTS_PERMISSION_MODES, DEFAULT_MODEL_LABEL, SELECTABLE_AGENT_KINDS, AGENT_SUPPORTS_PLAN_MODE, EFFORT_LEVELS, PERMISSION_MODES, SESSION_MODES, acpAskMode, acpPlanMode, sessionModeOf, attachmentDisposition, attachmentNote, attachmentSummary, formatAttachmentSize, type AcpSessionMode, type AgentKind, type Environment, type GitInfo, type McpServer, type ModelInfo, type Session, type SessionMode, type SessionStatus, type Skill } from "@realm/contracts";
import { Icon, type IconName } from "@realm/ui";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Menu, type MenuItem } from "../../components/Menu";
import type { AgentProbe, PickedAttachment, SessionOptions, SubmitKey } from "../../state/store";
import { agentAvailability, availabilityNote } from "../../state/agent-availability";
import { MentionPicker, filterMentionSkills, mentionQueryAt } from "./MentionPicker";
import { modelIdOn, modelRows } from "./model-rows";
import { SkillPicker } from "./SkillPicker";
import { ModelPicker, formatEffort, type OverflowGroup } from "./ModelPicker";
import { SUGGESTIONS } from "./suggestions";
import { heroGreeting } from "./greeting";
import { continueList, highlightSegments, indentList, toggleList, type DraftEdit } from "./draft-format";
import { AttachmentTile } from "./AttachmentTile";

// ~10 lines of 15px/1.55 plus the vertical padding (Ara refresh §1 raises the input to 15px; §4:
// autogrows to 10 lines). Matches .composer-input's max-height in styles.css.
const MAX_ROWS_PX = 254;

/** Session ids whose suggestion chips already played their stagger-in. Module-level on purpose:
 *  §4 says "never re-animate on revisit", and pane-slot keying remounts this component on every
 *  tab-back — a mount-scoped flag would replay. Lives for the app run; a fresh launch replays once. */
const staggerPlayed = new Set<string>();

/** Branch + diff chips (W3): still the one way IN to the diff pane. The cwd and environment chips
 *  that used to lead this group are retired outright (prompter rework): the folder and the checkout
 *  are named by the sidebar and the diff pane, and neither earned a permanent seat on the row. The
 *  diff and dirty counts hide themselves at zero — an all-clean repo shows just the branch. */
function GitChip({ gitInfo, onOpenDiff }: { gitInfo: GitInfo | null; onOpenDiff: () => void }) {
  if (!gitInfo) return null;
  return (
    // One button, not three — the whole group means "show me these changes".
    <button type="button" className="composer-git" onClick={onOpenDiff}
      title={gitInfo.dirty > 0 ? `Show ${gitInfo.dirty} changed ${gitInfo.dirty === 1 ? "file" : "files"} on ${gitInfo.branch}` : `Show changes on ${gitInfo.branch}`}>
      <span className="ghost-chip git-branch"><Icon name="branch" size={13} className="chip-brand" /><span className="chip-label">{gitInfo.branch}</span></span>
      {(gitInfo.additions > 0 || gitInfo.deletions > 0) && (
        <span className="ghost-chip git-diff">
          <span className="diff-add">+{gitInfo.additions}</span>
          <span className="diff-del">−{gitInfo.deletions}</span>
        </span>
      )}
      {gitInfo.dirty > 0 && <span className="ghost-chip git-dirty">{gitInfo.dirty} changed</span>}
    </button>
  );
}

/** Borderless ghost chip that opens an upward Menu (§4 control row). With nothing to pick it is not a
 *  control at all but a label — an agent whose CLI owns model choice still deserves its model named,
 *  and a disabled button would leave the tab order and be announced as unavailable. */
function ChipMenu({ ariaLabel, title, label, icon, items, warning }: { ariaLabel: string; title?: string; label: ReactNode; icon?: string; items: MenuItem[]; warning?: boolean }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // A sibling of chip-label, never inside it: chip-label truncates with an ellipsis, which needs a
  // plain inline box — an icon nested in there gets no gap and sits off the text's centre line.
  const glyph = icon ? <Icon name={icon} size={13} className="chip-brand" /> : null;
  if (items.length === 0) {
    return <span className="ghost-chip" data-static title={title ?? ariaLabel} data-warning={warning || undefined}>{glyph}<span className="chip-label">{label}</span></span>;
  }
  return (
    <>
      {/* Toggle, not a bare open: Menu deliberately ignores pointerdown on its own anchor, so closing
          by clicking the chip a second time is this handler's job. */}
      <button ref={btn} type="button" className="ghost-chip" aria-label={ariaLabel} title={title ?? ariaLabel} aria-haspopup="menu" aria-expanded={open}
        data-warning={warning || undefined} onClick={() => setOpen((v) => !v)}>
        {glyph}
        <span className="chip-label">{label}</span>
        <Icon name="chevronDown" size={12} className="chip-caret" />
      </button>
      {open && <Menu items={items} onClose={() => setOpen(false)} anchorRef={btn} placement="up" label={ariaLabel} />}
    </>
  );
}

/**
 * Pending attachments (§4 row 1): one removable chip per file, then one note row per distinct fate
 * that is worth saying out loud.
 *
 * The notes are the point of this row. The three adapters do three different things with the same
 * file — Claude DROPS a PDF without a word, Codex hands over paths, an ACP agent gets a link — and the
 * only moment that difference is actionable is before the message is sent. So the note names the agent
 * and says what will happen, and a file that will simply be discarded says so in the warning tone. A
 * file the agent reads as-is gets no row (see `attachmentSummary`); its fate is on the chip's tip.
 */
function AttachmentRow({ kind, attachments, onRemove }: { kind: AgentKind; attachments: PickedAttachment[]; onRemove: (path: string) => void }) {
  if (attachments.length === 0) return null;
  return (
    <>
      <ul className="composer-attachments" aria-label="Attachments">
        {attachments.map((a) => (
          <li key={a.path} className="composer-attach-item">
            <AttachmentTile path={a.path} mime={a.mime} name={a.name} disposition={attachmentDisposition(kind, a.mime)}
              detail={`${formatAttachmentSize(a.size)} · ${attachmentNote(kind, a.mime)}`}
              onRemove={() => onRemove(a.path)} />
          </li>
        ))}
      </ul>
      {attachmentSummary(kind, attachments).map((row) => (
        <p key={row.disposition} className="composer-attach-note" data-disposition={row.disposition}>
          {row.disposition === "ignored" && <Icon name="alert" size={12} className="attach-note-glyph" />}
          <span>{row.note}</span>
          <span className="attach-note-files">{row.files.join(", ")}</span>
        </p>
      ))}
    </>
  );
}

const permissionLabel = (id: string) => PERMISSION_MODES.find((m) => m.id === id)?.label ?? id;
const MODE_LABEL: Record<SessionMode, string> = { build: "Build", plan: "Plan", ask: "Ask" };
/** `search` for Ask, not the session bubble: the mode is reading and searching, and the bubble is
 *  already what a session row is. */
const MODE_ICON: Record<SessionMode, IconName> = { build: "tool", plan: "plan", ask: "search" };

/** An environment's display name (under-strip selector, Plan 12 W1): the space's own name for the
 *  primary (the folder IS the space), the branch for a worktree, the folder's basename otherwise. */
export function environmentLabel(e: Environment, spaceName: string): string {
  if (e.kind === "primary") return spaceName;
  return e.branch ?? e.path.replace(/\/+$/, "").split("/").pop() ?? e.path;
}

/**
 * A connector row's honest state (Plan 12 W1). The dot renders the hub's LAST KNOWN connection state —
 * `mcp.list` reads rows and held status, and `mcp.serverStatus` broadcasts patch the cache live; nothing
 * about opening this menu ever dials a server. `idle` means the hub has not connected yet, and it says
 * "not checked" rather than wearing a green dot for a state nobody observed.
 */
export function connectorState(s: McpServer): { tone: "ok" | "warning" | "muted"; note: string | null } {
  if (s.oauthStatus === "reconnect_needed") return { tone: "warning", note: "reconnect needed" };
  switch (s.status) {
    case "connected": return { tone: "ok", note: null };
    case "error": return { tone: "warning", note: "error" };
    case "circuit_open": return { tone: "warning", note: "unavailable" };
    default: return { tone: "muted", note: "not checked" };
  }
}

/**
 * The "+" menu (Plan 12 W1): the plus stops being a bare file-picker trigger and becomes the row's
 * add-anything menu — files (⌘U, bound in hotkeys.ts; the label here is purely visual), a folder,
 * skills, and the space's connectors.
 *
 * Skills opens the `SkillPicker` (W-discovery) rather than priming the `@`-mention popover as it first
 * did. Priming could only ever offer skills that were ALREADY on, which on a machine with a hundred
 * installed made the one menu item named "Skills" the one place that could not show them.
 *
 * The Connectors "submenu" is the same Menu swapped in place (`keepOpen` + a keyed remount so the
 * upward placement re-measures for the new height) — the two-step idiom the menu machinery already
 * carries, not a hover-submenu invented for one item. No Plugins item: Realm has no plugin system,
 * and the plan refuses menu parity over honesty.
 */
function PlusMenu({ onAttachPick, onAddFolder, onSkills, canSkills, connectors, onOpened, onManageConnections, btnRef }: {
  onAttachPick: () => void; onAddFolder: () => void;
  /** Open the skill picker. Offered only when `canSkills` — an item that would silently do nothing
   *  (a Cursor session, a machine with no skills anywhere) is never grown. */
  onSkills: () => void; canSkills: boolean;
  /** The space's servers, or null when the cache has never been fetched (rendered as loading). */
  connectors: McpServer[] | null;
  /** Fired on open — the store re-reads its cache (a row read, never a probe). */
  onOpened: () => void;
  onManageConnections: () => void;
  /** The plus button itself, so the Composer can anchor the skill picker on it. Shared rather than
   *  wrapped: the control row's left group is asserted by DOM order, and a wrapper element would be a
   *  new child of it. */
  btnRef?: RefObject<HTMLButtonElement | null>;
}) {
  const ownBtn = useRef<HTMLButtonElement>(null);
  const btn = btnRef ?? ownBtn;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"root" | "connectors">("root");
  const enabled = (connectors ?? []).filter((s) => s.enabled);
  const rootItems: MenuItem[] = [
    { label: "Add files…", kbd: "⌘U", onSelect: onAttachPick },
    { label: "Add folder…", onSelect: onAddFolder },
    ...(canSkills ? [{ label: "Skills", onSelect: onSkills } as MenuItem] : []),
    { kind: "separator" },
    { label: <span className="plus-submenu-label">Connectors<Icon name="chevronRight" size={12} className="plus-submenu-caret" /></span>, keepOpen: true, onSelect: () => setView("connectors") },
  ];
  const connectorItems: MenuItem[] = [
    { label: <span className="plus-submenu-label"><Icon name="chevronLeft" size={12} className="plus-submenu-caret" />Connectors</span>, keepOpen: true, onSelect: () => setView("root") },
    { kind: "separator" },
    ...(connectors === null
      ? [{ label: "Loading…", disabled: true, onSelect: () => {} } as MenuItem]
      : enabled.length === 0
        ? [{ label: "No connectors enabled in this space", disabled: true, onSelect: () => {} } as MenuItem]
        : enabled.map((s): MenuItem => {
            const st = connectorState(s);
            return {
              label: (
                <span className="connector-row">
                  <span className="connector-dot" data-tone={st.tone} />
                  <span className="chip-label">{s.name}</span>
                  {st.note && <span className="connector-note">{st.note}</span>}
                </span>
              ),
              // Informational: the row states health; acting on a server lives in settings.
              disabled: true, title: `${s.name} — ${st.note ?? "connected"}`, onSelect: () => {},
            };
          })),
    { kind: "separator" },
    { label: "Manage connections…", onSelect: onManageConnections },
  ];
  return (
    <>
      {/* Toggle, mirroring ChipMenu: the Menu ignores pointerdown on its own anchor, so closing by a
          second click is this handler's job. Enter/Space come for free on a real button. */}
      <button ref={btn} type="button" className="icon-btn composer-attach" aria-label="Add"
        title="Add files, folders, skills and connectors" aria-haspopup="menu" aria-expanded={open}
        onClick={() => { if (!open) { setView("root"); onOpened(); } setOpen(!open); }}>
        <Icon name="add" size={16} />
      </button>
      {/* key={view}: the in-place swap changes the menu's height, and the upward placement was
          measured at mount — remounting re-measures instead of overlapping the anchor. */}
      {open && <Menu key={view} items={view === "root" ? rootItems : connectorItems} onClose={() => setOpen(false)}
        anchorRef={btn} placement="up" label={view === "root" ? "Add" : "Connectors"} />}
    </>
  );
}

/** The prompter (design-language §4): one floating card, two states. `hero` centers it at ~38%
 *  viewport height with the greeting above and suggestion chips below (both absolutely positioned
 *  around the card so the hero→docked move is one element transitioning transform, §6: 320ms).
 *  Docked pins it to the pane bottom on the transcript's 680px rails.
 *
 *  Enter sends by default (Shift+Enter inserts a newline); Settings ▸ App can switch that to
 *  ⌘/Ctrl+Enter-to-send, Enter-inserts-a-newline instead — ⌘/Ctrl+Enter always sends either way.
 *  The draft text is owned by the store (keyed by
 *  session id, A-M9) so a suggestion chip can fill it without sending — and layout reshapes never
 *  lose it. */
/**
 * What the current mode MEANS for this agent — the chip title's honesty clause (Plan 14 W3).
 *
 * Claude and Codex have Realm-transmitted semantics and each is described in its OWN terms, because
 * they are not the same guarantee: Codex's Plan can be talked out of the sandbox by approving a
 * prompt, and its Ask cannot. An ACP agent's Plan or Ask is its own mode, described in its own words
 * where it offered any — Realm does not paraphrase an agent's mode into Realm's vocabulary.
 */
function modeMeaning(mode: Exclude<SessionMode, "build">, kind: AgentKind, acpMode: AcpSessionMode | null): string {
  const label = AGENT_META[kind].label;
  const name = MODE_LABEL[mode];
  if (acpMode) {
    return acpMode.description
      ? `${name} is ${label}'s own ${acpMode.name} mode: ${acpMode.description}`
      : `${name} is ${label}'s own ${acpMode.name} mode`;
  }
  if (mode === "ask") {
    if (kind === "codex") return "Ask runs the turn read-only with approvals disabled — there is no prompt through which to escalate, and a mid-session switch applies when the session next starts";
    return "Ask is read-only: the agent may read and search, and every edit or command is refused before it runs";
  }
  if (kind === "codex") return "Plan runs the turn read-only under an untrusted approval policy — the agent proposes, but does not edit";
  return "Plan means the agent researches and proposes, but does not edit";
}

export function Composer({ session, status, gitInfo, onOpenDiff, draft, onDraftChange, attachments, onAttachPick, onAttachFiles, onRemoveAttachment, onSend, onStop, onOptions, onPickModel, onMode, planReturn, canSwitchAgent, agentProbe, modelFavorites, modelInfo, onToggleModelFavorite, hero, spaceName, userName = "", onSuggestion, mentionSkills = [], allSkills = [], onToggleSkill, onManageSkills, staleMentions = [], machineName = "", environments = [], onSelectEnvironment, onNewWorktree, connectors = null, onConnectorsOpened, onAddFolder, onManageConnections, acpModes = null, submitKey = "enter", promptHint = null }: {
  session: Session; status: SessionStatus; gitInfo: GitInfo | null;
  /** Open the diff pane for the session's checkout (W3) — what the branch/diff chips do. */
  onOpenDiff: () => void;
  draft: string; onDraftChange: (text: string) => void;
  /** Part of the draft, and store-owned for the same reason: a remount must not drop them. */
  attachments: PickedAttachment[];
  /** The attach button — the native multi-select picker. */
  onAttachPick: () => void;
  /** Dropped or pasted Files. The store resolves paths (and writes pathless pastes out). */
  onAttachFiles: (files: File[]) => void;
  onRemoveAttachment: (path: string) => void;
  onSend: (text: string) => void; onStop: () => void; onOptions: (o: SessionOptions) => void;
  /** Sets agent AND model in one action — the picker's rows are (agent, model) pairs. */
  onPickModel: (kind: AgentKind, modelId: string | null) => void;
  /** Build ⇄ Plan. The store parks and restores the permission mode around the trip. */
  onMode: (mode: SessionMode) => void;
  /** ACP sessions only (Plan 14 W3): the agent's OWN modes as the session's init event carried them —
   *  null until the handshake has been seen, [] when it named none. What decides whether Build/Plan
   *  exists HERE, per session; the static AGENT_SUPPORTS_PLAN_MODE table answers for the other kinds. */
  acpModes?: AcpSessionMode[] | null;
  /** The permission mode Plan is holding for this session, if any — what returning to Build restores. */
  planReturn: string | null;
  /** False once the session has produced an event — see ModelPicker. */
  canSwitchAgent: boolean;
  /** Latest `agents.probe`, for the picker's per-agent availability note. Empty before the first probe. */
  agentProbe: AgentProbe[];
  /** Canonical model keys the user has starred, and the toggle behind the picker's stars. */
  modelFavorites: string[];
  /** The model catalog by canonical key — prices, context windows and reasoning efforts for the
   *  picker's detail pane. `{}` is a supported state (never fetched, or offline). */
  modelInfo: Record<string, ModelInfo>;
  onToggleModelFavorite: (key: string) => void;
  hero: boolean; spaceName: string; onSuggestion: (prompt: string) => void;
  /** The person's first name, for the hero greeting. "" (the default) means the greeting keeps to
   *  the space — never a "Good evening, " with nothing after the comma. */
  userName?: string;
  /** What `@` may complete to HERE (W4): the space's enabled, valid skills — and only for an agent
   *  Realm can inject skills into. Empty (the default) means typing `@` opens nothing, which is how a
   *  Cursor session never grows an affordance that would silently do nothing. */
  mentionSkills?: Skill[];
  /** Every skill visible to this space — enabled or not — for the "+ → Skills" picker. `mentionSkills`
   *  stays the ENABLED subset, because that is what an `@` in the draft can actually resolve to. */
  allSkills?: Skill[];
  /** Turn a skill on or off for this space, from the picker. */
  onToggleSkill?: (id: string, enabled: boolean) => void;
  /** Open the space's skills settings (scan folders, per-agent notes). */
  onManageSkills?: () => void;
  /** Recognised mentions still in the draft whose skill has since been disabled or deleted — shown in
   *  the warning tone, because at send they degrade to plain text (the `@` stripped) and do not invoke. */
  staleMentions?: string[];
  /** The under-strip's machine label (Plan 12 W1). Display only — no caret, no menu: Realm runs agents
   *  on this Mac and no other, and a one-item dropdown pretending otherwise is the lie the plan bans.
   *  "" (boot not answered) renders nothing rather than a wrong name. */
  machineName?: string;
  /** The space's environments — the workspace selector's options. May momentarily lack the session's
   *  own row (the map loads separately); the chip then labels itself from the session's cwd. */
  environments?: Environment[];
  /** Selecting an existing environment / "New worktree…". Only reachable while the selector is a menu
   *  (no events yet — the same guard as the agent switch; the server enforces it regardless). */
  onSelectEnvironment?: (environmentId: string) => void;
  onNewWorktree?: () => void;
  /** The "+" menu's Connectors source: the space's servers as last fetched, or null = never fetched. */
  connectors?: McpServer[] | null;
  /** The "+" menu opened — refresh the connectors cache (a row read, never a probe). */
  onConnectorsOpened?: () => void;
  /** The "+" menu's Add folder — the existing project-link flow. */
  onAddFolder?: () => void;
  /** The "+" menu's Manage connections — the space settings' Connections tab. */
  onManageConnections?: () => void;
  /** Which key sends the draft (Settings ▸ App). Default "enter": plain Enter sends. "cmdEnter":
   *  only ⌘/Ctrl+Enter sends, plain Enter inserts a newline. */
  submitKey?: SubmitKey;
  /** The session-derived suggested prompt (`prompt-hint.ts`), or null when there is nothing specific
   *  to offer. Shown as the hint text over the empty box and filled in by ⇥. */
  promptHint?: string | null;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const running = status === "running" || status === "waiting_permission";
  const kind = session.agentKind;
  // Hidden exactly like the model menu is empty when the agent has no models: an option Realm cannot
  // transmit is worse than no option at all.
  const canSetPermissionMode = AGENT_SUPPORTS_PERMISSION_MODES[kind];
  // Build/Plan (Plan 14 W3): static for the kinds whose adapters act on Realm's plan wire value,
  // per-SESSION for ACP kinds — their mode ids are agent-defined, so the chip exists exactly when
  // THIS session's handshake advertised a plan-equivalent. No handshake yet on a session that has
  // started = the brief materialization window: the chip renders disabled (a static label) rather
  // than promising a mapping that may not exist. A fresh session shows nothing at all.
  const isAcpKind = kind.startsWith("acp:");
  const acpPlan = isAcpKind ? acpPlanMode(acpModes) : null;
  const acpAsk = isAcpKind ? acpAskMode(acpModes) : null;
  const canPlan = isAcpKind ? acpPlan !== null : AGENT_SUPPORTS_PLAN_MODE[kind];
  // Asked separately from Plan and answered separately: Cursor advertises both, opencode neither, and
  // an agent offering one is not offering the other.
  const canAsk = isAcpKind ? acpAsk !== null : AGENT_SUPPORTS_ASK_MODE[kind];
  const acpModesPending = isAcpKind && acpModes === null && !canSwitchAgent && status !== "error" && status !== "ended";
  const mode = sessionModeOf(session.permissionMode);
  // Plan and Ask both REPLACE the permission axis rather than sitting beside it.
  const inReadOnly = mode !== "build";
  // bypassPermissions must never be a one-click slip (U-M7): selecting it arms an inline confirm chip
  // for 5s while the chip simply stays on the current mode; only the explicit confirm applies it.
  const [confirmBypass, setConfirmBypass] = useState(false);
  useEffect(() => {
    if (!confirmBypass) return;
    const t = setTimeout(() => setConfirmBypass(false), 5000);
    return () => clearTimeout(t);
  }, [confirmBypass]);

  // Drag depth, not a boolean: dragging across a child element fires leave-then-enter, and a boolean
  // flickers the drop target off on every internal boundary. Reset outright on drop.
  const [dragDepth, setDragDepth] = useState(0);
  // Realm already drags its own sidebar rows onto panes (DropEdge). Only a drag carrying FILES is ours;
  // anything else must fall through to the pane's own drop handling untouched.
  const carriesFiles = (e: DragEvent) => e.dataTransfer?.types?.includes("Files") ?? false;
  const onDragEnter = (e: DragEvent) => { if (!carriesFiles(e)) return; e.preventDefault(); setDragDepth((d) => d + 1); };
  const onDragOver = (e: DragEvent) => { if (!carriesFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; };
  const onDragLeave = (e: DragEvent) => { if (!carriesFiles(e)) return; setDragDepth((d) => Math.max(0, d - 1)); };
  const onDrop = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    setDragDepth(0);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onAttachFiles(files);
  };
  /** Pasting an image: it has no path yet, which the store handles. A paste with no files is text —
   *  fall through untouched, or ⌘V would stop working in the one box people paste into most. */
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    onAttachFiles(files);
  };

  /** The hint replaces the placeholder, so it lives and dies with the placeholder: an empty draft
   *  only. A single narrowed const rather than a boolean, so the ⇥ handler and the markup below both
   *  get the string itself out of the one check. */
  const hint = promptHint && draft === "" ? promptHint : null;
  const hintId = `prompt-hint-${session.id}`;

  // First-render-only stagger (§6): decided once at mount (so a mid-animation re-render — typing,
  // status — never strips the attribute and snaps the chips), then marked as played for the app run.
  const [stagger] = useState(() => hero && !staggerPlayed.has(session.id));
  useEffect(() => { if (hero) staggerPlayed.add(session.id); }, [hero, session.id]);

  // The greeting is picked once per session (and re-picked only if the space is renamed or the name
  // arrives late from boot): the time of day is read at that moment, so an open hero never rewrites
  // itself mid-sentence at 6pm.
  const greeting = useMemo(() => heroGreeting({ spaceName, userName, seed: session.id }), [spaceName, userName, session.id]);

  // ── Rich text (highlight mirror) ───────────────────────────────────────
  // The textarea keeps every character; what it does NOT keep is its own colour. Its text is painted
  // transparent and this div — same font, same padding box, same wrapping, one layer below — draws
  // the identical string in coloured runs. The caret, the selection, undo, IME and every existing
  // key handler stay the textarea's, which is the whole reason for the mirror over a contenteditable.
  const hl = useRef<HTMLDivElement>(null);
  /** The mirror has no scrollbar of its own; it is scrolled to wherever the textarea is. */
  const syncScroll = () => {
    const el = ta.current, m = hl.current;
    if (el && m) { m.scrollTop = el.scrollTop; m.scrollLeft = el.scrollLeft; }
  };
  const liveMentionIds = useMemo(() => mentionSkills.map((s) => s.id), [mentionSkills]);
  // Coloured as a mention only if `scanMentions` resolves it — the same call the server re-runs on the
  // sent text. Stale ids get the warning tone the note below the card already explains.
  const segments = useMemo(() => highlightSegments(draft, liveMentionIds, staleMentions), [draft, liveMentionIds, staleMentions]);

  useLayoutEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(MAX_ROWS_PX, el.scrollHeight)}px`;
    syncScroll(); // growing past max-height starts scrolling; the mirror must follow in the same frame
  }, [draft]);

  // ── @-mention picker (W4) ──────────────────────────────────────────────
  // The caret is tracked as state (onSelect fires for typing, clicks and arrow moves alike) because
  // the token under it is what decides whether the popover shows. The token itself is derived, never
  // stored — the draft is the only source of truth, so a pane remount that restores the draft
  // restores the mention with it.
  const [caret, setCaret] = useState(0);
  const [mentionActive, setMentionActive] = useState(0);
  // The "+ → Skills" picker. Anchored on the plus itself, so it opens over the button the user pressed.
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  /** Token start Esc was pressed on: that token stays closed until it is left or retyped. */
  const [mentionDismissed, setMentionDismissed] = useState<number | null>(null);
  /** Where the selection belongs after a pick or a list edit rewrites the draft; applied once the new
   *  text renders. A range, not a point: toggling a bullet over three selected lines must leave those
   *  three lines selected, or the next ⌘⇧8 would undo only the line the caret collapsed onto. */
  const pendingSel = useRef<{ start: number; end: number } | null>(null);
  const mentionToken = useMemo(
    () => (mentionSkills.length > 0 ? mentionQueryAt(draft, Math.min(caret, draft.length)) : null),
    [mentionSkills.length, draft, caret],
  );
  const mentionMatches = useMemo(
    () => (mentionToken ? filterMentionSkills(mentionSkills, mentionToken.query) : []),
    [mentionSkills, mentionToken],
  );
  const mentionOpen = mentionToken !== null && mentionMatches.length > 0 && mentionDismissed !== mentionToken.start;
  // Leaving the token (or deleting it) clears the dismissal, so a fresh `@` in the same spot reopens.
  useEffect(() => { if (mentionToken === null && mentionDismissed !== null) setMentionDismissed(null); }, [mentionToken, mentionDismissed]);
  useLayoutEffect(() => {
    if (pendingSel.current === null) return;
    const sel = pendingSel.current; pendingSel.current = null;
    const el = ta.current;
    if (el) { el.focus(); el.setSelectionRange(sel.start, sel.end); }
    setCaret(sel.start);
  }, [draft]);
  /** Insert `@id ` over the WHOLE token (start..end, not start..caret — `@ma|c` must not leave a
   *  stray `c`). The trailing space is the canonical delimiter the send-time scan expects. */
  const pickMention = (s: Skill) => {
    if (!mentionToken) return;
    const insert = `@${s.id} `;
    onDraftChange(draft.slice(0, mentionToken.start) + insert + draft.slice(mentionToken.end));
    const pos = mentionToken.start + insert.length;
    pendingSel.current = { start: pos, end: pos };
    setMentionActive(0);
  };
  const mentionCur = Math.min(mentionActive, mentionMatches.length - 1);

  /** The "+" menu's Skills item: prime the @-mention picker — insert `@` at the caret (led by a space
   *  when it would otherwise glue onto a word, a shape mentionQueryAt refuses as an email) and put the
   *  caret after it; the existing picker takes over. Deliberately not a second picker. */
  /** Insert `@<id>` at the caret, the same shape `pickMention` leaves behind — so a skill added from
   *  the picker and one completed by typing `@` produce byte-identical drafts. */
  const insertMention = (id: string) => {
    const pos = Math.min(caret, draft.length);
    const lead = pos > 0 && !/\s/.test(draft[pos - 1]!) ? " " : "";
    const trail = /^\s/.test(draft.slice(pos)) ? "" : " ";
    const insert = `${lead}@${id}${trail}`;
    onDraftChange(draft.slice(0, pos) + insert + draft.slice(pos));
    // the [draft] layout effect focuses the textarea here
    pendingSel.current = { start: pos + insert.length, end: pos + insert.length };
  };

  // ── Under-strip (Plan 12 W1): machine label + workspace selector ───────
  const currentEnv = environments.find((e) => e.id === session.environmentId) ?? null;
  const envLabel = currentEnv ? environmentLabel(currentEnv, spaceName) : (session.cwd.replace(/\/+$/, "").split("/").pop() ?? session.cwd);
  const envIcon = currentEnv?.kind === "worktree" ? "branch" : "folder";
  // Menu only while the session has no events — ChipMenu with no items degrades to a caret-less label,
  // exactly the after-first-message rule. Same guard the agent switch reads; the server enforces it
  // regardless, so this is the honest affordance, not the enforcement.
  const envItems: MenuItem[] = !canSwitchAgent ? [] : [
    ...environments.map((e): MenuItem => ({ label: environmentLabel(e, spaceName), checked: e.id === session.environmentId, onSelect: () => onSelectEnvironment?.(e.id) })),
    ...(environments.length > 0 ? [{ kind: "separator" } as MenuItem] : []),
    { label: "New worktree…", onSelect: () => onNewWorktree?.() },
  ];

  // Attachment-only messages (Plan 14 W5): a send needs text OR at least one attachment this agent
  // will actually receive. Attachments whose disposition is `ignored` (non-images on Claude, anything
  // on the fake agent) can't carry a message by themselves — the adapter would deliver literally
  // nothing — so they don't unlock the button, and its tooltip says why.
  const deliverable = attachments.some((a) => attachmentDisposition(kind, a.mime) !== "ignored");
  const send = () => { const t = draft.trim(); if (!t && !deliverable) return; onSend(t); onDraftChange(""); };

  /** Apply a list rewrite: the draft is the source of truth, so this is one `onDraftChange` plus the
   *  selection to restore once React has painted the new text (same channel a mention pick uses). */
  const applyEdit = (edit: DraftEdit) => {
    onDraftChange(edit.text);
    pendingSel.current = { start: edit.start, end: edit.end };
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // ⌘/Ctrl+Enter sends even while the picker is open — the send gesture never changes meaning.
    // Shift is deliberately excluded AND untouched: ⌘⇧↩ is dispatch (Plan 13 W2), bound at the
    // window level in hotkeys.ts — consuming it here would turn dispatch into a plain send.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey) { e.preventDefault(); send(); return; }
    // ⌘⇧8 bulleted / ⌘⇧7 numbered — the shortcuts these have everywhere else. Keyed off `code`, not
    // `key`: with Shift down the digit row reports "*" and "&", and those differ by layout.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.code === "Digit8" || e.code === "Digit7")) {
      e.preventDefault();
      const el = e.currentTarget;
      applyEdit(toggleList(draft, el.selectionStart, el.selectionEnd, e.code === "Digit7"));
      return;
    }
    if (mentionOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionActive(Math.min(mentionMatches.length - 1, mentionCur + 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMentionActive(Math.max(0, mentionCur - 1)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mentionMatches[mentionCur]!); return; }
      // Escape reaches us through the popover hook's own window listener → onClose → dismissal.
    }
    // ⇥ takes the suggested prompt — the sentence the user is reading in the empty box. Gated on an
    // EMPTY draft, which is exactly when the hint is on screen: once there is text, Tab goes back to
    // meaning list-indent (below) or focus-move, and neither is worth a hidden second meaning. Shift
    // is excluded so ⇧⇥ still walks focus backwards out of the textarea.
    if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && hint) {
      e.preventDefault();
      onDraftChange(hint);
      // Caret at the end, through the same channel a mention pick uses — the prompt is a starting
      // point to edit, so it must land ready to type after, not with the caret parked at 0.
      pendingSel.current = { start: hint.length, end: hint.length };
      return;
    }
    // Tab shifts a list item a level — but ONLY inside one. `indentList` returns null on a plain
    // draft, which leaves Tab as Tab: stealing it unconditionally would trap keyboard users in the
    // textarea. The picker above already claimed Tab when it is open.
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const el = e.currentTarget;
      const edit = indentList(draft, el.selectionStart, el.selectionEnd, e.shiftKey ? -1 : 1);
      if (edit) { e.preventDefault(); applyEdit(edit); return; }
    }
    // A newline landing in a list carries the list on. This is exactly the Enter that would INSERT
    // one — Shift+Enter in either mode, plus plain Enter under "cmdEnter" — so list continuation can
    // never eat a send. A non-empty selection falls through: Enter there means "replace this".
    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && (e.shiftKey || submitKey === "cmdEnter")) {
      const el = e.currentTarget;
      const edit = el.selectionStart === el.selectionEnd ? continueList(draft, el.selectionStart) : null;
      if (edit) { e.preventDefault(); applyEdit(edit); return; }
    }
    // Plain Enter (Settings ▸ App, default "enter"): the picker above already claimed Enter when
    // open, so this never fights mention-picking. Shift+Enter stays a newline in both modes.
    if (submitKey === "enter" && e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // Effort's one home is the model picker (prompter rework): the standalone chip is retired, the
  // chip's gray suffix names the level, and this list is the picker's permanent Effort section.
  // Deliberately narrow (no `MenuItem[]`): OverflowGroup's item shape, which has no separator arm.
  const effortItems = EFFORT_LEVELS.map((l) => ({ label: formatEffort(l), checked: session.effort === l, onSelect: () => onOptions({ effort: l }) }));
  // Only the modes this agent can actually be put INTO. Build is always offered — it is the absence
  // of the other two, not a capability — and a menu row for a mode nothing would enforce is the lie
  // the per-kind tables exist to prevent.
  const modeItems: MenuItem[] = SESSION_MODES
    .filter((m) => (m.id === "plan" ? canPlan : m.id === "ask" ? canAsk : true))
    .map((m) => ({ label: m.label, checked: m.id === mode, onSelect: () => onMode(m.id) }));

  // While IN a read-only mode the title says what that mode is doing; from Build it says what each
  // offered mode WOULD do, because Build is where the choice is made and the per-agent guarantee is
  // exactly what the user needs before making it.
  const modeTitle = `Mode: ${MODE_LABEL[mode]}. ` + (mode === "build"
    ? [canPlan ? modeMeaning("plan", kind, acpPlan) : null, canAsk ? modeMeaning("ask", kind, acpAsk) : null].filter(Boolean).join(". ")
    : modeMeaning(mode, kind, mode === "ask" ? acpAsk : acpPlan));

  // Built HERE rather than inside ModelPicker so the harness chip and the model list are the same
  // rows: the chip resolves a switch through `modelIdOn`, and two independent `modelRows` calls
  // could disagree about which harness a model resolved to.
  const rows = useMemo(
    () => modelRows({ kind, model: session.model, agentProbe, canSwitchAgent, favorites: modelFavorites }),
    [kind, session.model, agentProbe, canSwitchAgent, modelFavorites]);
  const permissionItems = PERMISSION_MODES.map((m) => ({
    label: m.label, checked: session.permissionMode === m.id,
    onSelect: () => {
      if (m.id === "bypassPermissions" && session.permissionMode !== "bypassPermissions") { setConfirmBypass(true); return; }
      setConfirmBypass(false);
      onOptions({ permissionMode: m.id });
    },
  }));

  // Overflow collapse (§3): the control row never wraps. When the left group cannot fit at the
  // card's width, the permission chip folds into the model menu instead (effort already lives
  // there permanently, so it is the only chip left with somewhere to go). Measured, not
  // hoped: the row is nowrap/overflow-hidden with non-shrinking chips, so overflow is exactly
  // `scrollWidth > clientWidth`. The width the un-collapsed row NEEDED is remembered so growing the
  // pane back past it un-collapses without flip-flopping (chips removed = no overflow to observe).
  const optsRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const neededW = useRef(0);
  useLayoutEffect(() => {
    const el = optsRef.current; if (!el) return;
    const measure = () => {
      if (!collapsed && el.scrollWidth > el.clientWidth) { neededW.current = el.scrollWidth; setCollapsed(true); }
      else if (collapsed && el.clientWidth >= neededW.current) setCollapsed(false);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return; // jsdom
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
  // In Plan the permission control is a read-only label (see below) and stays on the row — only
  // the MENU collapses.
  const overflow: OverflowGroup[] | undefined = collapsed && canSetPermissionMode && !inReadOnly
    ? [{ label: "Permissions", items: permissionItems }]
    : undefined;

  return (
    <div className="composer-dock">
      {hero && (
        /* Click the emphasised word — your name, or the space's — and the line nods back. Nothing
           announces it, nothing reaches it by keyboard, and nothing depends on it having happened.
           The mark goes on the element and comes off when the animation ends, so there is no state,
           no timer and nothing to clean up. Taking it off and putting it straight back would replay
           nothing — the browser only sees the value it holds at the end of the frame — so the read
           of `offsetWidth` between the two forces the removal to land first. Under
           prefers-reduced-motion the global kill means no animation runs and no `animationend`
           arrives, which is the correct outcome: the greeting simply does not nod. */
        <div className="hero-greeting"
          onClick={(e) => {
            if (!(e.target instanceof HTMLElement) || e.target.tagName !== "EM") return;
            const line = e.currentTarget;
            line.removeAttribute("data-nod");
            void line.offsetWidth;
            line.setAttribute("data-nod", "");
          }}
          onAnimationEnd={(e) => e.currentTarget.removeAttribute("data-nod")}>
          {greeting.map((part, i) => (part.em ? <em key={i}>{part.text}</em> : <Fragment key={i}>{part.text}</Fragment>))}
        </div>
      )}
      {/* The whole card is the drop target — aiming at a 44px textarea with a file in hand is a chore.
          §6 forbids animating during a drag, so the state change is a static ring, not a transition. */}
      <div className="composer" data-dropping={dragDepth > 0 || undefined}
        onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <AttachmentRow kind={kind} attachments={attachments} onRemove={onRemoveAttachment} />
        {/* A mention whose skill vanished after typing (W4): warning tone, same row language as the
            attachment fates — the last moment the degradation is actionable is before send. */}
        {staleMentions.length > 0 && (
          <p className="composer-attach-note composer-mention-note" data-disposition="ignored">
            <Icon name="alert" size={12} className="attach-note-glyph" />
            <span>{staleMentions.length === 1 ? "No longer an enabled skill — sent as plain text, without the @:" : "No longer enabled skills — sent as plain text, without the @:"}</span>
            <span className="attach-note-files">{staleMentions.map((m) => `@${m}`).join(", ")}</span>
          </p>
        )}
        {/* The mirror and the textarea are one control in two layers, so they share a positioned box.
            aria-hidden on the mirror: it is a duplicate of text the textarea already exposes. */}
        <div className="composer-editor">
          <div ref={hl} className="composer-highlight" aria-hidden="true">
            {segments.map((s, i) => (s.kind ? <span key={i} className={`ch-${s.kind}`}>{s.text}</span> : s.text))}
            {/* A draft ending in a newline: the block would drop that last empty line, and the mirror
                would sit one line short of the textarea from there down. */}
            {draft.endsWith("\n") && "\n"}
          </div>
          {/* The suggested prompt, in the placeholder's own place. Not the native `placeholder`: that
              cannot carry the ⇥ cap, and a textarea placeholder wraps to a second line the one-row
              empty box has no room for — this one ellipsizes instead. The real placeholder steps
              aside while it shows, or the two would stack in the same box. */}
          {hint && (
            <div id={hintId} className="composer-hint">
              <span className="composer-hint-text">{hint}</span>
              <kbd>Tab</kbd>
              <span className="visually-hidden">Press Tab to fill in this suggested prompt.</span>
            </div>
          )}
          <textarea ref={ta} className="composer-input" aria-label="Message" placeholder={hint ? "" : `Ask ${AGENT_META[kind].label} anything…`} rows={1}
            value={draft} onChange={(e) => { onDraftChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setMentionActive(0); }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown} onPaste={onPaste} onScroll={syncScroll}
            aria-describedby={hint ? hintId : undefined}
            aria-controls={mentionOpen ? "mention-list" : undefined}
            aria-activedescendant={mentionOpen ? `mention-${mentionMatches[mentionCur]!.id}` : undefined} />
        </div>
        {mentionOpen && (
          <MentionPicker skills={mentionMatches} activeIndex={mentionCur} anchorRef={ta}
            onPick={pickMention} onHover={setMentionActive}
            onClose={() => setMentionDismissed(mentionToken.start)} />
        )}
        {skillPickerOpen && (
          <SkillPicker skills={allSkills} anchorRef={plusRef}
            onToggle={(sk, enabled) => onToggleSkill?.(sk.id, enabled)}
            onMention={(sk) => insertMention(sk.id)}
            onManage={() => onManageSkills?.()}
            onClose={() => setSkillPickerOpen(false)} />
        )}
        {dragDepth > 0 && <div className="composer-drop-hint" aria-hidden="true">Drop to attach</div>}
        <div className="composer-bar">
          <div className="composer-opts" ref={optsRef} data-collapsed={collapsed || undefined}>
            {/* The "+" opens the add menu now (Plan 12 W1) — its Add files… reaches the SAME picker
                through the same handler the bare attach button used to call directly. */}
            <PlusMenu onAttachPick={onAttachPick} onAddFolder={() => onAddFolder?.()}
              onSkills={() => setSkillPickerOpen(true)} canSkills={allSkills.length > 0}
              connectors={connectors} onOpened={() => onConnectorsOpened?.()}
              onManageConnections={() => onManageConnections?.()} btnRef={plusRef} />
            {/* Left group order (prompter rework): "+" · permission · mode · branch. The permission
                and mode chips sit against the attach button; the git chip trails them. */}
            {/* In Plan and in Ask the permission mode is not in effect — Claude's `plan` replaces it
                outright, Realm's own gate refuses in Ask, and Codex forces read-only either way — so
                the control becomes a LABEL naming what Build will restore.
                Offering a picker whose selection changes nothing is the lie this split exists to end;
                hiding it instead would lose the answer to "what happens when I go back?". */}
            {canSetPermissionMode && (
              inReadOnly
                ? <ChipMenu ariaLabel="Permission mode" items={[]}
                    title={`${MODE_LABEL[mode]} is read-only — returning to Build restores ${permissionLabel(planReturn ?? "default")}`}
                    label={permissionLabel(planReturn ?? "default")} />
                : !collapsed && <ChipMenu ariaLabel="Permission mode" warning={session.permissionMode === "bypassPermissions"}
                    label={permissionLabel(session.permissionMode)} items={permissionItems} />
            )}
            {(canPlan || canAsk) && (
              <ChipMenu ariaLabel="Mode" title={modeTitle} icon={MODE_ICON[mode]} label={MODE_LABEL[mode]} items={modeItems} />
            )}
            {/* The materialize-honestly window: the session is live but the agent has not named its
                modes yet. Disabled (a static label, out of the tab order) rather than absent, so the
                chip does not pop into a row the user is already aiming at — and rather than enabled,
                because offering Plan before the agent has said it exists would be a guess. */}
            {!canPlan && !canAsk && acpModesPending && (
              <ChipMenu ariaLabel="Mode" title="Waiting for the agent's modes" icon="tool" label="Build" items={[]} />
            )}
            <GitChip gitInfo={gitInfo} onOpenDiff={onOpenDiff} />
            {confirmBypass && (
              <button className="composer-chip bypass-confirm"
                onClick={() => { setConfirmBypass(false); onOptions({ permissionMode: "bypassPermissions" }); }}>
                Allow everything? Confirm
              </button>
            )}
          </div>
          <div className="composer-actions">
            {/* ONE chip, not two. The harness menu that used to sit here is gone: a harness is only
                ever chosen FOR a model, so that choice moved inside the picker as the highlighted
                model's "Run it through" pills, where the consequence of each route is on screen
                beside it. The chip still wears the harness's mark, so nothing it said is lost. */}
            <ModelPicker kind={kind} model={session.model} effort={session.effort} rows={rows} info={modelInfo}
              onToggleFavorite={onToggleModelFavorite}
              onPick={onPickModel} effortItems={effortItems} overflow={overflow} />
            {/* Send↔stop morph (§6): both icons stay in the DOM; data-state cross-fades them (160ms,
                opacity + scale .25→1 + 4px blur). ⌘↵ still sends while running — only the button morphs. */}
            {/* Attachments the agent will receive can go alone (Plan 14 W5 relaxed sessions.send's
                text.min(1) for exactly this); ones it would IGNORE cannot — rather than let the
                button look broken there, it says why. */}
            <button className="composer-send" data-state={running ? "stop" : "send"}
              aria-label={running ? "Stop" : "Send"}
              title={running ? "Stop (interrupt)"
                : !draft.trim() && attachments.length > 0 && !deliverable ? `${AGENT_META[kind].label} ignores these attachments — add a message to send`
                : "Send (⌘↵)"}
              disabled={!running && !draft.trim() && !deliverable}
              onClick={() => (running ? onStop() : send())}>
              <Icon name="arrowUp" size={16} className="send-icon" />
              <Icon name="stop" size={13} className="stop-icon" />
            </button>
          </div>
        </div>
      </div>
      {/* Under-strip (Plan 12 W1): where this session runs. In normal flow inside .composer-dock so
          the hero→docked move — one transform on the dock (§6: 320ms) — carries it untouched. */}
      <div className="composer-understrip">
        {machineName && (
          // Display only, deliberately: Realm runs agents on this Mac and no other. The selector
          // ships when remote execution does (roadmap: pairing) — no caret, no one-item dropdown.
          <span className="ghost-chip" data-static title={`Agents run on this Mac — ${machineName}`}>
            <Icon name="laptop" size={12} className="chip-brand" />
            <span className="chip-label">{machineName}</span>
          </span>
        )}
        <ChipMenu ariaLabel="Workspace" icon={envIcon} label={envLabel} items={envItems}
          title={canSwitchAgent ? `Workspace: ${envLabel}` : `Workspace: ${envLabel} — a session's checkout can only change before its first message`} />
        {status === "running" && <div className="composer-thinking"><span>Thinking…</span></div>}
      </div>
      {hero && (
        <div className="suggestions" data-animate={stagger || undefined}>
          {SUGGESTIONS[kind].map((s, i) => (
            <button key={s.title} type="button" className="suggestion-chip" style={{ "--i": i } as React.CSSProperties}
              onClick={() => onSuggestion(s.prompt)}>
              <Icon name="idea" size={16} className="suggestion-glyph" />
              <span className="suggestion-title">{s.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
