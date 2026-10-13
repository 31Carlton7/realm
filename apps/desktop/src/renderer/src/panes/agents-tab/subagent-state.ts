import { AGENT_META, AGENT_MODELS, DEFAULT_MODEL_LABEL, type AgentKind, type DelegatedChild, type SessionStatus } from "@realm/contracts";

/**
 * Where one sub-agent stands, in the words its lead's Agents tab and transcript use for it.
 *
 * Two sources, and the order between them is the point. The child's LIVE status says what it is doing
 * now — a finished child someone has since sent a message to is working again, whatever its recorded
 * outcome says. Once it is not busy, the outcome `agent_run` wrote down says how its run ended, which
 * the status cannot: a child that timed out and one that finished both sit at `idle`.
 */
export type SubagentState = "queued" | "working" | "waiting" | "done" | "failed" | "timeout" | "stopped" | "cancelled";

export const STATE_LABEL: Record<SubagentState, string> = {
  queued: "Queued", working: "Working", waiting: "Needs you", done: "Done",
  failed: "Failed", timeout: "Timed out", stopped: "Stopped", cancelled: "Cancelled",
};

/** The transcript's line for the same state — "Sub-agent finished · <task>", as Codex writes it. */
export const STATE_VERB: Record<SubagentState, string> = {
  queued: "Sub-agent starting", working: "Sub-agent working", waiting: "Sub-agent waiting on you", done: "Sub-agent finished",
  failed: "Sub-agent failed", timeout: "Sub-agent timed out", stopped: "Sub-agent stopped", cancelled: "Sub-agent cancelled",
};

/** Still going, in any sense a clock should keep ticking for. */
export const isLive = (state: SubagentState): boolean => state === "queued" || state === "working" || state === "waiting";

export function subagentState(child: DelegatedChild, live: SessionStatus | undefined, inFlight: boolean): SubagentState {
  const status = live ?? child.session.status;
  if (status === "waiting_permission") return "waiting";
  if (status === "running") return "working";
  switch (child.outcome) {
    case "done": return "done";
    case "timeout": return "timeout";
    case "stopped": return "stopped";
    case "interrupted": return "cancelled";
    case "failed": case "gone": return "failed";
    case null: break;
  }
  if (status === "error") return "failed";
  // Nothing recorded. Either the run has not begun its first turn yet, or the child came from a tool
  // that keeps no ledger (a browser agent, a reviewer) — whose last word is then the only evidence
  // that it finished. A child no run is waiting on and that never spoke did not finish.
  if (inFlight) return "queued";
  if (child.report !== null) return "done";
  return status === "ended" ? "failed" : "stopped";
}

/** How long it ran — still running, how long it has been going. */
export function subagentElapsed(child: DelegatedChild, state: SubagentState, now: number): number {
  if (isLive(state)) return Math.max(0, now - child.startedAt);
  const end = child.settledAt ?? child.activity?.ts ?? child.session.updatedAt;
  return Math.max(0, end - child.startedAt);
}

/** A model id's name: the probe's live catalog first (Codex, Cursor), the curated list next
 *  (Claude), and the id itself when neither has heard of it — a wrong name is worse than the id.
 *  Named as the picker names it under its harness: "Opus 5.5" beside Claude's mark. */
export function modelLabel(kind: AgentKind, id: string | null, probe: readonly { kind: AgentKind; models?: readonly { id: string; label: string }[] | null }[]): string {
  if (id === null) return DEFAULT_MODEL_LABEL[kind];
  const named = (probe.find((p) => p.kind === kind)?.models ?? []).find((m) => m.id === id)
    ?? (AGENT_MODELS[kind] as readonly { id: string; label: string }[]).find((m) => m.id === id);
  const label = named?.label.replace(/\[[^\]]*\]\s*$/, "") ?? id;
  // Beside the harness's own mark the harness's name is said twice — "Claude Fable 5.1" on one row
  // and the default "Fable 5.1" on the next read as two models. The picker's rule: the word comes off
  // only when what follows is itself a name, never leaving a bare version.
  const harness = `${AGENT_META[kind].label} `;
  const rest = label.startsWith(harness) ? label.slice(harness.length) : null;
  return rest !== null && /^[A-Za-z]+(\s|$)/.test(rest) ? rest : label;
}

/** What a sub-agent's row is titled with: its own title — the name its lead gave the task, or the
 *  one Realm read out of the goal — and the goal's first line only for a child with none. The rest
 *  of the brief is a click away. */
export function taskTitle(title: string | null | undefined, goal: string | null, fallback: string): string {
  if (title && title.trim() !== "") return title.trim();
  const line = (goal ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "");
  return line ?? fallback;
}

/** What a sub-agent's card is titled: `taskTitle` over its session's title — unless that is still the
 *  "Agent: <first line of the goal>" an older build wrote and the boot repair could not claim (a row
 *  renamed in one place but not the other), which is boilerplate cut at forty characters; the goal's
 *  first line says the same thing whole. */
export function childTitle(child: Pick<DelegatedChild, "goal" | "session">): string {
  const title = child.session.title;
  return taskTitle(/^(Agent|Browser agent): /.test(title.trim()) ? null : title, child.goal, "Sub-agent");
}

/** Where a state sorts in the Agents tab: what waits on you, then what is working, then what has
 *  ended — the order the sidebar puts sessions in, for the same reason. */
const ORDER: Record<SubagentState, number> = { waiting: 0, working: 1, queued: 1, done: 2, failed: 2, timeout: 2, stopped: 2, cancelled: 2 };

/** The tab's order: by `ORDER`, then by when each started, oldest first. A sorted copy. */
export function orchestratorOrder<T extends { startedAt: number }>(children: readonly T[], stateOf: (c: T) => SubagentState): T[] {
  return [...children].sort((a, b) => ORDER[stateOf(a)] - ORDER[stateOf(b)] || a.startedAt - b.startedAt);
}

/** The roll-up over the cards, in words, most urgent first: "1 needs you · 3 working · 1 done". */
export function rollup(states: readonly SubagentState[]): string {
  const n = (...of: SubagentState[]) => states.filter((s) => of.includes(s)).length;
  return [
    [n("waiting"), n("waiting") === 1 ? "needs you" : "need you"], [n("working", "queued"), "working"], [n("done"), "done"],
    [n("failed", "timeout"), "failed"], [n("stopped", "cancelled"), "stopped"],
  ].filter(([k]) => (k as number) > 0).map(([k, w]) => `${k} ${w}`).join(" · ");
}

/** How much of its budget of working time a child has spent: the server's figure, carried forward
 *  while it works and held while it waits on you, which the budget does not charge it for. Null
 *  where the server kept none. */
export function spentMs(child: Pick<DelegatedChild, "working">, state: SubagentState, now: number): number | null {
  const w = child.working;
  if (!w) return null;
  return state === "working" || state === "queued" ? w.ms + Math.max(0, now - w.at) : w.ms;
}

/**
 * A report as a line or three of plain prose: what the row says once the child is done.
 *
 * The report is markdown, and the row is not a document — headings, fences and emphasis markers are
 * dropped rather than drawn, and the full report is the child's own transcript, one click away.
 */
export function reportSummary(report: string): string {
  return report
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
