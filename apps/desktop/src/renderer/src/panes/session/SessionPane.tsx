import { Icon, type IconName } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { AGENT_SKILL_SUPPORT, MAC_SKILL_ID, PLAN_PERMISSION_MODE, basenameOf, offeredModes, sessionModeOf, type Item, type LinkChip, type MentionRef, type UnlabelledRef, type SessionMode, type Skill, runnableCommands, type UserCommand, type TurnChanges } from "@realm/contracts";

/** A stable empty list for the commands selector. A fresh `[]` in the selector is a new reference on
 *  every render, which is how a zustand subscription turns into a render loop. */
const EMPTY_COMMANDS: readonly UserCommand[] = Object.freeze([]);

/** Stable empty array for `useSyncExternalStore`: a fresh `[]` per render reads as a change forever. */
const NO_LINKS: LinkChip[] = [];
import { spaceIsPlainFolder, useApp, type PickedAttachment } from "../../state/store";
import { agentAvailability, isBlocked } from "../../state/agent-availability";
import type { PaneProps } from "../registry";
import type { MenuItem } from "../../components/Menu";
import { Composer, type QueueActions } from "./Composer";
import { useFileDrop } from "../../components/use-file-drop";
import { InstallCard } from "./InstallCard";
import { Transcript } from "./Transcript";
import { SubagentPanel } from "./SubagentPanel";
import { RunningAgents } from "./DelegatedRuns";
import { TerminalDock } from "./TerminalDock";
import { emptyTranscript } from "./transcript-model";
import { promptHint } from "./prompt-hint";
import { latestTodos } from "./session-todos";
import { SessionSummaryHost, useSummaryLive } from "./SessionSummary";
import { SessionFilesHost } from "./SessionFiles";
import { GoalStrip } from "./GoalStrip";
import { useSelectInRealm } from "../../app-pick/start";
import { PathMenu, asRef } from "./PathMenu";
import { useSpaceTint } from "../../components/sidebar/use-sidebar-model";
import type { SlashCommand } from "./slash-commands";
import { MediaSessionContext } from "../../components/viewer/open";

/** Stable empty array: a fresh `[]` from the selector on every render makes useSyncExternalStore
 *  re-render (and warn) forever. */
const NO_ATTACHMENTS: PickedAttachment[] = [];
const NO_SKILLS: Skill[] = [];
const NO_MENTIONS: string[] = [];
const NO_REFS: MentionRef[] = [];
const NO_SAVED: number[] = [];

const STATUS_LABEL = { idle: "Idle", running: "Running", waiting_permission: "Needs permission", error: "Error", ended: "Ended" } as const;


/** PanelBar right-side meta for a session item: model label, cost (only once real spend exists), status dot.
 *  PanelBar owns the icon + title; this is everything the old .session-header showed on its right. */
export function SessionMeta({ item }: { item: Item }) {
  const id = item.refId;
  const status = useApp((s) => s.sessionStatus[id] ?? s.sessions[id]?.status ?? "idle");
  return (
    <>
      {/* The status dot, alone. The cost used to sit here; it now rides the summary button, which is
          where the rest of what a session produced already lives — and a number in the bar was one
          more thing competing with the title for a strip that has four buttons on the other end. */}
      {/* The agents this session has working — at the bar's right, where "what is it doing" is read. */}
      <RunningAgents sessionId={id} />
      <span className="status-dot" data-status={status} title={STATUS_LABEL[status]} aria-label={`Status: ${STATUS_LABEL[status]}`} />
    </>
  );
}

/** What each mode's `/`-command says in the picker. The ids ARE the mode ids — `/plan`, `/ask`,
 *  `/build` — because a command is typed from memory and the word it is named after is the word on
 *  the chip. */
const MODE_COMMAND: Record<SessionMode, { label: string; hint: string; icon: "tool" | "plan" | "search" }> = {
  build: { label: "Build", hint: "Read, write and run — the usual way", icon: "tool" },
  plan: { label: "Plan", hint: "Work out an approach without changing anything", icon: "plan" },
  ask: { label: "Ask", hint: "Questions only — no edits, no commands", icon: "search" },
};

/**
 * A session's own actions, as data — one list, read by the bar and by the ⋯ menu.
 *
 * Data rather than a component per button, because the two halves have to agree: the bar draws the
 * first `keep` of them (components/pane-bar-fit.ts) and the menu picks up exactly where it left off.
 *
 * What is here is what is about THIS session, and nothing else: the panels that dock to the session's
 * own pane. The tools a session opens beside itself — documents, the terminal, its agents, a page, a
 * device, a machine — are launched from the side pane they open in (`side-tools.ts`), which is where
 * the seven glyphs this bar used to carry now live. A bar of icons that each open something somewhere
 * else said nothing about the session it headed, and was the loudest thing at the top of the window.
 */
type BarAction = {
  id: string;
  /** The menu's wording: a phrase, because a row has room for one. */
  label: string;
  /** The button's tooltip: the short form of the same thing. */
  title: string;
  icon: IconName;
  /** The button's accessible name, which names the pane — two session panes in a split otherwise
   *  offer a screen reader two identically-named buttons. The menu row is already inside a menu
   *  labelled for the pane, so it takes the plain `label`. */
  aria: string;
  onSelect: () => void;
  /** A toggle: `data-on` on the button, a tick in the menu. */
  on?: boolean;
  /** `aria-pressed` instead of `data-on`. The two are one appearance and two accessible names: a
   *  toggle whose NAME holds still takes `pressed`; one whose name flips to its next action takes
   *  `on`, because "Hide terminal, pressed" is a sentence at war with itself. */
  pressed?: boolean;
  /** It opens a docked panel rather than doing something — the button says so. */
  dialog?: boolean;
};

