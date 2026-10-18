import { describe, expect, it } from "vitest";
import type { RoleRun, TeamActivity, TeamHandoff } from "@realm/contracts";
import { teamReview, teamRole } from "../../../state/store.test-fakes";
import { assembleThread, dayLabel, type ThreadInput, type ThreadItem } from "./thread";

const NOW = new Date(2026, 9, 18, 15, 0).getTime();
const at = (h: number, m = 0, daysAgo = 0) => new Date(2026, 9, 18 - daysAgo, h, m).getTime();

const role = teamRole("r1", "s1", "Researcher");

const run = (id: string, extra: Partial<RoleRun> = {}): RoleRun => ({
  id, roleId: "r1", state: "succeeded", wokeOn: "manual", wokeNote: null, wokeBy: null, sessionId: `ses-${id}`,
  createdAt: at(9), startedAt: at(9), settledAt: at(9, 5), costUsd: 0.42, summary: null, report: null, error: null,
  stoppedAtCap: null, reviewId: null, reviewState: null, ...extra,
});

const line = (id: string, verb: string, extra: Partial<TeamActivity> = {}): TeamActivity => ({
  id, spaceId: "s1", ts: at(9, 2), actor: "role:r1", runId: null, sessionId: null, verb, object: null, detail: {}, ...extra,
});

const handoff = (id: string, extra: Partial<TeamHandoff> = {}): TeamHandoff => ({
  id, spaceId: "s1", kind: "handoff", fromRoleId: "r2", fromSessionId: null, toRoleId: "r1", recordPath: null, note: "Check these numbers.",
  files: [], runId: null, sessionId: null, state: "done", costUsd: null, createdAt: at(9), settledAt: null, ...extra,
});

const input = (extra: Partial<ThreadInput>): ThreadInput => ({
  role, runs: [], reviews: [], handoffs: [], activity: [], names: new Map([["r1", "Researcher"], ["r2", "Editor"]]), runLimit: 30, now: NOW, ...extra,
});

/** The thread as kinds, with the words that tell entries apart. */
const shape = (items: ThreadItem[]) => items.map((i) => {
  if (i.kind === "day") return `day ${i.label}`;
  if (i.kind === "you") return `you ${i.text}${i.about ? ` (${i.about})` : ""}`;
  if (i.kind === "said") return `said ${i.text}`;
  if (i.kind === "note") return `note ${i.text}${i.detail ? ` · ${i.detail}` : ""}`;
  if (i.kind === "ask") return `ask ${i.question}`;
  if (i.kind === "draft") return `draft ${i.review.title}`;
  if (i.kind === "handoff") return `handoff-${i.direction} ${i.handoff.otherName}: ${i.handoff.note}`;
  if (i.kind === "record") return `record ${i.name}`;
  if (i.kind === "goal") return `goal ${i.objective}`;
  return i.kind;
});

