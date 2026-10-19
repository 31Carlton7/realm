import { describe, expect, it } from "vitest";
import type { ActTicket, TeamReviewDetail, TeamReviewItem, TeamReviewSummary } from "@realm/contracts";
import { teamReview } from "../../../state/store.test-fakes";
import {
  approveConsequence, closeConsequence, destination, doneLine, finishedLine, inboxGroups, kindWords, phaseLabel, phaseTone, receipt, reviewPhase, rowLine, when,
  type ReviewPhase,
} from "./review-model";

/** Review's state → presentation mapping. Each test names the one-line mutant it kills. */

const r = (over: Partial<TeamReviewSummary> = {}) => teamReview("r1", "s1", "3 slideshows for Nathan", { roleName: "Content Producer", ...over });
const NOW = new Date(2026, 9, 18, 15, 0, 0, 0).getTime();
const H = 3_600_000;

describe("the phase a person meets", () => {
  const cases: [string, Partial<TeamReviewSummary>, ReviewPhase][] = [
    ["a fresh draft", {}, "waiting"],
    ["a second version", { version: 2 }, "revised"],
    ["a draft whose file changed after the yes", { version: 2, changedSinceApproval: true }, "changed"],
    ["one sent back", { state: "changes" }, "changes"],
    ["approved, posts waiting for their press", { state: "approved", actsTotal: 3, actsDone: 0, actsWaiting: 3 }, "to-press"],
    ["approved, one refused by the platform", { state: "approved", actsTotal: 3, actsDone: 1, actsWaiting: 1, actsFailed: 1 }, "failed"],
    ["approved, the rest pressed for their slots", { state: "approved", actsTotal: 2, actsDone: 1, actsWaiting: 0, nextActAt: NOW + H }, "scheduled"],
    ["approved, Realm doesn't post it", { state: "approved", verb: "post" }, "by-hand"],
    ["approved, nowhere to go", { state: "approved", kind: "answer", verb: null }, "approved"],
    ["done, everything went out", { state: "done", actsTotal: 3, actsDone: 3 }, "posted"],
    ["done by hand", { state: "done" }, "done"],
    ["done by the role another way", { state: "done", closedAs: "done" }, "finished"],
    ["rejected", { state: "rejected" }, "rejected"],
    ["closed", { state: "closed" }, "closed"],
    ["replaced by its role", { state: "dismissed", closedAs: "superseded" }, "replaced"],
    ["withdrawn by its role", { state: "dismissed", closedAs: "withdrawn" }, "withdrawn"],
    ["put away by the old Dismiss", { state: "dismissed" }, "put-away"],
  ];
  it.each(cases)("%s", (_, over, phase) => {
    // THE MUTANTS: any branch of `reviewPhase` returning its neighbour's phase.
    expect(reviewPhase(r(over))).toBe(phase);
  });

  it("reads an approved batch from a server that counts no presses as waiting for one, not as scheduled", () => {
    // THE MUTANT: `actsWaiting ?? 0` — a batch nobody pressed would read "Posting now" from an older server.
    expect(reviewPhase(r({ state: "approved", actsTotal: 2, actsDone: 0 }))).toBe("to-press");
  });

  it("colours only state: orange waits on you, red went wrong, green went out", () => {
    expect(phaseTone("to-press")).toBe("waiting");
    expect(phaseTone("failed")).toBe("bad");
    expect(phaseTone("posted")).toBe("ok");
    // THE MUTANT: a rejection drawn red — a decision the person made is not something that went wrong.
    expect(phaseTone("rejected")).toBe("quiet");
    expect(phaseTone("changes")).toBe("quiet");
  });
});

