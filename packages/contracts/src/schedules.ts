import { z } from "zod";
import { IdSchema } from "./entities";
import { RunConstraintsSchema } from "./runs";

/**
 * Work Realm starts on a clock instead of on a keystroke.
 *
 * A schedule is not a run and does not become one — it CREATES runs. That separation is the whole
 * design: a run already knows how to own a session across attempts, survive restarts, stop and ask a
 * human, and release its dedupe key when it settles (see `runs.ts`). A scheduler that tried to own
 * execution as well would be a second answer to every one of those questions, and the two would
 * disagree the first time a machine slept through a firing.
 *
 * So this file is only about WHEN. `runs.create` is what happens next, and everything a run's
 * vocabulary refuses — `bypassPermissions` above all — a schedule refuses too, by construction:
 * `RunConstraintsSchema` is reused verbatim rather than mirrored.
 *
 * WHEN has two spellings, and `nextFireOf` is the single gate in front of both: a cron expression for
 * work that recurs, and `once:<epoch ms>` for a single moment. They share one field because they
 * answer one question, and because a schedule that has nothing left to fire is already a state this
 * model has — `nextRunAt === null` with `enabled` still true, which the page reads as Completed.
 */

/* ────────────────────────────── cron ────────────────────────────── */

/**
 * The five fields, in the order every crontab on earth writes them.
 *
 * Deliberately five, not six or seven: seconds are not a schedule anyone wants for work that spawns
 * an agent, and a year field is a way to write a schedule that fires once in 2031 and is forgotten —
 * a one-shot wearing a recurring expression's clothes. Something that happens once says so instead,
 * in the `once:` spelling below, where the page can show it as finished rather than as armed.
 * Ranges are inclusive at both ends. Day-of-week takes 0–6 with 0 = Sunday, and 7 is accepted as a
 * second spelling of Sunday because half the world's crontabs use it.
 */
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7 },
] as const;

/** One parsed expression: the set of permitted values per field, already expanded. */
export type Cron = {
  minute: Set<number>; hour: Set<number>; dayOfMonth: Set<number>; month: Set<number>; dayOfWeek: Set<number>;
  /** True when the field was a bare `*`. Kept because day-of-month and day-of-week are OR'd only
   *  when BOTH are restricted — the standard's one genuinely surprising rule (see `matchesCron`). */
  domRestricted: boolean; dowRestricted: boolean;
};

const CRON_ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 9 * * *",      // 9am, not midnight: this starts an agent, and a person should be awake
  "@weekly": "0 9 * * 1",     // Monday morning, for the same reason
  "@monthly": "0 9 1 * *",
};

/**
 * Parse a 5-field expression, or one of the four aliases. Null for anything malformed — never a
 * partial parse and never a "best effort" fallback: a schedule that silently fires at a different
 * time than its author wrote is worse than one that refuses to be saved.
 *
 * Supported per field: a star, a number, `a-b`, a comma list of either, and a `/n` step suffix on
 * either of the first two ("every n").
 * Names (`MON`, `JAN`) are deliberately not supported — one spelling per concept, and the numeric
 * form is what the UI writes.
 */
export function parseCron(expr: string): Cron | null {
  const trimmed = expr.trim().toLowerCase();
  const source = CRON_ALIASES[trimmed] ?? trimmed;
  const parts = source.split(/\s+/);
  if (parts.length !== 5) return null;
  const sets: Set<number>[] = [];
  const restricted: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    const field = FIELDS[i]!;
    const raw = parts[i]!;
    const set = parseField(raw, field.min, field.max);
    if (!set) return null;
    sets.push(set);
    restricted.push(raw !== "*");
  }
  const dow = sets[4]!;
  // 7 and 0 are the same day. Normalising here means every consumer compares against `getDay()`
  // alone rather than each of them remembering the alias.
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return {
    minute: sets[0]!, hour: sets[1]!, dayOfMonth: sets[2]!, month: sets[3]!, dayOfWeek: dow,
    domRestricted: restricted[2]!, dowRestricted: restricted[4]!,
  };
}

