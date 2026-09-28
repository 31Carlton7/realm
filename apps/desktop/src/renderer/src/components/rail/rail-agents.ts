import type { Session, SessionStatus } from "@realm/contracts";
import { groupAgents } from "../../panes/agents/AgentsPage";
import { AT_WORK } from "../../state/session-activity";

/**
 * The agents the right rail lists: every session in the profile that is at work, grouped and
 * ordered exactly as the Agents page groups them.
 *
 * Built ON `groupAgents` rather than beside it. The page and the rail answer the same question —
 * "what needs me, and what is running" — and two orderings of one answer is two answers. The rail
 * takes the page's groups and keeps only the at-work ones, so a session can never be "Needs you"
 * in one place and "Working" in the other.
 *
 * Two row sources, merged. `rows` is every space's rows from the last cross-space list; `local` is
 * the active space's, which the store keeps current as titles change — so where a session is in
 * both, the local row wins. Status is read from `status`, the live map, never from either row.
 *
 * The quick chat is left out. It is already on screen as its own window whenever it exists, and it
 * has no item in any space, so `revealSession` has nothing to open for it — a row there would be a
 * link to a window you are looking at, that does not work.
 */
export function railAgents(d: {
  rows: Readonly<Record<string, Session>>;
  local: Readonly<Record<string, Session>>;
  status: Readonly<Record<string, SessionStatus>>;
  quickChatId: string | null;
}): ReturnType<typeof groupAgents> {
  const merged = { ...d.rows, ...d.local };
  const working = Object.values(merged).filter(
    (s) => s.id !== d.quickChatId && AT_WORK.has(d.status[s.id] ?? s.status),
  );
  return groupAgents(working, d.status as Record<string, SessionStatus>);
}

/**
 * The set of ids at work, as one stable string — what the rail watches to decide when its rows
 * need re-reading. A status flicker inside the set changes nothing; an agent starting or stopping
 * changes the key.
 */
export function workingKey(groups: ReturnType<typeof groupAgents>): string {
  return groups.flatMap((g) => g.rows.map((r) => r.id)).sort().join(",");
}
