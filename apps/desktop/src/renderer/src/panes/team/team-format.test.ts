import { describe, expect, it } from "vitest";
import { teamReview, teamRole } from "../../state/store.test-fakes";
import type { TeamActivity } from "@realm/contracts";
import { actButton, activitySentence, othersPhrase, reviewStateLine, slotPhrase, ageShort, duration, feedTime, meter, money, plainError, reviewGroups, roleFieldErrors, roleStateLine, runChip, sharesNote, spendLine, wakeSentence } from "./team-format";

const NOW = new Date(2026, 9, 8, 15, 0).getTime();

describe("the team's words and numbers", () => {
  it("turns validation issues into one plain line per field, and anything else into a plain sentence", () => {
    expect(roleFieldErrors([{ path: ["roles", 0, "weekBudgetUsd"] }, { path: ["name"] }, { path: ["name"] }])).toEqual({
      weekBudgetUsd: expect.stringMatching(/^A week's budget is a number of dollars/), name: "Give this teammate a name of up to 60 characters.",
    });
    const raw = Object.assign(new Error(JSON.stringify([{ path: ["roles", 1, "model"], code: "too_small" }])), { code: "INVALID_PARAMS" });
    // THE MUTANT: the message passed through — the validator's JSON on screen.
    expect(plainError(raw)).toBe("Pick a model.");
    expect(plainError(Object.assign(new Error(JSON.stringify([{ path: ["spaceId"] }])), { code: "INVALID_PARAMS" }))).toBe("Realm could not read part of this request. Check the fields and try again.");
    expect(plainError(new Error("this team already has a role called Editor"))).toBe("this team already has a role called Editor");
  });

  it("says what the shares come to against the week, and by how much they pass it", () => {
    expect(sharesNote(45, 60)).toEqual({ text: "Shares come to $45 of the team's $60 a week", over: false, pct: 75 });
    // THE MUTANT: the cap read as a floor — over never said, and the meter past its end.
    expect(sharesNote(85, 60)).toEqual({ text: "Shares come to $85 of the team's $60 a week — $25 over", over: true, pct: 100 });
    expect(sharesNote(60, 60).over).toBe(false);
    expect(sharesNote(10.1 + 0.2, 60).text).toBe("Shares come to $10.30 of the team's $60 a week");
  });

  it("prints dollars as dollars, and never $0.00 beside work that cost something", () => {
    expect(money(0.84)).toBe("$0.84");
    expect(money(3)).toBe("$3");
    expect(money(0.001)).toBe("<$0.01");
    expect(money(null)).toBe("—");
  });

  it("says a run's length and an age the way a list's corner does", () => {
    expect(duration(45_000)).toBe("45s");
    expect(duration(0)).toBe("<1s");
    expect(duration(400)).toBe("<1s");
    expect(duration(6 * 60_000)).toBe("6m");
    expect(duration(72 * 60_000)).toBe("1h 12m");
    expect(ageShort(NOW - 40 * 60_000, NOW)).toBe("40m");
    expect(ageShort(NOW - 2 * 3_600_000, NOW)).toBe("2h");
    expect(ageShort(NOW - 2 * 86_400_000, NOW)).toMatch(/^[A-Z][a-z]{2}/);
  });

  it("turns orange at 80% of a week's budget, and draws no meter where there is no budget", () => {
    // THE MUTANT: an empty meter for a role with no cap — a claim nobody made (design.md).
    expect(meter(16, 20)).toEqual({ pct: 80, high: true });
    expect(meter(5.1, 20)?.high).toBe(false);
    expect(meter(5, null)).toBeNull();
    expect(spendLine(5.1, 20)).toBe("$5.10 of $20 this week");
  });

  it("says a role's state in a card's corner, and its clock as a sentence", () => {
    expect(roleStateLine(teamRole("r", "s", "CM", { state: "working", stateSince: NOW - 4 * 60_000 }), NOW)).toBe("Working · 4m");
    expect(roleStateLine(teamRole("r", "s", "CM", { state: "waiting" }), NOW)).toBe("Waiting on you");
    // The sidebar row's words for the same fact: "Next run …", never a bare "Next today".
    const at = new Date(NOW); at.setHours(23, 0, 0, 0);
    expect(roleStateLine(teamRole("r", "s", "CM", { cron: "0 9 * * 1-5", scheduleEnabled: true, nextRunAt: at.getTime() }), at.getTime() - 60_000)).toMatch(/^Next run today 11:00\sPM$/);
    // The Scheduled page's clock, not a second one: "9:00 AM", never "09:00".
    expect(wakeSentence("0 9 * * 1-5")).toBe("Every weekday at 9:00 AM");
    expect(wakeSentence("0 8 * * 1")).toBe("Mondays at 8:00 AM");
    expect(wakeSentence("0 9 * * 1,4")).toBe("Monday, Thursday at 9:00 AM");
    expect(wakeSentence(null)).toBe("Only when you run it");
  });

  it("stamps today's activity with the app's clock, not a 24-hour one", () => {
    const at = new Date(NOW); at.setHours(17, 4, 0, 0);
    expect(feedTime(at.getTime(), at.getTime() + 60_000)).toMatch(/^5:04\sPM$/);
  });

  it("groups Review the way a person works through it, with only this week's done", () => {
    const groups = reviewGroups([
      teamReview("a", "s", "A", { state: "waiting", createdAt: NOW - 1 }),
      teamReview("b", "s", "B", { state: "approved", createdAt: NOW - 2 }),
      teamReview("c", "s", "C", { state: "done", decidedAt: NOW - 86_400_000 }),
      teamReview("d", "s", "D", { state: "done", decidedAt: NOW - 9 * 86_400_000 }),
      teamReview("e", "s", "E", { state: "changes", createdAt: NOW - 3 }),
    ], NOW);
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ["Waiting for you", ["a", "e"]], ["Approved, not posted", ["b"]], ["Done this week", ["c"]],
    ]);
  });

  it("names a run's outcome by what became of its work", () => {
    const base = { id: "x", roleId: "r", wokeOn: "schedule" as const, wokeNote: null, sessionId: null, createdAt: 0, startedAt: 0, settledAt: 1, costUsd: 0.3, summary: null, error: null, stoppedAtCap: null, reviewId: null, reviewState: null };
    expect(runChip({ ...base, state: "succeeded", reviewState: "waiting" })).toEqual({ tone: "warn", word: "In review" });
    expect(runChip({ ...base, state: "succeeded", reviewState: "approved" })).toEqual({ tone: "ok", word: "Approved" });
    expect(runChip({ ...base, state: "cancelled", stoppedAtCap: "usd" })).toEqual({ tone: "warn", word: "Stopped at $ cap" });
  });
});