function useSessionActions(item: Item): BarAction[] {
  const id = item.refId;
  const dock = useApp((s) => s.sessionDock[id]?.kind);
  const toggleSessionDock = useApp((s) => s.toggleSessionDock);
  const closeSessionDock = useApp((s) => s.closeSessionDock);
  const terminalDocked = useApp((s) => s.terminalDock === "bottom");
  const showSessionTerminal = useApp((s) => s.showSessionTerminal);
  const summaryLive = useSummaryLive(item);
  const run = useApp((s) => s.run);
  return useMemo(() => {
    const list: BarAction[] = [];
    /* What the session made, from both of the places that know: the summary, folded out of the
       transcript (outputs, sources, plans, spend), and its files, read off the disk — which is the
       only list that has a file a shell line or a script wrote. Two answers to one question ("where
       did that go?") are one control, and the panel says which it is showing (DockViews). Always
       offered, because the files always have something to show; it opens on the summary once there
       is one. */
    const open = dock === "summary" || dock === "files";
    list.push({
      id: "summary", label: "Summary and files", title: "Summary and files", icon: "info",
      aria: `Summary and files for ${item.title}`, dialog: true, on: open,
      onSelect: () => (open ? closeSessionDock(id) : toggleSessionDock(id, { kind: summaryLive ? "summary" : "files" })),
    });
    /* The terminal is a tab of the side pane, launched from there — unless Settings has docked it to
       this pane's foot, where it is the session's own panel and this bar is what shows and hides it. */
    if (terminalDocked) list.push({
      id: "terminal", label: "Terminal", title: "Terminal (⌘J)", icon: "terminal",
      aria: `${dock === "terminal" ? "Hide" : "Show"} terminal for ${item.title}`, dialog: true, pressed: dock === "terminal",
      onSelect: () => run(() => showSessionTerminal(id)),
    });
    return list;
  }, [id, item.title, dock, terminalDocked, summaryLive, toggleSessionDock, closeSessionDock, showSessionTerminal, run]);
}

/**
 * PanelBar action cluster for a session. `keep` is how many of the list above still fit as buttons;
 * the rest are in the ⋯ menu, put there by `useSessionMenuItems`.
 *
 * The two hosts are outside the slice on purpose: each mounts a docked panel and its lightbox, and
 * those have to stay whatever the bar has room for. An action that moved into the ⋯ menu must still
 * be able to open the thing it opens.
 */
export function SessionPanelActions({ item, keep }: { item: Item; keep: number }) {
  const actions = useSessionActions(item);
  return (<>
    {actions.slice(0, keep).map((a) => (
      <button key={a.id} className="icon-btn" data-on={a.on || undefined}
        aria-label={a.aria} title={a.title} aria-pressed={a.pressed}
        aria-haspopup={a.dialog ? "dialog" : undefined}
        aria-expanded={a.dialog ? (a.on ?? a.pressed ?? false) : undefined}
        onClick={a.onSelect}>
        <Icon name={a.icon} size={14} />
      </button>
    ))}
    <SessionSummaryHost item={item} />
    <SessionFilesHost item={item} />
  </>);
}

/** The overflow, as menu rows — the same cluster, continued. The separator goes BELOW them so they
 *  read as the group they came from rather than as the first of the layout rows. */
export function useSessionMenuItems(item: Item, keep: number): MenuItem[] {
  const actions = useSessionActions(item);
  return useMemo(() => {
    if (item.kind !== "session") return [];
    const overflow = actions.slice(keep);
    if (overflow.length === 0) return [];
    /* Fenced on both sides: these are the bar's cluster, continued, and without the leading rule they
       read as a continuation of Rename instead — one list of five unrelated things at the top of the
       menu. */
    return [
      { kind: "separator" },
      ...overflow.map((a): MenuItem => ({
        label: a.label,
        icon: <Icon name={a.icon} size={14} />,
        // A toggle keeps saying which way it is pointing; a plain action must not grow a tick column.
        checked: a.on ?? a.pressed,
        onSelect: a.onSelect,
      })),
      { kind: "separator" },
    ];
  }, [actions, keep, item.kind]);
}

/**
 * Where a peek's prompter would be (W11b): what the tab is, which space the session lives in when it
 * is not this one, and the way in. Peeks answer cards and nothing more — no composer, by the user's
 * decision — so writing to the session is opening it, and the button says where that will be.
 */
function PeekBar({ spaceName, elsewhere, onOpen }: { spaceName: string; elsewhere: boolean; onOpen: () => void }) {
  return (
    <div className="peek-bar" role="group" aria-label="Peek">
      <span className="peek-where"><Icon name="peek" size={14} /><span className="peek-where-text">{elsewhere ? `Peek · ${spaceName}` : "Peek"}</span></span>
      <button type="button" className="btn" onClick={onOpen}
        title={elsewhere ? `Switches to ${spaceName} and opens it there` : "Keeps it as a tab here"}>Open session</button>
    </div>
  );
}

/** Transcript + composer for one agent session (item.refId = session id). PanelBar renders the header. */
/** Stable, so a pane with no references hands the Composer the same array every render. */
const EMPTY_REFS: readonly { sessionId: string; title: string; agent: string }[] = [];

const trimSlash = (path: string): string => path.replace(/\/+$/, "");

