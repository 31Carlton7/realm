import { AGENT_MODELS, DEFAULT_MODEL_LABEL, type AgentKind, type DelegatedChild, type SessionStatus } from "@realm/contracts";

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

/** The transcript's line for the same state — "Subagent finished · <task>", as Codex writes it. */
export const STATE_VERB: Record<SubagentState, string> = {
  queued: "Subagent starting", working: "Subagent working", waiting: "Subagent waiting on you", done: "Subagent finished",
  failed: "Subagent failed", timeout: "Subagent timed out", stopped: "Subagent stopped", cancelled: "Subagent cancelled",
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
 *  (Claude), and the id itself when neither has heard of it — a wrong name is worse than the id. */
export function modelLabel(kind: AgentKind, id: string | null, probe: readonly { kind: AgentKind; models?: readonly { id: string; label: string }[] | null }[]): string {
  if (id === null) return DEFAULT_MODEL_LABEL[kind];
  const named = (probe.find((p) => p.kind === kind)?.models ?? []).find((m) => m.id === id)
    ?? (AGENT_MODELS[kind] as readonly { id: string; label: string }[]).find((m) => m.id === id);
  return named?.label.replace(/\[[^\]]*\]\s*$/, "") ?? id;
}

/** What a sub-agent's row is titled with: its own title — the name its lead gave the task, or the
 *  one Realm read out of the goal — and the goal's first line only for a child with none. The rest
 *  of the brief is a click away. */
export function taskTitle(title: string | null | undefined, goal: string | null, fallback: string): string {
  if (title && title.trim() !== "") return title.trim();
  const line = (goal ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "");
  return line ?? fallback;
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
