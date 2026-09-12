import type { Session } from "@realm/contracts";

/**
 * The chat feed's arithmetic: which day a session belongs to, and in what order the days come.
 *
 * Pure and separate from the component for the usual reason, and one specific one: every bug this
 * kind of list has is a date bug, and date bugs are only findable with a fixed `now`. Nothing here
 * reads the clock — the caller passes it.
 *
 * Local time throughout, deliberately. A day heading is a claim about the user's day, so "Today" has
 * to mean the day they are having, not UTC's. That is also why the boundary is computed by zeroing a
 * local `Date` rather than by dividing epoch milliseconds: days are not all 86,400,000 ms long, and a
 * feed that thought so would mislabel every row on the two days a year that clocks change.
 */

/** Midnight at the start of `ts`'s local day. */
function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole local days between two instants — 0 for the same day, 1 for yesterday. */
export function daysApart(ts: number, now: number): number {
  return Math.round((startOfLocalDay(now) - startOfLocalDay(ts)) / 86_400_000);
}

/**
 * The heading a session sits under.
 *
 * Named days for the first two because that is how people refer to them; weekday names for the rest
 * of the week because "Tuesday" is read faster than a date when it is still this week; and a date
 * once it is far enough back that a weekday name would be ambiguous. The year appears only when it is
 * not the current one — a year on every row of a feed that is mostly this week is noise.
 */
export function dayLabel(ts: number, now: number): string {
  const days = daysApart(ts, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(ts);
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

export type ChatDay = { key: number; label: string; sessions: Session[] };

/**
 * Every session, newest first, cut into local days.
 *
 * `updatedAt` and not `createdAt`: the question this feed answers is "what have I been working on",
 * and a conversation started on Monday and worked on today belongs under today. A session that has
 * never been touched since creation has the two equal anyway.
 *
 * `key` is the day's local midnight, so a caller can key a list on something stable while the label
 * stays a display string that changes under the user's feet at midnight — which it should.
 */
export function groupSessionsByDay(sessions: readonly Session[], now: number): ChatDay[] {
  const byDay = new Map<number, Session[]>();
  for (const s of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = startOfLocalDay(s.updatedAt);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(s); else byDay.set(key, [s]);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([key, rows]) => ({ key, label: dayLabel(key, now), sessions: rows }));
}
