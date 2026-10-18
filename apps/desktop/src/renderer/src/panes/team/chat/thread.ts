import { RUN_BLOCK_SENTINEL, parseBlockRequest, type RoleRun, type TeamActivity, type TeamHandoff, type TeamReviewSummary, type TeamRole } from "@realm/contracts";
import { duration, money } from "../team-format";

/**
 * A teammate's chat, assembled from what it did and what was said to it: its runs (what woke each, its
 * report, how it ended), the reviews it sent, the handoffs it made and took, the records it wrote, the
 * person's answers to its questions, and the times its clock was skipped. Pure, so the order, the
 * grouping and which fact becomes which card are tested without a window.
 *
 * Within one run the order is what a reader expects of a conversation rather than the clock's: what
 * woke it, then what happened along the way (records, handoffs, the person's answers), then what it
 * said, then the drafts it sent with that, then how it ended — or, while it is live, that it is working.
 */

export type ThreadSide = "them" | "you" | "center";

type Base = { key: string; ts: number; runId: string | null };

export type ThreadEntry = Base & (
  /** What the person said: a message, an answer, the changes asked for, a goal. `about` quotes what it answers. */
  | { kind: "you"; text: string; about: string | null }
  /** The teammate's report for a run, and where the whole run can be read. */
  | { kind: "said"; text: string; sessionId: string | null; from: number; to: number | null; meta: string }
  /** A run that is working now. */
  | { kind: "typing"; sessionId: string | null; since: number }
  /** A run parked on a question for the person. */
  | { kind: "ask"; question: string }
  /** A line across the thread: a wake by the clock, an end, a skip. */
  | { kind: "note"; text: string; detail: string | null; tone: "plain" | "warn" | "bad"; glyph: "clock" | "play" | "stop" | "alert" | "at" | "queue" }
  | { kind: "draft"; review: TeamReviewSummary }
  | { kind: "handoff"; handoff: HandoffView; direction: "in" | "out" }
  | { kind: "record"; name: string; path: string | null; line: string | null }
  | { kind: "goal"; objective: string }
);

/** A handoff as its card draws it: the other teammate by id and name, the note, the record. */
export type HandoffView = Pick<TeamHandoff, "note" | "recordPath" | "files" | "sessionId"> & { otherId: string | null; otherName: string; state: TeamHandoff["state"] | null };

/** An entry with its place in the thread: its side, and whether it opens or closes a run of bubbles
 *  from one side — the avatar and the time ride on a group's last bubble. */
export type ThreadRow = ThreadEntry & { side: ThreadSide; groupStart: boolean; groupEnd: boolean };

export type ThreadItem = ThreadRow | { kind: "day"; key: string; ts: number; label: string };

export type ThreadInput = {
  role: Pick<TeamRole, "id" | "runCapUsd" | "runCapMs">;
  /** Newest first, as `team.roleRuns` answers. */
  runs: readonly RoleRun[];
  /** The space's reviews; the role's are picked out. */
  reviews: readonly TeamReviewSummary[];
  handoffs: readonly TeamHandoff[];
  /** The role's own log lines (`team.activity` with its id). */
  activity: readonly TeamActivity[];
  /** Every role's name, the removed ones too, so a handoff names who was on the other end. */
  names: ReadonlyMap<string, string>;
  /** How many runs were asked for: a full page means older history was left out, and so is anything
   *  older than its oldest run. */
  runLimit: number;
  now: number;
};

/** Consecutive bubbles from one side group when they belong to one run, or arrive within this of each other. */
const GROUP_GAP_MS = 5 * 60_000;

const PHASE = { trigger: 0, along: 1, said: 2, drafts: 3, outcome: 4, live: 5 } as const;
type Placed = { entry: ThreadEntry; phase: number };

