import { REPEATS, type Repeat } from "@realm/contracts";
import { clockLabel, exprOf, minuteOptions, ordinal, timeOptions, type When } from "./schedule-model";

const REPEAT_LABEL: Record<Repeat | "custom", string> = {
  hourly: "Hourly", daily: "Daily", weekdays: "Weekdays", weekly: "Weekly", monthly: "Monthly", custom: "Custom (cron)",
};
/** Monday first, the way a week is read; the values stay cron's (0 is Sunday). */
const WEEK = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ day: d, label: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d]! }));

/**
 * WHEN, as rows of a settings card: how often, then the day, the minute or the expression that
 * cadence needs, then the time. One set of rows for Schedule a task and a teammate's check-in, so a
 * cadence is chosen one way everywhere. The caller owns the card and the line under it.
 */
export function WhenRows({ d, patch }: { d: When; patch: (p: Partial<When>) => void }) {
  // Custom is "write the expression yourself", so it opens on the one the menu was writing.
  const pickRepeat = (every: Repeat | "custom") => patch(every === "custom" ? { every, cron: exprOf(d) ?? d.cron } : { every });
  return (
    <>
      {d.repeat && (
        <li className="settings-row">
          <span className="settings-row-main"><span className="settings-row-name">Repeat</span></span>
          <select className="sched-select" aria-label="Repeat" value={d.every} onChange={(e) => pickRepeat(e.target.value as Repeat | "custom")}>
            {[...REPEATS, "custom" as const].map((r) => <option key={r} value={r}>{REPEAT_LABEL[r]}</option>)}
          </select>
        </li>
      )}
      {d.repeat && d.every === "weekly" && (
        <li className="settings-row">
          <span className="settings-row-main"><span className="settings-row-name">Day</span></span>
          <select className="sched-select" aria-label="Day" value={d.weekday} onChange={(e) => patch({ weekday: Number(e.target.value) })}>
            {WEEK.map((w) => <option key={w.day} value={w.day}>{w.label}</option>)}
          </select>
        </li>
      )}
      {d.repeat && d.every === "monthly" && (
        <li className="settings-row">
          <span className="settings-row-main"><span className="settings-row-name">Day</span></span>
          <select className="sched-select" aria-label="Day of the month" value={d.monthDay} onChange={(e) => patch({ monthDay: Number(e.target.value) })}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{ordinal(n)}</option>)}
          </select>
        </li>
      )}
      {d.repeat && d.every === "hourly" && (
        <li className="settings-row">
          <span className="settings-row-main"><span className="settings-row-name">Minute</span></span>
          <select className="sched-select" aria-label="Minute past the hour" value={d.minute} onChange={(e) => patch({ minute: Number(e.target.value) })}>
            {minuteOptions(d.minute).map((m) => <option key={m} value={m}>:{String(m).padStart(2, "0")}</option>)}
          </select>
        </li>
      )}
      {d.repeat && d.every === "custom" && (
        <li className="settings-row">
          <span className="settings-row-main"><span className="settings-row-name">Expression</span></span>
          {/* Mono and verbatim: this is machine state the person is typing, and the line under
              the card reads it back before it is saved. */}
          <input className="sched-cron" aria-label="Cron expression" spellCheck={false} value={d.cron}
            onChange={(e) => patch({ cron: e.target.value })} />
        </li>
      )}
      {!d.repeat && (
        <li className="settings-row">
          <span className="settings-row-main"><span className="settings-row-name">Date</span></span>
          <input type="date" className="sched-date" aria-label="Date" value={d.date} onChange={(e) => patch({ date: e.target.value })} />
        </li>
      )}
      {(!d.repeat || (d.every !== "hourly" && d.every !== "custom")) && (
        <li className="settings-row">
          <span className="settings-row-main"><span className="settings-row-name">Time</span></span>
          <select className="sched-select" aria-label="Time" value={d.time} onChange={(e) => patch({ time: e.target.value })}>
            {timeOptions(d.time).map((t) => <option key={t} value={t}>{clockLabel(Number(t.slice(0, 2)), Number(t.slice(3, 5)))}</option>)}
          </select>
        </li>
      )}
    </>
  );
}
