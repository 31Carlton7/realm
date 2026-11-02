import type { Teammate, TeammateState, TeammateTaskSession } from "@realm/contracts";

/** The dot a teammate or one of its sessions wears, in the session rows' vocabulary (attention.ts),
 *  and the words it is read out in: its state when that is worth a mark, else unread, else nothing. */
export function teammateMark(state: TeammateState, unread: boolean):
  { mark: "running" | "waiting_permission" | "unseen"; label: string } | null {
  if (state === "needs-you") return { mark: "waiting_permission", label: "needs you" };
  if (state === "working") return { mark: "running", label: "working" };
  return unread ? { mark: "unseen", label: "new since you were here" } : null;
}

/** The computer's state line: "Ready", "Working", "Needs you". */
export const STATE_WORD: Record<TeammateState, string> = { idle: "Ready", working: "Working", "needs-you": "Needs you" };

/** A session in a teammate's list, at its depth, with how many were handed on from it. */
export type SessionNode = { session: TeammateTaskSession; depth: number; handoffs: number };

/**
 * A teammate's sessions as the list draws them: newest first at the top, and every session handed on
 * from one directly under it, one step in — and again under those. A session whose parent is not in
 * the list (capped, or another teammate's) starts a branch of its own.
 */
export function sessionTree(sessions: readonly TeammateTaskSession[]): SessionNode[] {
  const ids = new Set(sessions.map((s) => s.id));
  const kids = new Map<string, TeammateTaskSession[]>();
  for (const s of sessions) if (s.parentId && ids.has(s.parentId)) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s]);
  const newest = (a: TeammateTaskSession, b: TeammateTaskSession) => b.updatedAt - a.updatedAt;
  const out: SessionNode[] = [];
  const walk = (s: TeammateTaskSession, depth: number) => {
    const under = [...(kids.get(s.id) ?? [])].sort(newest);
    out.push({ session: s, depth, handoffs: under.length });
    for (const k of under) walk(k, depth + 1);
  };
  for (const s of [...sessions].filter((s) => !s.parentId || !ids.has(s.parentId)).sort(newest)) walk(s, 0);
  return out;
}

/** A space's teammates as the sidebar lists them: the ones in no group at the top, then each group
 *  in the order its first teammate stands. */
export function groupTeammates(list: readonly Teammate[]): { top: Teammate[]; groups: [string, Teammate[]][] } {
  const top: Teammate[] = [];
  const groups = new Map<string, Teammate[]>();
  for (const t of list) {
    if (t.group) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
    else top.push(t);
  }
  return { top, groups: [...groups] };
}

/** The sessions a teammate's sidebar row unfolds to: the ones still running or waiting, and the
 *  newest others, up to `cap` in all — the rest are on its computer. */
export function recentSessions(sessions: readonly TeammateTaskSession[], cap = 5): TeammateTaskSession[] {
  const live = sessions.filter((s) => s.state !== "idle");
  const rest = sessions.filter((s) => s.state === "idle");
  const keep = new Set([...live, ...rest].slice(0, Math.max(cap, live.length)).map((s) => s.id));
  return sessions.filter((s) => keep.has(s.id));
}
