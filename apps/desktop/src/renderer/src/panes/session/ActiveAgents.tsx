import { AGENT_META, type AgentKind, type DelegatedChild } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Menu, type MenuItem } from "../../components/Menu";
import { useApp } from "../../state/store";
import { StateMark } from "../agents-tab/StateMark";
import { STATE_LABEL, isLive, modelLabel, orchestratorOrder, type SubagentState } from "../agents-tab/subagent-state";
import { stripAgents, useSessionSubagents, type SessionSubagent } from "./session-subagents";
import { formatDuration } from "./tool-group";
import type { Block } from "./transcript-model";
import { useElapsed } from "./use-elapsed";

/** How many agents the row names. Past it, the last place goes to "+N" and the rest are one click away. */
export const ROW_MAX = 3;

const NO_BLOCKS: readonly Block[] = [];
const NO_IDS: readonly string[] = [];
const NO_CHILDREN: readonly DelegatedChild[] = [];

/**
 * The agents the row shows, most urgent first: every one still going, and the ones the latest turn
 * started — the strip under the transcript's rule, so a finished teammate stays to be read and goes
 * with the next message — less the ones the person dismissed. What needs you leads, so the fold can
 * never hide it.
 */
function rowAgents(all: readonly SessionSubagent[], blocks: readonly Block[], dismissed: readonly string[]): SessionSubagent[] {
  const hidden = new Set(dismissed);
  return orchestratorOrder(stripAgents(all, blocks).filter((a) => !hidden.has(a.id)), (a) => a.state);
}

/** The agents `sessionId`'s row shows (`rowAgents`), read from the store — what decides whether the
 *  prompter draws its over-strip at all, as well as what goes on it. */
export function useRowAgents(sessionId: string): SessionSubagent[] {
  const all = useSessionSubagents(sessionId);
  const blocks = useApp((s) => s.transcripts[sessionId]?.t.blocks ?? NO_BLOCKS);
  const dismissed = useApp((s) => s.dismissedSubagents[sessionId] ?? NO_IDS);
  const loaded = useApp((s) => s.subagents[sessionId] !== undefined);
  const refreshSubagents = useApp((s) => s.refreshSubagents);
  const run = useApp((s) => s.run);
  // The list is otherwise read on demand (the Agents tab, a delegation line), and a teammate that
  // finished before a relaunch is still one the row owes the person until their next message.
  useEffect(() => { if (!loaded) run(() => refreshSubagents(sessionId)); }, [loaded, sessionId, refreshSubagents, run]);
  return useMemo(() => rowAgents(all, blocks, dismissed), [all, blocks, dismissed]);
}

/**
 * Who is working in this session, on the prompter's over-strip: the teammates the person added and the
 * sub-agents the session's agent started, each as its state's mark and its name. Nothing at all when
 * there are none.
 *
 * A click opens one in the session's Agents tab, as its line in the transcript does. Its menu (a
 * right-click) adds what can be done to it from here: put its name in the prompter to message it, stop
 * it, or take it off the row. A harness's own sub-agent runs inside the session's agent, so it can be
 * neither messaged nor stopped on its own, and its menu does not offer either.
 */
export function ActiveAgents({ sessionId, agents, onMessage }: {
  sessionId: string;
  /** `useRowAgents(sessionId)`, which the prompter has already read to decide on the strip. */
  agents: readonly SessionSubagent[];
  /** Put this sub-agent's name in the prompter, as the `@` list would. Absent where the prompter has
   *  no mentions to put it in. */
  onMessage?: (agent: { id: string; title: string }) => void;
}) {
  const children = useApp((s) => s.subagents[sessionId] ?? NO_CHILDREN);
  const leadKind = useApp((s) => (s.sessions[sessionId] ?? s.allSessions[sessionId])?.agentKind);
  const agentProbe = useApp((s) => s.agentProbe);
  const live = agents.filter((a) => isLive(a.state));
  const since = live.length > 0 ? Math.min(...live.map((a) => a.startedAt)) : 0;
  // One clock for the row, ticking while anything on it is live.
  const now = since + useElapsed(since, live.length > 0);
  if (agents.length === 0) return null;

  const describe = (a: SessionSubagent): Described => {
    const child = a.source === "delegated" ? children.find((c) => c.session.id === a.id) : undefined;
    const on = child
      ? `${AGENT_META[child.session.agentKind].label} · ${modelLabel(child.session.agentKind, child.session.model, agentProbe)}`
      : leadKind ? `inside ${AGENT_META[leadKind].label}` : null;
    const task = child?.goal?.split("\n")[0]?.trim() || null;
    const took = formatDuration(Math.max(0, (a.endedAt ?? now) - a.startedAt));
    // Its own harness for a delegated child; a harness's own sub-agent runs inside the lead's.
    const kind = child?.session.agentKind ?? leadKind ?? null;
    return { agent: a, kind, on, task: task && task !== a.title ? task : null, took, delegated: child !== undefined };
  };
  const shown = agents.length > ROW_MAX ? agents.slice(0, ROW_MAX - 1) : agents;
  const folded = agents.slice(shown.length);
  return (
    <div className="active-agents" role="group" aria-label="Agents in this session">
      {shown.map((a) => <AgentChip key={a.id} leadId={sessionId} d={describe(a)} onMessage={onMessage} />)}
      {folded.length > 0 && <MoreChip leadId={sessionId} agents={folded.map(describe)} />}
    </div>
  );
}