describe("the inbox's groups", () => {
  it("puts what needs a hand first — a post to press and a failed one included — then what is under way, then this week's", () => {
    const rows = [
      r({ id: "old-done", state: "done", decidedAt: NOW - 8 * 24 * H }),
      r({ id: "rejected", state: "rejected", decidedAt: NOW - 2 * H }),
      r({ id: "scheduled", state: "approved", actsTotal: 1, actsWaiting: 0, nextActAt: NOW + H, decidedAt: NOW - 3 * H }),
      r({ id: "press", state: "approved", actsTotal: 1, actsWaiting: 1, createdAt: NOW - 5 * H }),
      r({ id: "failed", state: "approved", actsTotal: 1, actsFailed: 1, createdAt: NOW - 6 * H }),
      r({ id: "new", createdAt: NOW - H }),
      r({ id: "older", createdAt: NOW - 4 * H }),
      r({ id: "sent-back", state: "changes", decidedAt: NOW - H }),
    ];
    const groups = inboxGroups(rows, NOW);
    expect(groups.map((g) => [g.label, g.rows.map((x) => x.id)])).toEqual([
      // THE MUTANT: approved batches filed as finished — the post still waiting for its press leaves "Waiting for you".
      ["Waiting for you", ["new", "older", "press", "failed"]],
      ["In progress", ["sent-back", "scheduled"]],
      // THE MUTANT: no week's cut — last month's done batch would sit in the inbox for good.
      ["Recent", ["rejected"]],
    ]);
  });

  it("drops a group with nothing in it", () => {
    expect(inboxGroups([r()], NOW).map((g) => g.label)).toEqual(["Waiting for you"]);
    expect(inboxGroups([], NOW)).toEqual([]);
  });
});

describe("a row's words", () => {
  it("says what a waiting draft is and where it goes", () => {
    // THE MUTANT: the role's free label printed where the format names the thing — "replies" for an email.
    expect(rowLine(r({ kind: "replies", format: "email", verb: "send", account: "me@versed.app", to: "dana@acme.com" }))).toBe("Email to dana@acme.com");
    expect(rowLine(r({ kind: "DM", format: "message", verb: "dm", channels: ["instagram"], account: "@versed.nathan", to: "@reader" }))).toBe("DM to @reader on Instagram");
    expect(rowLine(r({ kind: "slideshows", itemCount: 3, channels: ["TikTok"], account: "@versed.nathan", verb: "post" }))).toBe("3 slideshows on TikTok as @versed.nathan");
    expect(rowLine(r({ kind: "answer", format: "markdown", verb: null }))).toBe("Document");
    expect(rowLine(r({ kind: "files", format: "files", verb: null }))).toBe("Files");
  });

  it("capitalises a channel a connector spelled in lower case, and never says where a draft that stays goes", () => {
    expect(destination(r({ verb: "post", channels: ["tiktok"], account: "@a" }))).toBe("on Tiktok as @a");
    expect(destination(r({ verb: "post", channels: ["TikTok"], account: "@a" }))).toBe("on TikTok as @a");
    // THE MUTANT: an email's own `mail` channel spelled out — "to dana@acme.com on Email".
    expect(destination(r({ verb: "send", channels: ["email"], to: "dana@acme.com" }))).toBe("to dana@acme.com");
    expect(destination(r({ kind: "answer", verb: null }))).toBeNull();
  });

  it("says where everything else stands", () => {
    expect(rowLine(r({ version: 2 }))).toBe("Version 2 · after your changes");
    expect(rowLine(r({ version: 2, editedItems: [1] }))).toBe("Version 2 · with your edit");
    expect(rowLine(r({ state: "approved", verb: "post", actsTotal: 3, actsWaiting: 2, actsDone: 1 }))).toBe("Approved · 2 to post");
    expect(rowLine(r({ state: "approved", verb: "post", actsTotal: 1, actsFailed: 1 }))).toBe("A post didn't go out");
    expect(rowLine(r({ state: "approved", verb: "dm", actsTotal: 4, actsFailed: 2 }))).toBe("2 messages didn't send");
    const tomorrow = new Date(NOW); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(10, 0, 0, 0);
    expect(rowLine(r({ state: "approved", verb: "post", actsTotal: 1, actsWaiting: 0, nextActAt: tomorrow.getTime() }), NOW)).toMatch(/^Posts 10:00\sAM tomorrow$/);
    expect(rowLine(r({ state: "done", verb: "post", actsTotal: 3, actsDone: 3 }))).toBe("All 3 posted");
    expect(rowLine(r({ state: "rejected", note: "Too salesy." }))).toBe("Rejected · “Too salesy.”");
    expect(rowLine(r({ state: "closed", verb: "post", actsDone: 1 }))).toBe("Closed · 1 already posted");
    expect(rowLine(r({ state: "dismissed", closedAs: "superseded" }))).toBe("Replaced by a newer version");
    expect(rowLine(r({ state: "dismissed", closedAs: "withdrawn" }))).toBe("Withdrawn by Content Producer");
  });

  it("names the kind by what it is", () => {
    expect(kindWords({ kind: "slideshows", itemCount: 1, format: "images", verb: "post" })).toBe("Slideshow");
    expect(kindWords({ kind: "replies", itemCount: 3, format: "email", verb: "send" })).toBe("3 emails");
    expect(kindWords({ kind: "DMs", itemCount: 16, format: "message", verb: "dm" })).toBe("16 DMs");
    // A label with no format to read is said as the role wrote it, and so is a bundle's.
    expect(kindWords({ kind: "release notes", itemCount: 1, format: null, verb: null })).toBe("release notes");
    // THE MUTANT: the format's noun for a bundle — a press kit of four files listed as "PDF".
    expect(kindWords({ kind: "assets", itemCount: 1, format: "pdf", verb: null })).toBe("assets");
    expect(kindWords({ kind: "document", itemCount: 1, format: "pdf", verb: null })).toBe("PDF");
  });

  it("puts a send's words on a message and a post's on a post", () => {
    expect(phaseLabel("to-press", { kind: "x", verb: "dm" })).toBe("Ready to send");
    expect(phaseLabel("to-press", { kind: "slideshows", verb: "post" })).toBe("Ready to post");
    // THE MUTANT: the family ignored — "Posted" over an email that was sent.
    expect(phaseLabel("posted", { kind: "replies", verb: "send" })).toBe("Sent");
  });
});

