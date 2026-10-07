import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { join } from "node:path";
import { openDatabase, type Db } from "../db/database";
import { GoalsStore } from "../store/goals";
import { GoalService } from "./service";
import type { Goal } from "@realm/contracts";

/* The continuation loop, with the session service replaced by a list of what it was asked to send.
   Everything worth checking here is a decision about WHETHER to start another turn, so the thing to
   watch is that list. */

const dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function bring(opts: { queued?: boolean } = {}) {
  const db = openDatabase(join(tempDir("realm-goal-"), "realm.db"));
  dbs.push(db);
  // The FK is to `sessions`, which this test never creates — SQLite enforces it on write, so the row
  // needs one. A single insert is cheaper and clearer than standing up the whole session service.
  db.exec("PRAGMA foreign_keys = OFF");
  const sent: { sessionId: string; text: string; tag: string }[] = [];
  const events: (Goal | null)[] = [];
  let queued = opts.queued ?? false;
  const service = new GoalService({
    rpc: { broadcast: (name: string, payload: { goal: Goal | null }) => { if (name === "goal.changed") events.push(payload.goal); } } as never,
    goals: new GoalsStore(db),
    deliver: async (sessionId, text, tag) => { sent.push({ sessionId, text, tag }); },
    queued: () => queued,
  });
  return { service, sent, events, setQueued: (v: boolean) => { queued = v; }, db };
}

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
