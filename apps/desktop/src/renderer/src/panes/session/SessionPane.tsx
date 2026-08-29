import { Icon } from "@realm/ui";
import { useCallback, useEffect, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { Item } from "@realm/contracts";
import { TERMINAL_PANEL_WIDTH, useApp } from "../../state/store";
import { agentAvailability, isBlocked } from "../../state/agent-availability";
import { TerminalView } from "../TerminalPane";
import type { PaneProps } from "../registry";
import { Composer } from "./Composer";
import { InstallCard } from "./InstallCard";
import { Transcript } from "./Transcript";
import { emptyTranscript } from "./transcript-model";

const STATUS_LABEL = { idle: "Idle", running: "Running", waiting_permission: "Needs permission", error: "Error", ended: "Ended" } as const;

const fmtCost = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);

/** PanelBar right-side meta for a session item: model label, cost (only once real spend exists), status dot.
 *  PanelBar owns the icon + title; this is everything the old .session-header showed on its right. */
export function SessionMeta({ item }: { item: Item }) {
  const id = item.refId;
  const status = useApp((s) => s.sessionStatus[id] ?? s.sessions[id]?.status ?? "idle");
  const model = useApp((s) => s.sessions[id]?.model ?? s.transcripts[id]?.t.init?.model ?? null);
  const usage = useApp((s) => s.transcripts[id]?.t.usage ?? null);
  return (
    <>
      {model && <span>{model}</span>}
      {usage && usage.costUsd > 0 && <span>{fmtCost(usage.costUsd)} · {usage.numTurns} {usage.numTurns === 1 ? "turn" : "turns"}</span>}
      <span className="status-dot" data-status={status} title={STATUS_LABEL[status]} aria-label={`Status: ${STATUS_LABEL[status]}`} />
    </>
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
      <Icon name="terminal" size={13} />
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
  // Restore path: the panel was left open in a previous run, so the terminal is fetched (never created
  // twice — the server's openTerminal is get-or-create, and the store guards concurrent calls).
  useEffect(() => { if (!terminalId) run(() => ensureSessionTerminal(sessionId)); }, [terminalId, sessionId, ensureSessionTerminal, run]);
  return (
    <PanelGroup className="session-split" id={`sterm-${sessionId}`} direction="horizontal"
      onLayout={(sizes) => { if (sizes[1] !== undefined) setTerminalPanelWidth(sessionId, sizes[1]); }}>
      <Panel id={`sbody-${sessionId}`} order={1} defaultSize={100 - width} minSize={25}>{children}</Panel>
      <PanelResizeHandle className="resize-handle" />
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
  const projects = useApp((s) => s.projects);
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
  const gitInfo = useApp((s) => { const cwd = s.sessions[id]?.cwd; return cwd ? s.gitInfo[cwd] ?? null : null; });
  const panelOpen = useApp((s) => s.terminalPanel[id]?.open ?? false);
  const agentProbe = useApp((s) => s.agentProbe);
  const probeAgents = useApp((s) => s.probeAgents);
  const prefillTerminal = useApp((s) => s.prefillTerminal);
  // Stable across renders: InstallCard registers it as a window "focus" listener.
  const reprobe = useCallback(() => { run(() => probeAgents(true)); }, [probeAgents, run]);

  useEffect(() => { run(() => openSession(id)); }, [id, openSession, run]);
  // Cheap by construction: the store dedups concurrent calls and the server holds a TTL cache, so a
  // four-pane split (or a tab-back) costs one round trip, not a process spawn per agent.
  useEffect(() => { run(() => probeAgents()); }, [id, probeAgents, run]);

  if (!session) return <div className="pane-placeholder muted">Loading session…</div>;
  const project = session.projectId ? projects.find((p) => p.id === session.projectId) ?? null : null;
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
  const blocked = isBlocked(availability) && status !== "running" && status !== "waiting_permission";
  const body = (
    <div className="session-pane" data-visible={visible || undefined} data-composer={hero ? "hero" : "docked"}>
      <Transcript transcript={transcript} sessionStatus={status} visible={visible} focused={focused}
        onDecide={(requestId, d) => run(() => respondPermission(id, requestId, d))} />
      {blocked && isBlocked(availability)
        ? <InstallCard availability={availability} onRetry={reprobe}
            onOpenInTerminal={(command) => run(() => prefillTerminal(id, command))} />
        : <Composer session={session} status={status} project={project} gitInfo={gitInfo} draft={draft} onDraftChange={(t) => setDraft(id, t)}
            onSend={(text) => run(() => sendMessage(id, text))}
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
            canSwitchAgent={canSwitchAgent}
            agentProbe={agentProbe}
            hero={hero} spaceName={space?.name ?? "this space"} onSuggestion={(p) => setDraft(id, p)} />}
    </div>
  );
  if (!panelOpen) return body;
  return <TerminalDrawer sessionId={id} title={terminalTitle(session.cwd)} visible={visible}>{body}</TerminalDrawer>;
}

/** The drawer's empty-state hint names where the shell opened — the session's cwd, by basename. */
function terminalTitle(cwd: string): string {
  return cwd.replace(/\/+$/, "").split("/").pop() || cwd;
}
