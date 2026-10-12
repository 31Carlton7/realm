import { useEffect, useMemo } from "react";
import type { DelegatedChild } from "@realm/contracts";
import { useApp } from "../../state/store";
import { childTitle, isLive, subagentElapsed, subagentState, type SubagentState } from "../agents-tab/subagent-state";
import { harnessAgents } from "./DelegatedRuns";
import type { Block } from "./transcript-model";

/**
 * One sub-agent of a session, whichever kind it is: one the session's own harness runs in-process
 * (`Task`/`Agent`, keyed by its launching call's id) or a Realm session it delegated to (keyed by
 * that session's id). The id is what the Agents tab focuses a card by.
 */
export type SessionSubagent = {
  id: string;
  source: "harness" | "delegated";
  title: string;
  state: SubagentState;
  startedAt: number;
  /** Null while it is live. */
  endedAt: number | null;
};

const NO_BLOCKS: readonly Block[] = [];
const NO_CHILDREN: readonly DelegatedChild[] = [];

/**
 * Every sub-agent a session has, from the stores the pane-bar chip and the Agents tab already read:
 * the transcript's launching calls for the harness's own, and `subagents` (with the live statuses and
 * `delegatedRuns` that say where each stands) for delegated children. Nothing new is kept.
 */
export function useSessionSubagents(sessionId: string): SessionSubagent[] {
  const blocks = useApp((s) => s.transcripts[sessionId]?.t.blocks ?? NO_BLOCKS);
  const status = useApp((s) => s.sessionStatus[sessionId]);
  const children = useApp((s) => s.subagents[sessionId]) ?? NO_CHILDREN;
  const loaded = useApp((s) => s.subagents[sessionId] !== undefined);
  const runs = useApp((s) => s.delegatedRuns[sessionId]);
  const statuses = useApp((s) => s.sessionStatus);
  const refreshSubagents = useApp((s) => s.refreshSubagents);
  const run = useApp((s) => s.run);
  // The children are read on demand — by the Agents tab, or a delegation line. A session with a run
  // in flight and neither on screen still owes the strip its list.
  const owed = !loaded && (runs?.some((r) => r.owned) ?? false);
  useEffect(() => { if (owed) run(() => refreshSubagents(sessionId)); }, [owed, sessionId, refreshSubagents, run]);
  const live = status === undefined || status === "running" || status === "waiting_permission";
  return useMemo(() => {
    const harness: SessionSubagent[] = harnessAgents(blocks, live).map((h) => ({
      id: h.id, source: "harness", title: h.label, state: h.state, startedAt: h.startedAt, endedAt: h.endedAt,
    }));
    const delegated: SessionSubagent[] = children.map((c) => {
      const state = subagentState(c, statuses[c.session.id], runs?.some((r) => r.sessionId === c.session.id) ?? false);
      return {
        id: c.session.id, source: "delegated", title: childTitle(c), state, startedAt: c.startedAt,
        endedAt: isLive(state) ? null : c.startedAt + subagentElapsed(c, state, 0),
      };
    });
    return [...harness, ...delegated].sort((a, b) => a.startedAt - b.startedAt);
  }, [blocks, live, children, statuses, runs]);
}

/**
 * The ones the transcript's strip is about: every one still going, wherever it started, and the ones
 * the latest turn started, finished or not — so a turn's fan-out reads as done under that turn, and a
 * new message that starts none leaves no strip behind it.
 */
export function stripAgents(agents: readonly SessionSubagent[], blocks: readonly Block[]): SessionSubagent[] {
  let since = -Infinity;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "user") { since = b.ts; break; }
  }
  return agents.filter((a) => isLive(a.state) || a.startedAt >= since);
}

const sub = (n: number) => `${n} sub-agent${n === 1 ? "" : "s"}`;

/**
 * The strip's line, most urgent first: "2 sub-agents working · 1 needs you · 1 done" while any is
 * live, and "3 sub-agents finished · 1 failed" once none is.
 */
export function stripHeadline(states: readonly SubagentState[]): string {
  const n = (...of: SubagentState[]) => states.filter((s) => of.includes(s)).length;
  const working = n("working", "queued"), waiting = n("waiting");
  const failed = n("failed", "timeout"), stopped = n("stopped", "cancelled"), done = n("done");
  const needs = (k: number) => `${k} ${k === 1 ? "needs" : "need"} you`;
  if (working + waiting === 0) {
    return [sub(states.length) + " finished", failed > 0 && `${failed} failed`, stopped > 0 && `${stopped} stopped`]
      .filter(Boolean).join(" · ");
  }
  const head = working > 0 ? `${sub(working)} working` : `${sub(waiting)} ${waiting === 1 ? "needs" : "need"} you`;
  return [head, working > 0 && waiting > 0 && needs(waiting), done > 0 && `${done} done`,
    failed > 0 && `${failed} failed`, stopped > 0 && `${stopped} stopped`].filter(Boolean).join(" · ");
}