function parseField(raw: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    if (part === "") return null;
    const [range, stepRaw] = part.split("/");
    if (stepRaw !== undefined && (part.split("/").length !== 2)) return null;
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number, hi: number;
    if (range === "*") { lo = min; hi = max; }
    else if (range?.includes("-")) {
      const [a, b] = range.split("-");
      lo = Number(a); hi = Number(b);
      if (range.split("-").length !== 2 || !Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    } else {
      lo = Number(range); hi = lo;
      if (!Number.isInteger(lo)) return null;
      // A bare number with a step is `n/k`, which no crontab means anything sensible by.
      if (stepRaw !== undefined) return null;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

/**
 * Does this local wall-clock minute match?
 *
 * The day rule is cron's one genuine surprise and it is implemented, not simplified: when BOTH
 * day-of-month and day-of-week are restricted the two are OR'd — `0 9 1 * 1` fires on the 1st AND on
 * every Monday — and when only one is restricted, only that one is consulted. Treating them as a
 * plain AND is the common bug, and it makes `0 9 1 * 1` fire only on Mondays that fall on the 1st,
 * which is roughly seven times a decade rather than five times a month.
 */
export function matchesCron(cron: Cron, ts: number): boolean {
  const d = new Date(ts);
  if (!cron.minute.has(d.getMinutes())) return false;
  if (!cron.hour.has(d.getHours())) return false;
  if (!cron.month.has(d.getMonth() + 1)) return false;
  const dom = cron.dayOfMonth.has(d.getDate());
  const dow = cron.dayOfWeek.has(d.getDay());
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  if (cron.domRestricted) return dom;
  if (cron.dowRestricted) return dow;
  return true;
}

/** How far ahead `nextCronFire` will look before giving up. Four years covers every leap-day
 *  expression (`0 9 29 2 *`); past that an expression matches nothing and should say so. */
const SEARCH_MINUTES = 4 * 366 * 24 * 60;

/**
 * The first minute strictly after `after` that matches, or null when nothing does within four years.
 *
 * Minute-stepping rather than arithmetic, and it steps in LOCAL time by construction: the loop
 * advances a `Date` by one minute and re-reads its fields, so the hour that repeats when the clocks
 * go back and the hour that does not exist when they go forward are both handled by the calendar
 * rather than by a correction. Closed-form next-fire arithmetic is where every DST bug in every
 * scheduler lives.
 *
 * It is not as slow as it looks: the coarse fields are checked first and a non-matching hour skips
 * the whole hour rather than sixty minutes one at a time.
 */
export function nextCronFire(cron: Cron, after: number): number | null {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after
  for (let steps = 0; steps < SEARCH_MINUTES; ) {
    if (!cron.month.has(d.getMonth() + 1)) {
      // Jump to the first minute of the next month rather than walking a whole one.
      d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + 1);
      steps += 60; continue;
    }
    const dom = cron.dayOfMonth.has(d.getDate());
    const dow = cron.dayOfWeek.has(d.getDay());
    const dayOk = cron.domRestricted && cron.dowRestricted ? dom || dow
      : cron.domRestricted ? dom : cron.dowRestricted ? dow : true;
    if (!dayOk) { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); steps += 60; continue; }
    if (!cron.hour.has(d.getHours())) { d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); steps += 60; continue; }
    if (cron.minute.has(d.getMinutes())) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
    steps += 1;
  }
  return null;
}

/* ────────────────────────────── once ────────────────────────────── */

/** The one-shot spelling: `once:` followed by an absolute epoch millisecond. */
export const ONCE_PREFIX = "once:";

/** Write one. `Math.trunc` rather than a round, so the stored moment is never a millisecond LATER
 *  than what the caller asked for — a schedule may fire late, but not early. */
export const onceExpr = (ms: number): string => `${ONCE_PREFIX}${Math.trunc(ms)}`;

/**
 * The moment a one-shot names, or null when this is not one.
 *
 * Absolute milliseconds rather than a local wall-clock string, which is the opposite of the choice
 * cron makes one section up, and deliberately: "every day at 9" means nine o'clock wherever the
 * person is and has to survive a DST change, while "the 30th at 1pm" is a single instant somebody
 * already picked. Storing that instant as local text would reintroduce the one hour a year that
 * happens twice and the one that never happens at all, for a value that has no reason to be ambiguous.
 *
 * Digits only — `once:1e12`, `once:0x10` and `once:+1` are refused rather than coerced, because every
 * one of them has a "helpful" reading and this field decides when unattended work runs.
 */
