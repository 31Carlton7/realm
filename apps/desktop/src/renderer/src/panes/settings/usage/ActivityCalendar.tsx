import { activityLevel, dayKey, dayRange, USAGE_CALENDAR_DAYS, type UsageDay } from "@realm/contracts";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../../../state/store";

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Rows are Sunday-first, and only alternate rows are labelled — three labels down the left edge is
 *  as much as a 12px cell can carry without the words becoming the grid. */
const WEEKDAY_LABEL = ["", "Mon", "", "Wed", "", "Fri", ""];

export type CalendarCell = { day: string; messages: number; sessions: number; level: 0 | 1 | 2 | 3 | 4 };

/**
 * The calendar's grid: whole weeks, oldest first, each a column of seven days starting on Sunday.
 *
 * The window is padded BACKWARD to the Sunday on or before its first day, so every column is a full
 * week and the grid has no ragged first stripe. Padding forward is deliberately not done — a column
 * of days that have not happened yet would be indistinguishable from a week the reader spent away.
 */
export function calendarWeeks(days: readonly UsageDay[], now: number): CalendarCell[][] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const max = days.reduce((m, d) => Math.max(m, d.messages), 0);
  const start = new Date(now - (USAGE_CALENDAR_DAYS - 1) * DAY_MS);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay()); // back to Sunday
  const keys = dayRange(start.getTime(), now, USAGE_CALENDAR_DAYS + 7);
  const weeks: CalendarCell[][] = [];
  for (const key of keys) {
    const hit = byDay.get(key);
    const messages = hit?.messages ?? 0;
    const cell: CalendarCell = { day: key, messages, sessions: hit?.sessions ?? 0, level: activityLevel(messages, max) };
    if (weeks.length === 0 || weeks[weeks.length - 1]!.length === 7) weeks.push([cell]);
    else weeks[weeks.length - 1]!.push(cell);
  }
  return weeks;
}

/** Month labels along the top: the month's name over the first week that CONTAINS its first day, so a
 *  label never sits over a column belonging mostly to the month before it. */
export function monthLabels(weeks: readonly CalendarCell[][]): { index: number; label: string }[] {
  const out: { index: number; label: string }[] = [];
  let last = "";
  weeks.forEach((week, index) => {
    const first = week[0];
    if (!first) return;
    const month = first.day.slice(0, 7);
    if (month === last) return;
    // Not the very first column unless the month genuinely starts in it: otherwise a window opening
    // on the 28th gets that month's name over a column that is six-sevenths of the previous one.
    if (index > 0 || Number(first.day.slice(8)) <= 7) out.push({ index, label: MONTHS[Number(month.slice(5, 7)) - 1] ?? "" });
    last = month;
  });
  return out;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const readableDay = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`;
};

/**
 * A year of days Realm was used, as a calendar.
 *
 * The measure is a message SENT, not a dollar or a token, and that choice is what makes the graph
 * mean anything: nine of the eleven engines report neither, so a spend-coloured calendar would go
 * blank for every Cursor session and quietly become a graph of which engine reports usage rather
 * than of when its reader was working.
 *
 * Its own fetch, over its own window, unscoped by the page's filter row. "Days I used Realm" is not a
 * question about the last 30 days in one space, and a calendar that emptied when the reader narrowed
 * the chart beside it would be answering a question nobody asked.
 *
 * Every cell carries its own count in a `title` and in an accessible name — the colour is a summary,
 * never the only telling, and the four steps are relative to the reader's own busiest day rather
 * than to a fixed scale (see `activityLevel`).
 */
export function ActivityCalendar() {
  const usageActiveDays = useApp((s) => s.usageActiveDays);
  const run = useApp((s) => s.run);
  const [days, setDays] = useState<UsageDay[] | null>(null);
  // Frozen at mount: the grid's last column is "today", and a clock read on every render would
  // re-lay the whole calendar at midnight under a reader who is looking at it.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    void run(async () => {
      const from = new Date(now - (USAGE_CALENDAR_DAYS + 7) * DAY_MS).setHours(0, 0, 0, 0);
      const rows = await usageActiveDays({ from, to: now });
      if (live) setDays(rows);
    });
    return () => { live = false; };
  }, [usageActiveDays, run, now]);

  const weeks = useMemo(() => calendarWeeks(days ?? [], now), [days, now]);
  const months = useMemo(() => monthLabels(weeks), [weeks]);
  const activeDays = (days ?? []).filter((d) => d.messages > 0).length;
  const messages = (days ?? []).reduce((n, d) => n + d.messages, 0);
  const today = dayKey(now);

  return (
    <section className="usage-card">
      <header className="usage-card-head">
        <h3>Days you used Realm</h3>
        <span className="usage-card-sub">
          {days === null ? "Reading…" : activeDays === 0 ? "No sent messages in the last year"
            : `${plural(activeDays, "day")} · ${messages.toLocaleString()} messages sent`}
        </span>
      </header>
      <div className="cal-scroll">
        <div className="cal">
          <div className="cal-months" aria-hidden="true">
            {/* Absolutely placed off the column index rather than laid out in the same grid: a label
                is wider than the 12px column it belongs to, and letting it take a track would space
                the weeks by the width of the word "September". */}
            {months.map((m) => <span key={`${m.index}-${m.label}`} className="cal-month" style={{ left: `${m.index * 14}px` }}>{m.label}</span>)}
          </div>
          <div className="cal-body">
            <div className="cal-weekdays" aria-hidden="true">
              {WEEKDAY_LABEL.map((l, i) => <span key={i} className="cal-weekday">{l}</span>)}
            </div>
            {/* A table, not a grid of divs: this IS tabular — weeks across, weekdays down — and the
                row/column structure is what lets a screen reader walk it at all. */}
            <table className="cal-grid">
              <caption className="visually-hidden">Messages sent per day over the last year</caption>
              <tbody>
                {[0, 1, 2, 3, 4, 5, 6].map((weekday) => (
                  <tr key={weekday}>
                    {weeks.map((week, i) => {
                      const cell = week[weekday];
                      if (!cell) return <td key={i} className="cal-cell" data-empty="" />;
                      const label = `${readableDay(cell.day)}: ${cell.messages === 0 ? "no messages" : plural(cell.messages, "message")}`;
                      return (
                        <td key={i} className="cal-cell" data-level={cell.level}
                          data-today={cell.day === today || undefined} title={label}>
                          <span className="visually-hidden">{label}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="cal-legend">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => <span key={l} className="cal-cell cal-key" data-level={l} aria-hidden="true" />)}
        <span>More</span>
      </div>
    </section>
  );
}
