import { AGENT_META, type SessionStatus } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { createContext, useContext, useEffect } from "react";
import { Spinner } from "../../components/Spinner";
import { useApp } from "../../state/store";
import { STATE_VERB, isLive, modelLabel, subagentElapsed, subagentState, taskTitle, type SubagentState } from "../agents-tab/subagent-state";
import { delegatedChildIds } from "./DelegatedRuns";
import { formatDuration, type ToolBlock } from "./tool-group";

export { isDelegationLine, isDelegationWait } from "./tool-group";
import { useElapsed } from "./use-elapsed";

/** The session a transcript belongs to, for the lines inside it that need their lead: a delegation
 *  line links to its row in THIS session's Agents tab. Null in the read-only mounts (a fork preview,
 *  a test), where the line still reads and links nowhere. */
export const LeadSessionContext = createContext<string | null>(null);

/**
 * A sub-agent, as its lead's transcript shows it: one quiet line — "Subagent finished · Write the
 * migration", the model it ran on, how long — and a click away from its row in the Agents tab.
 *
 * The call's raw input and result are deliberately not here. What a person wants from a delegation
 * is whether it finished and what it said, and both are in the Agents tab and the child's own
 * transcript; a card of JSON beside each one is how a fan-out of four becomes a wall.
 */
export function DelegationLine({ block, sessionStatus, enter = false }: { block: ToolBlock; sessionStatus: SessionStatus; enter?: boolean }) {
  const lead = useContext(LeadSessionContext);
  const children = useApp((s) => (lead ? s.subagents[lead] : undefined));
  const refreshSubagents = useApp((s) => s.refreshSubagents);
  const openAgentsTab = useApp((s) => s.openAgentsTab);
  const run = useApp((s) => s.run);
  const loaded = children !== undefined;
  // A transcript opened without its Agents tab has never read the list; the first line asks.
  useEffect(() => { if (lead && !loaded) run(() => refreshSubagents(lead)); }, [lead, loaded, refreshSubagents, run]);
  const ids = delegatedChildIds(block);
  const goal = typeof block.input.goal === "string" ? block.input.goal : "";
  /* By the id its result names — and, for an `agent_run` still blocking (no result yet), by its task:
     the only thing the call and the child share before the call returns. */
  const child = children?.find((c) => ids.includes(c.session.id))
    ?? (block.result ? undefined : children?.find((c) => c.goal === goal));
  const id = child?.session.id ?? null;
  const live = useApp((s) => (id ? s.sessionStatus[id] : undefined));
  const inFlight = useApp((s) => (id && lead ? s.delegatedRuns[lead]?.some((r) => r.sessionId === id) ?? false : false));
  const probe = useApp((s) => s.agentProbe);
  /* A call whose child this window cannot find once the list has loaded — the session was deleted —
     says only what it was asked; claiming it is still starting would leave a spinner on it forever. */
  const gone = loaded && !child && block.result !== null;
  const state: SubagentState = child ? subagentState(child, live, inFlight) : "queued";
  const ticking = child ? isLive(state) : !gone && (sessionStatus === "running" || sessionStatus === "waiting_permission");
  const runningFor = useElapsed(child?.startedAt ?? block.ts, ticking);
  const elapsed = child && !isLive(state) ? subagentElapsed(child, state, Date.now()) : runningFor;
  const named = (block.input.constraints as { model?: unknown } | undefined)?.model;
  const model = child ? modelLabel(child.session.agentKind, child.session.model, probe) : typeof named === "string" ? named : null;
  const kind = child?.session.agentKind ?? null;
  // The child's own title once it exists; before that, the name the call gave it.
  const task = taskTitle(child?.session.title ?? (typeof block.input.title === "string" ? block.input.title : null), goal, "Sub-agent");
  return (
    <div className="tool-card delegation-line" data-tool-use-id={block.toolUseId} data-state={state} data-enter={enter || undefined}>
      <button type="button" className="tool-row" disabled={!lead || !id}
        title={lead && id ? "Show it in this session's Agents tab" : undefined}
        aria-label={`${gone ? "Subagent" : STATE_VERB[state]}: ${task}${model ? `, on ${model}` : ""}`}
        onClick={() => { if (lead && id) run(() => openAgentsTab(lead, { childId: id })); }}>
        <span className="tool-status" aria-hidden="true">
          {gone ? null
            : state === "working" || state === "queued" ? <Spinner size={16} />
            : state === "waiting" ? <span className="status-dot" data-status="waiting_permission" />
            : state === "done" ? <Icon name="check" size={14} />
            : state === "stopped" || state === "cancelled" ? <Icon name="stop" size={14} />
            : <Icon name="errorCircle" size={14} />}
        </span>
        <span className="tool-name">{gone ? "Subagent" : STATE_VERB[state]}</span>
        <span className="delegation-line-task" title={goal}>{task}</span>
        {model && (
          <span className="delegation-line-model">
            {kind && <Icon name={AGENT_META[kind].icon} size={12} colored />}
            <span>{model}</span>
          </span>
        )}
        {!gone && <span className="delegation-line-time">{formatDuration(elapsed)}</span>}
      </button>
    </div>
  );
}

/** One collected report per `## Agent <id> — …` heading in the call's result — `agent_wait`'s own
 *  format (agent-run.ts `reportSection`). The ids listed as still running are not collected. */
const COLLECTED = /^## Agent [0-9A-HJKMNP-TV-Z]{26} — /gm;

/**
 * The lead waiting for its sub-agents, as a line of the same kind: "Waiting for 2 subagents", then
 * "Collected 2 reports". The reports themselves are each sub-agent's own, in the Agents tab — which
 * is where the line goes.
 */
export function DelegationWait({ block, sessionStatus, enter = false }: { block: ToolBlock; sessionStatus: SessionStatus; enter?: boolean }) {
  const lead = useContext(LeadSessionContext);
  const owned = useApp((s) => (lead ? s.delegatedRuns[lead]?.filter((r) => r.owned).length ?? 0 : 0));
  const openAgentsTab = useApp((s) => s.openAgentsTab);
  const run = useApp((s) => s.run);
  const waiting = block.result === null;
  const live = waiting && (sessionStatus === "running" || sessionStatus === "waiting_permission");
  const collected = block.result ? (block.result.content.match(COLLECTED) ?? []).length : 0;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const label = waiting
    ? (owned > 0 ? `Waiting for ${plural(owned, "subagent")}` : "Waiting for subagents")
    : `Collected ${plural(collected, "report")}`;
  return (
    <div className="tool-card delegation-line" data-tool-use-id={block.toolUseId} data-state={waiting ? "working" : "done"} data-enter={enter || undefined}>
      <button type="button" className="tool-row" disabled={!lead} title={lead ? "Show them in this session's Agents tab" : undefined}
        onClick={() => { if (lead) run(() => openAgentsTab(lead)); }}>
        <span className="tool-status" aria-hidden="true">
          {live ? <Spinner size={16} /> : waiting ? null : <Icon name="check" size={14} />}
        </span>
        <span className="tool-name">{label}</span>
      </button>
    </div>
  );
}
