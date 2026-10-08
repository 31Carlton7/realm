import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { join } from "node:path";
import { openDatabase, type Db } from "../db/database";
import { GoalsStore } from "../store/goals";
import { GoalService, MAX_GOAL_TURNS, madeNoProgress, type SettledTurn } from "./service";
import type { Goal } from "@realm/contracts";

/* The continuation loop, with the session service replaced by a list of what it was asked to send.
   Everything worth checking here is a decision about WHETHER to start another turn, so the thing to
   watch is that list. */

const dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function bring(opts: { queued?: boolean; closeWith?: string | null } = {}) {
  const db = openDatabase(join(tempDir("realm-goal-"), "realm.db"));
  dbs.push(db);
  // The FK is to `sessions`, which this test never creates — SQLite enforces it on write, so the row
  // needs one. A single insert is cheaper and clearer than standing up the whole session service.
  db.exec("PRAGMA foreign_keys = OFF");
  const sent: { sessionId: string; text: string; tag: string }[] = [];
  const events: (Goal | null)[] = [];
  /** The seams back into the session service, in the order they were called. */
  const calls: string[] = [];
  let queued = opts.queued ?? false;
  const service = new GoalService({
    rpc: { broadcast: (name: string, payload: { goal: Goal | null }) => { if (name === "goal.changed") events.push(payload.goal); } } as never,
    goals: new GoalsStore(db),
    deliver: async (sessionId, text, tag) => { calls.push(`deliver:${tag}`); sent.push({ sessionId, text, tag }); },
    queued: () => queued,
    dropQueued: (sessionId) => { calls.push(`drop:${sessionId}`); },
    notifyTools: async (sessionId) => { calls.push(`notify:${sessionId}`); },
    ...(opts.closeWith !== undefined ? { closeWith: () => opts.closeWith! } : {}),
  });
  return { service, sent, events, calls, setQueued: (v: boolean) => { queued = v; }, db };
}

/** What the session service reports about a settled turn. */
const turn = (t: Partial<SettledTurn> = {}): SettledTurn => ({ continuation: true, toolCalls: 0, wallMs: 5_000, finalText: null, ...t });
const settle = (service: GoalService, t?: Partial<SettledTurn>) => service.onSettled("s1", { interrupted: false, turn: turn(t) });

const usage = (tokens: number) => ({ costUsd: 0, inputTokens: tokens, outputTokens: 0, numTurns: 1 });

describe("starting a goal", () => {
  it("stores the objective and sends it as the first turn", async () => {
    // A goal that sat in a row until someone pressed send would be a note. `/goal ship the release
    // notes` means get on with it.
    const { service, sent } = bring();
    const goal = await service.start("s1", "  ship the release notes  ", null);
    expect(goal).toMatchObject({ objective: "ship the release notes", status: "active", turns: 0, tokensUsed: 0, tokenBudget: null });
    expect(sent).toEqual([{ sessionId: "s1", text: "ship the release notes", tag: "goal-start" }]);
  });

  it("refuses an empty objective and an impossible budget", async () => {
    const { service } = bring();
    await expect(service.start("s1", "   ", null)).rejects.toThrow(/needs an objective/);
    await expect(service.start("s1", "do it", 0)).rejects.toThrow(/positive whole number/);
    await expect(service.start("s1", "do it", 1.5)).rejects.toThrow(/positive whole number/);
    // A "budget" of a billion is the absence of a ceiling written down as though it were one.
    await expect(service.start("s1", "do it", 999_000_000)).rejects.toThrow(/largest token budget/);
  });

  it("replaces an objective rather than stacking a second one on the session", async () => {
    const { service } = bring();
    await service.start("s1", "first thing", 1000);
    await service.onSettled("s1", { interrupted: false });
    const second = await service.start("s1", "different thing", null);
    // Counters reset with the objective: turns spent on the old goal are not this one's.
    expect(second).toMatchObject({ objective: "different thing", turns: 0, tokensUsed: 0, tokenBudget: null });
  });
});