type Described = { agent: SessionSubagent; kind: AgentKind | null; on: string | null; task: string | null; took: string; delegated: boolean };

/**
 * Which agent it is, and where it stands: the harness's own mark — the one the model picker draws
 * beside the model — with the state on its corner. Live, the sidebar's dot; ended, the transcript's
 * glyph, so done, failed and stopped are told apart by shape as well as by tone.
 */
function AgentMark({ kind, state }: { kind: AgentKind | null; state: SubagentState }) {
  return (
    <span className="active-agent-mark" data-state={state}>
      {kind ? <Icon name={AGENT_META[kind].icon} size={14} colored /> : <Icon name="bot" size={14} />}
      <span className="active-agent-badge" aria-hidden="true">
        {isLive(state) ? <StateMark state={state} /> : <EndedGlyph state={state} />}
      </span>
    </span>
  );
}

function EndedGlyph({ state }: { state: SubagentState }) {
  const name = state === "done" ? "check" : state === "failed" || state === "timeout" ? "errorCircle" : "stop";
  // off-ladder: a badge on the corner of a 14px mark, where the 12 rung would cover the mark it marks.
  return <Icon name={name} size={8} />;
}

/** "Write the tests · Codex · GPT-6 Luna · Working, 2:10 · <its task>" — the name, what runs it, where it
 *  stands and for how long, and what it was asked when that says more than its name. */
function agentSummary(d: Described): string {
  return [d.agent.title, d.on, `${STATE_LABEL[d.agent.state]}, ${d.took}`, d.task].filter(Boolean).join(" · ");
}

function AgentChip({ leadId, d, onMessage }: { leadId: string; d: Described; onMessage?: (agent: { id: string; title: string }) => void }) {
  const { agent } = d;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const items = useAgentMenu(leadId, d, onMessage);
  const open = useOpen(leadId);
  return (
    <>
      <button type="button" className="ghost-chip active-agent" data-state={agent.state}
        title={`${agentSummary(d)}. Right-click for more.`}
        aria-label={`${agent.title}, ${STATE_LABEL[agent.state]}. Opens it in the Agents tab`}
        onClick={() => open(agent.id)}
        onContextMenu={(e) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); }}>
        <AgentMark kind={d.kind} state={agent.state} />
        <span className="chip-label">{agent.title}</span>
      </button>
      {menuAt && <Menu items={items} at={menuAt} onClose={() => setMenuAt(null)} label={agent.title} />}
    </>
  );
}

/** The rest of the row, folded: a count, and a menu of them. */
function MoreChip({ leadId, agents }: { leadId: string; agents: Described[] }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const show = useOpen(leadId);
  const items: MenuItem[] = agents.map((d) => ({
    label: d.agent.title, icon: <AgentMark kind={d.kind} state={d.agent.state} />,
    detail: STATE_LABEL[d.agent.state], title: agentSummary(d), onSelect: () => show(d.agent.id),
  }));
  return (
    <>
      <button ref={btn} type="button" className="ghost-chip active-agents-more" aria-haspopup="menu" aria-expanded={open}
        aria-label={`${agents.length} more ${agents.length === 1 ? "agent" : "agents"}`}
        title={agents.map((d) => `${d.agent.title} (${STATE_LABEL[d.agent.state].toLowerCase()})`).join(", ")}
        onClick={() => setOpen((v) => !v)}>
        <span className="chip-label">+{agents.length}</span>
      </button>
      {open && <Menu items={items} anchorRef={btn} placement="up" onClose={() => setOpen(false)} label="More agents" />}
    </>
  );
}

function useOpen(leadId: string): (id: string) => void {
  const openAgentsTab = useApp((s) => s.openAgentsTab);
  const run = useApp((s) => s.run);
  return (id) => run(() => openAgentsTab(leadId, { childId: id }));
}

/** What a chip's menu offers, by what its owner supports: a delegated child can be messaged and
 *  stopped; every agent can be opened and dismissed. */
function useAgentMenu(leadId: string, d: Described, onMessage?: (agent: { id: string; title: string }) => void): MenuItem[] {
  const open = useOpen(leadId);
  const interruptSession = useApp((s) => s.interruptSession);
  const dismissSubagent = useApp((s) => s.dismissSubagent);
  const run = useApp((s) => s.run);
  const { agent } = d;
  return [
    { label: "Open in Agents tab", icon: <Icon name="bot" size={16} />, onSelect: () => open(agent.id) },
    ...(d.delegated && onMessage ? [{ label: "Message", icon: <Icon name="comment" size={16} />, detail: "Name it in the prompter",
      onSelect: () => onMessage({ id: agent.id, title: agent.title }) } as MenuItem] : []),
    ...(d.delegated && isLive(agent.state) ? [{ label: "Stop", icon: <Icon name="stop" size={16} />,
      onSelect: () => run(() => interruptSession(agent.id)) } as MenuItem] : []),
    { label: "Dismiss", icon: <Icon name="close" size={16} />, detail: isLive(agent.state) ? "It keeps working" : undefined,
      title: "Take it off this row. It stays in the Agents tab.", onSelect: () => run(() => dismissSubagent(leadId, agent.id)) },
  ];
}
