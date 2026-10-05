import {
  EFFORT_LEVELS, cadenceOf, cronOf, describeSchedule, isOnce, momentInputValue, nextFireOf, onceExpr, parseMoment, parseOnce,
  type AgentKind, type Cadence, type Repeat, type Run, type RunConstraints, type Schedule, type Session,
} from "@realm/contracts";

/**
 * The Scheduled page's reading of schedules and their runs, as pure functions — what a row says, what
 * the modal holds, what counts as unread — so the decisions are testable without a DOM.
 */

/* ────────────────────────────── when ────────────────────────────── */

/** A moment, read the way a person asks about one: the time if it is today, the weekday and time if
 *  it is this week, the date otherwise. */
export function whenLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const days = dayOffset(ts, now);
  const time = clock(d);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  if (days === -1) return `Yesterday at ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: "long" })} at ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}

/**
 * The same moment inside a sentence: "Next tomorrow at 9:00 am", "Next Sep 30 at 1:00 pm".
 *
 * Only the relative words are lowered. A blanket `toLowerCase()` reads fine while every next run is
 * within a day — which is what a cron schedule's always is — and turns into "next sep 30" the moment
 * a one-shot is armed a fortnight out, because a month and a weekday are proper nouns. The meridiem
 * goes down either way, which is the ordinary typographic form and keeps the two branches matching.
 */
export const whenPhrase = (ts: number, now = Date.now()): string =>
  lowerRelative(whenLabel(ts, now).replace(/\b(AM|PM)\b/g, (m) => m.toLowerCase()));

/** "Yesterday 4:01 PM" as the middle of a sentence — the relative word lowered, nothing else. */
export const lowerRelative = (label: string): string =>
  /^(Today|Tomorrow|Yesterday)\b/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;

/**
 * The column's short form, as Codex's rows have it: "Today 9:00 AM", "Tomorrow 8:01 AM", "Friday
 * 4:00 PM" within the week, and the date alone past it ("Oct 9") — a row under a 288px column has
 * room for a day or a time, and a fortnight out the day is the part that matters.
 */
export function shortWhen(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const days = dayOffset(ts, now);
  if (days === 0) return `Today ${clock(d)}`;
  if (days === 1) return `Tomorrow ${clock(d)}`;
  if (days === -1) return `Yesterday ${clock(d)}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: "long" })} ${clock(d)}`;
  if (days < -1 && days > -7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${clock(d)}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
const dayOffset = (ts: number, now: number) => Math.round((startOfDay(new Date(ts)) - startOfDay(new Date(now))) / 86_400_000);

/* ────────────────────────────── cadence ────────────────────────────── */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const REPEAT_LABEL: Record<Repeat, string> = { hourly: "Hourly", daily: "Daily", weekdays: "Weekdays", weekly: "Weekly", monthly: "Monthly" };

/** The one-word cadence a row ends on: what the Repeat menu calls it, or Once, or Custom. */
export function cadenceLabel(expr: string): string {
  if (isOnce(expr)) return "Once";
  const c = cadenceOf(expr);
  return c ? REPEAT_LABEL[c.repeat] : "Custom";
}

/** `9:00 AM` for an hour and minute, in the person's own clock. */
export function clockLabel(hour: number, minute: number): string {
  return clock(new Date(2026, 0, 1, hour, minute));
}

export const ordinal = (n: number): string => {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
};

/**
 * The task card's sentence, in Codex's words: "Fridays at 4:00 PM", "Weekdays at 9:00 AM", "Every
 * hour at :15", "The 1st of every month at 9:00 AM". A one-shot keeps `describeSchedule`'s sentence,
 * which is the only place its moment survives once it has fired; an expression the modal cannot name
 * is shown as itself, never as a guess.
 */
export function cadenceSentence(expr: string, now = Date.now()): string {
  if (isOnce(expr)) return describeSchedule(expr, now);
  const c = cadenceOf(expr);
  if (!c) return expr;
  switch (c.repeat) {
    case "hourly": return `Every hour at :${String(c.minute).padStart(2, "0")}`;
    case "daily": return `Every day at ${clockLabel(c.hour, c.minute)}`;
    case "weekdays": return `Weekdays at ${clockLabel(c.hour, c.minute)}`;
    case "weekly": return `${WEEKDAYS[c.weekday]}s at ${clockLabel(c.hour, c.minute)}`;
    case "monthly": return `The ${ordinal(c.day)} of every month at ${clockLabel(c.hour, c.minute)}`;
  }
}

/** The second line of a task's row: when it runs next, then how often — "Tomorrow 8:01 AM · Weekly". */
export function taskLine(s: Schedule, now = Date.now()): string {
  const when = !s.enabled ? "Paused"
    : s.nextRunAt !== null ? shortWhen(s.nextRunAt, now)
    : s.lastRunAt !== null ? `Ran ${lowerRelative(shortWhen(s.lastRunAt, now))}` : "Finished";
  return `${when} · ${cadenceLabel(s.cron)}`;
}

/**
 * The column's order: what fires soonest first, then what is paused or finished, newest first among
 * those. "Upcoming" is a promise about the top of the list, and a task that will never fire again
 * at the top would break it.
 */
export function upcomingOrder(schedules: readonly Schedule[]): Schedule[] {
  const armed = (s: Schedule) => s.enabled && s.nextRunAt !== null;
  return [...schedules].sort((a, b) => {
    if (armed(a) !== armed(b)) return armed(a) ? -1 : 1;
    if (armed(a)) return a.nextRunAt! - b.nextRunAt! || a.title.localeCompare(b.title);
    return b.createdAt - a.createdAt;
  });
}

/**
 * The search over the column: the title, the instructions and the cadence's own words. The
 * instructions matter most — a person looking for the task that files their expenses remembers what
 * it DOES, not what they called it.
 */
export function filterSchedules(schedules: readonly Schedule[], query: string): Schedule[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...schedules];
  return schedules.filter((s) => `${s.title}\n${s.goal}\n${cadenceSentence(s.cron)}\n${cadenceLabel(s.cron)}`.toLowerCase().includes(q));
}

/* ────────────────────────────── runs ────────────────────────────── */

/**
 * A run is unread until its session has been looked at to the end.
 *
 * Deliberately NOT the sidebar's `isUnread`, which reads a never-opened session (`seenSeq` 0) as having
 * missed nothing: a session somebody started, they watched start. A scheduled run's session was
 * started by a clock while nobody was looking, so never opened is exactly what unread means here. The
 * mark itself is the same column, so reading a run from the sidebar clears its dot on this page too.
 */
export function runUnread(session: Pick<Session, "seenSeq" | "lastEventSeq"> | undefined): boolean {
  return session !== undefined && session.lastEventSeq > session.seenSeq;
}

/** When a run happened, for its row: when it started, or when it was queued if it never did. */
export const runMoment = (run: Pick<Run, "startedAt" | "createdAt">): number => run.startedAt ?? run.createdAt;

/** The word a run's row wears beside its time, where the time alone would not say it. Null for a
 *  finished run, which is the ordinary case and wears nothing. */
export function runState(run: Pick<Run, "state">): { label: string; mark: "running" | "waiting_permission" | "error" | null } | null {
  switch (run.state) {
    case "queued": return { label: "Starting", mark: null };
    case "running": return { label: "Running", mark: "running" };
    case "blocked": return { label: "Needs you", mark: "waiting_permission" };
    case "failed": return { label: "Failed", mark: "error" };
    case "expired": return { label: "Expired", mark: "error" };
    case "cancelled": return { label: "Stopped", mark: null };
    case "succeeded": return null;
  }
}

/* ────────────────────────────── the modal's draft ────────────────────────────── */

export type Effort = (typeof EFFORT_LEVELS)[number];

/** Everything the Schedule a task modal holds, in its own terms. The expression is derived from it
 *  (`exprOf`) rather than stored beside it, so the two can never disagree. */
export type Draft = {
  title: string;
  goal: string;
  /** The Repeat task switch: off is a single run at `date` and `time`. */
  repeat: boolean;
  every: Repeat | "custom";
  /** `HH:MM`, 24-hour — the time of day for daily, weekly, monthly and a single run. */
  time: string;
  /** Minute past the hour, for hourly. */
  minute: number;
  /** 0 is Sunday, as cron has it. */
  weekday: number;
  monthDay: number;
  /** The expression itself, for Custom. */
  cron: string;
  /** `YYYY-MM-DD`, for a single run. */
  date: string;
  newSessionPerRun: boolean;
  archiveSucceeded: boolean;
  spaceId: string;
  agentKind: AgentKind;
  model: string | null;
  effort: Effort | null;
};

const pad = (n: number) => String(n).padStart(2, "0");
const timeOf = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;
const hm = (time: string): [number, number] => { const [h, m] = time.split(":").map(Number); return [h ?? 0, m ?? 0]; };

/** A new task's starting point: every day at nine — an agent should start when someone is awake to
 *  answer it, which is why `@daily` points there too — in the space the page was opened from. */
export function blankDraft(spaceId: string, agentKind: AgentKind, now = Date.now()): Draft {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    title: "", goal: "", repeat: true, every: "daily", time: "09:00", minute: 0,
    weekday: new Date(now).getDay(), monthDay: 1, cron: "0 9 * * *",
    date: momentInputValue(tomorrow.getTime()).slice(0, 10),
    newSessionPerRun: true, archiveSucceeded: false, spaceId, agentKind, model: null, effort: null,
  };
}

/** The draft a saved task opens as — the same fields the modal wrote, read back off its expression. */
export function draftOf(s: Schedule, fallbackKind: AgentKind, now = Date.now()): Draft {
  const base = blankDraft(s.spaceId, s.constraints?.agentKind ?? fallbackKind, now);
  const shared = {
    ...base, title: s.title, goal: s.goal, cron: s.cron, newSessionPerRun: s.newSessionPerRun, archiveSucceeded: s.archiveSucceeded,
    model: s.constraints?.model ?? null, effort: s.constraints?.effort ?? null,
  };
  const once = parseOnce(s.cron);
  if (once !== null) {
    const local = momentInputValue(once);
    return { ...shared, repeat: false, date: local.slice(0, 10), time: local.slice(11, 16) };
  }
  const c = cadenceOf(s.cron);
  if (!c) return { ...shared, every: "custom" };
  if (c.repeat === "hourly") return { ...shared, every: "hourly", minute: c.minute };
  const time = timeOf(c.hour, c.minute);
  if (c.repeat === "weekly") return { ...shared, every: "weekly", time, weekday: c.weekday };
  if (c.repeat === "monthly") return { ...shared, every: "monthly", time, monthDay: c.day };
  return { ...shared, every: c.repeat, time };
}

/** The expression a draft writes — the single thing the server is told about WHEN. Null for a single
 *  run whose date and time do not name a moment. */
export function exprOf(d: Draft): string | null {
  if (!d.repeat) {
    const ms = parseMoment(`${d.date}T${d.time}`);
    return ms === null ? null : onceExpr(ms);
  }
  if (d.every === "custom") return d.cron.trim();
  const [hour, minute] = hm(d.time);
  const c: Cadence = d.every === "hourly" ? { repeat: "hourly", minute: d.minute }
    : d.every === "weekly" ? { repeat: "weekly", weekday: d.weekday, hour, minute }
    : d.every === "monthly" ? { repeat: "monthly", day: d.monthDay, hour, minute }
    : { repeat: d.every, hour, minute };
  return cronOf(c);
}

/** When the draft would first fire, or null when it never would — what keeps Create disabled. */
export function firstRun(d: Draft, now = Date.now()): number | null {
  const expr = exprOf(d);
  return expr === null || expr === "" ? null : nextFireOf(expr, now);
}

export const draftValid = (d: Draft, now = Date.now()): boolean =>
  d.title.trim() !== "" && d.goal.trim() !== "" && d.spaceId !== "" && firstRun(d, now) !== null;

/**
 * The run constraints a draft asks for, laid over what the task already carried: the modal owns the
 * agent, the model and the effort, and anything else a task was given through `runs`' vocabulary —
 * a permission mode, a skill subset — is kept rather than dropped by an edit that never showed it.
 */
export function constraintsOf(d: Draft, before: RunConstraints | null): RunConstraints {
  const { model: _m, effort: _e, ...kept } = before ?? {};
  return { ...kept, agentKind: d.agentKind, ...(d.model ? { model: d.model } : {}), ...(d.effort ? { effort: d.effort } : {}) };
}

/** The time menu's options: every half hour, plus the draft's own time when it is off that grid — a
 *  task an agent scheduled for 8:01 must open showing 8:01, not the nearest half hour. */
export function timeOptions(current: string): string[] {
  const grid = Array.from({ length: 48 }, (_, i) => timeOf(Math.floor(i / 2), (i % 2) * 30));
  return grid.includes(current) ? grid : [...grid, current].sort();
}

export const minuteOptions = (current: number): number[] => {
  const grid = [0, 15, 30, 45];
  return grid.includes(current) ? grid : [...grid, current].sort((a, b) => a - b);
};

/* ────────────────────────────── suggestions ────────────────────────────── */

/**
 * The Suggested section: tasks that are worth having on a clock in a Realm space, each written as
 * standing instructions for an agent that has never seen a conversation about it — which is what a
 * scheduled run is. They name the tools a run in a space actually has (`agent_peers`, git, `gh`), not
 * an inbox or a news feed it cannot reach.
 */
export const SUGGESTIONS: readonly { title: string; blurb: string; goal: string; every: Repeat; time: string; weekday?: number }[] = [
  {
    title: "Weekly review",
    blurb: "A short status update from the week's sessions and commits",
    goal: "Look back over this week in this space. List its sessions with agent_peers, read the week's commits on every branch with `git log --since='7 days ago' --all`, and note any branch that is still unmerged. Write a short status update in three parts: what shipped, what is in progress, and what is blocked.",
    every: "weekly", time: "16:00", weekday: 5,
  },
  {
    title: "Morning brief",
    blurb: "What changed since yesterday, and what needs attention today",
    goal: "Give me a short start-of-day brief for this space's repository: what changed since yesterday (`git log --since=yesterday`), which branches have work that is not merged, and anything that looks broken or half-finished. Keep it under ten lines.",
    every: "weekdays", time: "08:00",
  },
  {
    title: "Watch CI",
    blurb: "Check the latest CI runs, and explain any failure with its likely fix",
    goal: "Check the latest CI runs on this repository's default branch with `gh run list --limit 5`. If one failed, read its log with `gh run view --log-failed`, find the cause, and say what would fix it. If everything passed, say so in one line.",
    every: "weekdays", time: "09:00",
  },
];

/** A suggestion as a draft, ready for the modal to open on. */
export function draftOfSuggestion(s: (typeof SUGGESTIONS)[number], spaceId: string, agentKind: AgentKind, now = Date.now()): Draft {
  return { ...blankDraft(spaceId, agentKind, now), title: s.title, goal: s.goal, every: s.every, time: s.time, ...(s.weekday !== undefined ? { weekday: s.weekday } : {}) };
}