describe("the turn after the turn", () => {
  it("continues itself when a turn settles, counting the turn", async () => {
    const { service, sent } = bring();
    await service.start("s1", "ship the release notes", null);
    expect(await service.onSettled("s1", { interrupted: false })).toBe("continued");
    expect(service.get("s1")!.turns).toBe(1);
    expect(sent[1]!.tag).toBe("goal-continuation");
    // The continuation carries the objective and says which turn this is — the agent has no memory
    // of the goal outside what it is handed.
    expect(sent[1]!.text).toContain("ship the release notes");
    expect(sent[1]!.text).toContain("turn 2");
  });

  it("stops when the user stops the turn, and says so", async () => {
    // Stop has to mean stop. A goal that started a fresh turn a moment after the button was pressed
    // would read as the button not working — the same rule the message queue follows.
    const { service, sent } = bring();
    await service.start("s1", "ship it", null);
    expect(await service.onSettled("s1", { interrupted: true })).toBe("stopped");
    expect(service.get("s1")).toMatchObject({ status: "paused", note: "You stopped the turn." });
    expect(sent).toHaveLength(1);
  });

  it("stands down when the user has typed something", async () => {
    // Their message is the next turn; the goal picks up behind it. Otherwise the user would be
    // talking over their own agent.
    const { service, sent } = bring({ queued: true });
    await service.start("s1", "ship it", null);
    expect(await service.onSettled("s1", { interrupted: false })).toBe("idle");
    expect(sent).toHaveLength(1);
    // …and the turn still counts: it happened, and the blocked audit is about turns.
    expect(service.get("s1")!.turns).toBe(1);
  });

  it("stands down when the settle is already sending a queued message, though the queue now reads empty", async () => {
    const { service, sent } = bring();
    await service.start("s1", "ship it", null);
    expect(await service.onSettled("s1", { interrupted: false, queuedNext: true })).toBe("idle");
    expect(sent).toHaveLength(1);
  });

  it("does nothing at all for a session with no goal, or one that is stopped", async () => {
    const { service, sent } = bring();
    expect(await service.onSettled("nobody", { interrupted: false })).toBe("idle");
    await service.start("s1", "ship it", null);
    service.set("s1", "complete", "done");
    expect(await service.onSettled("s1", { interrupted: false })).toBe("idle");
    expect(sent).toHaveLength(1);
  });
});

describe("a turn that cannot run", () => {
  it("stops the goal after three errored turns in a row", async () => {
    /* THE runaway. A turn that fails to START — a missing CLI, an expired login, a harness that dies
       on spawn — errors and settles in milliseconds. The model never runs, so it never calls
       `update_goal`; no tokens are spent, so no budget is ever reached. Without this guard a goal
       with no ceiling continues itself as fast as the machine allows, forever. */
    const { service, sent } = bring();
    await service.start("s1", "ship it", null);
    service.onError("s1");
    expect(await service.onSettled("s1", { interrupted: false })).toBe("continued");
    service.onError("s1");
    expect(await service.onSettled("s1", { interrupted: false })).toBe("continued");
    service.onError("s1");
    expect(await service.onSettled("s1", { interrupted: false })).toBe("failing");
    expect(service.get("s1")).toMatchObject({ status: "blocked" });
    expect(service.get("s1")!.note).toMatch(/ended in an error/);
    // Three turns went out (the objective and two continuations) and nothing after the third.
    expect(sent).toHaveLength(3);
  });

  it("a turn that worked clears the streak, so two bad turns either side of a good one are not three", async () => {
    const { service } = bring();
    await service.start("s1", "ship it", null);
    for (const errored of [true, true, false, true, true]) {
      if (errored) service.onError("s1");
      expect(await service.onSettled("s1", { interrupted: false })).toBe("continued");
    }
    expect(service.get("s1")!.status).toBe("active");
  });

  it("a resume starts the audit again", async () => {
    const { service } = bring();
    await service.start("s1", "ship it", null);
    for (let i = 0; i < 3; i++) { service.onError("s1"); await service.onSettled("s1", { interrupted: false }); }
    expect(service.get("s1")!.status).toBe("blocked");
    await service.resume("s1");
    service.onError("s1");
    expect(await service.onSettled("s1", { interrupted: false })).toBe("continued");
  });
});