describe("a teammate's thread", () => {
  it("runs read oldest first, and inside a run: what woke it, what happened along the way, what it said, its draft, how it ended", () => {
    const items = assembleThread(input({
      runs: [
        run("b", { createdAt: at(11), startedAt: at(11), settledAt: at(11, 20), state: "cancelled", stoppedAtCap: "usd", report: "Got halfway.", wokeOn: "schedule" }),
        run("a", { wokeNote: "find three sources", report: "Found three sources.", reviewId: "v1" }),
      ],
      reviews: [teamReview("v1", "s1", "Launch brief", { roleId: "r1", runId: "a", createdAt: at(9, 3) }), teamReview("v2", "s1", "Someone else's", { roleId: "r2", runId: "x" })],
      activity: [line("l1", "updated_record", { runId: "a", object: "Nathan Beyenhof", detail: { path: "creators/nathan.md", line: "Deadline: Friday" } })],
    }));
    expect(shape(items)).toEqual([
      "day Today",
      "you find three sources",
      // THE MUTANT: entries sorted by their clock alone — the draft (9:03) and the record (9:02) would
      // land before the report that tells you about them (9:05).
      "record Nathan Beyenhof",
      "said Found three sources.",
      "draft Launch brief",
      "note Ran on schedule · 11:00 AM",
      "said Got halfway.",
      "note Stopped at its $3 limit · $0.42",
    ]);
  });

  it("turns each kind of wake into its own entry: the clock, a handoff, a goal, a mention, changes asked, and Run now", () => {
    const items = assembleThread(input({
      runs: [
        run("f", { createdAt: at(14), wokeNote: null }),
        run("e", { createdAt: at(13), wokeOn: "review", wokeNote: "Shorter, please." }),
        run("d", { createdAt: at(12), wokeOn: "mention", wokeBy: "You", wokeNote: "what's due?" }),
        run("c", { createdAt: at(11), wokeOn: "goal", wokeNote: "Keep every record current" }),
        run("b", { createdAt: at(10), wokeOn: "handoff", wokeBy: "Editor", wokeNote: "Check these numbers." }),
        run("a", { createdAt: at(9), startedAt: at(9, 1), wokeOn: "schedule" }),
      ],
      // Sent by a run older than the page: it stands at the time it was sent.
      reviews: [teamReview("v1", "s1", "Launch brief", { roleId: "r1", state: "changes", note: "Shorter, please.", runId: "zz", createdAt: at(12, 30) })],
      handoffs: [handoff("h1", { runId: "b", fromRoleId: "r2", recordPath: "creators/nathan.md" })],
    }));
    expect(shape(items)).toEqual([
      "day Today",
      "note Ran on schedule · 9:01 AM",
      "handoff-in Editor: Check these numbers.",
      "goal Keep every record current",
      "note You mentioned it in a session · what's due?",
      "draft Launch brief",
      "you Shorter, please. (Changes to “Launch brief”)",
      "note You started a run",
    ]);
    const card = items.find((i) => i.kind === "handoff");
    expect(card?.kind === "handoff" && card.handoff).toMatchObject({ otherId: "r2", recordPath: "creators/nathan.md", state: "done" });
  });

  it("says a live run is working, a queued one is waiting, and a run parked on a question asks it — without the sentinel line", () => {
    const items = assembleThread(input({
      runs: [
        run("c", { createdAt: at(14), state: "queued", startedAt: null, settledAt: null, wokeNote: "after that" }),
        run("b", { createdAt: at(13), state: "running", settledAt: null, wokeNote: "take your time" }),
        run("a", { createdAt: at(12), state: "blocked", settledAt: null, wokeNote: "ask me first", report: "Two are due.\n\nNEEDS-HUMAN: Which creator first?" }),
      ],
    }));
    expect(shape(items)).toEqual([
      "day Today",
      "you ask me first", "said Two are due.", "ask Which creator first?",
      "you take your time", "typing",
      "you after that", "note Waiting for a free slot",
    ]);
  });

  it("puts the person's answer to a question between the question's run and what the run said next, quoting the question", () => {
    const items = assembleThread(input({
      runs: [run("a", { wokeNote: "ask me first", settledAt: at(9, 30), report: "Starting with Nathan." })],
      activity: [line("l1", "replied", { actor: "user", runId: "a", ts: at(9, 20), detail: { roleId: "r1", note: "Start with Nathan", question: "Which creator first?" } })],
    }));
    expect(shape(items)).toEqual(["day Today", "you ask me first", "you Start with Nathan (Which creator first?)", "said Starting with Nathan."]);
  });

  it("files a handoff the role made under the run whose session made it, and a skipped clock on its own", () => {
    const items = assembleThread(input({
      runs: [run("a", { createdAt: at(9), wokeNote: "pass it on", report: "Handed to the editor." })],
      handoffs: [handoff("h1", { fromRoleId: "r1", toRoleId: "r2", fromSessionId: "ses-a", createdAt: at(9, 2), note: "Proof this." })],
      activity: [line("p1", "paused", { actor: "realm", ts: at(12), object: "Researcher", detail: { roleId: "r1", why: "the team has spent its $60 for this week" } })],
    }));
    expect(shape(items)).toEqual([
      "day Today", "you pass it on", "handoff-out Editor: Proof this.", "said Handed to the editor.",
      "note Skipped its schedule · the team has spent its $60 for this week",
    ]);
  });

  it("ends a run that failed or was stopped with a line saying so", () => {
    const items = assembleThread(input({
      runs: [
        run("b", { createdAt: at(10), state: "cancelled", error: "cancelled", wokeNote: "two" }),
        run("a", { createdAt: at(9), state: "failed", error: "the run's session ended with status \"error\"", wokeNote: "one" }),
      ],
    }));
    expect(shape(items)).toEqual(["day Today", "you one", "note Its run ended · the run's session ended with status \"error\"", "you two", "note Its run was stopped · cancelled"]);
    const failed = items.find((i) => i.kind === "note" && i.text === "Its run ended");
    expect(failed?.kind === "note" && failed.tone).toBe("bad");
  });

  it("groups one side's bubbles by run or by a short gap, never across a day or a line, and puts a day head before each day", () => {
    const items = assembleThread(input({
      runs: [
        run("c", { createdAt: at(10, 30), wokeNote: "third", report: "Three." }),
        run("b", { createdAt: at(10, 2), settledAt: at(10, 4), wokeNote: "second", report: "Two." }),
        run("a", { createdAt: at(10, 0), settledAt: at(10, 1), wokeNote: "first", report: "One.", reviewId: "v1" }),
        run("y", { createdAt: at(17, 0, 1), settledAt: at(17, 1, 1), wokeNote: "yesterday", report: "Then." }),
      ],
      reviews: [teamReview("v1", "s1", "Brief", { roleId: "r1", runId: "a" })],
    }));
    const rows = items.map((i) => (i.kind === "day" ? `— ${i.label}` : `${i.side} ${i.kind} ${i.groupStart ? "[" : ""}${i.groupEnd ? "]" : ""}`));
    expect(rows).toEqual([
      "— Yesterday",
      "you you []", "them said []",
      "— Today",
      "you you []",
      // One run's report and its draft are one group.
      "them said [", "them draft ]",
      // Two minutes later the person writes again: a group of its own side, so it stands alone.
      "you you []",
      "them said []",
      // Twenty-six minutes on, a new group.
      "you you []", "them said []",
    ]);
  });

  it("leaves out what is older than the oldest run when the runs were a full page, and the other roles' reviews always", () => {
    const runs = [run("b", { createdAt: at(12), wokeNote: "b" }), run("a", { createdAt: at(11), wokeNote: "a" })];
    const early = line("p1", "paused", { actor: "realm", ts: at(8), detail: { roleId: "r1", why: "spent" } });
    expect(shape(assembleThread(input({ runs, activity: [early], runLimit: 2 })))).toEqual(["day Today", "you a", "you b"]);
    expect(shape(assembleThread(input({ runs, activity: [early], runLimit: 30 })))[1]).toBe("note Skipped its schedule · spent");
  });

  it("names a day as today, yesterday, or its weekday and date", () => {
    expect(dayLabel(at(1), NOW)).toBe("Today");
    expect(dayLabel(at(23, 0, 1), NOW)).toBe("Yesterday");
    expect(dayLabel(at(9, 0, 3), NOW)).toBe(new Date(at(9, 0, 3)).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }));
  });
});
