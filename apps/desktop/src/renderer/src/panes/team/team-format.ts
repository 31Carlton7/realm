import { describeSchedule, type RoleRun, type TeamActivity, type TeamReviewSummary, type TeamRole } from "@realm/contracts";
import { cadenceSentence, clockLabel } from "../schedules/schedule-model";
import { vaultSentence } from "./vault-format";

/**
 * The words and numbers the team surfaces print, pure so each is testable. Dollars are always shown
 * (the Teams plan, 9.5) and always as dollars — on a subscription they are an API-equivalent weight,
 * which the overview's tooltip says once.
 */

/** "$0.84", "$3", "$12.50". Under a cent reads as "<$0.01", never "$0.00" beside work that cost something. */
export function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n > 0 && n < 0.005) return "<$0.01";
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** A run's length: "<1s", "45s", "6m", "1h 12m". A run that settled inside half a second says "<1s",
 *  not the "0s" that reads as a run that never happened. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 1) return "<1s";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** How long ago, in a list's corner: "now", "40m", "2h", then the weekday this week, then the date. */
export function ageShort(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (min < 24 * 60 && new Date(ts).toDateString() === new Date(now).toDateString()) return `${Math.floor(min / 60)}h`;
  if (now - ts < 6 * 86_400_000) return new Date(ts).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The clock time a log line was written: "14:06" today, the weekday before that. */
export function feedTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  // The transcript's clock ("4:57 AM"), not a 24-hour one beside it.
  if (d.toDateString() === new Date(now).toDateString()) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return ageShort(ts, now);
}

/** "2h ago" inside a sentence. */
export function agoPhrase(ts: number, now = Date.now()): string {
  const a = ageShort(ts, now);
  return a === "now" ? "just now" : /^\d/.test(a) ? `${a} ago` : a;
}

/** How a role's runs are woken, in a sentence: "Every weekday at 9:00 AM", or that it waits to be
 *  asked. The clock is the Scheduled page's — a team card reading "09:00" beside a task reading
 *  "9:00 AM" was one time written two ways. Days the task modal cannot name keep the schedule's own
 *  words with the same clock: "Monday, Thursday at 9:00 AM". */
export function wakeSentence(cron: string | null): string {
  if (!cron) return "Only when you run it";
  const named = cadenceSentence(cron);
  const words = named !== cron ? named : describeSchedule(cron).replace(/\b(\d{2}):(\d{2})\b/g, (_, h: string, m: string) => clockLabel(Number(h), Number(m)));
  return words.replace(/^Weekdays at/, "Every weekday at");
}

/** A role's state, in a card's corner: "Working · 4m", "Next run Thu 9:00 AM", "Waiting on you" —
 *  the words the role's sidebar row uses for the same fact. */
