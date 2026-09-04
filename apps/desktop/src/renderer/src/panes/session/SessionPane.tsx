import { Icon } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from "react-resizable-panels";
import { AGENT_SKILL_SUPPORT, PLAN_PERMISSION_MODE, type Item, type Skill } from "@realm/contracts";
import { TERMINAL_PANEL_WIDTH, useApp, type PickedAttachment } from "../../state/store";
import { agentAvailability, isBlocked } from "../../state/agent-availability";
import { TerminalView } from "../TerminalPane";
import type { PaneProps } from "../registry";
import { Composer } from "./Composer";
import { InstallCard } from "./InstallCard";
import { Transcript } from "./Transcript";
import { DelegatedRuns } from "./DelegatedRuns";
import { emptyTranscript } from "./transcript-model";
import { promptHint } from "./prompt-hint";

/** Stable empty array: a fresh `[]` from the selector on every render makes useSyncExternalStore
 *  re-render (and warn) forever. */
const NO_ATTACHMENTS: PickedAttachment[] = [];
const NO_SKILLS: Skill[] = [];
const NO_MENTIONS: string[] = [];

const STATUS_LABEL = { idle: "Idle", running: "Running", waiting_permission: "Needs permission", error: "Error", ended: "Ended" } as const;

const fmtCost = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);

/** PanelBar right-side meta for a session item: model label, cost (only once real spend exists), status dot.
 *  PanelBar owns the icon + title; this is everything the old .session-header showed on its right. */
export function SessionMeta({ item }: { item: Item }) {
  const id = item.refId;
  const status = useApp((s) => s.sessionStatus[id] ?? s.sessions[id]?.status ?? "idle");
  const usage = useApp((s) => s.transcripts[id]?.t.usage ?? null);
  return (
    <>
      {/* Cost alone. The model used to lead this line and the turn count trailed the cost, and
          neither earned the space: the prompter's own chip names the model a few pixels below —
          and names it properly, where this printed whatever raw id the harness pins (Cursor's
          run to `claude-fable-5-1[thinking=true,context=300k,effort=high]`) — while the turn
          count answers a question nobody asked of a header. What is worth glancing at while a
          session runs is what it is costing. */}
      {usage && usage.costUsd > 0 && <span>{fmtCost(usage.costUsd)}</span>}
      <span className="status-dot" data-status={status} title={STATUS_LABEL[status]} aria-label={`Status: ${STATUS_LABEL[status]}`} />
    </>
  );
}

/** PanelBar action cluster for a session item (Ara refresh §6): branch/diff, then the terminal
 *  toggle — uniform icon buttons, no text labels. Open-external is skipped: a session has nothing
 *  to open externally, and dead chrome is worse than none (§7). */
export function SessionPanelActions({ item }: { item: Item }) {
  return (<><SessionDiffButton item={item} /><SessionDocumentsButton item={item} /><SessionTerminalToggle item={item} /></>);
}

/** Opens (or focuses) the diff pane for the session's environment — the same openDiff the prompter's
 *  branch chip drives; this is chrome-level access to it (Ara refresh §6). */
function SessionDiffButton({ item }: { item: Item }) {
  const id = item.refId;
  // Gated on the environment being loaded — openDiff's own precondition. A button that could only
  // no-op is dead chrome, and §7 says dead chrome is worse than none.
  const environmentId = useApp((s) => {
    const e = s.sessions[id]?.environmentId;
    return e && s.environments[e] ? e : null;
  });
  const openDiff = useApp((s) => s.openDiff);
  const run = useApp((s) => s.run);
  if (!environmentId) return null;
  return (
    <button className="icon-btn" aria-label={`Show changes for ${item.title}`} title="Changes"
      onClick={() => run(() => openDiff(environmentId))}>
      <Icon name="branch" size={14} />
    </button>
  );
}

