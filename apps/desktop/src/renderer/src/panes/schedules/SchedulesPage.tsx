import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Item, Run, Schedule } from "@realm/contracts";
import { FALLBACK_AGENT, useApp, useProfileSpaces } from "../../state/store";
import type { PaneProps } from "../registry";
import { Menu, type MenuItem } from "../../components/Menu";
import { PageRail } from "../../components/page-nav";
import { useDissolve } from "../../components/ScrollFades";
import { SpaceIcon } from "../../components/SpaceIcon";
import { SessionPane } from "../session/SessionPane";
import { summarize } from "../session/session-summary";
import { ScheduleModal, type ModalOpen } from "./ScheduleModal";
import { ScheduleRunText } from "./ScheduleRunPicker";
import {
  SUGGESTIONS, blankDraft, cadenceSentence, draftOfSuggestion, filterSchedules, lowerRelative, runMoment, runState, runUnread, shortWhen,
  taskLine, upcomingOrder, whenPhrase,
} from "./schedule-model";

export { whenLabel, whenPhrase } from "./schedule-model";

/** A task, or one of its runs. `runId` null is the task itself, which shows its latest run when it
 *  has one and its details when it has none. */
type Selection = { scheduleId: string; runId: string | null };

/** Runs listed under an open task before "Show older" — Codex's three. */
const RUNS_SHOWN = 3;
const NO_RUNS: Run[] = [];

/**
 * Scheduled tasks, in Codex's layout: the page's own column — Scheduled, New task, the Upcoming
 * tasks with their runs, and Suggested — and beside it whatever is selected. The column is the
 * sidebar's while the page is up (`PageRail`): the same ground, corner, edge and width as every other
 * page's sections, under the column's Back; with the sidebar folded away it stands in the page.
 *
 * A run is its session, drawn by the real session pane (the transcript and the prompter, to read the
 * run and carry it on) with the task's card at its top right; a task with no runs yet is its card and
 * a way to run it now; nothing selected is the place to start one.
 *
 * Every task in the window's profile is listed, whichever space it runs in — the modal's Space field
 * moves one between them, and a list that showed only the vantage space would lose a task the moment
 * it moved. New tasks start in the vantage space (`item.spaceId`), the one the page was opened from.
 *
 * A run is unread until its session has been read (`runUnread`), off the same mark the sidebar
 * keeps, so opening the run anywhere clears it here.
 */