export function assembleThread(input: ThreadInput): ThreadItem[] {
  const { role, runs, names, now } = input;
  const oldest = runs.length >= input.runLimit ? Math.min(...runs.map((r) => r.createdAt)) : -Infinity;
  const byRun = new Map<string, Placed[]>();
  const loose: ThreadEntry[] = [];
  const place = (entry: ThreadEntry, phase: number) => {
    const owner = entry.runId ? runs.find((r) => r.id === entry.runId) : undefined;
    if (owner) {
      // Inside its run's span, so a draft first sent days ago and revised by this run reads as today's.
      const ts = Math.min(Math.max(entry.ts, owner.createdAt), owner.settledAt ?? now);
      const list = byRun.get(owner.id) ?? [];
      list.push({ entry: { ...entry, ts }, phase });
      byRun.set(owner.id, list);
    } else if (entry.ts >= oldest) {
      loose.push(entry);
    }
  };

  const mine = input.reviews.filter((r) => r.roleId === role.id);
  const handoffs = input.handoffs.filter((h) => h.kind === "handoff" && (h.toRoleId === role.id || h.fromRoleId === role.id));

  for (const run of runs) {
    for (const e of runEntries(run, role, mine, handoffs, names, now)) place(e.entry, e.phase);
  }

  // What the run that sent a draft said comes before the draft, as an attachment follows its message.
  for (const review of mine) {
    place({ kind: "draft", key: `draft:${review.id}`, ts: review.createdAt, runId: review.runId, review }, PHASE.drafts);
  }

  // A handoff this role made belongs to the run whose session made it.
  for (const h of handoffs.filter((x) => x.fromRoleId === role.id)) {
    const from = runs.find((r) => r.sessionId !== null && r.sessionId === h.fromSessionId);
    place({ kind: "handoff", key: `handoff-out:${h.id}`, ts: h.createdAt, runId: from?.id ?? null, direction: "out", handoff: handoffView(h, h.toRoleId, names) }, PHASE.along);
  }

  for (const line of input.activity) {
    const entry = activityEntry(line);
    if (entry) place(entry, PHASE.along);
  }

  const blocks: { ts: number; entries: ThreadEntry[] }[] = [];
  for (const run of runs) {
    const placed = byRun.get(run.id) ?? [];
    placed.sort((a, b) => a.phase - b.phase || a.entry.ts - b.entry.ts);
    blocks.push({ ts: run.createdAt, entries: placed.map((p) => p.entry) });
  }
  for (const entry of loose) blocks.push({ ts: entry.ts, entries: [entry] });
  blocks.sort((a, b) => a.ts - b.ts);
  return withDaysAndGroups(blocks.flatMap((b) => b.entries), now);
}

/** What one run puts in the thread, each at its phase. */
function runEntries(run: RoleRun, role: ThreadInput["role"], reviews: readonly TeamReviewSummary[], handoffs: readonly TeamHandoff[], names: ReadonlyMap<string, string>, now: number): Placed[] {
  const out: Placed[] = [];
  const at = (entry: ThreadEntry, phase: number) => out.push({ entry, phase });
  const base = (suffix: string, ts: number) => ({ key: `${suffix}:${run.id}`, ts, runId: run.id });
  const start = run.startedAt ?? run.createdAt;

  // What woke it.
  if (run.wokeOn === "schedule") {
    at({ ...base("woke", run.createdAt), kind: "note", text: `Ran on schedule · ${clock(start)}`, detail: null, tone: "plain", glyph: "clock" }, PHASE.trigger);
  } else if (run.wokeOn === "handoff") {
    const h = handoffs.find((x) => x.runId === run.id);
    const view = h ? handoffView(h, h.fromRoleId, names)
      : { note: run.wokeNote ?? "", recordPath: null, files: [], sessionId: null, otherId: null, otherName: run.wokeBy ?? "A teammate", state: null };
    at({ ...base("woke", run.createdAt), kind: "handoff", direction: "in", handoff: view }, PHASE.trigger);
  } else if (run.wokeOn === "goal") {
    at({ ...base("woke", run.createdAt), kind: "goal", objective: run.wokeNote ?? "" }, PHASE.trigger);
  } else if (run.wokeOn === "mention") {
    const by = run.wokeBy && run.wokeBy !== "You" ? `${run.wokeBy} mentioned it` : "You mentioned it in a session";
    at({ ...base("woke", run.createdAt), kind: "note", text: by, detail: run.wokeNote, tone: "plain", glyph: "at" }, PHASE.trigger);
  } else if (run.wokeNote) {
    at({ ...base("woke", run.createdAt), kind: "you", text: run.wokeNote, about: run.wokeOn === "review" ? reviewAsked(run.wokeNote, reviews) : null }, PHASE.trigger);
  } else {
    at({ ...base("woke", run.createdAt), kind: "note", text: "You started a run", detail: null, tone: "plain", glyph: "play" }, PHASE.trigger);
  }

  // What it said, without the line that parks it on the person — that is the question card's. A
  // mention's sub-agent has no report here: its words are in the session that asked.
  const said = run.report ? withoutAsk(run.report) : "";
  const meta = [run.startedAt ? `Worked ${duration((run.settledAt ?? now) - run.startedAt)}` : null, run.costUsd ? money(run.costUsd) : null].filter(Boolean).join(" · ");
  if (said) at({ ...base("said", run.settledAt ?? start), kind: "said", text: said, sessionId: run.sessionId, from: start, to: run.settledAt, meta }, PHASE.said);

  // How it ended, or that it is still going.
  if (run.state === "running") at({ ...base("typing", now), kind: "typing", sessionId: run.sessionId, since: start }, PHASE.live);
  else if (run.state === "queued") at({ ...base("queued", run.createdAt), kind: "note", text: "Waiting for a free slot", detail: null, tone: "plain", glyph: "queue" }, PHASE.live);
  else if (run.state === "blocked") at({ ...base("ask", start), kind: "ask", question: parseBlockRequest(run.report ?? null) ?? "It needs you before it goes on." }, PHASE.live);
  else if (run.stoppedAtCap) {
    const cap = run.stoppedAtCap === "usd" ? `its ${money(role.runCapUsd)} limit` : `its ${Math.round(role.runCapMs / 60_000)}-minute limit`;
    at({ ...base("end", run.settledAt ?? start), kind: "note", text: `Stopped at ${cap}`, detail: run.costUsd ? money(run.costUsd) : null, tone: "warn", glyph: "stop" }, PHASE.outcome);
  } else if (run.state === "failed" || run.state === "expired") {
    at({ ...base("end", run.settledAt ?? start), kind: "note", text: "Its run ended", detail: run.error, tone: "bad", glyph: "alert" }, PHASE.outcome);
  } else if (run.state === "cancelled") {
    at({ ...base("end", run.settledAt ?? start), kind: "note", text: "Its run was stopped", detail: run.error, tone: "plain", glyph: "stop" }, PHASE.outcome);
  }
  return out;
}