describe("approve → act, in words", () => {
  const at = (h: number, m = 0, d = 8) => new Date(2026, 9, d, h, m).getTime();
  it("says a slot as the sheet's When row does, and the button as the action and its time", () => {
    expect(slotPhrase(NOW, NOW)).toBe("now");
    expect(slotPhrase(at(16, 10), NOW)).toMatch(/^4:10\s?PM today$/);
    expect(slotPhrase(at(8, 0, 9), NOW)).toMatch(/^8:00\s?AM tomorrow$/);
    // THE MUTANT: "Post now" beside a later slot.
    expect(actButton({ kind: "post", slotAt: at(16, 10) }, NOW)).toMatch(/^Post at 4:10\s?PM$/);
    expect(actButton({ kind: "dm", slotAt: at(8, 0, 9) }, NOW)).toMatch(/^Send tomorrow at 8:00\s?AM$/);
    expect(actButton({ kind: "post", slotAt: NOW }, NOW)).toBe("Post now");
  });

  it("names the rest of a batch by number", () => {
    expect(othersPhrase([1, 2, 3, 4, 5], "slideshow")).toBe("Slideshows 2–6");
    expect(othersPhrase([2], "slideshow")).toBe("Slideshow 3");
    expect(othersPhrase([1, 3], "slideshow")).toBe("Slideshows 2 and 4");
    expect(othersPhrase([], "slideshow")).toBeNull();
  });

  it("counts what went out on an approved card", () => {
    expect(reviewStateLine(teamReview("r", "s", "6 slideshows", { state: "approved", actsTotal: 6, actsDone: 0 })).text).toBe("Approved by you · 0 of 6 posted");
    expect(reviewStateLine(teamReview("r", "s", "DMs", { kind: "message", state: "approved", actsTotal: 3, actsDone: 1 })).text).toBe("Approved by you · 1 of 3 sent");
    // Generic deliverables: worded by the batch's verb. THE MUTANT: "Approve before anything posts" on a
    // research note that goes nowhere, or on a reply that is sent.
    expect(reviewStateLine(teamReview("r", "s", "Answer", { kind: "answer", verb: null })).text).toBe("Approve before anything leaves Realm");
    expect(reviewStateLine(teamReview("r", "s", "Reply", { kind: "replies", verb: "send", account: "me@x.co" })).text).toBe("Sends from me@x.co");
  });

  it("writes each act's line in the log, its proof and its refusals included", () => {
    const line = (verb: string, detail: Record<string, unknown>, actor = "realm"): TeamActivity => ({ id: "a", spaceId: "s", ts: NOW, actor, runId: null, sessionId: null, verb, object: "@versed.nathan", detail });
    const post = { ticketId: "t", kind: "post", channel: "TikTok", account: "@versed.nathan" };
    expect(activitySentence(line("acted", { ...post, url: "https://x.invalid/1" }), "Realm")).toEqual({ text: "Posted as @versed.nathan on TikTok", detail: "https://x.invalid/1" });
    expect(activitySentence(line("refused", { ...post, why: "no_press" }), "Realm")).toEqual({ text: "Realm refused a post as @versed.nathan on TikTok", detail: "nobody pressed its sheet in Realm's window" });
    expect(activitySentence(line("refused", { reviewId: "r", why: "changed_after_approval" }), "Realm").text).toBe("@versed.nathan needs your yes again");
    expect(activitySentence(line("acted", { ticketId: "t", kind: "dm", channel: "TikTok", account: "@versed.nathan", to: "@reader" }), "Realm").text).toBe("Sent to @reader from @versed.nathan");
    expect(activitySentence(line("held_acts", {}, "user"), "You").text).toBe("You held every post and send of the team");
    expect(activitySentence(line("issued_tickets", { tickets: 6 }), "Realm").text).toBe("6 acts from @versed.nathan wait for your press");
  });
});
