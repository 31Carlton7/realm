import { LINK_SERVICE_META, elementChipToken, scanElementChips, type LinkChip , type SessionRef } from "@realm/contracts";
import { AGENT_META, AGENT_SUPPORTS_ASK_MODE, AGENT_SUPPORTS_PERMISSION_MODES, DEFAULT_MODEL_LABEL, SELECTABLE_AGENT_KINDS, AGENT_SUPPORTS_PLAN_MODE, EFFORT_LEVELS, PERMISSION_MODES, SESSION_MODES, acpAskMode, acpPlanMode, sessionModeOf, attachmentDisposition, attachmentNote, attachmentSummary, basenameOf, formatAttachmentSize, steerInterrupts, steerNote, tightestWindow, type AcpSessionMode, type MidTurnMode, type PlanLimits, type AgentKind, type Environment, type GitInfo, type McpServer, type ModelInfo, type QueuedPrompt, type Session, type SessionMode, type SessionStatus, type Skill } from "@realm/contracts";
import { Icon, type IconName } from "@realm/ui";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { Menu, type MenuItem } from "../../components/Menu";
import { useFileDrop } from "../../components/use-file-drop";
import { useItemDrop } from "../../components/use-item-drop";
import type { AgentProbe, PickedAttachment, SessionOptions, SubmitKey } from "../../state/store";
import { agentAvailability, availabilityNote } from "../../state/agent-availability";
import { MentionPicker, filterMentionSkills, mentionQueryAt } from "./MentionPicker";
import { SlashPicker } from "./SlashPicker";
import { filterSlashCommands, slashCallIn, slashQueryAt, type SlashCommand } from "./slash-commands";
import { modelIdOn, modelRows } from "./model-rows";
import { SkillPicker } from "./SkillPicker";
import { ModelPicker, formatEffort, type FastMode, type OverflowGroup } from "./ModelPicker";
import { heroGreeting } from "./greeting";
import { chipAround, chipSpans, continueList, deleteChipAt, highlightSegments, indentList, isChipKind, stepOverChip, toggleList, type DraftEdit } from "./draft-format";
import { AttachmentTile } from "./AttachmentTile";
import { whenLabel } from "../schedules/SchedulesPage";
import { DelegatedRuns } from "./DelegatedRuns";
import { TodoStrip } from "./TodoStrip";
import { SessionUsage } from "./SessionUsage";
import type { Usage } from "./transcript-model";
import type { Todo } from "./rich/tool-view";

// ~10 lines of 15px/1.55 plus the vertical padding (Ara refresh §1 raises the input to 15px; §4:
// autogrows to 10 lines). Matches .composer-input's max-height in styles.css.
const MAX_ROWS_PX = 254;

/** Stable default for the `usage` prop — a fresh object per render would make the under-strip's ring
 *  re-render on every keystroke for no change. No `contextTokens`, so it draws no ring at all. */
const EMPTY_USAGE: Usage = { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 };
/** Stable empty default, for the same reason. */
const NO_COMMANDS: SlashCommand[] = [];
/** Stable empty default, for the same reason. */
const NO_GREETINGS: readonly string[] = [];

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
      <span className="ghost-chip git-branch"><Icon name="branch" size={12} className="chip-brand" /><span className="chip-label">{gitInfo.branch}</span></span>
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
  const glyph = icon ? <Icon name={icon} size={12} className="chip-brand" /> : null;
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
 * Pending attachments (§4 row 1): one removable chip per file, then a note row only for a fate worth
 * saying out loud before send.
 *
 * The adapters do different things with the same file — Claude inlines an image and is handed every
 * other file's path, Codex takes paths for everything, an ACP agent gets a link — and every one of
 * them is on the chip's tooltip. Only a file the agent will DROP earns a row: it is the one outcome
 * the user would not otherwise learn about, and the only moment it is actionable is before the
 * message is sent. A handoff the agent completes itself (path, link) used to get a row too, and it
 * read as narration under every Codex message; see `attachmentSummary`.
 */
/**
 * The provider's own warning that this account is close to a limit, or past one.
 *
 * Shown only when the provider says so — `alert` comes from Claude's `allowed_warning`/`rejected`,
 * never from a utilization Realm compared against a number it chose. That is what keeps this row
 * silent at 31% and present at 92% without Realm having an opinion about where the line is.
 *
 * Above the prompter rather than in the transcript, and for the same reason the queue is: it is about
 * what will happen to the NEXT message, not about anything that was said.
 */
function LimitRow({ limits }: { limits: PlanLimits | null }) {
  if (!limits || limits.alert === "none") return null;
  const named = limits.windows.find((w) => w.id === limits.alertWindow);
  // The window the provider named, or the fullest one it reported. A warning with neither is still
  // worth showing — the account is near a limit and the useful half of that sentence is not the name.
  const w = named ?? tightestWindow(limits.windows);
  const pct = w?.utilization === null || w?.utilization === undefined ? null : Math.round(w.utilization);
  return (
    <p className="composer-limit" data-alert={limits.alert}>
      <Icon name="alert" size={12} className="attach-note-glyph" />
      <span>
        {limits.alert === "exceeded"
          ? `${w ? w.label : "Plan"} limit reached.`
          : `${w ? w.label : "Plan"} limit ${pct === null ? "nearly used" : `at ${pct}%`}.`}
        {w?.resetsAt ? ` Resets ${whenLabel(w.resetsAt)}.` : ""}
      </span>
    </p>
  );
}

/**
 * The messages waiting for this turn to end, oldest first.
 *
 * Above the input rather than in the transcript, because they are not transcript: nothing has been
 * asked yet, and a bubble for a message no agent has seen would make the log claim otherwise.
 *
 * The send-now sits on the row rather than in the button corner, which is Stop's while a turn runs.
 * What it costs is `steerNote`'s answer and differs by agent.
 */
