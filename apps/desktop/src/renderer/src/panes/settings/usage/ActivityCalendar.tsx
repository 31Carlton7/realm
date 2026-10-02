import { activityLevel, dayKey, dayRange, USAGE_CALENDAR_DAYS, type UsageDay } from "@realm/contracts";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../../state/store";

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Rows are Sunday-first, and only alternate rows are labelled — three labels down the left edge is
 *  as much as a 12px cell can carry without the words becoming the grid. */
const WEEKDAY_LABEL = ["", "Mon", "", "Wed", "", "Fri", ""];

/**
 * What a cell is painted by. One grid, three readings of it:
 *
 * - `daily` — the day's own messages. Where the busy days were.
 * - `weekly` — the whole week's, on every day of its column. A column is a week already, so this
 *   is the grid read down rather than across: the heads-down weeks stand out as solid bars where a
 *   daily reading scatters them into dots.
 * - `cumulative` — everything sent from the first day shown up to this one. It only ever climbs, so
 *   it reads as the year's growth: where the slope is steep is where the use was.
 */
export type CalendarMode = "daily" | "weekly" | "cumulative";
const MODES: { id: CalendarMode; label: string; hint: string }[] = [
  { id: "daily", label: "Daily", hint: "Each day by the messages sent that day" },
  { id: "weekly", label: "Weekly", hint: "Each week by the messages sent that week" },
  { id: "cumulative", label: "Cumulative", hint: "Each day by every message sent from the first day shown up to it" },
];

/** `messages` is always the day's own count; `value` is what the cell is painted by in the mode it
 *  was built for, and what its label states. */
export type CalendarCell = { day: string; messages: number; sessions: number; value: number; level: 0 | 1 | 2 | 3 | 4 };

/**
 * The calendar's grid: whole weeks, oldest first, each a column of seven days starting on Sunday.
 *
 * The window is padded BACKWARD to the Sunday on or before its first day, so every column is a full
 * week and the grid has no ragged first stripe. Padding forward is deliberately not done — a column
 * of days that have not happened yet would be indistinguishable from a week the reader spent away.
 *
 * Levels are relative to the largest value ON THE GRID in the mode asked for: a week's total and a
 * day's count are different quantities, and a weekly grid scaled by its busiest day would be solid.
 */
export function calendarWeeks(days: readonly UsageDay[], now: number, mode: CalendarMode = "daily"): CalendarCell[][] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const start = new Date(now - (USAGE_CALENDAR_DAYS - 1) * DAY_MS);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay()); // back to Sunday
  const keys = dayRange(start.getTime(), now, USAGE_CALENDAR_DAYS + 7);
  const weeks: CalendarCell[][] = [];
  for (const key of keys) {
    const hit = byDay.get(key);
    const messages = hit?.messages ?? 0;
    const cell: CalendarCell = { day: key, messages, sessions: hit?.sessions ?? 0, value: messages, level: 0 };
    if (weeks.length === 0 || weeks[weeks.length - 1]!.length === 7) weeks.push([cell]);
    else weeks[weeks.length - 1]!.push(cell);
  }
  if (mode === "weekly") {
    for (const week of weeks) {
      const total = week.reduce((n, c) => n + c.messages, 0);
      for (const c of week) c.value = total;
    }
  } else if (mode === "cumulative") {
    let sum = 0;
    for (const c of weeks.flat()) { sum += c.messages; c.value = sum; }
  }
  const max = weeks.flat().reduce((m, c) => Math.max(m, c.value), 0);
  for (const c of weeks.flat()) c.level = activityLevel(c.value, max);
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