/**
 * Opens (or focuses) the document workspace for the session's environment (Plan 17 W1) — the gesture
 * the user described as "open documents the way we open a terminal for a session".
 *
 * It sits next to the diff button and works the same way, because it IS the same shape: a documents
 * pane is rooted at an ENVIRONMENT, so several sessions sharing a checkout share one workspace and one
 * tab strip. Unlike the terminal, this is a real layout item rather than an internal drawer — a
 * document needs the whole pane, and needs to be splittable beside the session that is editing it.
 */
function SessionDocumentsButton({ item }: { item: Item }) {
  const id = item.refId;
  // Same precondition as the diff button: gated on the environment being loaded, because an action
  // that could only no-op is dead chrome (Ara refresh §7).
  const environmentId = useApp((s) => {
    const e = s.sessions[id]?.environmentId;
    return e && s.environments[e] ? e : null;
  });
  const openDocuments = useApp((s) => s.openDocuments);
  const run = useApp((s) => s.run);
  if (!environmentId) return null;
  return (
    <button className="icon-btn" aria-label={`Open documents for ${item.title}`} title="Documents"
      onClick={() => run(() => openDocuments(environmentId))}>
      <Icon name="documents" size={14} />
    </button>
  );
}

/** PanelBar action for a session item: show/hide its terminal side panel (W4). The terminal belongs to
 *  this session, so its switch lives on this session's header — not in the sidebar. */
export function SessionTerminalToggle({ item }: { item: Item }) {
  const id = item.refId;
  const open = useApp((s) => s.terminalPanel[id]?.open ?? false);
  const toggle = useApp((s) => s.toggleTerminalPanel);
  const run = useApp((s) => s.run);
  return (
    <button className="icon-btn" aria-pressed={open} aria-label={`${open ? "Hide" : "Show"} terminal for ${item.title}`}
      title="Terminal (⌘J)" onClick={() => run(() => toggle(id))}>
      <Icon name="terminal" size={14} />
    </button>
  );
}

/**
 * The session pane, plus its optional right-hand terminal drawer (W4). The split is INTERNAL: it is not
 * a layout leaf, so the terminal never appears in the sidebar, never takes a pane of its own, and moves
 * with the session wherever the session is opened.
 *
 * The PanelGroup only exists while the drawer is open, so each opening honours the session's persisted
 * width exactly (react-resizable-panels only reads `defaultSize` at mount, and renormalizes when a panel
 * is added to a live group). The cost is that the transcript remounts on toggle — the transcript is
 * store-owned and re-renders at the same scroll anchor, so this is a scroll nudge at worst.
 */
function TerminalDrawer({ sessionId, title, visible, children }: { sessionId: string; title: string; visible: boolean; children: ReactNode }) {
  const width = useApp((s) => s.terminalPanel[sessionId]?.width ?? TERMINAL_PANEL_WIDTH);
  const terminalId = useApp((s) => s.sessionTerminals[sessionId]);
  const ensureSessionTerminal = useApp((s) => s.ensureSessionTerminal);
  const setTerminalPanelWidth = useApp((s) => s.setTerminalPanelWidth);
  const run = useApp((s) => s.run);
  const group = useRef<ImperativePanelGroupHandle>(null);
  // Restore path: the panel was left open in a previous run, so the terminal is fetched (never created
  // twice — the server's openTerminal is get-or-create, and the store guards concurrent calls).
  useEffect(() => { if (!terminalId) run(() => ensureSessionTerminal(sessionId)); }, [terminalId, sessionId, ensureSessionTerminal, run]);
  // The group reads `width` at mount only, so a width the STORE changed (double-click-to-restore) has
  // to be pushed in — the same imperative echo PaneHost's SplitGroup does for layout splits. The length
  // guard is not cosmetic: setLayout THROWS ("Invalid 0 panel layout") on a group whose panels have not
  // registered yet. A drag takes the other direction (onLayout → store), and lands within 0.01 of what
  // it just reported, so the two never chase each other.
  useEffect(() => {
    const g = group.current; if (!g) return;
    const current = g.getLayout();
    if (current.length !== 2) return;
    if (Math.abs((current[1] ?? NaN) - width) >= 0.01) g.setLayout([100 - width, width]);
  }, [width]);
  return (
    <PanelGroup ref={group} className="session-split" id={`sterm-${sessionId}`} direction="horizontal"
      onLayout={(sizes) => { if (sizes[1] !== undefined) setTerminalPanelWidth(sessionId, sizes[1]); }}>
      <Panel id={`sbody-${sessionId}`} order={1} defaultSize={100 - width} minSize={25}>{children}</Panel>
      {/* Same double-click-to-restore gesture as the layout dividers (PaneHost), and routed the same
          way — through the store, with the effect above pushing the result back into the group. This
          split is not born equal, so "original" here is the drawer's default width, not 50/50; the
          store's own sub-0.01 guard is what makes an untouched divider ignore the gesture. */}
      <PanelResizeHandle className="resize-handle"
        onDoubleClick={() => setTerminalPanelWidth(sessionId, TERMINAL_PANEL_WIDTH)} />
      <Panel id={`sterm-p-${sessionId}`} order={2} defaultSize={width} minSize={15}>
        {terminalId
          ? <TerminalView terminalId={terminalId} title={title} visible={visible} />
          : <div className="terminal-pane"><div className="terminal-hint"><div className="terminal-hint-path">Starting shell…</div></div></div>}
      </Panel>
    </PanelGroup>
  );
}

