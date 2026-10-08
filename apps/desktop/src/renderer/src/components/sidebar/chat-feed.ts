/**
 * The Recent lens's arithmetic: which day a session belongs to, and in what order the days come.
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

export type DayGroup<T> = { key: number; label: string; rows: T[] };

/**
 * Rows, newest first, cut into local days by when each last moved (`at`).
 *
 * Last activity and not creation: the question this answers is "what have I been working on", and a
 * session started on Monday and worked on today belongs under today. A session never touched since
 * it was made has the two equal anyway.
 *
 * `key` is the day's local midnight, so a caller can key a list on something stable while the label
 * stays a display string that changes under the user's feet at midnight — which it should.
 */
export function groupByDay<T>(rows: readonly T[], at: (row: T) => number, now: number): DayGroup<T>[] {
  const byDay = new Map<number, T[]>();
  for (const row of [...rows].sort((a, b) => at(b) - at(a))) {
    const key = startOfLocalDay(at(row));
    const bucket = byDay.get(key);
    if (bucket) bucket.push(row); else byDay.set(key, [row]);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([key, grouped]) => ({ key, label: dayLabel(key, now), rows: grouped }));
}

/** The local midnight `days` calendar days before `ts`'s — a calendar step, not 86,400,000 ms. */
function daysBefore(ts: number, days: number): number {
  const d = new Date(startOfLocalDay(ts));
  d.setDate(d.getDate() - days);
  return d.getTime();
}

/**
 * A coarser heading than `dayLabel`, for a list that runs back for months: Today, Yesterday, This
 * week (two to six days back), then one heading per month — "September", or "August 2025" when it is
 * not this year. A per-day head on a month of work is a page of one-row groups.
 *
 * `key` is the bucket's first instant, so buckets sort newest first by it and stay stable while the
 * label changes at midnight.
 */
export function bucketOf(ts: number, now: number): { key: number; label: string } {
  const days = daysApart(ts, now);
  if (days <= 0) return { key: startOfLocalDay(now), label: "Today" };
  if (days === 1) return { key: daysBefore(now, 1), label: "Yesterday" };
  if (days < 7) return { key: daysBefore(now, 6), label: "This week" };
  const d = new Date(ts);
  const first = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return { key: first, label: d.toLocaleDateString(undefined, sameYear ? { month: "long" } : { month: "long", year: "numeric" }) };
}

/** `bucketOf`'s label alone. */
export function bucketLabel(ts: number, now: number): string {
  return bucketOf(ts, now).label;
}

/**
 * Rows cut into `bucketOf`'s buckets by `at`, newest bucket first. Within a bucket the rows keep the
 * order they came in, so a caller that ranked them (what needs you first) keeps its ranking.
 */
export function groupByBucket<T>(rows: readonly T[], at: (row: T) => number, now: number): DayGroup<T>[] {
  const groups = new Map<number, DayGroup<T>>();
  for (const row of rows) {
    const { key, label } = bucketOf(at(row), now);
    const group = groups.get(key);
    if (group) group.rows.push(row); else groups.set(key, { key, label, rows: [row] });
  }
  return [...groups.values()].sort((a, b) => b.key - a.key);
}