/** The log lines a chat draws: the person's answers, the records the role wrote, its skipped clock. */
function activityEntry(a: TeamActivity): ThreadEntry | null {
  const str = (k: string) => (typeof a.detail[k] === "string" ? (a.detail[k] as string) : null);
  if (a.verb === "replied") return { kind: "you", key: `reply:${a.id}`, ts: a.ts, runId: a.runId, text: str("note") ?? "", about: str("question") };
  if (a.verb === "updated_record" && a.actor.startsWith("role:")) return { kind: "record", key: `record:${a.id}`, ts: a.ts, runId: a.runId, name: a.object ?? "a record", path: str("path"), line: str("line") };
  if (a.verb === "paused") return { kind: "note", key: `paused:${a.id}`, ts: a.ts, runId: null, text: "Skipped its schedule", detail: str("why"), tone: "warn", glyph: "clock" };
  return null;
}

function handoffView(h: TeamHandoff, otherId: string | null, names: ReadonlyMap<string, string>): HandoffView {
  return { note: h.note, recordPath: h.recordPath, files: h.files, sessionId: h.sessionId, otherId, otherName: (otherId && names.get(otherId)) ?? "A teammate", state: h.state };
}

/** Which review a "changes" wake was about: the role's review whose note is the one it woke with. */
function reviewAsked(note: string, reviews: readonly TeamReviewSummary[]): string | null {
  const r = reviews.find((x) => x.note === note);
  if (!r) return null;
  return r.state === "rejected" ? `You rejected “${r.title}”` : `Changes to “${r.title}”`;
}

function withoutAsk(text: string): string {
  return text.split("\n").filter((l) => !l.trim().toUpperCase().startsWith(RUN_BLOCK_SENTINEL)).join("\n").trim();
}

const sideOf = (e: ThreadEntry): ThreadSide => (e.kind === "you" ? "you" : e.kind === "note" ? "center" : "them");

function withDaysAndGroups(entries: ThreadEntry[], now: number): ThreadItem[] {
  const rows: ThreadRow[] = entries.map((e) => ({ ...e, side: sideOf(e), groupStart: true, groupEnd: true }));
  const together = (a: ThreadRow, b: ThreadRow) =>
    a.side !== "center" && a.side === b.side && dayKey(a.ts) === dayKey(b.ts)
    && ((a.runId !== null && a.runId === b.runId) || Math.abs(b.ts - a.ts) < GROUP_GAP_MS);
  for (let i = 1; i < rows.length; i++) {
    if (together(rows[i - 1]!, rows[i]!)) { rows[i - 1]!.groupEnd = false; rows[i]!.groupStart = false; }
  }
  const out: ThreadItem[] = [];
  let day: string | null = null;
  for (const row of rows) {
    const k = dayKey(row.ts);
    if (k !== day) { out.push({ kind: "day", key: `day:${k}`, ts: row.ts, label: dayLabel(row.ts, now) }); day = k; }
    out.push(row);
  }
  return out;
}

const dayKey = (ts: number) => new Date(ts).toDateString();

/** "Today", "Yesterday", then the weekday and date the Activity page heads its days with. */
export function dayLabel(ts: number, now: number): string {
  const d = new Date(ts);
  if (d.toDateString() === new Date(now).toDateString()) return "Today";
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
