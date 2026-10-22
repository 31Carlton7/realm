import type { DelegatedChild, SessionStatus } from "@realm/contracts";

/**
 * Where one sub-agent stands, in the words its lead's Agents tab and transcript use for it. Shared
 * (`@realm/view`) so Realm Mobile says how a sub-agent's work went the way the Agents tab does.
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

/** Still going, in any sense a clock should keep ticking for. */
export const isLive = (state: SubagentState): boolean => state === "queued" || state === "working" || state === "waiting";

export function subagentState(child: Pick<DelegatedChild, "session" | "outcome" | "report">, live: SessionStatus | undefined, inFlight: boolean): SubagentState {
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