/* ── the reader's decision ──────────────────────────────────────────────────────────────────────── */

const item = (ord: number, over: Partial<TeamReviewItem> = {}): TeamReviewItem => ({
  id: `i${ord}`, reviewId: "r1", version: 1, ord, files: [], body: "x", target: null, contentHash: "h", approvedHash: null, actState: "none", ...over,
});
const detail = (over: Partial<TeamReviewDetail> = {}): TeamReviewDetail => ({
  ...r(), items: [item(0)], previous: [], costUsd: null, durationMs: null, runCapUsd: null, model: null, recordName: null, checks: [], ledger: [],
  root: "/s", tickets: [], ...over,
});
const ticket = (over: Partial<ActTicket> = {}): ActTicket => ({
  id: "t1", spaceId: "s1", reviewId: "r1", itemId: "i0", ord: 0, kind: "post", channel: "TikTok", account: "@versed.nathan", to: null, device: null,
  signin: null, consent: null, contentHash: "h", disclosure: "caption", state: "ready", slotAt: NOW, slotWhy: "next", pressedAt: null, actedAt: null,
  proofUrl: null, screenshot: null, error: null, todayCount: 0, todayCap: 3, adapter: { connected: true, label: "Fake", why: null }, createdAt: 0, updatedAt: 0, ...over,
});

describe("what Approve says it will do", () => {
  it("says a batch of posts lines up, each for its own press, on its channel and account", () => {
    const d = detail({ items: [0, 1, 2].map((o) => item(o, { target: { channel: "TikTok", account: "@versed.nathan" } })) });
    // THE MUTANT: "Approve" read as "post" — a consequence line that promised the yes posts.
    expect(approveConsequence(d)).toBe("Approving posts nothing. Each of the 3 posts then waits for you to press Post, on TikTok as @versed.nathan.");
  });

  it("names who a single DM goes to and from", () => {
    const d = detail({ kind: "DM", items: [item(0, { action: { connector: "channel:instagram", verb: "dm", account: "@versed.nathan", to: "@reader" } })] });
    expect(approveConsequence(d)).toBe("Approving sends nothing. The DM to @reader then waits for you to press Send, from @versed.nathan.");
  });

  it("says Realm will not send what it cannot, and that nothing leaves Realm for what goes nowhere", () => {
    const mail = detail({ kind: "replies", items: [item(0, { action: { connector: "mcp:gmail", verb: "send", account: "me@versed.app", to: "dana@acme.com" } })] });
    // THE MUTANT: a connector's send read as a channel act — "waits for you to press Send" with no Send ever offered.
    expect(approveConsequence(mail)).toBe("Approving marks it ready. Realm doesn't send this — you send it yourself from me@versed.app.");
    expect(approveConsequence(detail({ kind: "answer" }))).toBe("Approving marks it approved. Nothing leaves Realm.");
  });

  it("says the person sends what Realm issues no ticket for — no account, or nobody to send it to — as its checks do", () => {
    // THE MUTANT: any channel verb read as a press to come. An email aimed only at "Email", slides aimed
    // only at TikTok, a DM to no one: approving issues no ticket, and the line promised a press that never came.
    const email = detail({ kind: "message", items: [item(0, { target: { channel: "Email" } })] });
    expect(approveConsequence(email)).toBe("Approving marks it ready. Realm doesn't send this — you send it yourself.");
    expect(approveConsequence(detail({ items: [item(0, { target: { channel: "TikTok" } })] })))
      .toBe("Approving marks it ready. Realm doesn't post this — you post it yourself.");
    const dm = detail({ kind: "DM", items: [item(0, { action: { connector: "channel:instagram", verb: "dm", account: "@versed.nathan" } })] });
    expect(approveConsequence(dm)).toBe("Approving marks it ready. Realm doesn't send this — you send it yourself from @versed.nathan.");
    // …and the receipt after the yes promises no press either.
    expect(receipt("approve", email, { wakes: true })).toBe("Approved “3 slideshows for Nathan”.");
  });
});