function QueueRow({ kind, queued, onRelease, onDrop }: { kind: AgentKind; queued: QueuedPrompt[]; onRelease: (queuedId: string) => void; onDrop: (queuedId: string) => void }) {
  if (queued.length === 0) return null;
  const note = steerNote(kind);
  return (
    <ul className="composer-queue" aria-label="Queued messages">
      {queued.map((q, i) => (
        <li key={q.id} className="composer-queue-item">
          <span className="queue-position" aria-hidden="true">{i + 1}</span>
          {/* One line, with the whole of it in the title: the row is a reminder of what is coming, and
              the message becomes a real bubble the moment it goes out. */}
          <span className="queue-text" title={q.text}>{q.text || "(attachments only)"}</span>
          {q.attachments.length > 0 && (
            <span className="queue-attach" title={q.attachments.map((a) => basenameOf(a.path)).join(", ")}>
              <Icon name="attach" size={12} />{q.attachments.length}
            </span>
          )}
          <button type="button" className="queue-send" title={note} onClick={() => onRelease(q.id)}>Send now</button>
          <button type="button" className="queue-drop" aria-label={`Remove queued message: ${q.text}`} title="Remove" onClick={() => onDrop(q.id)}>
            <Icon name="close" size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The other sessions this draft points at.
 *
 * A row of pills rather than tokens in the text, and that is forced: `draft-format.ts` allows a
 * painted run to change "colour, background and underline" and never "weight, family, size or
 * spacing", because the mirror sits under a real textarea. A mark inside a run moves every glyph
 * after it. So a reference that shows WHO it points at lives beside the box, like an attachment.
 *
 * The mark is the agent's own, in the agent's own colour — a session is recognised by which agent is
 * running it long before anyone reads the title.
 */
/** Stable, so a Composer with no references does not get a new array on every render. */
const NO_SESSION_REFS: readonly SessionRef[] = [];

function SessionRefRow({ refs, onRemove }: { refs: readonly SessionRef[]; onRemove: (sessionId: string) => void }) {
  if (refs.length === 0) return null;
  return (
    <ul className="composer-refs" aria-label="Sessions this message points at">
      {refs.map((r) => (
        <li key={r.sessionId} className="composer-ref">
          <Icon name={AGENT_META[r.agent as AgentKind]?.icon ?? "chat"} size={14} colored className="composer-ref-mark" />
          <span className="composer-ref-title">{r.title}</span>
          <button type="button" className="composer-ref-remove" aria-label={`Stop pointing at ${r.title}`}
            title="Remove" onClick={() => onRemove(r.sessionId)}><Icon name="close" size={12} /></button>
        </li>
      ))}
    </ul>
  );
}

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
          {/* A real space, not the flex gap. The gap separates the two boxes on screen but leaves the
              row's text content — what a screen reader announces and what a copy takes — reading
              "…never see them:report.pdf", which is the run-on the colon was added to fix. */}
          <span>{row.note}{" "}</span>
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
 *
 * **Mode** rides the same idiom. It used to be a chip in the control row, paired with the permission
 * chip inside a `.chip-group` that drew the two as one segmented control. Two things were wrong with
 * that: the row is where the things you change PER MESSAGE live, and the mode is a property of the
 * session that most turns never touch; and grouping it with permissions implied the two were one
 * decision, when Plan and Ask actually REPLACE the permission axis rather than sit beside it. The
 * row keeps the permission chip alone, which is also what un-groups its corners.
 *
 * The row carries the current mode as its value, because removing the chip removed the only place
 * the mode was written down. The card's own tint still says it for Plan and Ask; Build is untinted,
 * and this is where Build is legible.
 */
function PlusMenu({ onAttachPick, onAddFolder, onSkills, canSkills, onGoal, connectors, onOpened, onManageConnections,
  mode, modeItems, modeTitle, modePending, canChooseMode, btnRef }: {
  onAttachPick: () => void; onAddFolder: () => void;
  /** Open the skill picker. Offered only when `canSkills` — an item that would silently do nothing
   *  (a Cursor session, a machine with no skills anywhere) is never grown. */
  onSkills: () => void; canSkills: boolean;
  /** Arm the box with `/goal `, or null when this prompter has no goal command to arm — the gate is
   *  the command list itself, so this row can never offer something the `/` picker does not. */
  onGoal: (() => void) | null;
  /** The space's servers, or null when the cache has never been fetched (rendered as loading). */
  connectors: McpServer[] | null;
  /** Fired on open — the store re-reads its cache (a row read, never a probe). */
  onOpened: () => void;
  onManageConnections: () => void;
  /** The session's mode, and the rows that change it — built by the Composer (`modeItems`) so the
   *  per-agent filtering that decides whether Plan or Ask is even offered stays in one place. */
  mode: SessionMode;
  modeItems: MenuItem[];
  modeTitle: string;
  /** The agent is live but has not named its modes yet (ACP kinds answer at handshake). Distinguished
   *  from "offers none" because they read the same on a disabled row and mean opposite things: one is
   *  a wait, the other is an answer. */
  modePending: boolean;
  /** Whether this agent offers any mode to choose. False collapses the row to a static value: a
   *  session whose agent has named no modes still has one, and hiding it would leave the mode with
   *  nowhere at all to be read. */
  canChooseMode: boolean;
  /** The plus button itself, so the Composer can anchor the skill picker on it. Shared rather than
   *  wrapped: the control row's left group is asserted by DOM order, and a wrapper element would be a
   *  new child of it. */
  btnRef?: RefObject<HTMLButtonElement | null>;
}) {
  const ownBtn = useRef<HTMLButtonElement>(null);
  const btn = btnRef ?? ownBtn;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"root" | "connectors" | "mode">("root");
  const enabled = (connectors ?? []).filter((s) => s.enabled);
  const modeRow = (
    <span className="plus-submenu-label">
      Mode
      <span className="plus-submenu-value" data-mode={mode}>
        <Icon name={MODE_ICON[mode]} size={12} />{MODE_LABEL[mode]}
      </span>
      {canChooseMode && <Icon name="chevronRight" size={12} className="plus-submenu-caret" />}
    </span>
  );
  const modeRowTitle = canChooseMode ? modeTitle : modePending ? "Waiting for the agent's modes" : modeTitle;
  const rootItems: MenuItem[] = [
    { label: "Add files…", kbd: "⌘U", onSelect: onAttachPick },
    { label: "Add folder…", onSelect: onAddFolder },
    ...(canSkills ? [{ label: "Skills", onSelect: onSkills } as MenuItem] : []),
    { kind: "separator" },
    /* A goal sits with Mode rather than with the files above it: both are properties of the SESSION
       rather than of this message. It arms the box instead of opening anything — the objective is
       the argument, and there is nothing to pick from — which is the same gesture `/goal` already
       is, reached by someone who does not know the command exists. */
    ...(onGoal ? [{ label: "Set a goal…", onSelect: onGoal } as MenuItem] : []),
    // Static when the agent offers nothing to switch to — the value is still worth reading, and a
    // row that opened onto a list of one would be a control whose only outcome is the state it is in.
    canChooseMode
      ? { label: modeRow, title: modeRowTitle, keepOpen: true, onSelect: () => setView("mode") }
      : { label: modeRow, title: modeRowTitle, disabled: true, onSelect: () => {} },
    { label: <span className="plus-submenu-label">Connectors<Icon name="chevronRight" size={12} className="plus-submenu-caret" /></span>, keepOpen: true, onSelect: () => setView("connectors") },
  ];
  const modeViewItems: MenuItem[] = [
    { label: <span className="plus-submenu-label"><Icon name="chevronLeft" size={12} className="plus-submenu-caret" />Mode</span>, keepOpen: true, onSelect: () => setView("root") },
    { kind: "separator" },
    ...modeItems,
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
      {open && <Menu key={view}
        items={view === "root" ? rootItems : view === "mode" ? modeViewItems : connectorItems}
        onClose={() => setOpen(false)}
        anchorRef={btn} placement="up"
        label={view === "root" ? "Add" : view === "mode" ? "Mode" : "Connectors"} />}
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

export function Composer({ session, status, gitInfo, onOpenDiff, draft, onDraftChange, attachments, onAttachPick, onAttachFiles, onRemoveAttachment, sessionRefs = NO_SESSION_REFS, onRemoveSessionRef, onDropItem, onSend, onStop, onOptions, queued = [], onReleaseQueued, onDropQueued, midTurnMode = "queue", planLimits = null, onParkPermission, onPickModel, onMode, planReturn, canSwitchAgent, agentProbe, modelFavorites, modelInfo, onToggleModelFavorite, hero, spaceName, userName = "", mentionSkills = [], allSkills = [], onToggleSkill, onManageSkills, staleMentions = [], machineName = "", environments = [], onSelectEnvironment, onNewWorktree, connectors = null, onConnectorsOpened, onAddFolder, onManageConnections, acpModes = null, submitKey = "enter", eggs = false, promptHint = null, todos = [], usage = EMPTY_USAGE, slashCommands = NO_COMMANDS, goal = null, packGreetings = NO_GREETINGS, supportsFastMode, links, onLinkPaste, compact = false }: {
  session: Session; status: SessionStatus; gitInfo: GitInfo | null;
  /**
   * The quick chat's prompter: the card, and only the card.
   *
   * Everything the flag removes is a fact about WHERE and HOW a session runs — the permission and
   * mode chips, the machine, the workspace, the meter, the agents in flight. A quick chat is a
   * question you ask in a corner of the screen; none of those are the question, and a row of them
   * under a 280px card would be most of the window. What stays is what the ask still needs: the
   * model, attachments, and send.
   */
  compact?: boolean;
  /** Open the diff pane for the session's checkout (W3) — what the branch/diff chips do. */
  onOpenDiff: () => void;
  draft: string; onDraftChange: (text: string) => void;
  /** The session's plan as it stands, pinned above the card. Empty draws nothing at all. */
  todos?: readonly Todo[];
  /** Part of the draft, and store-owned for the same reason: a remount must not drop them. */
  attachments: PickedAttachment[];
  /** The attach button — the native multi-select picker. */
  onAttachPick: () => void;
  /** Dropped or pasted Files. The store resolves paths (and writes pathless pastes out). */
  onAttachFiles: (files: File[]) => void;
  onRemoveAttachment: (path: string) => void;
  onSend: (text: string) => void; onStop: () => void; onOptions: (o: SessionOptions) => void;
  /** The other sessions this draft points at, and the two ways they change. */
  sessionRefs?: readonly SessionRef[]; onRemoveSessionRef?: (sessionId: string) => void;
  /** One of Realm's own sidebar items was dropped on the prompter. The pane decides what it means. */
  onDropItem?: (itemId: string) => void;
  queued?: QueuedPrompt[]; onReleaseQueued?: (queuedId: string) => void; onDropQueued?: (queuedId: string) => void; midTurnMode?: MidTurnMode; planLimits?: PlanLimits | null;
  /** Set the permission Build will return to, while a read-only mode is in force. Absent leaves the
   *  chip a label, which is what the read-only mounts want. */
  onParkPermission?: (permissionMode: string) => void;
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
  hero: boolean; spaceName: string;
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
  /** Whether the easter eggs are on. Passed straight to the model picker. */
  eggs?: boolean;
  /** The session-derived suggested prompt (`prompt-hint.ts`), or null when there is nothing specific
   *  to offer. Shown as the hint text over the empty box and filled in by ⇥. */
  promptHint?: string | null;
  /** This session's latest usage sample — the under-strip's context ring and its hover panel. The
   *  empty default is what a pane with no transcript yet passes, and it draws no ring. */
  usage?: Usage;
  /** What a `/` at the start of the draft may complete to. These RUN here; nothing in the list is
   *  ever transmitted, which is the whole difference between this and an `@`-mention. Empty (the
   *  default) means typing `/` opens nothing at all. */
  slashCommands?: SlashCommand[];
  /** The session's goal strip, already built by the pane — `null` for a session pursuing none. A
   *  node rather than the goal itself, for `hero`'s reason: everything it needs to DO belongs to the
   *  pane, and a Composer that took four goal callbacks would be a Composer that knows about goals. */
  goal?: React.ReactNode;
  /** Hero-greeting lines from an unlocked friend pack. Drawn only with the eggs on, like everything
   *  else a pack brings — the switch is the consent boundary and a pack is not a way around it. */
  packGreetings?: readonly string[];
  /** Whether the harness has said THIS session's model can run fast mode (the `init` event's own
   *  answer). Undefined is "not stated", and the picker offers no switch — never a disabled one,
   *  because there is nothing the user could do about a capability nobody has claimed. */
  supportsFastMode?: boolean;
  /** The draft's link chips (store `draftLinks`): what a `@[label]` token in the text stands for,
   *  so the mirror can wear the app's mark on it. */
  links?: readonly LinkChip[];
  /** A pasted URL Realm can name becomes a chip through this; null means "paste it as text". */
  onLinkPaste?: (url: string) => LinkChip | null;
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

  /* The card CLAIMS a file drag from the session pane around it, which is also a drop target. Both
     lighting up for one drag would say the file is about to land in two places. */
  const drop = useFileDrop(onAttachFiles, true);
  // A second vocabulary on the same box: files attach, one of Realm's own items points. The
  // hooks claim different `dataTransfer` types, so neither ever sees the other's drag.
  const itemDrop = useItemDrop((itemId) => onDropItem?.(itemId));
  /* …except in the quick chat, where the card takes no drag at all and the handlers below are left
     off it. That window is 380px of one thing: its own glow covers the card as well as the
     transcript, and a card that claimed inside it would swap a glow around the window for a
     rectangle around its bottom strip. `dropping` stays false with nothing attached, so the card's
     ring and its "Drop to attach" hint come off with the handlers. */
  const dropHandlers = compact ? {} : drop.handlers;
  /* COMPOSED, not two spreads. Two `{...handlers}` on one element is one set silently overwriting
     the other — which is how the file drop stopped working the moment the item drop was added, and
     what the prompter's own drop tests caught. Each hook ignores the drag it does not own, so
     calling both in order is safe and exactly one of them ever acts. `compact` turns both off
     together, the way it already turned the file one off alone. */
  const bothDrops = compact ? {} : {
    onDragEnter: (e: DragEvent) => { drop.handlers.onDragEnter(e); itemDrop.handlers.onDragEnter(e); },
    onDragOver: (e: DragEvent) => { drop.handlers.onDragOver(e); itemDrop.handlers.onDragOver(e); },
    onDragLeave: (e: DragEvent) => { drop.handlers.onDragLeave(e); itemDrop.handlers.onDragLeave(e); },
    onDrop: (e: DragEvent) => { drop.handlers.onDrop(e); itemDrop.handlers.onDrop(e); },
  };
  /** Pasting an image: it has no path yet, which the store handles. A paste with no files is text —
   *  fall through untouched, or ⌘V would stop working in the one box people paste into most. */
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) { e.preventDefault(); onAttachFiles(files); return; }
    /* One URL to an app the agent can reach — a Slack thread, a Linear issue, a Notion page — lands
       as a chip wearing that app's mark and a name a person can read, and the agent is sent the
       link. Only a paste that is exactly a URL: a sentence with a link in it is prose, and prose
       stays as typed. A URL Realm cannot name is pasted as text, which is what it was. */
    const text = (e.clipboardData?.getData("text/plain") ?? "").trim();
    if (!onLinkPaste || !/^https?:\/\/\S+$/.test(text)) return;
    const chip = onLinkPaste(text);
    if (!chip) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart ?? draft.length, end = el.selectionEnd ?? start;
    const before = draft.slice(0, start), after = draft.slice(end);
    const lead = before === "" || /\s$/.test(before) ? "" : " ";
    const tail = after === "" || /^\s/.test(after) ? " " : " ";
    onDraftChange(`${before}${lead}${elementChipToken(chip.label)}${tail}${after}`);
  };

  /** The hint replaces the placeholder, so it lives and dies with the placeholder: an empty draft
   *  only. A single narrowed const rather than a boolean, so the ⇥ handler and the markup below both
   *  get the string itself out of the one check. */
  const hint = promptHint && draft === "" ? promptHint : null;
  const hintId = `prompt-hint-${session.id}`;

  // The greeting is picked once per session (and re-picked only if the space is renamed or the name
  // arrives late from boot): the time of day is read at that moment, so an open hero never rewrites
  // itself mid-sentence at 6pm.
  const greeting = useMemo(() => heroGreeting({ spaceName, userName, seed: session.id, extra: eggs ? packGreetings : [] }),
    [spaceName, userName, session.id, eggs, packGreetings]);

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
  /** Which `@[label]` tokens are LINK chips, by label — the mirror wears the app's mark on those. */
  const linkByLabel = useMemo(() => new Map((links ?? []).map((l) => [l.label, l])), [links]);
  const linkOf = (tokenText: string): LinkChip | null => { const c = scanElementChips(tokenText)[0]; return c ? linkByLabel.get(c.label) ?? null : null; };
  // Coloured as a mention only if `scanMentions` resolves it — the same call the server re-runs on the
  // sent text. Stale ids get the warning tone the note below the card already explains.
  /* The command ids the mirror may colour — the same list the picker offers, so a run and the popover
     under it can never disagree about whether `/goal` is a command. */
  const commandIds = useMemo(() => slashCommands.map((c) => c.id), [slashCommands]);
  const segments = useMemo(() => highlightSegments(draft, liveMentionIds, staleMentions, commandIds),
    [draft, liveMentionIds, staleMentions, commandIds]);
  /* Chip geometry, in draft offsets rather than pixels. The mirror is behind the textarea and takes no
     pointer events, so a click never reaches a painted run — but it does not have to: the browser has
     already resolved the point to a caret by the time `click` fires, and `selectionStart` is that same
     answer in the coordinate system the chips are already in. */
  const chips = useMemo(() => chipSpans(segments), [segments]);
  /** Where each painted run begins, so a chip span can carry its own draft offset as an attribute. */
  const segStarts = useMemo(() => { const out: number[] = []; let at = 0; for (const s of segments) { out.push(at); at += s.text.length; } return out; }, [segments]);
  /** The chip under the pointer, by start offset. */
  const [hotChip, setHotChip] = useState<number | null>(null);
  /* Hover is the one chip gesture with no selection behind it to read, so it is the one place the
     composer needs real geometry — and it takes it from the mirror's own runs rather than from a
     caret-from-point API, which would have to guess which layer the point belongs to. Nothing else
     changes: the runs are measured, never hit-tested, so the mirror keeps taking no pointer events. */
  const onHoverChip = (e: ReactMouseEvent<HTMLTextAreaElement>) => {
    const m = hl.current;
    let hit: number | null = null;
    if (m && chips.length > 0) {
      for (const el of m.querySelectorAll<HTMLElement>("[data-chip]")) {
        // A run that wraps has one box per line; the pointer is in the chip if it is in any of them.
        for (const r of el.getClientRects()) {
          if (e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) { hit = Number(el.dataset.chip); break; }
        }
        if (hit !== null) break;
      }
    }
    if (hit !== hotChip) setHotChip(hit);
  };

  /**
   * Size the box to its content.
   *
   * Collapsing to 0 first is what makes it SHRINK as well as grow: `scrollHeight` on a box that is
   * already tall enough reports the box, not the text. The written value is compared before it is
   * applied so this is idempotent — which is what lets the observer below call it without cycling.
   */
  const measure = useCallback(() => {
    const el = ta.current; if (!el) return;
    const prev = el.style.height;
    el.style.height = "0px";
    const next = `${Math.min(MAX_ROWS_PX, el.scrollHeight)}px`;
    el.style.height = next;
    if (next !== prev) syncScroll(); // growing past max-height starts scrolling; the mirror follows in the same frame
  }, [syncScroll]);

  useLayoutEffect(() => { measure(); }, [draft, measure]);

  /**
   * Re-measure when the WIDTH changes, and once the webfont has landed.
   *
   * Keying the measurement on the draft alone left the height stale in two ways that both look like
   * "the prompter is a different height for no reason":
   *
   *  - **A pane resize re-wraps the text and nothing re-measured it.** A three-line draft dragged
   *    narrower needs four lines and kept a three-line box, scrolling instead of growing.
   *  - **The first measurement can happen before Inter has loaded**, and an EMPTY box is the case
   *    that shows it: its height is one line of whatever font was resolved at that instant, so a
   *    pane that mounted during the font swap kept a box a pixel or two off every other pane's, for
   *    the life of the session. That is the one the user notices, because two prompters sitting side
   *    by side in a split disagree.
   *
   * Only width is acted on: the observed box's HEIGHT is the thing this effect writes, and reacting
   * to it would be a loop even with the idempotence guard above holding it to two passes.
   */
  const lastWidth = useRef(0);
  useEffect(() => {
    const el = ta.current; if (!el) return;
    void (document as Document & { fonts?: FontFaceSet }).fonts?.ready.then(measure).catch(() => {});
    if (typeof ResizeObserver === "undefined") return; // jsdom
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0;
      if (w === lastWidth.current) return;
      lastWidth.current = w;
      measure();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

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

  // ── `/` commands ───────────────────────────────────────────────────────
  // Same shape as the mention picker above, and deliberately so: to the person typing, `@` and `/`
  // are one gesture with two sigils. What differs is what a pick DOES — a mention becomes part of
  // the message, a command runs and the draft is cleared of it.
  const [slashActive, setSlashActive] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashToken = useMemo(
    () => (slashCommands.length > 0 ? slashQueryAt(draft, Math.min(caret, draft.length)) : null),
    [slashCommands.length, draft, caret],
  );
  const slashMatches = useMemo(
    () => (slashToken ? filterSlashCommands(slashCommands, slashToken.query) : []),
    [slashCommands, slashToken],
  );
  const slashOpen = slashToken !== null && slashMatches.length > 0 && !slashDismissed;
  // Leaving the token clears the dismissal, so a fresh `/` reopens. There is only ever one slash
  // token (it must open the draft), so unlike the mention's this is a plain boolean.
  useEffect(() => { if (slashToken === null && slashDismissed) setSlashDismissed(false); }, [slashToken, slashDismissed]);
  const slashCur = Math.min(slashActive, slashMatches.length - 1);
  /** Run a command and take its token out of the draft. The token is removed BEFORE the command
   *  runs, so one that opens a dialog does not leave `/export` sitting in the box behind it — and
   *  anything else the user had typed after the token survives, because only the token is cut. */
  const pickSlash = (c: SlashCommand) => {
    if (!slashToken) return;
    const rest = draft.slice(slashToken.end).replace(/^\s+/, "");
    setSlashActive(0);
    /* A command that needs an argument is ARMED rather than run: the picker is open, so nothing has
       been typed after it yet, and running now would run it on nothing. The box keeps the command
       and gains a space; Enter is what finishes the gesture (see `send`). */
    if (c.takesArgument && !rest) {
      const armed = `/${c.id} `;
      onDraftChange(armed);
      pendingSel.current = { start: armed.length, end: armed.length };
      return;
    }
    onDraftChange(rest);
    pendingSel.current = { start: 0, end: 0 };
    // What followed the command goes to the command as well as back into the box: `/plan look at the
    // auth code` flips the mode and leaves the sentence ready to send.
    c.run(rest);
  };

  /** The "+" menu's Skills item: prime the @-mention picker — insert `@` at the caret (led by a space
   *  when it would otherwise glue onto a word, a shape mentionQueryAt refuses as an email) and put the
   *  caret after it; the existing picker takes over. Deliberately not a second picker. */
  /**
   * The "+" menu's goal row: put the draft BEHIND `/goal `, so Enter starts it.
   *
   * The same armed shape `pickSlash` leaves for an argument-taking command, with one difference it
   * has to have: `pickSlash` only ever fires on a draft that IS the token, so it can replace the
   * whole box. This can be reached with a sentence already typed, and that sentence is almost
   * always the objective — so it becomes the argument rather than being thrown away.
   */
  const armGoal = () => {
    const typed = draft.trim();
    const armed = typed.startsWith("/goal") ? draft : `/goal ${typed}`;
    onDraftChange(armed);
    // the [draft] layout effect focuses the textarea and puts the caret here
    pendingSel.current = { start: armed.length, end: armed.length };
  };

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
  // will actually receive. Attachments whose disposition is `ignored` — today only the fake agent's,
  // which reads none of them — can't carry a message by themselves, because the adapter would deliver
  // literally nothing, so they don't unlock the button and its tooltip says why.
  const deliverable = attachments.some((a) => attachmentDisposition(kind, a.mime) !== "ignored");

  /* While a turn runs the corner button is Stop, so a message typed into the box has no button of its
     own and the keyboard is its only route. The tooltip on the one button that IS there is where that
     gets said — and it says which of the two things the send will do, because the answer is a setting
     and a tooltip that guessed would be wrong for half of its readers. */
  const stopTitle = draft.trim() || deliverable
    ? midTurnMode === "steer"
      ? `Stop (interrupt). ⌘↵ sends your message instead — ${steerInterrupts(kind) ? "which also stops this turn" : `into the turn ${AGENT_META[kind].label} is running`}.`
      : "Stop (interrupt). ⌘↵ queues your message for when this turn ends."
    : "Stop (interrupt)";
  const send = () => {
    /* A draft that IS a call to an argument-taking command runs it instead of going to the agent.
       This is the other half of `pickSlash`'s arming: by the time an objective has been typed after
       `/goal`, the picker has long since stepped aside (`slashQueryAt` closes it once the caret
       leaves the token), so Enter is the only gesture left to finish the gesture with. */
    const call = slashCallIn(draft, slashCommands);
    if (call) {
      if (!call.rest) return; // `/goal ` on its own has nothing to run on; the box keeps waiting
      onDraftChange("");
      call.command.run(call.rest);
      return;
    }
    const t = draft.trim(); if (!t && !deliverable) return; onSend(t); onDraftChange("");
  };

  /** Apply a list rewrite: the draft is the source of truth, so this is one `onDraftChange` plus the
   *  selection to restore once React has painted the new text (same channel a mention pick uses). */
  const applyEdit = (edit: DraftEdit) => {
    onDraftChange(edit.text);
    pendingSel.current = { start: edit.start, end: edit.end };
  };

  /**
   * A click that lands inside a chip takes the whole token instead of dropping a caret into the
   * middle of one.
   *
   * Both kinds, unlike ⌫ and ←: a click is AIMED. Nobody clicks the third character of `@mac` on the
   * way to somewhere else, whereas the caret arrives there constantly just by moving. Aiming at the
   * pill is the user saying "that thing", and from a selection everything else is already free —
   * typing replaces it, ⌫ removes it, and the selection says so on screen.
   *
   * A drag is left alone: a range the user drew by hand is more specific than anything guessable from
   * it. The caret lands at the token's start rather than its end so that selecting `@mac` does not
   * also reopen the mention picker over the token it just selected.
   */
  const onClickChip = (e: ReactMouseEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd) return;
    const chip = chipAround(chips, el.selectionStart);
    if (!chip) return;
    el.setSelectionRange(chip.start, chip.end);
    setCaret(chip.start);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // ⌘/Ctrl+Enter sends even while the picker is open — the send gesture never changes meaning.
    // Shift is deliberately excluded AND untouched: ⌘⇧↩ is dispatch (Plan 13 W2), bound at the
    // window level in hotkeys.ts — consuming it here would turn dispatch into a plain send.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey) { e.preventDefault(); send(); return; }
    // ⌫ behind and ⌦ in front of an element chip take the whole token (see `deleteChipAt` for why
    // only that kind). A collapsed selection and no modifiers: ⌥⌫ and a live selection are the user
    // already being specific, and guessing wider destroys text they can no longer see.
    if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.ctrlKey && !e.altKey && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
      const edit = deleteChipAt(chips, draft, e.currentTarget.selectionStart ?? 0, e.key === "Backspace" ? -1 : 1);
      if (edit) { e.preventDefault(); applyEdit(edit); return; }
    }
    // ←/→ cross an element chip in one press. Bare arrows only: ⌥← and ⌘← already have widths of their
    // own, and ⇧← is the user drawing a range by hand, which is precisely when a 19-character jump is
    // the wrong help. A live selection collapses to its edge first, the way it does everywhere else.
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
      && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
      const to = stepOverChip(chips, e.currentTarget.selectionStart ?? 0, e.key === "ArrowRight" ? 1 : -1);
      if (to !== null) { e.preventDefault(); e.currentTarget.setSelectionRange(to, to); setCaret(to); return; }
    }
    // ⌘⇧8 bulleted / ⌘⇧7 numbered — the shortcuts these have everywhere else. Keyed off `code`, not
    // `key`: with Shift down the digit row reports "*" and "&", and those differ by layout.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.code === "Digit8" || e.code === "Digit7")) {
      e.preventDefault();
      const el = e.currentTarget;
      applyEdit(toggleList(draft, el.selectionStart, el.selectionEnd, e.code === "Digit7"));
      return;
    }
    // Ahead of the mention branch, and they can never both be open: a mention token needs an `@`
    // preceded by whitespace or nothing, and a slash token has to BE the start of the draft.
    if (slashOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashActive(Math.min(slashMatches.length - 1, slashCur + 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashActive(Math.max(0, slashCur - 1)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(slashMatches[slashCur]!); return; }
      // Escape reaches us through the popover hook's own window listener → onClose → dismissal.
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
  const effortItems = EFFORT_LEVELS.map((l) => ({ label: formatEffort(l), checked: session.effort === l, effort: l, onSelect: () => onOptions({ effort: l }) }));
  /* The switch and the truth, kept apart. `on` is what the session asked for and lives in its row;
     `state`/`reason` are what the last finished turn reported and live on the usage sample — see the
     `usage` event's own note for why those can differ, routinely. Built only when the harness has
     said the model can run it at all. */
  const fast: FastMode | undefined = supportsFastMode
    ? { on: session.fastMode, state: usage.fastMode ?? null, reason: usage.fastModeReason ?? null,
        onChange: (on) => onOptions({ fastMode: on }) }
    : undefined;
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
  /* The active model's context window, joined through the SAME canonical key the picker's rows use —
     the session stores a per-harness wire id (`gpt-5.3-codex[reasoning=medium]`), which no catalog is
     keyed by, so the selected ROW is the only thing that can bridge the two. Null whenever the
     catalog has no entry for the model, which is ordinary rather than exceptional: every adapter
     "Default" row and a good many real models have none, and the ring is simply not drawn there. */
  const contextWindow = useMemo(() => {
    const selected = rows.find((r) => r.selected);
    return (selected && modelInfo[selected.key]?.context) ?? null;
  }, [rows, modelInfo]);

  /* One builder, two targets. In Build the picker writes the LIVE permission; in Plan or Ask it
     writes the park — the value returning to Build will restore — because that is the only real,
     settable thing behind the label there. The bypass confirm is on both paths deliberately: a
     "Full access" chosen in Plan is still a full-access session the moment the plan is approved, and
     a gate you can walk around by being in the right mode is not a gate. */
  const buildPermissionItems = (current: string, apply: (id: string) => void) =>
    PERMISSION_MODES.map((m) => ({
      label: m.label, checked: current === m.id,
      onSelect: () => {
        if (m.id === "bypassPermissions" && current !== "bypassPermissions") { setConfirmBypass(true); return; }
        setConfirmBypass(false);
        apply(m.id);
      },
    }));
  const permissionItems = buildPermissionItems(session.permissionMode, (id) => onOptions({ permissionMode: id }));
  const parked = planReturn ?? "default";
  const parkedItems = buildPermissionItems(parked, (id) => onParkPermission?.(id));

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
          {/* One child, not one per run: the box is a flex container, and each run as its own
              anonymous flex item would have its leading and trailing spaces collapsed away —
              "working on in" would sit flush against the space's name. */}
          <span>
            {greeting.map((part, i) => (part.em ? <em key={i}>{part.text}</em> : <Fragment key={i}>{part.text}</Fragment>))}
          </span>
        </div>
      )}
      {/* The band of tabs above the card, outermost first: who is working, then what the plan is,
          then what the checkout has changed. It reads down the page from the most live fact to the
          least — agents come and go within a turn, a plan lasts a run, a branch lasts a session —
          and each tab draws nothing at all when it has nothing to say.

          Inside the dock, so the hero→docked move carries them and none is left behind
          mid-transition. In flow, so they grow UPWARD into the transcript rather than pushing the
          prompter's own controls off the bottom edge they sit on. */}
      {!compact && <DelegatedRuns sessionId={session.id} />}
      {/* Above the plan, because a goal outranks it: the plan is how this turn is going, the goal is
          why there is a turn at all. */}
      {!compact && goal}
      {!compact && <TodoStrip todos={todos} />}
      {/* Over-strip: the branch and what the checkout has changed, on a tab of their own above the
          card. It was a chip among the workspace chips under the prompter, and a diff is not that
          kind of fact — the row below reports where the session runs and never changes, while this
          moves every time the agent writes a file. Reading it meant finding it in a line of quiet
          labels. Centred, because it is one object on its own strip rather than an item in a row
          with a yielding order, and drawn only when there is a checkout to describe: an empty tab
          is a claim on space with nothing to put in it.
          Between the to-do strip and the card, so the two tabs stack into one frame band rather
          than fighting over the same edge (the join is `.composer-todos + .composer-overstrip` in
          styles.css) and the plan keeps its own top corners. */}
      {gitInfo && !compact && (
        <div className="composer-overstrip">
          <GitChip gitInfo={gitInfo} onOpenDiff={onOpenDiff} />
        </div>
      )}
      {/* The whole card is the drop target — aiming at a 44px textarea with a file in hand is a chore.
          §6 forbids animating during a drag, so the state change is a static ring, not a transition. */}
      {/* The card wears the MODE. Ask and Plan both mean "the agent will not change anything", and
          that is the single most consequential fact about the next send — worth more than a chip in
          a row of chips, which is where it used to live alone. Build is the default and stays
          neutral: a colour that is always on is a colour that says nothing. */}
      <div className="composer" data-mode={mode} data-dropping={drop.dropping || itemDrop.dropping || undefined} {...bothDrops}>
        <LimitRow limits={planLimits} />
        <QueueRow kind={kind} queued={queued} onRelease={onReleaseQueued ?? (() => {})} onDrop={onDropQueued ?? (() => {})} />
        <AttachmentRow kind={kind} attachments={attachments} onRemove={onRemoveAttachment} />
        <SessionRefRow refs={sessionRefs} onRemove={onRemoveSessionRef ?? (() => {})} />
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
            {segments.map((s, i) => {
              if (!s.kind) return s.text;
              const link = s.kind === "element" ? linkOf(s.text) : null;
              /* Every chip wears an icon over the sigil that opens its token — a skill mention's
                 `@`, a picked element's `@[`, a link's `@[` with the app's own mark — and the
                 delimiters go transparent. The token keeps every character, so the mirror stays the
                 width of the textarea's text under it (the rule draft-format.ts states), and the
                 eye sees an icon, a name and nothing else: no fill, no box. */
              const icon = link ? LINK_SERVICE_META[link.service].icon : s.kind === "element" ? "target" : s.kind === "mention" ? "sparkles" : null;
              const open = s.kind === "mention" ? 1 : 2; // `@` or `@[`
              return (
                <span key={i} className={`ch-${s.kind}`} data-service={link?.service}
                  data-chip={isChipKind(s.kind) ? segStarts[i] : undefined}
                  data-hot={(isChipKind(s.kind) && segStarts[i] === hotChip) || undefined}
                  title={link ? `${LINK_SERVICE_META[link.service].label} · ${link.url}` : undefined}>
                  {icon
                    ? <><span className="chip-sigil">{s.text.slice(0, open)}<Icon name={icon} size={s.kind === "mention" ? 12 : 14} className="chip-mark" /></span>{s.kind === "mention" ? s.text.slice(open) : s.text.slice(open, -1)}{s.kind !== "mention" && <span className="chip-sigil">]</span>}</>
                    : s.text}
                </span>
              );
            })}
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
          <textarea ref={ta} className="composer-input" aria-label="Message" placeholder={hint ? "" : "Ask anything"} rows={1}
            value={draft} onChange={(e) => { onDraftChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setMentionActive(0); setSlashActive(0); setHotChip(null); }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onClick={onClickChip} onMouseMove={onHoverChip} onMouseLeave={() => setHotChip(null)}
            onKeyDown={onKeyDown} onPaste={onPaste} onScroll={syncScroll}
            aria-describedby={hint ? hintId : undefined}
            aria-controls={slashOpen ? "slash-list" : mentionOpen ? "mention-list" : undefined}
            aria-activedescendant={slashOpen ? `slash-${slashMatches[slashCur]!.id}`
              : mentionOpen ? `mention-${mentionMatches[mentionCur]!.id}` : undefined} />
        </div>
        {slashOpen && (
          <SlashPicker commands={slashMatches} activeIndex={slashCur} anchorRef={ta}
            onPick={pickSlash} onHover={setSlashActive} onClose={() => setSlashDismissed(true)} />
        )}
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
        {drop.dropping && <div className="composer-drop-hint" aria-hidden="true">Drop to attach</div>}
        {itemDrop.dropping && <div className="composer-drop-hint" aria-hidden="true">Drop to point this message at that session</div>}
        <div className="composer-bar">
          <div className="composer-opts" ref={optsRef} data-collapsed={collapsed || undefined}>
            {/* The "+" opens the add menu now (Plan 12 W1) — its Add files… reaches the SAME picker
                through the same handler the bare attach button used to call directly. */}
            <PlusMenu onAttachPick={onAttachPick} onAddFolder={() => onAddFolder?.()}
              onSkills={() => setSkillPickerOpen(true)} canSkills={allSkills.length > 0}
              onGoal={slashCommands.some((c) => c.id === "goal") ? armGoal : null}
              connectors={connectors} onOpened={() => onConnectorsOpened?.()}
              onManageConnections={() => onManageConnections?.()}
              mode={mode} modeItems={modeItems} modeTitle={modeTitle} modePending={acpModesPending}
              canChooseMode={canPlan || canAsk} btnRef={plusRef} />
            {/* Left group order (prompter rework): "+" · permission · mode · branch. The permission
                and mode chips sit against the attach button; the git chip trails them. */}
            {/* In Plan and in Ask the permission mode is not in effect — Claude's `plan` replaces it
                outright, Realm's own gate refuses in Ask, and Codex forces read-only either way — so
                the picker writes the PARK instead of the live value: what returning to Build will
                restore. It was a dead label for exactly that reason, which was half right. Offering a
                picker whose selection changes nothing would be a lie; so would having no way to
                answer "what should happen when I approve this plan?" at the moment you are asking
                it. Same control, same list, pointed at the value that is actually settable here. */}
            {/* One chip, ungrouped. The mode moved into the "+" menu (see PlusMenu), and with it the
                reason this pair was drawn as a segmented control — a group of one is nine seam rules
                that can never fire, and it left the permission chip wearing a squared corner and a
                hairline ring that no other chip in the row has. */}
            {canSetPermissionMode && !compact && (
              inReadOnly
                ? <ChipMenu ariaLabel="Permission mode" warning={parked === "bypassPermissions"}
                    title={`${MODE_LABEL[mode]} is read-only — this is what returning to Build will restore`}
                    label={permissionLabel(parked)} items={parkedItems} />
                : !collapsed && <ChipMenu ariaLabel="Permission mode" warning={session.permissionMode === "bypassPermissions"}
                    label={permissionLabel(session.permissionMode)} items={permissionItems} />
            )}
            {confirmBypass && (
              <button className="composer-chip bypass-confirm"
                onClick={() => { setConfirmBypass(false); if (inReadOnly) onParkPermission?.("bypassPermissions"); else onOptions({ permissionMode: "bypassPermissions" }); }}>
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
              onPick={onPickModel} effortItems={effortItems} overflow={overflow} fast={fast} eggs={eggs} />
            {/* Send↔stop morph (§6): both icons stay in the DOM; data-state cross-fades them (160ms,
                opacity + scale .25→1 + 4px blur). ⌘↵ still sends while running — only the button morphs. */}
            {/* Attachments the agent will receive can go alone (Plan 14 W5 relaxed sessions.send's
                text.min(1) for exactly this); ones it would IGNORE cannot — rather than let the
                button look broken there, it says why. */}
            <button className="composer-send" data-state={running ? "stop" : "send"}
              aria-label={running ? "Stop" : "Send"}
              title={running ? stopTitle
                : !draft.trim() && attachments.length > 0 && !deliverable ? `${AGENT_META[kind].label} ignores these attachments — add a message to send`
                : "Send (⌘↵)"}
              disabled={!running && !draft.trim() && !deliverable}
              onClick={() => (running ? onStop() : send())}>
              <Icon name="arrowUp" size={16} className="send-icon" />
              <Icon name="stop" size={14} className="stop-icon" />
            </button>
          </div>
        </div>
      </div>
      {/* Under-strip (Plan 12 W1): where this session runs. In normal flow inside .composer-dock so
          the hero→docked move — one transform on the dock (§6: 320ms) — carries it untouched. */}
      {!compact && (
      <div className="composer-understrip">
        {machineName && (
          // Display only, deliberately: Realm runs agents on this Mac and no other. The selector
          // ships when remote execution does (roadmap: pairing) — no caret, no one-item dropdown.
          <span className="ghost-chip strip-machine" data-static title={`Agents run on this Mac — ${machineName}`}>
            <Icon name="laptop" size={12} className="chip-brand" />
            <span className="chip-label">{machineName}</span>
          </span>
        )}
        <ChipMenu ariaLabel="Workspace" icon={envIcon} label={envLabel} items={envItems}
          title={canSwitchAgent ? `Workspace: ${envLabel}` : `Workspace: ${envLabel} — a session's checkout can only change before its first message`} />
        {/* The branch group is NOT here any more — it has the over-strip above the card (see there
            for why). What is left is standing context: the machine, the workspace, and the meter.
            None of it is user data of unbounded length now, so nothing on this row has to yield. */}
        <div className="understrip-end">
          {status === "running" && <div className="composer-thinking"><span>Thinking…</span></div>}
          <SessionUsage usage={usage} contextWindow={contextWindow} />
        </div>
      </div>
      )}

    </div>
  );
}
