import { useMemo } from "react";
import type { Session } from "@realm/contracts";
import { liveSessions, type LiveSession } from "../../state/attention";
import { useApp, useProfileSpaces } from "../../state/store";

/**
 * Every live session in the active profile — waiting on you, working, or finished with something
 * unread — most urgent first. What the sidebar's cross-room rows are drawn from.
 *
 * The profile is the boundary for the same reason the strip and the swiper keep to it: crossing it
 * is the profile chip's job, and a Work column listing a School session would be the leak the scoping
 * exists to stop.
 *
 * The active room's own row wins over the home-wide one: it is the copy that room's list reads, so a
 * session listed in both places can never wear a ring in one and not the other. The quick chat is
 * left out — it has no item in any room, so a row for it would be a click with nowhere to land.
 */
export function useLiveSessions(): LiveSession[] {
  const all = useApp((s) => s.allSessions);
  const local = useApp((s) => s.sessions);
  const status = useApp((s) => s.sessionStatus);
  const space = useApp((s) => s.sessionSpace);
  const updatedAt = useApp((s) => s.sessionUpdatedAt);
  const quick = useApp((s) => s.quickChat?.sessionId ?? null);
  const spaces = useProfileSpaces();
  return useMemo(() => {
    const inProfile = new Set(spaces.map((s) => s.id));
    const rows = new Map<string, Session>();
    for (const row of Object.values(all)) rows.set(row.id, row);
    for (const row of Object.values(local)) rows.set(row.id, row);
    if (quick) rows.delete(quick);
    return liveSessions(rows.values(), { status, space, updatedAt }).filter((l) => inProfile.has(l.spaceId));
  }, [all, local, status, space, updatedAt, quick, spaces]);
}