describe("the budget", () => {
  it("counts tokens as deltas, seeding from the first reading rather than charging the transcript", () => {
    // The `usage` event carries the SESSION's running total, and a session can have thousands of
    // tokens behind it before a goal is set. THE cumulative mutant charges all of them to the goal
    // on its first event and stops it immediately.
    const { service } = bring();
    void service.start("s1", "ship it", 1000);
    service.onUsage("s1", usage(5_000)); // the seeding reading
    expect(service.get("s1")!.tokensUsed).toBe(0);
    service.onUsage("s1", usage(5_400));
    expect(service.get("s1")!.tokensUsed).toBe(400);
    service.onUsage("s1", usage(6_000));
    expect(service.get("s1")!.tokensUsed).toBe(1_000);
  });

  it("ignores a total that went down, which is what a compaction does", () => {
    const { service } = bring();
    void service.start("s1", "ship it", null);
    service.onUsage("s1", usage(9_000));
    service.onUsage("s1", usage(1_000)); // compacted
    expect(service.get("s1")!.tokensUsed).toBe(0);
    service.onUsage("s1", usage(1_500));
    expect(service.get("s1")!.tokensUsed).toBe(500);
  });

  it("hands over on the turn the budget runs out, instead of stopping mid-thought", async () => {
    const { service, sent } = bring();
    await service.start("s1", "ship it", 1_000);
    service.onUsage("s1", usage(0));
    service.onUsage("s1", usage(1_200));
    expect(await service.onSettled("s1", { interrupted: false })).toBe("budget");
    expect(service.get("s1")).toMatchObject({ status: "budget_limited" });
    // The last turn asks for a handover rather than more work.
    expect(sent[1]!.tag).toBe("goal-budget");
    expect(sent[1]!.text).toContain("last turn");
    // …and it is the LAST one: the handover's own settle starts nothing.
    expect(await service.onSettled("s1", { interrupted: false })).toBe("idle");
    expect(sent).toHaveLength(2);
  });

  it("a goal with no budget runs until something ends it", async () => {
    const { service } = bring();
    await service.start("s1", "ship it", null);
    service.onUsage("s1", usage(0));
    service.onUsage("s1", usage(9_000_000));
    expect(await service.onSettled("s1", { interrupted: false })).toBe("continued");
  });
});

describe("stopping and picking back up", () => {
  it("the agent's own complete and blocked land as the goal's last word", () => {
    const { service, events } = bring();
    void service.start("s1", "ship it", null);
    const done = service.set("s1", "complete", "Released 1.2.0 and the notes are on the site.");
    expect(done).toMatchObject({ status: "complete", note: "Released 1.2.0 and the notes are on the site." });
    expect(events.at(-1)).toMatchObject({ status: "complete" });
  });

  it("resume starts a turn immediately, because nothing else would", async () => {
    // The session is idle when a goal is resumed: a status change on its own would sit there.
    const { service, sent } = bring();
    await service.start("s1", "ship it", null);
    service.set("s1", "paused", "You paused it.");
    const back = await service.resume("s1");
    expect(back).toMatchObject({ status: "active", note: null });
    expect(sent.at(-1)!.tag).toBe("goal-continuation");
  });

  it("resuming a spent budget grants the allowance again, or it would stop on its own next settle", async () => {
    const { service } = bring();
    await service.start("s1", "ship it", 1_000);
    service.onUsage("s1", usage(0));
    service.onUsage("s1", usage(1_500));
    await service.onSettled("s1", { interrupted: false });
    const back = await service.resume("s1");
    expect(back).toMatchObject({ status: "active", tokensUsed: 0, tokenBudget: 1_000 });
    expect(await service.onSettled("s1", { interrupted: false })).toBe("continued");
  });

  it("refuses to resume what is running or finished", async () => {
    const { service } = bring();
    await service.start("s1", "ship it", null);
    await expect(service.resume("s1")).rejects.toThrow(/already running/);
    service.set("s1", "complete", "done");
    await expect(service.resume("s1")).rejects.toThrow(/finished/);
  });

  it("dropping it takes the row, and says the goal is gone", async () => {
    const { service, events } = bring();
    await service.start("s1", "ship it", null);
    service.clear("s1");
    expect(service.get("s1")).toBeNull();
    expect(events.at(-1)).toBeNull();
    expect(await service.onSettled("s1", { interrupted: false })).toBe("idle");
  });
});

