import { Icon, type IconName } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_SKILL_SUPPORT, PLAN_PERMISSION_MODE, offeredModes, sessionModeOf, type Item, type LinkChip, type SessionMode, type Skill, runnableCommands, type UserCommand } from "@realm/contracts";

/** A stable empty list for the commands selector. A fresh `[]` in the selector is a new reference on
 *  every render, which is how a zustand subscription turns into a render loop. */
const EMPTY_COMMANDS: readonly UserCommand[] = Object.freeze([]);

/** Stable empty array for `useSyncExternalStore`: a fresh `[]` per render reads as a change forever. */
const NO_LINKS: LinkChip[] = [];
import { useApp, type PickedAttachment } from "../../state/store";
import { agentAvailability, isBlocked } from "../../state/agent-availability";
import type { PaneProps } from "../registry";
import type { MenuItem } from "../../components/Menu";
import { Composer } from "./Composer";
import { useFileDrop } from "../../components/use-file-drop";
import { InstallCard } from "./InstallCard";
import { Transcript } from "./Transcript";
import { SubagentPanel } from "./SubagentPanel";
import { TerminalDock } from "./TerminalDock";
import { emptyTranscript } from "./transcript-model";
import { promptHint } from "./prompt-hint";
import { latestTodos } from "./session-todos";
import { SessionSummaryHost, useSummaryLive } from "./SessionSummary";
import { GoalStrip } from "./GoalStrip";
import { PathMenu, asRef } from "./PathMenu";
import type { SlashCommand } from "./slash-commands";

/** Stable empty array: a fresh `[]` from the selector on every render makes useSyncExternalStore
 *  re-render (and warn) forever. */
const NO_ATTACHMENTS: PickedAttachment[] = [];
const NO_SKILLS: Skill[] = [];
const NO_MENTIONS: string[] = [];

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
      <span className="status-dot" data-status={status} title={STATUS_LABEL[status]} aria-label={`Status: ${STATUS_LABEL[status]}`} />
    </>
  );
}

/**
 * PanelBar action cluster for a session: summary, then the three panes a session opens beside
 * itself — terminal, documents, browser.
 *
 * The diff button is deliberately gone. It was the one action here duplicated a few pixels away:
 * the prompter's under-strip carries the branch chip, and that chip IS the way into the diff — it
 * also says which branch and how many files changed, which a bare icon in the bar never did.
 */
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
 * Data rather than six components, because the two halves have to agree: the bar draws the first
 * `keep` of them (components/pane-bar-fit.ts) and the menu picks up exactly where it left off. With
 * a component per button the menu would have to be given its own copy of the same six decisions,
 * and the first time somebody added a seventh it would appear in one place and not the other.
 *
 * ORDER IS PRIORITY, left to right, and the overflow simply takes from the end. The summary and the
 * terminal are what this session IS — one is the only place its outputs and spend are listed, the
 * other is its own shell — so they hold the bar longest. The three after them open a pane BESIDE the
 * session rather than showing anything about it, and every one of them is reachable from the sidebar
 * and the palette as well, so they are what a narrow pane can most afford to spell out in a menu.
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
  // Same precondition the documents button always had: gated on the environment being loaded,
  // because an action that could only no-op is dead chrome (Ara refresh §7).
  const environmentId = useApp((s) => {
    const e = s.sessions[id]?.environmentId;
    return e && s.environments[e] ? e : null;
  });
  const summaryLive = useSummaryLive(item);
  const openDocuments = useApp((s) => s.openDocuments);
  const newBrowser = useApp((s) => s.newBrowser);
  const newMachine = useApp((s) => s.newMachine);
  const newSimulator = useApp((s) => s.newSimulator);
  const run = useApp((s) => s.run);
  return useMemo(() => {
    const list: BarAction[] = [];
    if (summaryLive) list.push({
      id: "summary", label: "Summary", title: "Outputs, sources and plans", icon: "info",
      aria: `Summary of ${item.title}`, dialog: true, on: dock === "summary",
      onSelect: () => toggleSessionDock(id, { kind: "summary" }),
    });
    list.push({
      id: "terminal", label: "Terminal", title: "Terminal (⌘J)", icon: "terminal",
      aria: `${dock === "terminal" ? "Hide" : "Show"} terminal for ${item.title}`,
      dialog: true, pressed: dock === "terminal",
      onSelect: () => toggleSessionDock(id, { kind: "terminal" }),
    });
    if (environmentId) list.push({
      id: "documents", label: "Documents", title: "Documents", icon: "documents",
      aria: `Open documents for ${item.title}`,
      /* Beside, not instead. This is pressed FROM a session to read something alongside it, and
         taking the session's own pane to do that left the reader with a back button as the only way
         home. An empty focused leaf is still filled rather than split; see `openItemBeside`. */
      onSelect: () => run(() => openDocuments(environmentId, null, true)),
    });
    /* The last three take no precondition and are always offered, on one reasoning: each opens a
       PLACE YOU GO rather than a view of this session's checkout, so gating any of them on an
       environment would be gating it on something it has nothing to do with. The simulator in
       particular is not gated on this Mac having Xcode — the pane's own body answers that in a
       sentence, where a button that vanished would be a feature nobody could discover they were one
       install away from. */
    list.push({
      id: "browser", label: "Browser", title: "Browser", icon: "browser",
      aria: `Open a browser beside ${item.title}`,
      onSelect: () => run(() => newBrowser(null, true)),
    });
    list.push({
      id: "machine", label: "Machine", title: "Machine", icon: "machine",
      aria: `Connect a machine beside ${item.title}`,
      onSelect: () => run(() => newMachine(null, true)),
    });
    list.push({
      id: "simulator", label: "Simulator", title: "Simulator", icon: "simulator",
      aria: `Open a simulator beside ${item.title}`,
      onSelect: () => run(() => newSimulator(null, true)),
    });
    return list;
  }, [id, item.title, dock, environmentId, summaryLive, toggleSessionDock, openDocuments, newBrowser, newMachine, newSimulator, run]);
}

