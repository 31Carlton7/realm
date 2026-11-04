import type { SessionStatus } from "@realm/contracts";

/**
 * The sessions whose sub-agents are still at work, at any depth: a lead with a child running or
 * waiting on a person, and that lead's own lead.
 *
 * The unread mark waits on this. A lead that ended its turn with sub-agents still going has not
 * finished — what it started is still coming in — so it is unread only once the last of them is done.
 * Shared, so the sidebar's session and teammate rows and Realm Mobile's home wait on the same thing.
 *
 * `statuses` is every session's live status; `leadOf` names the session that started a sub-agent,
 * and null for any session that is nobody's sub-agent.
 */
export function leadsWithAgentsAtWork(statuses: Iterable<readonly [string, SessionStatus]>, leadOf: (id: string) => string | null): Set<string> {
  const leads = new Set<string>();
  for (const [id, status] of statuses) {
    if (status !== "running" && status !== "waiting_permission") continue;
    // Stops at a session already passed, so rows that name each other as lead cannot loop.
    const walked = new Set([id]);
    for (let lead = leadOf(id); lead !== null && !walked.has(lead); lead = leadOf(lead)) {
      walked.add(lead);
      leads.add(lead);
    }
  }
  return leads;
}