const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`;
/** "Sep 3" for "2026-09-03", and with its year, "Sep 3, 2026" — how a day is named in words. */
export const shortDay = (day: string) => {
  const [, m, d] = day.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
};
export const readableDay = (day: string) => `${shortDay(day)}, ${day.slice(0, 4)}`;

/** A cell's words: the same number its colour stands for, said in the mode's own terms. */
export function cellLabel(cell: CalendarCell, mode: CalendarMode, week: readonly CalendarCell[], first: string): string {
  if (mode === "weekly") return `Week of ${readableDay(week[0]!.day)}: ${cell.value === 0 ? "no messages" : plural(cell.value, "message")}`;
  if (mode === "cumulative") return `${readableDay(cell.day)}: ${cell.value === 0 ? "no messages yet" : `${plural(cell.value, "message")} since ${readableDay(first)}`}`;
  return `${readableDay(cell.day)}: ${cell.value === 0 ? "no messages" : plural(cell.value, "message")}`;
}

const CAPTION: Record<CalendarMode, string> = {
  daily: "Messages sent per day over the last year",
  weekly: "Messages sent per week over the last year",
  cumulative: "Messages sent so far, day by day, over the last year",
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
 *
 * The Daily / Weekly / Cumulative switch changes what a cell is painted by and nothing else: same
 * grid, same window, same fetch. See `CalendarMode`.
 */
export function ActivityCalendar() {
  const usageActiveDays = useApp((s) => s.usageActiveDays);
  const run = useApp((s) => s.run);
  const scroller = useRef<HTMLDivElement>(null);
  const [days, setDays] = useState<UsageDay[] | null>(null);
  // Frozen at mount: the grid's last column is "today", and a clock read on every render would
  // re-lay the whole calendar at midnight under a reader who is looking at it.
  const [now] = useState(() => Date.now());
  const [mode, setMode] = useState<CalendarMode>("daily");
  const name = useId();

  useEffect(() => {
    let live = true;
    void run(async () => {
      const from = new Date(now - (USAGE_CALENDAR_DAYS + 7) * DAY_MS).setHours(0, 0, 0, 0);
      const rows = await usageActiveDays({ from, to: now });
      if (live) setDays(rows);
    });
    return () => { live = false; };
  }, [usageActiveDays, run, now]);

  const weeks = useMemo(() => calendarWeeks(days ?? [], now, mode), [days, now, mode]);
  /* Opened at the RIGHT end, on this week. A year is wider than the pane, and a graph that started at
     last September would put the days a reader actually came for — the recent ones — off the far
     edge behind a scrollbar that is deliberately not drawn. Runs once the rows land, because before
     that the grid is a year of empty columns whose width is already final but whose content is not. */
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && days !== null) el.scrollLeft = el.scrollWidth;
  }, [days, weeks]);
  /* …and kept there when the window narrows under it. Opening at the present end was only true of
     the width it opened at: a year that fitted, narrowed, kept scrollLeft 0 and showed last autumn.
     Held only while the reader is AT the end — one who scrolled back to March is reading March. */
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let atEnd = true;
    const onScroll = () => { atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1; };
    const ro = new ResizeObserver(() => { if (atEnd) el.scrollLeft = el.scrollWidth; });
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    return () => { ro.disconnect(); el.removeEventListener("scroll", onScroll); };
  }, []);
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
            : `${plural(activeDays, "day")} · ${plural(messages, "message")} sent`}
        </span>
        <fieldset className="seg">
          <legend className="visually-hidden">Count by</legend>
          {MODES.map((m) => (
            <label key={m.id} className="seg-opt" data-selected={m.id === mode || undefined} title={m.hint}>
              <input type="radio" name={name} value={m.id} checked={m.id === mode} onChange={() => setMode(m.id)} />
              {m.label}
            </label>
          ))}
        </fieldset>
      </header>
      <div className="cal-scroll" ref={scroller}>
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
              <caption className="visually-hidden">{CAPTION[mode]}</caption>
              <tbody>
                {[0, 1, 2, 3, 4, 5, 6].map((weekday) => (
                  <tr key={weekday}>
                    {weeks.map((week, i) => {
                      const cell = week[weekday];
                      if (!cell) return <td key={i} className="cal-cell" data-empty="" />;
                      const label = cellLabel(cell, mode, week, weeks[0]![0]!.day);
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
