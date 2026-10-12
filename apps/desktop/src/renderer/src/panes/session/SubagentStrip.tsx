import { Icon } from "@realm/ui";
import { useMemo } from "react";
import { useApp } from "../../state/store";
import { StateMark } from "../agents-tab/StateMark";
import { STATE_LABEL, isLive } from "../agents-tab/subagent-state";
import { stripAgents, stripHeadline, useSessionSubagents } from "./session-subagents";
import { formatDuration } from "./tool-group";
import type { Block } from "./transcript-model";
import { useElapsed } from "./use-elapsed";

/**
 * The session's sub-agents, under its last message: what the pane-bar chip counts, said where the
 * reader is looking. A turn that ends with agents still out in the background used to end on its
 * last sentence, and the only sign anything was still working was a count in the corner.
 *
 * While any is live it lists them — each one's task, where it stands and for how long — and once
 * none is, it folds to the one line that says how they ended. Every part of it opens this session's
 * Agents tab, a row on that sub-agent's card, because that is where each one can be followed.
 */
export function SubagentStrip({ sessionId, blocks }: { sessionId: string; blocks: readonly Block[] }) {
  const all = useSessionSubagents(sessionId);
  const agents = useMemo(() => stripAgents(all, blocks), [all, blocks]);
  const openAgentsTab = useApp((s) => s.openAgentsTab);
  const run = useApp((s) => s.run);
  const live = agents.filter((a) => isLive(a.state));
  const since = live.length > 0 ? Math.min(...live.map((a) => a.startedAt)) : 0;
  // One clock for the strip, the chip's way: it ticks while anything is live, and every row reads it.
  const elapsed = useElapsed(since, live.length > 0);
  if (agents.length === 0) return null;
  const now = since + elapsed;
  const headline = stripHeadline(agents.map((a) => a.state));
  const open = (childId?: string) => run(() => openAgentsTab(sessionId, childId ? { childId } : undefined));
  if (live.length === 0) {
    return (
      <section className="subagent-strip" data-settled="" aria-label="Sub-agents">
        <button type="button" className="subagent-strip-head" title="Show them in this session's Agents tab" onClick={() => open()}>
          <Icon name="bot" size={14} />
          <span className="subagent-strip-line">{headline}</span>
          <Icon name="chevronRight" size={12} className="subagent-strip-go" />
        </button>
      </section>
    );
  }
  return (
    <section className="subagent-strip" aria-label="Sub-agents">
      <button type="button" className="subagent-strip-head" title="Show them in this session's Agents tab" onClick={() => open()}>
        <Icon name="bot" size={14} />
        <span className="subagent-strip-line">{headline}</span>
        <span className="subagent-strip-time">{formatDuration(elapsed)}</span>
        <Icon name="chevronRight" size={12} className="subagent-strip-go" />
      </button>
      <ul className="subagent-strip-list">
        {agents.map((a) => {
          const took = formatDuration(Math.max(0, (a.endedAt ?? now) - a.startedAt));
          return (
            <li key={a.id}>
              <button type="button" className="subagent-strip-row" data-state={a.state}
                aria-label={`${a.title}. ${STATE_LABEL[a.state]}, ${took}. Show it in the Agents tab`}
                onClick={() => open(a.id)}>
                <span className="subagent-strip-mark"><StateMark state={a.state} /></span>
                <span className="subagent-strip-title">{a.title}</span>
                <span className="subagent-strip-state">{STATE_LABEL[a.state]}</span>
                <span className="subagent-strip-time">{took}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