/**
 * PanelBar action cluster for a session. `keep` is how many of the list above still fit as buttons;
 * the rest are in the ⋯ menu, put there by `useSessionMenuItems`.
 *
 * `SessionSummaryHost` is outside the slice on purpose: it mounts the summary's docked panel and its
 * lightbox, and those have to stay whatever the bar has room for. An action that moved into the menu
 * must still be able to open the thing it opens.
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

/** Transcript + composer for one agent session (item.refId = session id). PanelBar renders the header. */
/** Stable, so a pane with no references hands the Composer the same array every render. */
const EMPTY_REFS: readonly { sessionId: string; title: string; agent: string }[] = [];

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
  const dequeuePrompt = useApp((s) => s.dequeuePrompt);
  const retryLastTurn = useApp((s) => s.retryLastTurn);
  const rateMessage = useApp((s) => s.rateMessage);
  const respondPermission = useApp((s) => s.respondPermission);
  const setParkedPermission = useApp((s) => s.setParkedPermission);
  const openSheet = useApp((s) => s.openSheet);
  const setSessionOptions = useApp((s) => s.setSessionOptions);
  const setSessionAgent = useApp((s) => s.setSessionAgent);
  const setSessionMode = useApp((s) => s.setSessionMode);
  const planReturn = useApp((s) => s.planReturn[id] ?? null);
  const run = useApp((s) => s.run);
  const transcript = entry?.t ?? emptyTranscript();
  // Store-owned, keyed by session id (A-M9): layout reshapes/remounts never lose typed text, and a
  // suggestion chip in the empty state can fill the draft without sending it.
  const draft = useApp((s) => s.drafts[id] ?? "");
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
  const draftLinks = useApp((s) => s.draftLinks[id] ?? NO_LINKS);
  // Attachments are part of the draft and are held the same way, for the same reason.
  const attachments = useApp((s) => s.pendingAttachments[id] ?? NO_ATTACHMENTS);
  // The @-mention picker's source (W4): the space's library, narrowed to what THIS session's agent can
  // be handed — empty for a Cursor (or fake) session, which is what keeps `@` from opening anything
  // there. `spaceSkills` rows are store-held references, so the memo only re-filters on real change.
  const spaceSkillList = useApp((s) => { const sess = s.sessions[id]; return (sess && s.spaceSkills[sess.spaceId]) || NO_SKILLS; });
  const agentKind = useApp((s) => s.sessions[id]?.agentKind);
  const mentionSkills = useMemo(
    () => (agentKind && AGENT_SKILL_SUPPORT[agentKind] === "injected" ? spaceSkillList.filter((k) => k.enabled && k.valid) : NO_SKILLS),
    [agentKind, spaceSkillList],
  );
  // The transcript recognises a sent message's `@name` against this same live set, so a bubble's
  // chips and the composer's agree about what is a skill and what is just an address.
  const liveMentionIds = useMemo(() => mentionSkills.map((k) => k.id), [mentionSkills]);
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
    const live = new Set(mentionSkills.map((k) => k.id));
    return draftMentionIds.filter((m) => !live.has(m));
  }, [draftMentionIds, mentionSkills]);
  const attachFiles = useApp((s) => s.attachFiles);
  const attachFromPicker = useApp((s) => s.attachFromPicker);
  const removeAttachment = useApp((s) => s.removeAttachment);
  // Under-strip + "+" menu (Plan 12 W1).
  const machineName = useApp((s) => s.machineName);
  const userName = useApp((s) => s.userName);
  const environments = useApp((s) => s.environments);
  const setSessionEnvironment = useApp((s) => s.setSessionEnvironment);
  const moveSessionToNewWorktree = useApp((s) => s.moveSessionToNewWorktree);
  const connectors = useApp((s) => { const sess = s.sessions[id]; return (sess && s.connectors[sess.spaceId]) ?? null; });
  const refreshConnectors = useApp((s) => s.refreshConnectors);
  const pickAndLinkProject = useApp((s) => s.pickAndLinkProject);
  const openSpacePage = useApp((s) => s.openSpacePage);
  const setSkillEnabled = useApp((s) => s.setSkillEnabled);
  const spaceEnvironments = useMemo(
    () => Object.values(environments).filter((e) => session && e.spaceId === session.spaceId),
    [environments, session],
  );
  // The environments map loads on space activation, BEFORE this session (and its lazily-created
  // primary row) may exist — so a session whose own environment is missing from the map re-fetches
  // once. Also what makes the diff button above appear without a space switch.
  const refreshEnvironments = useApp((s) => s.refreshEnvironments);
  const missingOwnEnv = session !== undefined && !environments[session.environmentId];
  useEffect(() => { if (missingOwnEnv) run(() => refreshEnvironments()); }, [missingOwnEnv, refreshEnvironments, run]);
  /* Once per mounted session: the pane catching up on a queue that filled while it was closed. */
  useEffect(() => { run(() => refreshSessionQueue(id)); }, [id, refreshSessionQueue, run]);
  const gitInfo = useApp((s) => { const cwd = s.sessions[id]?.cwd; return cwd ? s.gitInfo[cwd] ?? null : null; });
  // What is docked to this pane's right edge, if anything — one strip, one occupant.
  const dock = useApp((s) => s.sessionDock[id]);
  const closeSessionDock = useApp((s) => s.closeSessionDock);
  /* A callback ref, and the panel is gated on the STATE it sets — not on the ref alone.
     React attaches refs bottom-up, so a child rendered inside this div runs its own layout effect
     before this div's ref is assigned: the panel measured `null`, fell back to the whole window,
     and pinned itself without the pane ever being told to make room. Setting state re-renders once
     with the node in hand, which is what the gate below waits for. */
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  const setPane = useCallback((el: HTMLDivElement | null) => { paneRef.current = el; setPaneEl(el); }, []);
  const agentProbe = useApp((s) => s.agentProbe);
  const probeAgents = useApp((s) => s.probeAgents);
  const modelFavorites = useApp((s) => s.modelFavorites);
  const modelInfo = useApp((s) => s.modelInfo);
  const refreshModelCatalog = useApp((s) => s.refreshModelCatalog);
  const refreshModelFavorites = useApp((s) => s.refreshModelFavorites);
  const toggleModelFavorite = useApp((s) => s.toggleModelFavorite);
  const prefillTerminal = useApp((s) => s.prefillTerminal);
  const cliStatus = useApp((s) => s.cliStatus);
  const cliJob = useApp((s) => (session ? s.cliJobs[session.agentKind] : undefined));
  const runCliAction = useApp((s) => s.runCliAction);
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
  // intent: ⌘⇧↩ dispatches the draft into a NEW session (store.dispatchDraft, bound in hotkeys.ts)
  // and must leave this scroller exactly where the reader parked it.
  const [sends, setSends] = useState(0);
  /** The file path whose menu is open, and the element it was clicked on. */
  const [pathMenu, setPathMenu] = useState<{ path: string; at: HTMLElement } | null>(null);
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

  /* EVERY hook is above this line, and that is load-bearing rather than tidy: an early return with
     hooks below it renders a different NUMBER of hooks depending on whether the session row has
     loaded, which React answers by throwing (#310) — and since this pane is mounted at boot, the
     throw takes the whole window down to a blank screen. */
  if (!session) return <div className="pane-placeholder muted">Loading session…</div>;
  const space = spaces.find((s) => s.id === session.spaceId);
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
      data-dropping={fileDrop.dropping || undefined} {...fileDrop.handlers}>
      <Transcript transcript={transcript} sessionStatus={status} visible={visible} focused={focused} cwd={session.cwd}
        onExpandPlan={(planId) => openSheet({ kind: "session-plan", sessionId: id, planId })}
        mode={sessionModeOf(session.permissionMode)}
        eggs={easterEggs} packLabels={packLabels}
        onPath={(p, at) => setPathMenu({ path: p, at })}
        sends={sends}
        // Keyed by SESSION, not by pane: a space switch tears this pane down and rebuilds it, and
        // what the reader is owed back is their place in this log (scroll-memory.ts).
        scrollKey={id}
        mentionIds={liveMentionIds}
        onDecide={(requestId, d, answers) => run(() => respondPermission(id, requestId, d, answers))}
        onRetry={() => { setSends((n) => n + 1); run(() => retryLastTurn(id)); }}
        onRate={(messageId, rating) => run(() => rateMessage(id, messageId, rating))} />
      {blocked && isBlocked(availability)
        ? <InstallCard availability={availability} onRetry={reprobe}
            onOpenInTerminal={(command) => run(() => prefillTerminal(id, command))}
            offer={cliOffer} job={cliJob ?? null}
            onInstall={() => run(() => runCliAction(session.agentKind, "install"))}
            onDismissJob={() => dismissCliJob(session.agentKind)} />
        : <Composer session={session} status={status} gitInfo={gitInfo} todos={todos}
            onOpenDiff={() => run(() => openDiff(session.environmentId))} draft={draft} onDraftChange={(t) => setDraft(id, t)}
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
            onNewWorktree={() => run(() => moveSessionToNewWorktree(id))}
            connectors={connectors} onConnectorsOpened={() => run(() => refreshConnectors(session.spaceId))}
            onAddFolder={() => run(() => pickAndLinkProject())}
            onManageConnections={() => openSpacePage(session.spaceId, "connections")}
            submitKey={submitKey}
            eggs={easterEggs}
            hero={hero} spaceName={space?.name ?? "this space"}
            promptHint={hint} usage={transcript.usage} slashCommands={slashCommands}
            packGreetings={packGreetings}
            goal={<GoalStrip goal={goal}
              onPause={() => run(() => setGoalStatus(id, "paused", "You paused it."))}
              onResume={() => run(() => resumeGoal(id))}
              onDrop={() => run(() => clearGoal(id))} />}
            supportsFastMode={transcript.init?.supportsFastMode}
            links={draftLinks} onLinkPaste={(url) => addLinkChip(id, url)}
            queued={queued ?? []} midTurnMode={midTurnMode} planLimits={planLimits}
            onReleaseQueued={(queuedId) => run(() => releaseQueuedPrompt(id, queuedId))}
            onDropQueued={(queuedId) => run(() => dequeuePrompt(id, queuedId))} />}
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
      {/* The terminal, on the same strip and by the same rules — see TerminalDock. Rendered from the
          pane like the sub-agent view rather than wrapping it in a split, which is what stops the
          pane from looking cut in half for a shell most turns never ask for. */}
      {dock?.kind === "terminal" && paneEl && (
        <TerminalDock sessionId={id} title={terminalTitle(session.cwd)} visible={visible}
          anchorRef={paneRef} onClose={() => closeSessionDock(id)} />
      )}
      {/* Opened from a path in the prose. Owned by the PANE rather than by the message, because the
          menu outlives the render that produced it — a streaming turn re-renders the transcript
          constantly, and a menu parented to a message would be torn down under the pointer. */}
      {pathMenu && (
        <PathMenu path={pathMenu.path} anchorRef={asRef(pathMenu.at)} environmentId={session.environmentId}
          onClose={() => setPathMenu(null)} />
      )}
    </div>
  );
  return body;
}

/** The drawer's empty-state hint names where the shell opened — the session's cwd, by basename. */
function terminalTitle(cwd: string): string {
  return cwd.replace(/\/+$/, "").split("/").pop() || cwd;
}