/** Transcript + composer for one agent session (item.refId = session id). PanelBar renders the header. */
export function SessionPane({ item, visible, focused = false }: PaneProps) {
  const id = item.refId;
  const session = useApp((s) => s.sessions[id]);
  const status = useApp((s) => s.sessionStatus[id] ?? s.sessions[id]?.status ?? "idle");
  const entry = useApp((s) => s.transcripts[id]);
  const spaces = useApp((s) => s.spaces);
  const openSession = useApp((s) => s.openSession);
  const sendMessage = useApp((s) => s.sendMessage);
  const interruptSession = useApp((s) => s.interruptSession);
  const respondPermission = useApp((s) => s.respondPermission);
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
  const gitInfo = useApp((s) => { const cwd = s.sessions[id]?.cwd; return cwd ? s.gitInfo[cwd] ?? null : null; });
  const panelOpen = useApp((s) => s.terminalPanel[id]?.open ?? false);
  const agentProbe = useApp((s) => s.agentProbe);
  const probeAgents = useApp((s) => s.probeAgents);
  const modelFavorites = useApp((s) => s.modelFavorites);
  const modelInfo = useApp((s) => s.modelInfo);
  const refreshModelCatalog = useApp((s) => s.refreshModelCatalog);
  const refreshModelFavorites = useApp((s) => s.refreshModelFavorites);
  const toggleModelFavorite = useApp((s) => s.toggleModelFavorite);
  const prefillTerminal = useApp((s) => s.prefillTerminal);
  const openDiff = useApp((s) => s.openDiff);
  const submitKey = useApp((s) => s.submitKey);
  // Stable across renders: InstallCard registers it as a window "focus" listener.
  const reprobe = useCallback(() => { run(() => probeAgents(true)); }, [probeAgents, run]);
  // Sends from THIS prompter, counted so the transcript can pin to the bottom on each one. Counted
  // here rather than off the transcript's own growth because only the prompter's send carries the
  // intent: ⌘⇧↩ dispatches the draft into a NEW session (store.dispatchDraft, bound in hotkeys.ts)
  // and must leave this scroller exactly where the reader parked it.
  const [sends, setSends] = useState(0);

  useEffect(() => { run(() => openSession(id)); }, [id, openSession, run]);
  // Cheap by construction: the store dedups concurrent calls and the server holds a TTL cache, so a
  // four-pane split (or a tab-back) costs one round trip, not a process spawn per agent.
  useEffect(() => { run(() => probeAgents()); }, [id, probeAgents, run]);
  // One settings read, alongside the probe. Favourites only ever change through this app's own
  // toggle (which writes through and updates the store), so there is nothing to poll for.
  useEffect(() => { run(() => refreshModelFavorites()); }, [refreshModelFavorites, run]);
  // Prices and context windows for the picker's detail pane. Same shape as the two reads above and
  // just as cheap: the server caches the catalog for a day, the store collapses concurrent calls, and
  // a failure leaves `modelInfo` empty — which the picker renders as rows without prices.
  useEffect(() => { run(() => refreshModelCatalog()); }, [refreshModelCatalog, run]);

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
  // The prompter's suggested prompt, derived from THIS session (prompt-hint.ts): the last turn, the
  // working tree, the mode. Computed here rather than in Composer because everything it reads is
  // already the pane's — Composer only draws it and fills it in on ⇥.
  const hint = promptHint({
    blocks: transcript.blocks, gitInfo, status, inPlan: session.permissionMode === PLAN_PERMISSION_MODE,
  });
  const blocked = isBlocked(availability) && status !== "running" && status !== "waiting_permission";
  const body = (
    <div className="session-pane" data-visible={visible || undefined} data-composer={hero ? "hero" : "docked"}>
      <Transcript transcript={transcript} sessionStatus={status} visible={visible} focused={focused} cwd={session.cwd}
        sends={sends}
        onDecide={(requestId, d, answers) => run(() => respondPermission(id, requestId, d, answers))} />
      {/* Between the log and the prompter, not inside the scroller: a delegated child running RIGHT
          NOW is not history, and it must not scroll away from the reader who went back to re-read
          something. It draws nothing at all when this session is waiting on no one. */}
      <DelegatedRuns sessionId={id} />
      {blocked && isBlocked(availability)
        ? <InstallCard availability={availability} onRetry={reprobe}
            onOpenInTerminal={(command) => run(() => prefillTerminal(id, command))} />
        : <Composer session={session} status={status} gitInfo={gitInfo}
            onOpenDiff={() => run(() => openDiff(session.environmentId))} draft={draft} onDraftChange={(t) => setDraft(id, t)}
            attachments={attachments}
            onAttachPick={() => run(() => attachFromPicker(id))}
            onAttachFiles={(files) => run(() => attachFiles(id, files))}
            onRemoveAttachment={(path) => removeAttachment(id, path)}
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
            // The agent's own modes off THIS session's init event (Plan 14 W3): null = handshake not
            // seen yet, [] = the agent named none — the difference between "wait" and "no Plan here".
            acpModes={transcript.init ? transcript.init.availableModes ?? [] : null}
            canSwitchAgent={canSwitchAgent}
            agentProbe={agentProbe}
            modelFavorites={modelFavorites} modelInfo={modelInfo}
            onToggleModelFavorite={(key) => run(() => toggleModelFavorite(key))}
            mentionSkills={mentionSkills} allSkills={allSkills} staleMentions={staleMentions}
            onToggleSkill={(skillId, enabled) => run(() => setSkillEnabled(session.spaceId, skillId, enabled))}
            onManageSkills={() => run(() => openSpacePage(session.spaceId, "skills"))}
            machineName={machineName} userName={userName} environments={spaceEnvironments}
            onSelectEnvironment={(envId) => run(() => setSessionEnvironment(id, envId))}
            onNewWorktree={() => run(() => moveSessionToNewWorktree(id))}
            connectors={connectors} onConnectorsOpened={() => run(() => refreshConnectors(session.spaceId))}
            onAddFolder={() => run(() => pickAndLinkProject())}
            onManageConnections={() => run(() => openSpacePage(session.spaceId, "connections"))}
            submitKey={submitKey}
            hero={hero} spaceName={space?.name ?? "this space"} onSuggestion={(p) => setDraft(id, p)}
            promptHint={hint} />}
    </div>
  );
  if (!panelOpen) return body;
  return <TerminalDrawer sessionId={id} title={terminalTitle(session.cwd)} visible={visible}>{body}</TerminalDrawer>;
}

/** The drawer's empty-state hint names where the shell opened — the session's cwd, by basename. */
function terminalTitle(cwd: string): string {
  return cwd.replace(/\/+$/, "").split("/").pop() || cwd;
}