describe("a restart", () => {
  it("parks running goals instead of picking them up by itself", async () => {
    /* Codex resumes a running goal at startup. A CLI is relaunched by someone sitting there; a
       desktop app is relaunched by someone opening it, maybe days later, maybe to do something
       else — and a burst of autonomous turns on launch is a surprise nobody consented to. THE
       resume-on-boot mutant is an app that starts spending tokens because you double-clicked it. */
    const { service, sent } = bring();
    await service.start("s1", "ship it", null);
    await service.start("s2", "other thing", null);
    service.set("s2", "complete", "done");
    const before = sent.length;
    expect(service.parkOnBoot()).toBe(1);
    expect(service.get("s1")).toMatchObject({ status: "paused", note: "Realm restarted while this goal was running." });
    expect(service.get("s2")!.status).toBe("complete");
    expect(sent).toHaveLength(before);
  });
});

describe("an agent that already has its tool list", () => {
  it("is told the list changed before the goal's first turn, and again before a resume's", async () => {
    /* A `/goal` typed mid-conversation reaches an agent that listed its tools long ago. THE mutant
       notifies after `deliver` (or not at all): the turn that starts the goal is planned against the
       old list. */
    const { service, calls } = bring();
    await service.start("s1", "ship it", null);
    expect(calls).toEqual(["notify:s1", "deliver:goal-start"]);
    service.set("s1", "paused", "You paused it.");
    calls.length = 0;
    await service.resume("s1");
    expect(calls).toEqual(["notify:s1", "deliver:goal-continuation"]);
  });

  it("is told update_goal by the name it lists it under, or the reply line when it has no tool", async () => {
    const named = bring({ closeWith: "mcp__realm__realm-goal__update_goal" });
    await named.service.start("s1", "ship it", null);
    await settle(named.service, { toolCalls: 3 });
    expect(named.sent[1]!.text).toContain("`mcp__realm__realm-goal__update_goal`");
    const bare = bring({ closeWith: null });
    await bare.service.start("s1", "ship it", null);
    await settle(bare.service, { toolCalls: 3 });
    expect(bare.sent[1]!.text).toContain("GOAL COMPLETE:");
  });
});

describe("a goal that is over while its next turn waits", () => {
  it("throws away the queued goal turns when the agent, or the user, ends it", async () => {
    /* A continuation can be sitting in the session's queue behind the turn that called
       `update_goal`. THE mutant keeps it: the queue drains it after the goal is done and the loop
       that was just closed takes another turn. */
    const { service, calls } = bring();
    await service.start("s1", "ship it", null);
    calls.length = 0;
    service.set("s1", "complete", "Released.");
    expect(calls).toEqual(["drop:s1"]);
  });

  it("…and when the loop stops itself", async () => {
    const { service, calls } = bring();
    await service.start("s1", "ship it", null);
    calls.length = 0;
    await settle(service, { finalText: "GOAL BLOCKED: the registry is down" });
    expect(calls).toEqual(["drop:s1"]);
  });
});