export function SessionPane({ item, visible, focused = false }: PaneProps) {
  const id = item.refId;
  const session = useApp((s) => s.sessions[id]);
  const items = useApp((st) => st.items);
  const sessions = useApp((st) => st.sessions);
  const sessionRefs = useApp((st) => st.draftSessionRefs[id]) ?? EMPTY_REFS;
  const addSessionRef = useApp((st) => st.addSessionRef);
  const removeSessionRef = useApp((st) => st.removeSessionRef);
  const [refNote, setRefNote] = useState<string | null>(null);
  /* The agent kind is read off the session the item points at, so the pill wears the right mark. A
     session whose row has not loaded yet falls back to this one's kind rather than to nothing —
     a pill with no mark reads as a broken image. */
  const sessionAgent = (refId: string): string => sessions[refId]?.agentKind ?? session?.agentKind ?? "claude";
  const status = useApp((s) => s.sessionStatus[id] ?? s.sessions[id]?.status ?? "idle");
  const entry = useApp((s) => s.transcripts[id]);
  const spaces = useApp((s) => s.spaces);
  const moveSessionToSpace = useApp((s) => s.moveSessionToSpace);
  const openSession = useApp((s) => s.openSession);
  const sendMessage = useApp((s) => s.sendMessage);
  const interruptSession = useApp((s) => s.interruptSession);
  const queued = useApp((s) => s.sessionQueues[id]);
  const midTurnMode = useApp((s) => s.midTurnMode);
  // This session's own agent's row. A warning about the Claude account means nothing in a Cursor
  // pane, so the row is selected by kind rather than showing whichever provider warned last.
  const planLimits = useApp((s) => s.planLimits.find((r) => r.agentKind === s.sessions[id]?.agentKind) ?? null);
  const refreshSessionQueue = useApp((s) => s.refreshSessionQueue);
  const releaseQueuedPrompt = useApp((s) => s.releaseQueuedPrompt);
  const beginQueuedEdit = useApp((s) => s.beginQueuedEdit);
  const cancelQueuedEdit = useApp((s) => s.cancelQueuedEdit);
  const saveQueuedEdit = useApp((s) => s.saveQueuedEdit);
  const dequeuePrompt = useApp((s) => s.dequeuePrompt);
  const retryLastTurn = useApp((s) => s.retryLastTurn);
  const rateMessage = useApp((s) => s.rateMessage);
  const respondPermission = useApp((s) => s.respondPermission);
  const setParkedPermission = useApp((s) => s.setParkedPermission);
  const openSheet = useApp((s) => s.openSheet);
  const openAgentsTabFor = useApp((s) => s.openAgentsTab);
  const setSessionOptions = useApp((s) => s.setSessionOptions);
  const setSessionAgent = useApp((s) => s.setSessionAgent);
  const setSessionMode = useApp((s) => s.setSessionMode);
  const planReturn = useApp((s) => s.planReturn[id] ?? null);
  /* Looked at, not opened: a peek keeps the transcript and its cards and gives up the prompter. */
  const peek = useApp((s) => s.peek?.item.id === item.id);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const openPeek = useApp((s) => s.openPeek);
  const run = useApp((s) => s.run);
  const markSessionSeen = useApp((s) => s.markSessionSeen);
  /* Stable, so the queue's rows are not handed a new set of callbacks on every keystroke of the draft. */
  const queueActions = useMemo<QueueActions>(() => ({
    onRelease: (queuedId) => run(() => releaseQueuedPrompt(id, queuedId)),
    onDrop: (queuedId) => run(() => dequeuePrompt(id, queuedId)),
    onBeginEdit: (queuedId) => beginQueuedEdit(id, queuedId).catch(() => false),
    onSaveEdit: (queuedId, text) => run(() => saveQueuedEdit(id, queuedId, text)),
    onCancelEdit: (queuedId) => run(() => cancelQueuedEdit(id, queuedId)),
  }), [id, run, releaseQueuedPrompt, dequeuePrompt, beginQueuedEdit, saveQueuedEdit, cancelQueuedEdit]);
  const transcript = entry?.t ?? emptyTranscript();
  /* Having the pane with the keyboard IS reading it. `applySessionEvent` stamps what arrives while the
     pane is focused; this stamps what was already here when the focus did. Without it a session
     opened to read its news kept the unread ring — and its row in every list of what needs you —
     until it said something new. Unfocused, nothing: a pane restored behind another one has been
     opened, not read. Nor in a window nobody is looking at — and coming back to the window is when
     the focused pane is read, so the effect runs again then. */
  const readTo = entry?.lastSeq ?? 0;
  const windowActive = useApp((s) => s.windowActive);
  useEffect(() => { if (focused && windowActive && readTo > 0) void run(() => markSessionSeen(id)); }, [focused, windowActive, readTo, id, markSessionSeen, run]);
  // Store-owned, keyed by session id (A-M9): layout reshapes/remounts never lose typed text, and a
  // suggestion chip in the empty state can fill the draft without sending it. The pane only WRITES it;
  // the composer reads it (`DraftedComposer`), so a keystroke re-renders the composer and not this.
  const setDraft = useApp((s) => s.setDraft);
  /* `session` is not proven until the early return below, and a hook cannot move past it — hence the
     optional chain. The store refreshes this list when a session opens; the pane only reads it. */
  const spaceCommands = useApp((s) => (session ? s.spaceCommands[session.spaceId] : undefined) ?? EMPTY_COMMANDS);
  const expandCommand = useApp((s) => s.expandCommand);
  const startGoal = useApp((s) => s.startGoal);
  const setGoalStatus = useApp((s) => s.setGoalStatus);
  const resumeGoal = useApp((s) => s.resumeGoal);
  const clearGoal = useApp((s) => s.clearGoal);
  const addLinkChip = useApp((s) => s.addLinkChip);
  const selectInRealm = useSelectInRealm(id);
  const draftLinks = useApp((s) => s.draftLinks[id] ?? NO_LINKS);
  // Attachments are part of the draft and are held the same way, for the same reason.
  const attachments = useApp((s) => s.pendingAttachments[id] ?? NO_ATTACHMENTS);
  // The @-mention picker's source (W4): the space's library, narrowed to what THIS session's agent can
  // be handed — empty for a Cursor (or fake) session, which is what keeps `@` from opening anything
  // there. `spaceSkills` rows are store-held references, so the memo only re-filters on real change.
  const spaceSkillList = useApp((s) => { const sess = s.sessions[id]; return (sess && s.spaceSkills[sess.spaceId]) || NO_SKILLS; });
  /* @Mac: the `mac` skill, offered wherever the space's library holds it — on or off, and whatever the
     agent, because where it cannot be invoked it is handed over by its instructions instead. */
  const macSkill = useMemo(() => spaceSkillList.find((k) => k.id === MAC_SKILL_ID && k.valid) ?? null, [spaceSkillList]);
  const agentKind = useApp((s) => s.sessions[id]?.agentKind);
  /* What harnesses have said about fast mode, per model — the answer a session that has not started
     yet can offer the switch on. Its own `init` overrides it the moment it has one. */
  const fastSupport = useApp((s) => s.fastSupport);
  const effortSupport = useApp((s) => s.effortSupport);
  const mentionSkills = useMemo(
    () => (agentKind && AGENT_SKILL_SUPPORT[agentKind] === "injected" ? spaceSkillList.filter((k) => k.enabled && k.valid) : NO_SKILLS),
    [agentKind, spaceSkillList],
  );
  // The transcript recognises a sent message's `@name` against this same live set, so a bubble's
  // chips and the composer's agree about what is a skill and what is just an address.
  const liveMentionIds = useMemo(() => {
    const ids = mentionSkills.map((k) => k.id);
    return macSkill && !ids.includes(MAC_SKILL_ID) ? [...ids, MAC_SKILL_ID] : ids;
  }, [mentionSkills, macSkill]);
  // The "+ → Skills" picker's source: the same space list, unfiltered by enabled — the picker's whole
  // job is to show what is NOT on yet. Still gated on the agent, because a Cursor session cannot be
  // handed a skills directory at all and a picker there would promise something that never arrives.
  const allSkills = useMemo(
    () => (agentKind && AGENT_SKILL_SUPPORT[agentKind] === "injected" ? spaceSkillList : NO_SKILLS),
    [agentKind, spaceSkillList],
  );
  const draftMentionIds = useApp((s) => s.draftMentions[id] ?? NO_MENTIONS);
  // Recognised mentions whose skill has since been disabled/deleted — the draft still carries the
  // token, so the prompter warns that it will go as plain text.
  const staleMentions = useMemo(() => {
    const live = new Set(liveMentionIds);
    return draftMentionIds.filter((m) => !live.has(m));
  }, [draftMentionIds, liveMentionIds]);
  const attachFiles = useApp((s) => s.attachFiles);
  const attachFromPicker = useApp((s) => s.attachFromPicker);
  const removeAttachment = useApp((s) => s.removeAttachment);
  // Under-strip + "+" menu (Plan 12 W1).
  const machineName = useApp((s) => s.machineName);
  const userName = useApp((s) => s.userName);
  const environments = useApp((s) => s.environments);
  const setSessionEnvironment = useApp((s) => s.setSessionEnvironment);
  const moveSessionToNewWorktree = useApp((s) => s.moveSessionToNewWorktree);
  // A plain folder has no worktrees, so its prompter offers none (store.ts, `spaceIsPlainFolder`).
  const plainFolder = useApp((s) => (session ? spaceIsPlainFolder(s, session.spaceId) : false));
  const connectors = useApp((s) => { const sess = s.sessions[id]; return (sess && s.connectors[sess.spaceId]) ?? null; });
  const refreshConnectors = useApp((s) => s.refreshConnectors);
  const pickAndLinkProject = useApp((s) => s.pickAndLinkProject);
  const openSpacePage = useApp((s) => s.openSpacePage);
  const setSkillEnabled = useApp((s) => s.setSkillEnabled);
  const spaceEnvironments = useMemo(
    () => Object.values(environments).filter((e) => session && e.spaceId === session.spaceId),
    [environments, session],
  );
  // The environments map loads with the profile, which may be BEFORE this session (and its
  // lazily-created primary row) exists — so a session whose own environment is missing from the map
  // re-fetches its space's once. Also what makes the diff button above appear.
  const refreshEnvironments = useApp((s) => s.refreshEnvironments);
  const missingOwnEnv = session !== undefined && !environments[session.environmentId];
  const ownSpace = session?.spaceId ?? null;
  useEffect(() => { if (missingOwnEnv) run(() => refreshEnvironments(ownSpace)); }, [missingOwnEnv, ownSpace, refreshEnvironments, run]);
  /* Once per mounted session: the pane catching up on a queue that filled while it was closed. */
  useEffect(() => { run(() => refreshSessionQueue(id)); }, [id, refreshSessionQueue, run]);
  /* The turns saved in this log, for its track, read once as the pane mounts and kept by `session.saved`;
     and a prompt to open AT, when the Library sent the reader here for one. */
  const savedSeqs = useApp((s) => s.savedTurns[id] ?? NO_SAVED);
  const saveTurn = useApp((s) => s.saveTurn);
  const refreshSavedTurns = useApp((s) => s.refreshSavedTurns);
  useEffect(() => { run(() => refreshSavedTurns(id)); }, [id, refreshSavedTurns, run]);
  const onSaveTurn = useCallback((seq: number, saved: boolean) => { run(() => saveTurn(id, seq, saved)); }, [id, saveTurn, run]);
  const promptFor = useApp((s) => (s.promptFor?.sessionId === id ? s.promptFor : null));
  const promptTaken = useApp((s) => s.promptTaken);
  const gitInfo = useApp((s) => { const cwd = s.sessions[id]?.cwd; return cwd ? s.gitInfo[cwd] ?? null : null; });
  // What is docked to this pane's right edge, if anything — one strip, one occupant.
  const dock = useApp((s) => s.sessionDock[id]);
  const closeSessionDock = useApp((s) => s.closeSessionDock);
  const terminalDocked = useApp((s) => s.terminalDock === "bottom");
  /* A callback ref, and the panel is gated on the STATE it sets — not on the ref alone.
     React attaches refs bottom-up, so a child rendered inside this div runs its own layout effect
     before this div's ref is assigned: the panel measured `null`, fell back to the whole window,
     and pinned itself without the pane ever being told to make room. Setting state re-renders once
     with the node in hand, which is what the gate below waits for. */
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  const setPane = useCallback((el: HTMLDivElement | null) => { paneRef.current = el; setPaneEl(el); }, []);
  /* Opened from a list of sessions — the Active rows, another room's list, a notification — so the
     keyboard lands here, in the prompter, and the hand that clicked can type. Unless something in the
     pane already has it: a permission card takes the keyboard for itself the moment it is on screen
     (U-H4), and the answer it is asking for comes first. Either way the request is spent
     (`keyboardTaken`), so a later remount of this pane never pulls the caret back out of wherever the
     person has put it since. */
  const keyboardFor = useApp((s) => (s.keyboardFor?.sessionId === id ? s.keyboardFor.n : 0));
  const keyboardTaken = useApp((s) => s.keyboardTaken);
  useEffect(() => {
    if (!focused || !paneEl || keyboardFor === 0) return;
    if (!paneEl.contains(document.activeElement)) paneEl.querySelector<HTMLElement>(".composer-input")?.focus();
    keyboardTaken(keyboardFor);
  }, [focused, paneEl, keyboardFor, keyboardTaken]);
  const agentProbe = useApp((s) => s.agentProbe);
  const probeAgents = useApp((s) => s.probeAgents);
  const modelFavorites = useApp((s) => s.modelFavorites);
  const modelInfo = useApp((s) => s.modelInfo);
  const refreshModelCatalog = useApp((s) => s.refreshModelCatalog);
  const refreshModelFavorites = useApp((s) => s.refreshModelFavorites);
  const refreshFastSupport = useApp((s) => s.refreshFastSupport);
  const toggleModelFavorite = useApp((s) => s.toggleModelFavorite);
  const prefillTerminal = useApp((s) => s.prefillTerminal);
  const cliStatus = useApp((s) => s.cliStatus);
  const cliJob = useApp((s) => (session ? s.cliJobs[session.agentKind] : undefined));
  const runCliAction = useApp((s) => s.runCliAction);
  const startSignIn = useApp((s) => s.startSignIn);
  const dismissCliJob = useApp((s) => s.dismissCliJob);
  const refreshCliStatus = useApp((s) => s.refreshCliStatus);
  const cliRow = session ? cliStatus.find((r) => r.kind === session.agentKind) : undefined;
  const openDiff = useApp((s) => s.openDiff);
  const exportSession = useApp((s) => s.exportSession);
  const submitKey = useApp((s) => s.submitKey);
  const easterEggs = useApp((s) => s.easterEggs);
  // Stable across renders: InstallCard registers it as a window "focus" listener.
  const reprobe = useCallback(() => { run(() => probeAgents(true)); }, [probeAgents, run]);
  // Sends from THIS prompter, counted so the transcript can pin to the bottom on each one. Counted
  // here rather than off the transcript's own growth because only the prompter's send carries the
  // intent: ⌘⇧↩ dispatches the draft into a NEW session (store.dispatchDraft, bound in the keymap, keys/)
  // and must leave this scroller exactly where the reader parked it.
  const [sends, setSends] = useState(0);
  /* A passage quoted out of the transcript, on its way to the prompter. Held HERE because the two
     components that need it are siblings — the bar that reads the selection and the card that owns
     the caret — and a counter rather than a bare string so that quoting the same sentence twice is
     two events rather than one prop that did not change. */
  const [quote, setQuote] = useState<{ text: string; n: number } | null>(null);
  /** The file path whose menu is open, and the element it was clicked on. */
  const [pathMenu, setPathMenu] = useState<{ path: string; at: HTMLElement } | null>(null);
  /* A file the prose names inside this session's checkout opens straight in the documents pane, at
     the line it named — beside the session, as the side pane's Documents does, never in its place.
     Stable, because every finished message re-checks its links against it. */
  const openDocumentPath = useApp((s) => s.openDocumentPath);
  const ownEnvironmentId = session?.environmentId ?? null;
  const checkoutRoot = useApp((s) => { const sess = s.sessions[id]; return sess ? s.environments[sess.environmentId]?.path ?? sess.cwd : null; });
  const openFileAt = useCallback((path: string, line: number | null) => { run(() => openDocumentPath(path, ownEnvironmentId, null, { line: line ?? undefined, beside: { sessionId: id } })); },
    [run, openDocumentPath, ownEnvironmentId, id]);
  const checkout = useMemo(() => (checkoutRoot ? { root: checkoutRoot, onOpen: openFileAt } : null), [checkoutRoot, openFileAt]);
  /* The edit cards' half: every checkpoint in this checkout (whether a turn's Undo is honest), the
     turn's own diff for Review, and Undo through the checkpoint restore's own confirmation. */
  const envCheckpoints = useApp((s) => (ownEnvironmentId ? s.envCheckpoints[ownEnvironmentId] : undefined));
  const refreshEnvCheckpoints = useApp((s) => s.refreshEnvCheckpoints);
  const openCheckpoints = useApp((s) => s.openCheckpoints);
  const askRestoreCheckpoint = useApp((s) => s.askRestoreCheckpoint);
  const reviewTurn = useApp((s) => s.reviewTurn);
  useEffect(() => { if (ownEnvironmentId) run(() => refreshEnvCheckpoints(ownEnvironmentId)); }, [ownEnvironmentId, refreshEnvCheckpoints, run]);
  const turnEditing = useMemo(() => (ownEnvironmentId ? {
    sessionId: id, checkpoints: envCheckpoints,
    onReview: (changes: TurnChanges, asked: string | null) => { run(() => reviewTurn(ownEnvironmentId, { changes, asked })); },
    onUndo: (checkpointId: string) => { run(async () => { await openCheckpoints(ownEnvironmentId, id); await askRestoreCheckpoint(checkpointId); }); },
  } : null), [id, ownEnvironmentId, envCheckpoints, run, reviewTurn, openCheckpoints, askRestoreCheckpoint]);
  /* The whole pane takes a dropped file, not just the prompter: with a transcript on screen the card
     is a strip at the bottom, and aiming at it with a file in hand is the chore this removes. The
     session id is closed over here, so a four-pane split lands each file in the pane it was dropped
     on rather than in whichever session was last focused. The prompter claims the drag when the
     pointer is actually over it, so a drop is only ever handled once. */
  const fileDrop = useFileDrop((files) => run(() => attachFiles(id, files)));

  useEffect(() => { run(() => openSession(id)); }, [id, openSession, run]);
  // Cheap by construction: the store dedups concurrent calls and the server holds a TTL cache, so a
  // four-pane split (or a tab-back) costs one round trip, not a process spawn per agent.
  useEffect(() => { run(() => probeAgents()); }, [id, probeAgents, run]);
  // Alongside the probe and just as cheap: the server caches this for six hours and the store
  // collapses concurrent calls, so a split of four panes costs one round trip and no network.
  useEffect(() => { run(() => refreshCliStatus()); }, [id, refreshCliStatus, run]);
  // One settings read, alongside the probe. Favourites only ever change through this app's own
  // toggle (which writes through and updates the store), so there is nothing to poll for.
  useEffect(() => { run(() => refreshModelFavorites()); }, [refreshModelFavorites, run]);
  // The remembered fast-mode answers, on the same terms: the store re-reads them whenever a harness
  // states one, so a mount only has to catch up on whatever was filed before this renderer started.
  useEffect(() => { run(() => refreshFastSupport()); }, [refreshFastSupport, run]);
  // Prices and context windows for the picker's detail pane. Same shape as the two reads above and
  // just as cheap: the server caches the catalog for a day, the store collapses concurrent calls, and
  // a failure leaves `modelInfo` empty — which the picker renders as rows without prices.
  useEffect(() => { run(() => refreshModelCatalog()); }, [refreshModelCatalog, run]);
  const goal = useApp((st) => st.goals[id]) ?? null;
  const refreshGoal = useApp((st) => st.refreshGoal);
  // Seeded once per pane: the store only hears about a goal when it CHANGES, and a pane opened onto
  // a session whose objective was set last week has missed every event that ever carried it.
  useEffect(() => { void run(() => refreshGoal(id)); }, [id, run, refreshGoal]);
  /* The friend labels, from whichever packs this Realm has been told the word for. Flattened here
     rather than in the transcript so the pane is the one place that knows a pack has a shape. */
  const eggPacks = useApp((st) => st.eggPacks);
  const packLabels = useMemo(() => eggPacks.flatMap((p) => p.labels), [eggPacks]);
  const packGreetings = useMemo(() => eggPacks.flatMap((p) => p.greetings), [eggPacks]);
  // The space's colour on the composer's space chip — one of the three places it marks (Plan 27).
  const spaceTint = useSpaceTint(spaces.find((s) => s.id === session?.spaceId)?.color);
  // Where else the chip may move it: the profile's other spaces. Another profile's would take the
  // session out of this window, which is the sidebar menu's deliberate act, not a composer guess.
  const otherSpaces = useMemo(() => {
    const here = spaces.find((s) => s.id === session?.spaceId);
    return here ? spaces.filter((s) => s.profileId === here.profileId && s.id !== here.id) : [];
  }, [spaces, session?.spaceId]);
  /* The `@` list beyond the skills (mention-sources.ts): the checkout's files and the Library over the
     wire, the apps and their icons from main by way of the store, and whether macOS lets Realm drive
     them. Every function is held still, because the list keys its fetches on them. */
  const installedApps = useApp((st) => st.installedApps);
  const appIcons = useApp((st) => st.appIcons);
  const accessibility = useApp((st) => { const row = st.computerAccess?.rows.find((r) => r.id === "accessibility"); return row ? row.state === "granted" : null; });
  const loadInstalledApps = useApp((st) => st.loadInstalledApps);
  const ensureAppIcons = useApp((st) => st.ensureAppIcons);
  const refreshComputerAccess = useApp((st) => st.refreshComputerAccess);
  const addMentionRef = useApp((st) => st.addMentionRef);
  const mentionFilesFor = useApp((st) => st.mentionFiles);
  const libraryArtifacts = useApp((st) => st.libraryArtifacts);
  const draftRefs = useApp((st) => st.draftRefs[id] ?? NO_REFS);
  const profileId = spaces.find((s) => s.id === session?.spaceId)?.profileId ?? null;
  const mentionFiles = useCallback(async (q: string) => (await mentionFilesFor(id, q)).hits, [id, mentionFilesFor]);
  // One row per FILE (`perFile`): the list names things to hand over, not the moments they were touched.
  const mentionLibrary = useCallback(async (q: string) => (await libraryArtifacts({ profileId, query: q, limit: 20, perFile: true })).entries, [profileId, libraryArtifacts]);
  // Each opening re-reads both: an app installed, or Accessibility granted, since the last `@`.
  const onMentionOpen = useCallback(() => { run(() => loadInstalledApps()); run(() => refreshComputerAccess()); }, [run, loadInstalledApps, refreshComputerAccess]);
  const ensureIcons = useCallback((paths: readonly string[]) => { void ensureAppIcons(paths); }, [ensureAppIcons]);
  const addRef = useCallback((ref: UnlabelledRef, candidates: readonly string[]) => addMentionRef(id, ref, candidates), [id, addMentionRef]);
  const cwd = session?.cwd ?? "";
  const mentionSources = useMemo(() => ({ cwd, mac: macSkill, apps: installedApps, appIcons, accessibility, files: mentionFiles, library: mentionLibrary, onOpen: onMentionOpen, ensureIcons, addRef }),
    [cwd, macSkill, installedApps, appIcons, accessibility, mentionFiles, mentionLibrary, onMentionOpen, ensureIcons, addRef]);
  /* The apps the log's own messages named keep their icons after a relaunch: asked for once each,
     when the transcript first carries them. */
  const loggedApps = useMemo(() => [...new Set(transcript.blocks.flatMap((b) => (b.kind === "user" && b.refs ? b.refs.flatMap((r) => (r.kind === "app" ? [r.path] : [])) : [])))].join("\n"),
    [transcript.blocks]);
  useEffect(() => { if (loggedApps) ensureIcons(loggedApps.split("\n")); }, [loggedApps, ensureIcons]);

  /* EVERY hook is above this line, and that is load-bearing rather than tidy: an early return with
     hooks below it renders a different NUMBER of hooks depending on whether the session row has
     loaded, which React answers by throwing (#310) — and since this pane is mounted at boot, the
     throw takes the whole window down to a blank screen. */
  if (!session) return <div className="pane-placeholder muted">Loading session…</div>;
  const space = spaces.find((s) => s.id === session.spaceId);
  /* What the empty session's greeting names, and links to the space's page: the space, when the
     session works in the space's own folder; otherwise the checkout it works in, by its folder name,
     because that is the place the next message runs. The environment's kind says which when it has
     loaded; until then the paths do. */
  const ownEnv = environments[session.environmentId];
  const inSpaceFolder = ownEnv ? ownEnv.kind === "primary" : space !== undefined && trimSlash(session.cwd) === trimSlash(space.folderPath);
  const place = space ? { name: inSpaceFolder ? space.name : basenameOf(session.cwd), title: `Open ${space.name}`,
    onOpen: () => openSpacePage(space.id) } : undefined;
  // Hero vs docked (§4): the prompter centers as the hero only while there is nothing to read —
  // no transcript blocks and no visible permission cards (pending ones only show while waiting).
  const hero = transcript.blocks.length === 0 && (status !== "waiting_permission" || transcript.pendingPermissions.length === 0);
  // The agent is switchable only until the session's first event (W3; the server is the authority —
  // sessions.setAgent refuses after that). Both halves matter: the row's own seq covers a session
  // whose transcript has not been fetched yet, the transcript's covers events that arrived since.
  const canSwitchAgent = session.lastEventSeq === 0 && (entry?.lastSeq ?? 0) === 0;
  // The agent this session runs can't run here (W4): the prompter is REPLACED, not disabled — a text box
  // that always fails the first message is the failure this flow exists to remove. An un-probed agent is
  // never blocked; the card only appears on a probe that actually said no.
  //
  // …except while a turn is actually in flight. Stop lives on the prompter, so a probe that goes sour
  // mid-stream (its 5s timeout losing a race under load) would otherwise take away the one control that
  // can end the turn — and an agent that is streaming has self-evidently started.
  const availability = agentAvailability(session.agentKind, agentProbe);
  // Only an INSTALL is offered here, and only on the card that is about a missing CLI. A signed-out
  // agent's fix is a login — a browser flow or an API key, not a command that finishes on its own —
  // so this card never grows a button for it even if the two answers disagreed for a moment.
  const cliOffer = availability.state === "missing" && cliRow?.action === "install" ? cliRow.command : null;
  // The prompter's suggested prompt, derived from THIS session (prompt-hint.ts): the last turn, the
  // working tree, the mode. Computed here rather than in Composer because everything it reads is
  // already the pane's — Composer only draws it and fills it in on ⇥.
  const hint = promptHint({
    blocks: transcript.blocks, gitInfo, status, inPlan: session.permissionMode === PLAN_PERMISSION_MODE,
    generated: transcript.promptHint?.text ?? null,
  });
  // Derived at render like the hint above, not memoised and not stored: one backward walk over
  // blocks the pane already holds, and a slice beside the transcript could only disagree with it.
  const todos = latestTodos(transcript.blocks);
  const blocked = isBlocked(availability) && status !== "running" && status !== "waiting_permission";
  /* The prompter's `/` commands.
     Built here rather than in Composer for the same reason the prompt hint is: every one of them is
     already the pane's — they wrap handlers that exist a few lines below, so the list can never
     offer something the prompter cannot do. Derived at render rather than memoised: it is four
     objects, and a memo whose deps are the six things these close over would cost more to keep
     honest than it saves. */
  /* The agent's own advertised modes, off the init event. Hoisted out of the Composer's props so the
     `/`-commands and the mode chip are answering from one value rather than two reads of it. */
  const acpModes = transcript.init ? transcript.init.availableModes ?? [] : null;
  const slashCommands: SlashCommand[] = [
    /* The mode axis, as commands. The chip beside the prompter is the same switch, and this is the
       same list it draws (`offeredModes`), so a command can never offer a mode the chip says this
       agent does not have. Build is in the list because leaving a mode has to be as easy as
       entering one — a `/plan` with no `/build` is a door that only opens one way.
       What the user typed after the command stays in the box: `/plan look at the auth code` sets
       the mode and leaves the sentence ready to send. */
    ...offeredModes(session.agentKind, acpModes).map((m): SlashCommand => ({
      id: m, label: MODE_COMMAND[m].label, hint: MODE_COMMAND[m].hint, icon: MODE_COMMAND[m].icon,
      run: () => run(() => setSessionMode(id, m)),
    })),
    {
      /* Goal mode. The objective is the argument, and it is also the first turn — `/goal` on its own
         has nothing to pursue, so it arms the box instead of starting an empty goal. */
      id: "goal", label: "Set a goal", hint: "Work towards an objective across turns", icon: "target",
      takesArgument: true,
      /* No empty-objective guard here, deliberately: both callers already refuse one — the picker
         arms the box instead of running, and Enter returns without calling this — and the server
         refuses an empty objective with a sentence. A third check would be a branch no test could
         reach, which is a branch nobody can be sure still works. */
      run: (rest) => run(() => startGoal(id, rest.trim())),
    },
    {
      id: "export", label: "Export session", hint: "Save this transcript as Markdown", icon: "download",
      run: () => run(() => exportSession(id)),
    },
    // Each of the rest is gated on the thing it would act on actually existing: a command that could
    // only no-op is the dead chrome the pane bar bans, and a picker is a worse place for one than a
    // toolbar because the user typed its name expecting it to work.
    ...(environments[session.environmentId] ? [{
      id: "diff", label: "Show changes", hint: "Open the diff for this checkout", icon: "branch",
      run: () => run(() => openDiff(session.environmentId)),
    } as SlashCommand] : []),
    { id: "attach", label: "Add files", hint: "Attach files to this message", icon: "attach", run: () => run(() => attachFromPicker(id)) },
    ...(allSkills.length > 0 ? [{
      id: "skills", label: "Manage skills", hint: "Open this space's skills", icon: "sparkles",
      run: () => openSpacePage(session.spaceId, "skills"),
    } as SlashCommand] : []),
    { id: "connections", label: "Manage connections", hint: "Open this space's connectors", icon: "plug", run: () => openSpacePage(session.spaceId, "connections") },
    /* The user's own commands, from `<space>/commands`, `~/Realm/commands` and `~/.claude/commands`.
       Appended after the app's own so the built-ins lead the picker — and they can never collide with
       one, because the server marks a file whose name a built-in owns invalid, and only the runnable
       ones arrive here. */
    ...runnableCommands(spaceCommands).map((c): SlashCommand => ({
      id: c.name, label: c.name, hint: c.description, icon: "sparkles",
      /* Derived, not declared: a template that advertises an argument is one that needs one, so the
         picker arms the box instead of running on nothing — the same gesture `/goal` already has. */
      takesArgument: c.argumentHint !== null,
      run: (rest) => run(async () => {
        const { text } = await expandCommand(session.spaceId, c.name, rest);
        /* The DRAFT, never a send. An unmatched `$3` is left standing in `text` precisely so the user
           reads it before Return; sending here would turn that into a silent failure. */
        setDraft(id, text);
      }),
    })),
  ];
  const body = (
    <div ref={setPane} className="session-pane" data-visible={visible || undefined} data-focused={focused || undefined} data-composer={hero ? "hero" : "docked"}
      data-peek={peek || undefined}
      data-dropping={fileDrop.dropping || undefined} {...(peek ? {} : fileDrop.handlers)}>
      <Transcript transcript={transcript} sessionStatus={status} visible={visible} focused={focused} cwd={session.cwd} track
        saved={savedSeqs} onSave={onSaveTurn} reveal={promptFor} onRevealed={promptTaken}
        onExpandPlan={(planId) => openSheet({ kind: "session-plan", sessionId: id, planId })}
        // A plan, or an answer, handed to other models: this session's Agents tab, with it as the work.
        onImplementWith={peek ? undefined : (text) => run(() => openAgentsTabFor(id, { plan: text }))}
        sessionId={id}
        mode={sessionModeOf(session.permissionMode)}
        eggs={easterEggs} packLabels={packLabels}
        onPath={(p, at) => setPathMenu({ path: p, at })} checkout={checkout} turnEditing={turnEditing}
        onQuote={(text) => setQuote((q) => ({ text, n: (q?.n ?? 0) + 1 }))}
        sends={sends}
        // Keyed by SESSION, not by pane: a space switch tears this pane down and rebuilds it, and
        // what the reader is owed back is their place in this log (scroll-memory.ts).
        scrollKey={id}
        mentionIds={liveMentionIds} appIcons={appIcons}
        onDecide={(requestId, d, answers) => run(() => respondPermission(id, requestId, d, answers))}
        onRetry={() => { setSends((n) => n + 1); run(() => retryLastTurn(id)); }}
        onRate={(messageId, rating) => run(() => rateMessage(id, messageId, rating))} />
      {peek
        ? <PeekBar spaceName={space?.name ?? "another space"} elsewhere={session.spaceId !== activeSpaceId} onOpen={() => run(() => openPeek())} />
        : blocked && isBlocked(availability)
        ? <InstallCard availability={availability} onRetry={reprobe}
            onOpenInTerminal={(command) => run(() => prefillTerminal(id, command))}
            offer={cliOffer} job={cliJob ?? null}
            onInstall={() => run(() => runCliAction(session.agentKind, "install"))}
            onSignIn={() => run(() => startSignIn(session.agentKind, session.spaceId, session.id))}
            onDismissJob={() => dismissCliJob(session.agentKind)} />
        : <DraftedComposer session={session} status={status} gitInfo={gitInfo} todos={todos} quote={quote}
            onOpenDiff={() => run(() => openDiff(session.environmentId))}
            attachments={attachments}
            onAttachPick={() => run(() => attachFromPicker(id))}
            onAttachFiles={(files) => run(() => attachFiles(id, files))}
            onRemoveAttachment={(path) => removeAttachment(id, path)}
            sessionRefs={sessionRefs}
            onRemoveSessionRef={(refId) => removeSessionRef(id, refId)}
            /* A dropped sidebar item is only meaningful here if it is a SESSION: a terminal or a
               browser has no transcript to consult and no `agent_ask` to answer with, so those are
               ignored rather than turned into a reference that would resolve to nothing. */
            onDropItem={(itemId) => {
              const it = items.find((x) => x.id === itemId);
              if (!it || it.kind !== "session") return;
              const outcome = addSessionRef(id, { sessionId: it.refId, title: it.title, agent: sessionAgent(it.refId) });
              if (outcome === "self") setRefNote("That is this session.");
              else if (outcome === "duplicate") setRefNote(`${it.title} is already on this message.`);
              else if (outcome === "full") setRefNote("That is as many sessions as one message can point at.");
              else setRefNote(null);
            }}
            onSend={(text) => { setSends((n) => n + 1); run(() => sendMessage(id, text)); }}
            onStop={() => run(() => interruptSession(id))}
            onOptions={(o) => run(() => setSessionOptions(id, o))}
            onPickModel={(kind, modelId) => run(async () => {
              // Order matters and both halves are one user action: setAgent clears `model` (a
              // claude-opus-5 on a Codex session is a lie), so the model has to land after it, or the
              // pick would set the agent and drop the model the user actually chose.
              if (kind !== session.agentKind) await setSessionAgent(id, kind);
              if (modelId !== null) await setSessionOptions(id, { model: modelId });
            })}
            onMode={(mode) => run(() => setSessionMode(id, mode))} planReturn={planReturn}
            onParkPermission={(permissionMode) => run(() => setParkedPermission(id, permissionMode))}
            // The agent's own modes off THIS session's init event (Plan 14 W3): null = handshake not
            // seen yet, [] = the agent named none — the difference between "wait" and "no Plan here".
            acpModes={acpModes}
            canSwitchAgent={canSwitchAgent}
            agentProbe={agentProbe}
            modelFavorites={modelFavorites} modelInfo={modelInfo}
            onToggleModelFavorite={(key) => run(() => toggleModelFavorite(key))}
            mentionSkills={mentionSkills} allSkills={allSkills} staleMentions={staleMentions}
            onToggleSkill={(skillId, enabled) => run(() => setSkillEnabled(session.spaceId, skillId, enabled))}
            onManageSkills={() => openSpacePage(session.spaceId, "skills")}
            machineName={machineName} userName={userName} environments={spaceEnvironments}
            onSelectEnvironment={(envId) => run(() => setSessionEnvironment(id, envId))}
            onNewWorktree={plainFolder ? undefined : () => run(() => moveSessionToNewWorktree(id))}
            otherSpaces={otherSpaces} onMoveToSpace={(spaceId) => run(() => moveSessionToSpace(id, spaceId))}
            connectors={connectors} onConnectorsOpened={() => run(() => refreshConnectors(session.spaceId))}
            onAddFolder={() => run(() => pickAndLinkProject(session.spaceId))}
            onManageConnections={() => openSpacePage(session.spaceId, "connections")}
            submitKey={submitKey}
            eggs={easterEggs}
            hero={hero} spaceName={space?.name ?? "this space"} spaceTint={spaceTint} place={place}
            promptHint={hint} usage={transcript.usage} slashCommands={slashCommands}
            packGreetings={packGreetings}
            goal={<GoalStrip goal={goal}
              onPause={() => run(() => setGoalStatus(id, "paused", "You paused it."))}
              onResume={() => run(() => resumeGoal(id))}
              onDrop={() => run(() => clearGoal(id))}
              onDone={() => run(() => setGoalStatus(id, "complete", "Marked done by you."))} />}
            sessionInit={transcript.init} fastSupport={fastSupport} effortSupport={effortSupport}
            links={draftLinks} onLinkPaste={(url) => addLinkChip(id, url)}
            mentions={mentionSources} refs={draftRefs} selectInRealm={selectInRealm}
            queued={queued ?? []} midTurnMode={midTurnMode} planLimits={planLimits}
            queueActions={queueActions} />}
      {/* Last child and BELOW the prompter's dock, so the glow passes under the card exactly as the
          transcript does — an affordance that blurred across the prompter would be the fade band's
          old bug wearing a different colour. Decorative: the drop is announced by what it does. */}
      {fileDrop.dropping && <div className="session-drop" aria-hidden="true" />}
      {/* The sub-agent panel, docked to this pane's right edge — the same strip the summary uses,
          and the same one at a time (`sessionDock`). Rendered from the PANE rather than from the
          strip's row that opened it, because a background agent's row leaves the strip the moment
          the harness says it stopped, and a panel parented to that row would vanish out from under
          someone reading it. */}
      {dock?.kind === "subagent" && paneEl && (
        <SubagentPanel sessionId={id} toolUseId={dock.toolUseId} anchorRef={paneRef}
          onClose={() => closeSessionDock(id)} />
      )}
      {/* The terminal, when Settings docks it to the pane's foot — see TerminalDock. Its default place
          is a tab of the side pane, which is not this pane's to draw, so a dock left open when the
          setting moved back is not drawn either. Rendered from the pane like the sub-agent view
          rather than wrapping it in a split, which would cut the pane in half for a shell most turns
          never ask for. */}
      {dock?.kind === "terminal" && terminalDocked && paneEl && (
        <TerminalDock sessionId={id} title={terminalTitle(session.cwd)} visible={visible}
          anchorRef={paneRef} onClose={() => closeSessionDock(id)} />
      )}
      {/* Opened from a path in the prose. Owned by the PANE rather than by the message, because the
          menu outlives the render that produced it — a streaming turn re-renders the transcript
          constantly, and a menu parented to a message would be torn down under the pointer. */}
      {pathMenu && (
        <PathMenu path={pathMenu.path} anchorRef={asRef(pathMenu.at)} environmentId={session.environmentId}
          cwd={session.cwd} onClose={() => setPathMenu(null)} />
      )}
    </div>
  );
  // What this pane shows — its transcript's media, its prompter's chips — is asked about in this session.
  return <MediaSessionContext.Provider value={id}>{body}</MediaSessionContext.Provider>;
}

/** The drawer's empty-state hint names where the shell opened — the session's cwd, by basename. */
function terminalTitle(cwd: string): string {
  return cwd.replace(/\/+$/, "").split("/").pop() || cwd;
}

/**
 * The composer, reading its own draft.
 *
 * The draft used to be read by the session pane and handed down, so every keystroke re-rendered the
 * PANE — and with it the whole transcript, whose messages re-parsed their Markdown each time. On a
 * session with a few thousand turns that was most of a frame per character (measured: 176 ms median
 * per keystroke on a 3,000-row transcript). Read here, a keystroke re-renders the composer alone.
 */
function DraftedComposer(props: Omit<ComponentProps<typeof Composer>, "draft" | "onDraftChange">) {
  const id = props.session.id;
  const draft = useApp((s) => s.drafts[id] ?? "");
  const setDraft = useApp((s) => s.setDraft);
  const onDraftChange = useCallback((text: string) => setDraft(id, text), [setDraft, id]);
  return <Composer {...props} draft={draft} onDraftChange={onDraftChange} />;
}
