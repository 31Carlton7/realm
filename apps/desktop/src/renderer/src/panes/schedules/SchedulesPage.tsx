import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import { CRON_PRESETS, describeCron, nextFireOf, type Schedule } from "@realm/contracts";
import { useApp } from "../../state/store";
import type { PaneProps } from "../registry";

const NO_SCHEDULES: Schedule[] = [];

/** A moment, read the way a person asks about one: the time if it is today, the weekday and time if
 *  it is this week, the date otherwise. */
export function whenLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(new Date(now))) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  if (days === -1) return `Yesterday at ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: "long" })} at ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}

/**
 * Scheduled tasks: the goals this space starts on a clock rather than on a keystroke.
 *
 * A schedule creates RUNS, and the page says so rather than pretending to be a task list of its own —
 * the last firing's row links into the Tasks lens, which is where a run's attempts, its output and
 * its human gate already live. What this page owns is the WHEN.
 *
 * Two things it is careful to be honest about, because unattended work is the one place a silent
 * failure can go unnoticed for weeks:
 *
 *  - **A paused schedule says "Paused", not a next time.** There is no next occurrence, and inventing
 *    one would make a switch look like it did nothing.
 *  - **A skipped firing is shown.** A laptop that slept through Monday did not run Monday's task, and
 *    a row that only ever showed "last run" would quietly present the previous week's result as this
 *    week's.
 *
 * The vantage is `item.spaceId`, like every other destination page: the space whose layout holds this
 * pane, never "the active space", so a pane surviving a space switch cannot regroup under another.
 */
export function SchedulesPage({ item }: PaneProps) {
  const spaceId = item.spaceId;
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const schedules = useApp((s) => s.schedules[spaceId] ?? NO_SCHEDULES);
  const refreshSchedules = useApp((s) => s.refreshSchedules);
  const run = useApp((s) => s.run);
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => { run(() => refreshSchedules(spaceId)); }, [spaceId, refreshSchedules, run]);

  if (!space) return <div className="pane-placeholder muted">This page&rsquo;s space no longer exists.</div>;

  return (
    <div className="page schedules-page">
      <header className="page-head">
        <div className="page-title"><h1>Scheduled tasks</h1></div>
        <span className="page-vantage">{space.name}</span>
        <button className="btn primary sched-new" onClick={() => { setEditing(null); setComposing(true); }}>
          <Icon name="add" size={14} /> New schedule
        </button>
      </header>
      <div className="page-body">
        <div className="page-content">
          {composing && (
            <ScheduleForm spaceId={spaceId} schedule={null} onDone={() => setComposing(false)} />
          )}
          {schedules.length === 0 && !composing && (
            <p className="env-empty">
              Nothing is scheduled here yet. A schedule runs a goal on a repeating clock and hands the
              result to the Tasks lens, where it can stop and ask you before it does anything.
            </p>
          )}
          <ul className="sched-list">
            {schedules.map((s) => (
              <li key={s.id}>
                {editing === s.id
                  ? <ScheduleForm spaceId={spaceId} schedule={s} onDone={() => setEditing(null)} />
                  : <ScheduleRow schedule={s} onEdit={() => { setComposing(false); setEditing(s.id); }} />}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function ScheduleRow({ schedule, onEdit }: { schedule: Schedule; onEdit: () => void }) {
  const updateSchedule = useApp((s) => s.updateSchedule);
  const deleteSchedule = useApp((s) => s.deleteSchedule);
  const runScheduleNow = useApp((s) => s.runScheduleNow);
  const run = useApp((s) => s.run);
  // Two-step destructive confirm, the pattern the sidebar's item menu and the pane bar both use.
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="sched-row" data-enabled={schedule.enabled || undefined}>
      <div className="sched-main">
        <div className="sched-title">
          <span className="sched-name">{schedule.title}</span>
          {/* The expression's reading, or the expression itself where a sentence would be a guess. */}
          <span className="sched-cron">{describeCron(schedule.cron)}</span>
        </div>
        <p className="sched-goal">{schedule.goal}</p>
        <div className="sched-meta">
          {/* A paused schedule has no next time, and saying one would make the switch look inert. */}
          <span className="sched-next">
            {!schedule.enabled ? "Paused"
              : schedule.nextRunAt === null ? "No further runs"
              : `Next ${whenLabel(schedule.nextRunAt).toLowerCase()}`}
          </span>
          {schedule.lastRunAt !== null && <span className="sched-last">Last ran {whenLabel(schedule.lastRunAt).toLowerCase()}</span>}
          {/* Named, never swallowed: a laptop that slept through Monday did not run Monday's task,
              and a row that only showed "last ran" would present last week's result as this week's. */}
          {schedule.lastSkippedAt !== null && (
            <span className="sched-skipped"><Icon name="alert" size={12} /> Missed {whenLabel(schedule.lastSkippedAt).toLowerCase()}</span>
          )}
        </div>
      </div>
      <div className="sched-actions">
        {/* The app's own switch, not a raw checkbox: an OS check-square in a row of stroked icon
            buttons reads as a form control that wandered in, and this is a state, not a field. */}
        <input type="checkbox" role="switch" className="switch sched-toggle" checked={schedule.enabled}
          aria-label={`${schedule.title} is on`} title={schedule.enabled ? "Pause this schedule" : "Resume this schedule"}
          onChange={(e) => run(() => updateSchedule({ id: schedule.id, enabled: e.target.checked }))} />
        <button className="icon-btn" title="Run now — does not move the schedule" aria-label={`Run ${schedule.title} now`}
          onClick={() => run(() => runScheduleNow(schedule.id, schedule.spaceId))}><Icon name="play" size={14} /></button>
        <button className="icon-btn" title="Edit" aria-label={`Edit ${schedule.title}`} onClick={onEdit}><Icon name="edit" size={14} /></button>
        {confirming
          ? <button className="icon-btn danger sched-confirm" aria-label={`Really delete ${schedule.title}?`}
              onBlur={() => setConfirming(false)}
              onClick={() => run(() => deleteSchedule(schedule.id, schedule.spaceId))}>Really delete?</button>
          : <button className="icon-btn danger" title="Delete" aria-label={`Delete ${schedule.title}`}
              onClick={() => setConfirming(true)}><Icon name="trash" size={14} /></button>}
      </div>
    </div>
  );
}

/**
 * The create/edit form.
 *
 * The expression is checked HERE as well as on the server, and the two say the same thing for the
 * same reason: a schedule that will never fire is the one failure mode that is invisible until
 * someone notices the work has not happened. The local check also lets the form show the first
 * occurrence before it is saved, which is the only way to tell a right expression from a plausible
 * one at the moment you are writing it.
 */
function ScheduleForm({ spaceId, schedule, onDone }: { spaceId: string; schedule: Schedule | null; onDone: () => void }) {
  const createSchedule = useApp((s) => s.createSchedule);
  const updateSchedule = useApp((s) => s.updateSchedule);
  const run = useApp((s) => s.run);
  const [title, setTitle] = useState(schedule?.title ?? "");
  const [goal, setGoal] = useState(schedule?.goal ?? "");
  const [cron, setCron] = useState(schedule?.cron ?? CRON_PRESETS[1].expr);
  const preview = nextFireOf(cron, Date.now());
  const valid = title.trim().length > 0 && goal.trim().length > 0 && preview !== null;

  const submit = () => {
    if (!valid) return;
    const patch = { title: title.trim(), goal: goal.trim(), cron: cron.trim() };
    run(async () => {
      if (schedule) await updateSchedule({ id: schedule.id, ...patch });
      else await createSchedule({ spaceId, ...patch, enabled: true, constraints: null });
      onDone();
    });
  };

  return (
    <form className="sched-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <label className="field">
        <span>Name</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Morning triage" autoFocus />
      </label>
      <label className="field">
        <span>What should it do?</span>
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3}
          placeholder="Read the new issues, group them by area, and open a draft summary." />
      </label>
      <label className="field">
        <span>When</span>
        <div className="sched-when">
          <select value={CRON_PRESETS.some((p) => p.expr === cron) ? cron : "custom"}
            onChange={(e) => { if (e.target.value !== "custom") setCron(e.target.value); }}>
            {CRON_PRESETS.map((p) => <option key={p.expr} value={p.expr}>{p.label}</option>)}
            <option value="custom">Custom…</option>
          </select>
          {/* Always editable, never hidden behind the "Custom…" option: the presets WRITE this field,
              so showing what they wrote is how someone learns the syntax they would otherwise have to
              be taught. */}
          <input className="sched-cron-input" value={cron} onChange={(e) => setCron(e.target.value)}
            aria-label="Cron expression" spellCheck={false} />
        </div>
      </label>
      <p className="sched-preview" data-invalid={preview === null || undefined}>
        {preview === null
          ? "That expression will never run — check the five fields (minute, hour, day, month, weekday)."
          : `First run ${whenLabel(preview).toLowerCase()}.`}
      </p>
      <div className="sched-form-actions">
        <button type="submit" className="btn primary" disabled={!valid}>{schedule ? "Save" : "Create schedule"}</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
