import { cadenceOf, describeSchedule, isOnce, type Run, type Schedule, type Session } from "@realm/contracts";

/**
 * The Scheduled page's words for a task and its runs: when it runs, the order the column lists tasks
 * in, and what a run's row says. Shared (`@realm/view`) so Realm Mobile's Scheduled list says it the
 * way the desktop's page does, on the Mac's own clock.
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

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

/**
 * The column's order: what fires soonest first, then what is paused or finished, newest first among
 * those. "Upcoming" is a promise about the top of the list, and a task that will never fire again
 * at the top would break it.
 */
export function upcomingOrder<S extends Pick<Schedule, "enabled" | "nextRunAt" | "title" | "createdAt">>(schedules: readonly S[]): S[] {
  const armed = (s: S) => s.enabled && s.nextRunAt !== null;
  return [...schedules].sort((a, b) => {
    if (armed(a) !== armed(b)) return armed(a) ? -1 : 1;
    if (armed(a)) return a.nextRunAt! - b.nextRunAt! || a.title.localeCompare(b.title);
    return b.createdAt - a.createdAt;
  });
}

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