export function parseOnce(expr: string): number | null {
  const trimmed = expr.trim().toLowerCase();
  if (!trimmed.startsWith(ONCE_PREFIX)) return null;
  const digits = trimmed.slice(ONCE_PREFIX.length);
  if (!/^\d+$/.test(digits)) return null;
  const ms = Number(digits);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

/** Whether an expression fires once and is then finished. The runner reads this to decide that the
 *  catch-up window does not apply (see `ScheduleService.tick`). */
export const isOnce = (expr: string): boolean => parseOnce(expr) !== null;

/**
 * A local wall-clock moment, with no zone on it: `2026-09-30T13:00`, optionally with seconds, and a
 * space accepted in place of the `T` because models write it both ways.
 *
 * Date-only is NOT accepted, and that is the rule worth stating out loud. `new Date("2026-09-30")` is
 * UTC midnight by the language's own spec while `new Date("2026-09-30T13:00")` is local — the same
 * string one character shorter changes zone, silently, by up to a day. And a bare date has to invent a
 * time of day: midnight would start unattended work while nobody is awake to answer a permission
 * prompt, which is the exact state `@daily` already points at 9am to avoid.
 */
const LOCAL_MOMENT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ZONED = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * Text a person or a model wrote that names one moment, as absolute milliseconds — or null.
 *
 * Shared by the `once` picker in the UI and the `at` argument of `schedule_create`, because they are
 * the same question asked in two places and two parsers would be two answers.
 *
 * The local form is built through `new Date(y, m, d, …)` and then read back, because the constructor
 * ROLLS rather than refuses: February 30th becomes March 2nd and 25:00 becomes the next morning, both
 * without complaint. Comparing the fields back is what turns those into a refusal. It also refuses the
 * hour that does not exist on the day the clocks go forward, which is correct — there is no such
 * moment to schedule, and picking 03:30 on the caller's behalf would be a guess about the one thing
 * this file must not guess about.
 */
export function parseMoment(raw: string): number | null {
  const s = raw.trim();
  const m = LOCAL_MOMENT.exec(s);
  if (m) {
    const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
    const sec = m[6] === undefined ? 0 : Number(m[6]);
    if (sec > 59) return null;
    const t = new Date(y, mo - 1, d, h, mi, sec, 0);
    if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d) return null;
    if (t.getHours() !== h || t.getMinutes() !== mi) return null;
    return t.getTime();
  }
  // An explicit offset or `Z` is unambiguous, so the language's own parser is trustworthy here in a
  // way it is not above.
  if (ZONED.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** A moment as `<input type="datetime-local">` spells it — the inverse of `parseMoment`'s local form,
 *  and local by construction, which `toISOString` is not. */
export function momentInputValue(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ────────────────────────────── either one ────────────────────────────── */

/**
 * Parse and find the next fire in one step — what every caller outside the tests actually wants, and
 * the single gate both spellings pass through.
 *
 * Null covers three things that are all "nothing will happen": not a valid expression, a cron that
 * matches nothing ahead, and a one-shot whose moment has passed. The third is what makes a one-shot
 * cost the rest of the system nothing — `claimDue` writes this value back after firing, so a
 * one-shot advances itself to `nextRunAt === null` by the same statement that advances a daily
 * schedule to tomorrow, and the page's Completed lens reads that pair without being taught about
 * one-shots at all.
 *
 * Strictly after, for the same reason `nextCronFire` is: the runner writes `nextRunAt =
 * nextFireOf(now)` immediately after firing, and an inclusive comparison here would hand back the
 * moment that just fired and run it again on the next tick.
 */
export function nextFireOf(expr: string, after: number): number | null {
  const once = parseOnce(expr);
  if (once !== null) return once > after ? once : null;
  const cron = parseCron(expr);
  return cron ? nextCronFire(cron, after) : null;
}

/**
 * A one-line English reading of an expression, for the row under a schedule's title.
 *
 * Only the shapes the picker itself writes get a sentence; anything hand-typed falls back to the
 * expression in mono. That is the honest split — a general cron-to-prose translator gets the
 * gnarly cases subtly wrong, and a subtly wrong description of when unattended work runs is worse
 * than showing the expression the user wrote.
 *
 * A one-shot always gets its sentence, and it is the only place its moment survives: once the
 * schedule has fired there is no next occurrence for the row's meta line to show, and a row reading
 * only "No further runs" would have lost what it was ever for. The year appears when it is not the
 * current one — `now` is a parameter for the same reason `whenLabel` takes one, so a test can ask
 * about December from June.
 */
export function describeSchedule(expr: string, now = Date.now()): string {
  const once = parseOnce(expr);
  if (once !== null) {
    const d = new Date(once);
    const sameYear = d.getFullYear() === new Date(now).getFullYear();
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
    return `Once, on ${date} at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  const cron = parseCron(expr);
  if (!cron) return expr;
  const at = (h: Set<number>, m: Set<number>) => {
    if (h.size !== 1 || m.size !== 1) return null;
    const hh = [...h][0]!, mm = [...m][0]!;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };
  const time = at(cron.hour, cron.minute);
  const everyDay = !cron.domRestricted && !cron.dowRestricted && cron.month.size === 12;
  if (time && everyDay) return `Every day at ${time}`;
  if (time && cron.dowRestricted && !cron.domRestricted && cron.month.size === 12) {
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const days = [...cron.dayOfWeek].sort((a, b) => a - b).map((n) => names[n]!);
    if (days.length === 5 && [1, 2, 3, 4, 5].every((n) => cron.dayOfWeek.has(n))) return `Weekdays at ${time}`;
    return `${days.join(", ")} at ${time}`;
  }
  if (time && cron.domRestricted && !cron.dowRestricted && cron.dayOfMonth.size === 1 && cron.month.size === 12) {
    return `Day ${[...cron.dayOfMonth][0]} of each month at ${time}`;
  }
  if (cron.minute.size === 1 && cron.hour.size === 24 && everyDay) return `Every hour at :${String([...cron.minute][0]).padStart(2, "0")}`;
  return expr;
}

/** What the picker offers, so the common schedules are one click rather than a syntax lesson. */
export const CRON_PRESETS = [
  { label: "Every hour", expr: "0 * * * *" },
  { label: "Every day at 09:00", expr: "0 9 * * *" },
  { label: "Weekdays at 09:00", expr: "0 9 * * 1-5" },
  { label: "Every Monday at 09:00", expr: "0 9 * * 1" },
  { label: "The 1st of each month at 09:00", expr: "0 9 1 * *" },
] as const;

/* ────────────────────────────── the row ────────────────────────────── */

/**
 * How long after its due minute a firing is still worth starting.
 *
 * A Mac sleeps, and a schedule due at 09:00 on a laptop that woke at 14:00 has five hours of missed
 * minutes behind it. Running them all would be absurd; running none would make a daily schedule
 * useless on a machine that is not always on. So a single catch-up fires if the miss is inside this
 * window, and anything older is skipped forward to the next real occurrence — which is also why
 * `lastSkippedAt` exists on the row: a skip is a thing that happened and the page says so.
 */
export const SCHEDULE_CATCHUP_MS = 6 * 60 * 60 * 1000;

/** How often the runner wakes to look for due schedules. A minute is the resolution cron has, so
 *  anything finer would be a timer that mostly finds nothing. */
export const SCHEDULE_TICK_MS = 60_000;

export const ScheduleSchema = z.object({
  id: IdSchema,
  spaceId: IdSchema,
  title: z.string(),
  /** What the agent is asked to do — the run's `goal`, verbatim. */
  goal: z.string(),
  /** A 5-field cron expression in the MACHINE's local zone. Local rather than UTC because the person
   *  who wrote "every day at 9" meant nine o'clock where they are, and this app runs on their Mac. */
  cron: z.string(),
  enabled: z.boolean(),
  /** Narrowing for the runs this creates. Same schema a run takes, so a schedule can never ask for
   *  something a run would refuse — `bypassPermissions` is not in its vocabulary at either level. */
  constraints: RunConstraintsSchema.nullable(),
  /** When this will next fire, as the server last computed it. Persisted rather than derived at read
   *  time so a schedule the runner has already claimed cannot be claimed twice by a concurrent tick. */
  nextRunAt: z.number().int().nullable(),
  lastRunAt: z.number().int().nullable(),
  /** The run the last firing created, if it is still around. A plain string, not a foreign key: "this
   *  schedule produced run X" stays a true and useful statement after X is deleted. */
  lastRunId: z.string().nullable(),
  /** The last time a firing was skipped for being older than the catch-up window. Null once a real
   *  firing happens; the page shows it so a laptop's missed Monday is visible rather than silent. */
  lastSkippedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const CreateScheduleSchema = z.object({
  spaceId: IdSchema,
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(20_000),
  cron: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  constraints: RunConstraintsSchema.nullable().default(null),
});
export type CreateScheduleInput = z.infer<typeof CreateScheduleSchema>;

export const UpdateScheduleSchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(200).optional(),
  goal: z.string().min(1).max(20_000).optional(),
  cron: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  constraints: RunConstraintsSchema.nullable().optional(),
});
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleSchema>;