export function roleStateLine(role: TeamRole, now = Date.now()): string {
  if (role.state === "working") return role.stateSince ? `Working · ${duration(now - role.stateSince)}` : "Working";
  if (role.state === "waiting") return "Waiting on you";
  if (role.state === "queued") return "Queued";
  if (role.state === "paused") return "Paused";
  if (role.cron && role.scheduleEnabled && role.nextRunAt) {
    const d = new Date(role.nextRunAt);
    const day = d.toDateString() === new Date(now).toDateString() ? "today" : d.toLocaleDateString(undefined, { weekday: "short" });
    return `Next run ${day} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return "Idle";
}

/** The spend line under a role: "$5.10 of $20 this week", or just what it spent when it has no cap. */
export function spendLine(spent: number, budget: number | null): string {
  return budget ? `${money(spent)} of ${money(budget)} this week` : `${money(spent)} this week`;
}

/** The team's week as its roles' shares divide it: "$45 of the team's $60 a week", and — past the cap,
 *  which the server refuses — by how much. The meter fills to the cap and stops there. */
export function sharesNote(shares: number, cap: number): { text: string; over: boolean; pct: number } {
  const over = shares > cap + 1e-9;
  const text = over
    ? `Shares come to ${money(round2(shares))} of the team's ${money(cap)} a week — ${money(round2(shares - cap))} over`
    : `Shares come to ${money(round2(shares))} of the team's ${money(cap)} a week`;
  return { text, over, pct: cap > 0 ? Math.max(0, Math.min(100, (shares / cap) * 100)) : 100 };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A teammate's fields as the role sheet names them, and what each needs, in words a person reads. */
export const ROLE_FIELD_WORDS: Record<string, string> = {
  name: "Give this teammate a name of up to 60 characters.",
  brief: "Say what this teammate does.",
  model: "Pick a model.",
  effort: "Pick an effort level.",
  permissionMode: "Pick a mode.",
  cron: "Pick when it wakes.",
  weekBudgetUsd: "A week's budget is a number of dollars above zero, up to $10,000 — or leave it empty for no share of its own.",
  runCapUsd: "A run's limit is a number of dollars above zero.",
  runCapMs: "A run's time limit is between 1 minute and a day.",
  skills: "Pick at most 50 skills.",
  realmite: "Its Realmite could not be read. Shuffle it and try again.",
};

export type RoleFieldErrors = Partial<Record<string, string>>;

type Issue = { path: readonly PropertyKey[]; message?: string };

/** Validation issues as one plain message per field: the last part of each issue's path that names a
 *  field. A field Realm has no words for is left out here and said by `plainError`. */
export function roleFieldErrors(issues: readonly Issue[]): RoleFieldErrors {
  const out: RoleFieldErrors = {};
  for (const i of issues) {
    const field = [...i.path].reverse().find((p): p is string => typeof p === "string" && p in ROLE_FIELD_WORDS);
    if (field && !out[field]) out[field] = ROLE_FIELD_WORDS[field];
  }
  return out;
}

/** The issues a server's INVALID_PARAMS answer carries — its message is the validator's JSON — or
 *  null when the error is anything else. */
export function invalidIssues(e: unknown): Issue[] | null {
  const code = (e as { code?: unknown } | null)?.code;
  if (code !== "INVALID_PARAMS" || !(e instanceof Error)) return null;
  try {
    const v = JSON.parse(e.message) as unknown;
    return Array.isArray(v) && v.every((i) => i && Array.isArray((i as Issue).path)) ? (v as Issue[]) : null;
  } catch { return null; }
}

/** Any error as a sentence: never the validator's JSON. A field it names is said in that field's words;
 *  anything else in the request reads as one plain line. */
export function plainError(e: unknown): string {
  const issues = invalidIssues(e);
  if (issues) {
    const words = [...new Set(Object.values(roleFieldErrors(issues)))];
    return words.length > 0 ? words.join(" ") : "Realm could not read part of this request. Check the fields and try again.";
  }
  return e instanceof Error ? e.message : String(e);
}

/** How full a meter is, 0–100, and whether it has crossed 80% — orange is state, not decoration. */
export function meter(spent: number, budget: number | null): { pct: number; high: boolean } | null {
  if (!budget) return null;
  const pct = Math.max(0, Math.min(100, (spent / budget) * 100));
  return { pct, high: pct >= 80 };
}

/** Why a run woke, as its page's table says it. */
export function wokeLine(run: RoleRun): string {
  if (run.wokeOn === "schedule") return "Its schedule";
  if (run.wokeOn === "review") return "You asked for changes";
  if (run.wokeOn === "manual") return run.wokeNote ? "Your message" : "Run now";
  return "—";
}

/** A run's outcome as one chip: its tone and its word. */
export function runChip(run: RoleRun): { tone: "ok" | "warn" | "bad" | null; word: string } {
  if (run.state === "running") return { tone: null, word: "Working" };
  if (run.state === "queued") return { tone: null, word: "Queued" };
  if (run.state === "blocked") return { tone: "warn", word: "Needs you" };
  if (run.stoppedAtCap) return { tone: "warn", word: run.stoppedAtCap === "usd" ? "Stopped at $ cap" : "Stopped at time cap" };
  if (run.state === "failed" || run.state === "expired") return { tone: "bad", word: "Failed" };
  if (run.state === "cancelled") return { tone: null, word: "Cancelled" };
  if (run.reviewState === "waiting" || run.reviewState === "changes") return { tone: "warn", word: "In review" };
  if (run.reviewState === "approved") return { tone: "ok", word: "Approved" };
  if (run.reviewState === "done") return { tone: "ok", word: "Done" };
  return { tone: null, word: "Done" };
}

/** A review's state line in the list, in words. */
export function reviewStateLine(r: TeamReviewSummary): { text: string; dot: "waiting" | null } {
  if (r.state === "waiting") {
    if (r.changedSinceApproval) return { text: "A file changed after you approved it", dot: "waiting" };
    if (r.version > 1) return { text: `Version ${r.version} · approve before anything ${r.kind === "message" ? "sends" : "posts"}`, dot: "waiting" };
    return { text: r.kind === "message" && r.account ? `Sends from ${r.account}` : "Approve before anything posts", dot: "waiting" };
  }
  if (r.state === "changes") return { text: "Changes asked · the role is on it", dot: null };
  if (r.state === "approved") return { text: "Approved by you · post it by hand", dot: null };
  if (r.state === "done") return { text: "Done", dot: null };
  return { text: "Put away", dot: null };
}

/** The list's three groups, in the order a person works through them. Done shows this week's only. */
export function reviewGroups(reviews: readonly TeamReviewSummary[], now = Date.now()): { label: string; rows: TeamReviewSummary[] }[] {
  const week = now - 7 * 86_400_000;
  const by = (a: TeamReviewSummary, b: TeamReviewSummary) => b.createdAt - a.createdAt;
  return [
    { label: "Waiting for you", rows: reviews.filter((r) => r.state === "waiting" || r.state === "changes").sort(by) },
    { label: "Approved, not posted", rows: reviews.filter((r) => r.state === "approved").sort(by) },
    { label: "Done this week", rows: reviews.filter((r) => r.state === "done" && (r.decidedAt ?? r.updatedAt) >= week).sort(by) },
  ].filter((g) => g.rows.length > 0);
}

/** One line of the activity log, in plain words, with the actor's name already resolved. */
export function activitySentence(a: TeamActivity, actorName: string): { text: string; detail: string | null } {
  const d = a.detail;
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
  const num = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);
  switch (a.verb) {
    case "made_team": return { text: "You made this space a team", detail: null };
    case "made_role": return { text: `You made ${a.object}`, detail: null };
    case "edited_role": return { text: `You changed ${a.object}`, detail: Array.isArray(d.changed) ? (d.changed as string[]).join(", ") : null };
    case "archived_role": return { text: `You removed ${a.object} from the team`, detail: "its runs and what it made stay" };
    case "edited_team": return { text: "You changed the team's week", detail: num("weekBudgetUsd") !== null ? `${money(num("weekBudgetUsd"))} a week` : null };
    case "woke": return { text: `${actorName} woke`, detail: str("note") ? `“${str("note")}”` : d.wokeOn === "schedule" ? "on its schedule" : d.wokeOn === "review" ? "for your changes" : "when you ran it" };
    case "queued": return { text: `${a.object} is waiting for a free slot`, detail: null };
    case "finished": return { text: `${actorName} finished`, detail: [str("summary"), num("costUsd") !== null ? money(num("costUsd")) : null].filter(Boolean).join(" · ") || null };
    case "failed": return { text: `${actorName}'s run ended`, detail: str("summary") };
    case "stopped_at_cap": return { text: `${a.object} stopped at its ${d.cap === "time" ? "time" : "dollar"} limit`, detail: num("costUsd") !== null ? money(num("costUsd")) : null };
    case "paused": return { text: `${a.object} skipped its schedule`, detail: str("why") };
    case "submitted": return { text: `${actorName} sent ${a.object} to Review`, detail: num("items") !== null ? `${num("items")} item${num("items") === 1 ? "" : "s"}` : null };
    case "revised": return { text: `${actorName} sent a new version of ${a.object}`, detail: num("version") !== null ? `version ${num("version")}` : null };
    case "approved": return { text: `You approved ${a.object}`, detail: null };
    case "asked_changes": return { text: `You asked for changes to ${a.object}`, detail: str("note") ? `“${str("note")}”` : null };
    case "marked_done": return { text: `You marked ${a.object} done`, detail: null };
    case "dismissed": return { text: `You put away ${a.object}`, detail: null };
    case "read_record": return { text: `${actorName} read ${a.object}'s record`, detail: null };
    case "updated_record": return { text: `${actorName === "You" ? "You" : actorName} updated ${a.object}'s record`, detail: str("line") };
    case "refused": return { text: `${a.object} needs your yes again`, detail: "a file changed after you approved it" };
    default: return vaultSentence(a, actorName) ?? { text: `${actorName}: ${a.verb.replace(/_/g, " ")}${a.object ? ` ${a.object}` : ""}`, detail: null };
  }
}