export function SchedulesPage({ item, visible, focused = false }: PaneProps) {
  const vantage = item.spaceId;
  const spaces = useProfileSpaces();
  const bySpace = useApp((s) => s.schedules);
  const history = useApp((s) => s.scheduleRuns);
  const sessions = useApp((s) => s.allSessions);
  const lastAgentKind = useApp((s) => s.lastAgentKind);
  const refreshSchedules = useApp((s) => s.refreshSchedules);
  const refreshScheduleRuns = useApp((s) => s.refreshScheduleRuns);
  const loadOlderScheduleRuns = useApp((s) => s.loadOlderScheduleRuns);
  const runScheduleNow = useApp((s) => s.runScheduleNow);
  const run = useApp((s) => s.run);
  const [sel, setSel] = useState<Selection | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [modal, setModal] = useState<ModalOpen | null>(null);
  const columnBody = useRef<HTMLDivElement>(null);
  useDissolve(columnBody);

  // Every space of the profile, once: a task can run in any of them.
  const spaceIds = spaces.map((s) => s.id).join(",");
  useEffect(() => {
    for (const id of spaceIds.split(",").filter(Boolean)) run(() => refreshSchedules(id));
  }, [spaceIds, refreshSchedules, run]);

  const all = useMemo(() => upcomingOrder(spaces.flatMap((sp) => bySpace[sp.id] ?? [])), [spaces, bySpace]);
  const listed = useMemo(() => filterSchedules(all, query), [all, query]);
  // A suggestion somebody has already taken up is a task now, under its own name in Upcoming.
  const suggested = useMemo(() => SUGGESTIONS.filter((t) => !all.some((s) => s.title === t.title)), [all]);

  // Each task's first page of runs, once per task: what its unread mark and its history read. Asked
  // for here rather than on expand, because the mark is on a task whose runs are folded away.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const s of all) {
      if (asked.current.has(s.id)) continue;
      asked.current.add(s.id);
      run(() => refreshScheduleRuns(s));
    }
  }, [all, refreshScheduleRuns, run]);

  const runsOf = (id: string) => history[id]?.runs ?? NO_RUNS;
  const schedule = sel ? all.find((s) => s.id === sel.scheduleId) ?? null : null;
  const shownRun = schedule ? (sel!.runId ? runsOf(schedule.id).find((r) => r.id === sel!.runId) : runsOf(schedule.id)[0]) ?? null : null;

  const select = (scheduleId: string, runId: string | null) => {
    setSel({ scheduleId, runId });
    setExpanded((e) => (e.has(scheduleId) ? e : new Set([...e, scheduleId])));
  };
  const toggle = (scheduleId: string) => setExpanded((e) => {
    const next = new Set(e);
    if (!next.delete(scheduleId)) next.add(scheduleId);
    return next;
  });
  const showOlder = (s: Schedule) => {
    const now = shown[s.id] ?? RUNS_SHOWN;
    setShown({ ...shown, [s.id]: now + 10 });
    if (runsOf(s.id).length < now + 10) run(() => loadOlderScheduleRuns(s));
  };
  const runNow = (s: Schedule) => run(async () => {
    const fired = await runScheduleNow(s.id, s.spaceId);
    await refreshScheduleRuns(s);
    select(s.id, fired.lastRunId);
  });
  const defaultKind = lastAgentKind ?? FALLBACK_AGENT;
  const openNew = () => setModal({ draft: blankDraft(vantage, defaultKind) });

  return (
    <div className="page schedules-page">
      <PageRail label="Scheduled tasks">
        <nav className="sched-col" aria-label="Scheduled tasks">
          <div className="sched-col-head">
            <h1 className="sched-col-title">Scheduled</h1>
            <button type="button" className="icon-btn" aria-label="Search" title="Search tasks" aria-pressed={searching}
              onClick={() => { setSearching((x) => !x); setQuery(""); }}>
              <Icon name="search" size={14} />
            </button>
          </div>
          {searching && (
            <div className="sched-col-search">
              <input className="search-field" type="search" aria-label="Search tasks" placeholder="Search tasks" autoFocus value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setSearching(false); setQuery(""); } }} />
            </div>
          )}
          <div ref={columnBody} className="sched-col-body">
            <button type="button" className="sched-new" onClick={openNew}><Icon name="add" size={16} /> New task</button>
            {all.length > 0 && <div className="group-label">Upcoming</div>}
            {all.length > 0 && listed.length === 0 && <p className="sched-col-note">No task matches that.</p>}
            <ul className="sched-tasks">
              {listed.map((s) => (
                <TaskRow key={s.id} schedule={s} runs={runsOf(s.id)} more={history[s.id]?.nextCursor != null}
                  limit={shown[s.id] ?? RUNS_SHOWN} expanded={expanded.has(s.id)}
                  selectedRun={sel?.scheduleId === s.id ? shownRun?.id ?? null : undefined}
                  unread={(r) => runUnread(r.sessionId ? sessions[r.sessionId] : undefined)}
                  onSelect={() => (sel?.scheduleId === s.id && sel.runId === null && expanded.has(s.id) ? toggle(s.id) : select(s.id, null))}
                  onToggle={() => toggle(s.id)}
                  onRun={(r) => select(s.id, r.id)} onOlder={() => showOlder(s)} />
              ))}
            </ul>
            {suggested.length > 0 && <div className="group-label">Suggested</div>}
            <ul className="sched-suggested">
              {suggested.map((t) => (
                <li key={t.title}>
                  <button type="button" className="sched-suggestion" onClick={() => setModal({ draft: draftOfSuggestion(t, vantage, defaultKind) })}>
                    <span className="sched-suggestion-name">{t.title}</span>
                    <span className="sched-suggestion-blurb">{t.blurb}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      </PageRail>

      <div className="sched-main">
        {!schedule ? <ScheduleEmpty onNew={openNew} />
          : shownRun ? <RunView key={shownRun.id} schedule={schedule} run={shownRun} visible={visible} focused={focused && modal === null}
              onEdit={() => setModal({ schedule })} onRunNow={() => runNow(schedule)} onGone={() => setSel(null)} />
          : <TaskView schedule={schedule} onEdit={() => setModal({ schedule })} onRunNow={() => runNow(schedule)} onGone={() => setSel(null)} />}
      </div>

      {modal && (
        <ScheduleModal open={modal} spaces={spaces} onClose={() => setModal(null)}
          onSaved={(saved) => { setModal(null); run(() => refreshScheduleRuns(saved)); select(saved.id, null); }} />
      )}
    </div>
  );
}

/** One task in the column: its name, when it runs next and how often, and — open — its runs. */
function TaskRow({ schedule, runs, more, limit, expanded, selectedRun, unread, onSelect, onToggle, onRun, onOlder }: {
  schedule: Schedule; runs: Run[]; more: boolean; limit: number; expanded: boolean;
  /** Undefined: this task is not selected. Null: it is, showing no run. A run id: that run is shown. */
  selectedRun: string | null | undefined;
  unread: (r: Run) => boolean; onSelect: () => void; onToggle: () => void; onRun: (r: Run) => void; onOlder: () => void;
}) {
  const fresh = runs.filter(unread).length;
  const open = expanded && runs.length > 0;
  return (
    <li className="sched-task" data-active={selectedRun === null || undefined}>
      <div className="sched-task-row">
        <button type="button" className="sched-task-hit" onClick={onSelect} aria-current={selectedRun === null ? "true" : undefined}>
          <span className="sched-task-top">
            <span className="sched-task-name">{schedule.title}</span>
            {/* Folded, the task wears its runs' unread mark; open, each run wears its own. */}
            {!open && fresh > 0 && <span className="status-dot" data-status="unseen" aria-label={`${fresh} unread`} />}
          </span>
          <span className="sched-task-line">{taskLine(schedule)}</span>
          {/* What it runs on, in the prompter chip's words — the same line as its card. */}
          <span className="sched-task-line sched-task-model"><ScheduleRunText schedule={schedule} /></span>
        </button>
        {runs.length > 0 && (
          <button type="button" className="item-disclose sched-task-disclose" aria-expanded={open}
            aria-label={open ? `Hide ${schedule.title}'s runs` : `Show ${schedule.title}'s runs`} onClick={onToggle}>
            <Icon name="chevronRight" size={12} />
          </button>
        )}
      </div>
      <div className="sched-runs-wrap" data-open={open || undefined}>
        <div className="sched-runs-clip">
          <ul className="sched-runs" aria-label={`Runs of ${schedule.title}`}>
            {runs.slice(0, limit).map((r) => {
              const state = runState(r);
              const isUnread = unread(r);
              return (
                <li key={r.id}>
                  <button type="button" className="sched-run" data-active={selectedRun === r.id || undefined}
                    aria-current={selectedRun === r.id ? "true" : undefined} tabIndex={open ? 0 : -1} onClick={() => onRun(r)}>
                    <span className="sched-run-label">{shortWhen(runMoment(r))}</span>
                    {state && <span className="sched-run-state" data-mark={state.mark ?? undefined}>{state.label}</span>}
                    {state?.mark && <span className="status-dot" data-status={state.mark} aria-hidden="true" />}
                    {!state?.mark && isUnread && <span className="status-dot" data-status="unseen" aria-label="Unread" />}
                  </button>
                </li>
              );
            })}
            {(runs.length > limit || more) && (
              <li><button type="button" className="sched-older" tabIndex={open ? 0 : -1} onClick={onOlder}>Show older</button></li>
            )}
          </ul>
        </div>
      </div>
    </li>
  );
}

/** Nothing selected: the shortest honest path to a task. */
function ScheduleEmpty({ onNew }: { onNew: () => void }) {
  return (
    <div className="sched-empty">
      {/* off-ladder: the page's one illustration, Codex's clock over the line that says what a task
          is — the subject of an empty composition, as the diff pane's folder is, not a UI glyph. */}
      <Icon name="clock" size={32} className="sched-empty-mark" />
      <h2 className="sched-empty-title">Schedule a task</h2>
      <p className="sched-empty-line">Realm starts an agent in one of your spaces on the clock you set, and keeps each run here to read and carry on.</p>
      <button type="button" className="btn primary" onClick={onNew}>New task</button>
    </div>
  );
}

/** A session pane for a run's session — the run IS its session, so it is read the way any session
 *  is. Built rather than looked up: the session's row in the sidebar may be archived, or in a space
 *  this window's layout has not loaded, and the pane wants a kind, a ref and a space, never the row. */
const sessionItem = (run: Pick<Run, "spaceId" | "title">, sessionId: string): Item => ({
  id: `schedule-run:${sessionId}`, spaceId: run.spaceId, kind: "session", title: run.title, refId: sessionId,
  sortOrder: 0, pinned: false, archived: false, createdAt: 0, updatedAt: 0,
});

/** A run, opened: its session beside the task's card. */
function RunView({ schedule, run, visible, focused, onEdit, onRunNow, onGone }: {
  schedule: Schedule; run: Run; visible: boolean; focused: boolean; onEdit: () => void; onRunNow: () => void; onGone: () => void;
}) {
  const sessionId = run.sessionId;
  const { spaceId, title } = run;
  const item = useMemo(() => (sessionId ? sessionItem({ spaceId, title }, sessionId) : null), [spaceId, title, sessionId]);
  const [details, setDetails] = useState(false);
  return (
    <div className="sched-view" data-details={details || undefined}>
      <div className="sched-view-session">
        {item ? <SessionPane item={item} visible={visible} focused={focused} /> : <RunNotStarted run={run} />}
      </div>
      {/* Narrow, the card folds behind this; wide, the button is not drawn and the card stands docked. */}
      <button type="button" className="icon-btn sched-details-toggle" aria-label={details ? "Hide details" : "Show details"}
        aria-expanded={details} onClick={() => setDetails((x) => !x)}>
        <Icon name="info" size={14} />
      </button>
      <TaskCard schedule={schedule} run={run} onEdit={onEdit} onRunNow={onRunNow} onGone={onGone} />
    </div>
  );
}

/** A run with no session to show: one still queued, or one that failed before its session existed. */
function RunNotStarted({ run }: { run: Run }) {
  return (
    <div className="sched-empty">
      <h2 className="sched-empty-title">{run.state === "queued" ? "Starting…" : "This run never started"}</h2>
      {run.error && <p className="sched-empty-line">{run.error}</p>}
    </div>
  );
}

/** A task with no runs yet: when the first one will be, and a way to have it now. */
function TaskView({ schedule, onEdit, onRunNow, onGone }: { schedule: Schedule; onEdit: () => void; onRunNow: () => void; onGone: () => void }) {
  const next = schedule.enabled ? schedule.nextRunAt : null;
  return (
    <div className="sched-view" data-task="">
      <div className="sched-view-session">
        <div className="sched-empty">
          <h2 className="sched-empty-title">No runs yet</h2>
          <p className="sched-empty-line">{!schedule.enabled ? "This task is paused." : next !== null ? `The first one is ${whenPhrase(next)}.` : "It has nothing left to run."}</p>
          <button type="button" className="btn" onClick={onRunNow}>Run now</button>
        </div>
      </div>
      <TaskCard schedule={schedule} run={null} onEdit={onEdit} onRunNow={onRunNow} onGone={onGone} />
    </div>
  );
}

/**
 * The task's card, at the top right of whatever is selected: its name and the way to edit it, when it
 * runs, what it is told, and what it works with — the outputs of the run on screen, the model, the
 * space and the connections the run can reach. The ⋯ holds the rest: run now, pause, delete.
 */
function TaskCard({ schedule, run, onEdit, onRunNow, onGone }: {
  schedule: Schedule; run: Run | null; onEdit: () => void; onRunNow: () => void; onGone: () => void;
}) {
  const space = useApp((s) => s.spaces.find((x) => x.id === schedule.spaceId));
  const connectors = useApp((s) => s.connectors[schedule.spaceId]);
  const blocks = useApp((s) => (run?.sessionId ? s.transcripts[run.sessionId]?.t.blocks : undefined));
  const refreshConnectors = useApp((s) => s.refreshConnectors);
  const openSpacePage = useApp((s) => s.openSpacePage);
  const updateSchedule = useApp((s) => s.updateSchedule);
  const deleteSchedule = useApp((s) => s.deleteSchedule);
  const confirmDelete = useApp((s) => s.confirmDelete);
  const act = useApp((s) => s.run);
  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const spaceId = schedule.spaceId;
  useEffect(() => { if (connectors === undefined) act(() => refreshConnectors(spaceId)); }, [connectors, spaceId, refreshConnectors, act]);

  const outputs = useMemo(() => (blocks ? summarize(blocks).outputs.length : 0), [blocks]);
  const enabled = (connectors ?? []).filter((c) => c.enabled);
  const missed = schedule.lastSkippedAt !== null && (schedule.lastRunAt === null || schedule.lastSkippedAt > schedule.lastRunAt);
  const remove = () => act(async () => { await deleteSchedule(schedule.id, schedule.spaceId); onGone(); });
  const items: MenuItem[] = [
    { label: "Run now", icon: <Icon name="play" size={14} />, onSelect: onRunNow },
    schedule.enabled
      ? { label: "Pause", icon: <Icon name="pause" size={14} />, onSelect: () => act(() => updateSchedule({ id: schedule.id, enabled: false })) }
      : { label: "Resume", icon: <Icon name="play" size={14} />, onSelect: () => act(() => updateSchedule({ id: schedule.id, enabled: true })) },
    { kind: "separator" },
    // Two steps, where the app asks for them: a task is an object with a history, and the second row
    // says which one is going — its runs and their sessions stay.
    confirming
      ? { label: `Really delete ${schedule.title}?`, danger: true, onSelect: remove }
      : { label: "Delete task…", danger: true, keepOpen: confirmDelete, onSelect: () => (confirmDelete ? setConfirming(true) : remove()) },
  ];

  return (
    <aside className="sched-card" aria-label={`${schedule.title} details`}>
      <div className="sched-card-head">
        <h2 className="sched-card-name">{schedule.title}</h2>
        <button type="button" className="icon-btn" aria-label={`Edit ${schedule.title}`} title="Edit" onClick={onEdit}><Icon name="edit" size={14} /></button>
        <button ref={more} type="button" className="icon-btn" aria-label={`More for ${schedule.title}`} title="More" aria-haspopup="menu" aria-expanded={menu}
          onClick={() => { setConfirming(false); setMenu((m) => !m); }}><Icon name="more" size={14} /></button>
        {menu && <Menu items={items} anchorRef={more} align="right" label={`${schedule.title} actions`} onClose={() => { setMenu(false); setConfirming(false); }} />}
      </div>
      <p className="sched-card-when">{cadenceSentence(schedule.cron)}{schedule.enabled ? "" : " · Paused"}</p>
      <p className="sched-card-goal">{schedule.goal}</p>
      <ul className="sched-card-facts">
        {run && <li className="sched-card-fact"><Icon name="artifact" size={14} />{outputs === 1 ? "1 output" : `${outputs} outputs`}</li>}
        {schedule.enabled && schedule.nextRunAt !== null && (
          <li className="sched-card-fact"><Icon name="clock" size={14} />Next run {lowerRelative(shortWhen(schedule.nextRunAt))}</li>
        )}
        {/* Named, never swallowed: a laptop that slept through Monday did not run Monday's task. */}
        {missed && (
          <li className="sched-card-fact" data-tone="warn"><Icon name="alert" size={14} />Missed a run {lowerRelative(shortWhen(schedule.lastSkippedAt!))}</li>
        )}
        {/* The model each run starts on, at its level and speed: the chip's own words. */}
        <li className="sched-card-fact"><ScheduleRunText schedule={schedule} /></li>
      </ul>
      <div className="sched-card-sources">
        <div className="sched-card-sub">
          <span>Sources</span>
          <button type="button" className="icon-btn" aria-label={`Add a connection to ${space?.name ?? "this space"}`} title="Add a connection"
            onClick={() => openSpacePage(spaceId, "connections")}><Icon name="add" size={14} /></button>
        </div>
        <ul className="sched-card-list">
          {space && (
            <li><button type="button" className="sched-card-link" onClick={() => openSpacePage(spaceId)}>
              <SpaceIcon icon={space.icon} size={14} />{space.name}</button></li>
          )}
          {enabled.slice(0, 3).map((c) => (
            <li key={c.id} className="sched-card-source"><Icon name="plug" size={14} />{c.name}</li>
          ))}
          <li><button type="button" className="sched-card-link sched-card-quiet" onClick={() => openSpacePage(spaceId, "connections")}>
            <Icon name="plug" size={14} />{enabled.length > 3 ? `View all ${enabled.length}` : "View all"}</button></li>
        </ul>
      </div>
    </aside>
  );
}