describe("what Close says it will do, and what a finished review says", () => {
  it("names what it takes back and what has already gone", () => {
    const d = detail({ state: "approved", verb: "post", tickets: [ticket({ id: "a", state: "scheduled" }), ticket({ id: "b" }), ticket({ id: "c", state: "done", actedAt: NOW })] });
    expect(closeConsequence(d)).toBe("Takes back all 2 not posted yet. 1 already went out and stays out.");
    expect(closeConsequence(detail())).toBe("Nothing of it posts, and Content Producer is not told.");
  });

  it("quotes the reason a role closed it with, and the person's own", () => {
    expect(finishedLine(detail({ state: "dismissed", closedAs: "superseded", note: "the new hooks replace these" }), null, "replaced"))
      .toBe("Content Producer replaced it with a newer version: “the new hooks replace these”");
    expect(finishedLine(detail({ state: "rejected", note: "Too salesy." }), null, "rejected")).toBe("You rejected it: “Too salesy.” Nothing of it goes out.");
  });
});

describe("when, in a sentence", () => {
  it("says a clock time today and an age before that — never \"at 50m\"", () => {
    const today = new Date(NOW); today.setHours(9, 5, 0, 0);
    expect(when(today.getTime(), NOW)).toMatch(/^at 9:05\sAM$/);
    // THE MUTANT: `feedTime` after "at" — fifty minutes before midnight read "Posted at 50m".
    const lastNight = new Date(NOW); lastNight.setHours(0, 0, 0, 0);
    expect(when(lastNight.getTime() - 50 * 60_000, lastNight.getTime() + 10 * 60_000)).toBe("1h ago");
    expect(when(lastNight.getTime() - 20 * 60_000, lastNight.getTime() + 10 * 60_000)).toBe("30m ago");
    expect(when(NOW - 3 * 86_400_000, NOW)).toMatch(/^on \w{3}$/);
    expect(doneLine(ticket({ state: "done", actedAt: Date.now() }))).toMatch(/^Posted at \d{1,2}:\d{2}\s[AP]M as @versed\.nathan\.$/);
  });
});

describe("the receipts", () => {
  const d = detail({ items: [item(0, { target: { channel: "TikTok", account: "@versed.nathan" } })] });
  it("says an approval sent nothing, and what is still to press", () => {
    expect(receipt("approve", d, { wakes: true })).toBe("Approved “3 slideshows for Nathan”. Nothing posts until you press Post.");
    expect(receipt("approve", detail({ kind: "answer" }), { wakes: true })).toBe("Approved “3 slideshows for Nathan”.");
  });

  it("says the role hears of a rejection only when it is told why and wakes for Review", () => {
    expect(receipt("reject", d, { wakes: true, reason: "Off brand" })).toBe("Rejected “3 slideshows for Nathan”. Content Producer is told why.");
    // THE MUTANT: "is told why" with no reason given — the server wakes nobody then.
    expect(receipt("reject", d, { wakes: true, reason: null })).toBe("Rejected “3 slideshows for Nathan”.");
    expect(receipt("send-back", d, { wakes: false })).toMatch(/won't start on this by itself\.$/);
  });
});