describe("turns that make no progress", () => {
  it("counts a turn with no tool calls, or one quick call, as no progress — and nothing busier", () => {
    expect(madeNoProgress({ toolCalls: 0, wallMs: 600_000 })).toBe(true);
    expect(madeNoProgress({ toolCalls: 1, wallMs: 8_000 })).toBe(true);
    // A turn that waited on one long command did something, however little it said.
    expect(madeNoProgress({ toolCalls: 1, wallMs: 25_000 })).toBe(false);
    // Read, edit, test: three calls, never a stall however fast.
    expect(madeNoProgress({ toolCalls: 3, wallMs: 2_000 })).toBe(false);
  });

  it("stops the goal as blocked after three in a row, and says why", async () => {
    /* 2026-10-07: an agent that could not close its goal answered "nothing has changed" on every
       continuation, five to ten seconds and zero or one call each, for hours. THE mutant raises the
       limit past three (or never counts): the goal keeps continuing. */
    const { service, sent } = bring();
    await service.start("s1", "ship it", null);
    expect(await settle(service, { continuation: false, toolCalls: 6, wallMs: 90_000 })).toBe("continued");
    expect(await settle(service)).toBe("continued");
    expect(await settle(service, { toolCalls: 1 })).toBe("continued");
    expect(await settle(service)).toBe("stalled");
    expect(service.get("s1")).toMatchObject({ status: "blocked", note: "3 turns in a row made no progress, so Realm stopped continuing this goal." });
    // The objective, two continuations, a third continuation — and nothing after the third stall.
    expect(sent).toHaveLength(4);
  });

  it("a turn that did work resets the count", async () => {
    const { service } = bring();
    await service.start("s1", "ship it", null);
    for (const calls of [0, 0, 4, 0, 0]) expect(await settle(service, { toolCalls: calls })).toBe("continued");
    expect(service.get("s1")!.status).toBe("active");
  });

  it("does not count the user's own turns, which reset it instead", async () => {
    // A person's message is them steering, not the goal stalling.
    const { service } = bring();
    await service.start("s1", "ship it", null);
    for (const continuation of [true, true, false, true, true]) {
      expect(await settle(service, { continuation })).toBe("continued");
    }
    expect(service.get("s1")!.status).toBe("active");
  });

  it("stops a goal with no budget at the turn cap", async () => {
    // The ceiling a goal gets when nobody gave it one. Busy turns, so only the cap can stop it.
    const { service } = bring();
    await service.start("s1", "ship it", null);
    let last: string = "";
    for (let i = 0; i < MAX_GOAL_TURNS; i++) last = await settle(service, { toolCalls: 5 });
    expect(last).toBe("capped");
    expect(service.get("s1")).toMatchObject({ status: "blocked", turns: MAX_GOAL_TURNS });
    expect(service.get("s1")!.note).toContain(`${MAX_GOAL_TURNS} turns`);
  });
});

describe("the reply line", () => {
  it("ends the goal on a GOAL COMPLETE: line, with the agent's note", async () => {
    /* For an agent with no `update_goal` — its space switched the tools off. THE mutant ignores the
       line: that agent has no way left to finish, and its goal continues past done. */
    const { service, sent } = bring();
    await service.start("s1", "ship it", null);
    expect(await settle(service, { toolCalls: 4, finalText: "Shipped it.\nGOAL COMPLETE: Released 1.2.0." })).toBe("closed");
    expect(service.get("s1")).toMatchObject({ status: "complete", note: "Released 1.2.0." });
    expect(sent).toHaveLength(1);
  });

  it("does not end it on a sentence that only mentions the line", async () => {
    const { service } = bring();
    await service.start("s1", "ship it", null);
    expect(await settle(service, { toolCalls: 4, finalText: "When it is all done I will write GOAL COMPLETE: and stop." })).toBe("continued");
  });
});
