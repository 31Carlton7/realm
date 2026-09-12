import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { join } from "node:path";
import { openDatabase, type Db } from "../db/database";
import { GoalsStore } from "../store/goals";
import { GoalService } from "./service";
import { createGoalProvider, GOAL_PROVIDER_NAME, GOAL_STATUS_TOOL_NAME, UPDATE_GOAL_TOOL_NAME } from "./agent-tools";

const dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function bring(enabled = true) {
  const db = openDatabase(join(tempDir("realm-goal-tools-"), "realm.db"));
  dbs.push(db);
  db.exec("PRAGMA foreign_keys = OFF");
  const goals = new GoalService({
    rpc: { broadcast: () => {} } as never,
    goals: new GoalsStore(db),
    deliver: async () => {},
    queued: () => false,
  });
  const provider = createGoalProvider({ goals, mcp: { providerEnabled: () => enabled } });
  const ctx = { sessionId: "s1", spaceId: "sp1" };
  return { goals, provider, ctx };
}

const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

describe("the goal tools an agent can see", () => {
  it("appear only while a goal is actually being pursued", async () => {
    /* THE always-on mutant: offer `update_goal` to every session. A tool for ending an objective,
       present on a session that has none, is an invitation to invent one to close — and it is a
       permanent line of the toolset every agent reads on every turn for nothing. */
    const { goals, provider, ctx } = bring();
    expect(await provider.tools(ctx)).toEqual([]);
    await goals.start("s1", "ship the release notes", null);
    expect((await provider.tools(ctx)).map((t) => t.name)).toEqual([UPDATE_GOAL_TOOL_NAME, GOAL_STATUS_TOOL_NAME]);
    goals.set("s1", "complete", "done");
    expect(await provider.tools(ctx)).toEqual([]);
  });

  it("are gone entirely when the space turned the provider off", async () => {
    const { goals, provider, ctx } = bring(false);
    await goals.start("s1", "ship it", null);
    expect(await provider.tools(ctx)).toEqual([]);
    const r = await provider.call(ctx, UPDATE_GOAL_TOOL_NAME, { status: "complete", note: "x" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(GOAL_PROVIDER_NAME);
    expect(goals.get("s1")!.status).toBe("active");
  });
});

describe("update_goal", () => {
  it("ends the goal, and says how many turns it took", async () => {
    const { goals, provider, ctx } = bring();
    await goals.start("s1", "ship it", null);
    await goals.onSettled("s1", { interrupted: false });
    const r = await provider.call(ctx, UPDATE_GOAL_TOOL_NAME, { status: "complete", note: "Released 1.2.0." });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain("1 turn");
    expect(goals.get("s1")).toMatchObject({ status: "complete", note: "Released 1.2.0." });
  });

  it("cannot start a goal, change the objective, or set any status but the two conclusions", async () => {
    /* The narrowness IS the feature. An agent that could rewrite its own objective can declare
       victory by lowering the bar, and one that could set `active` could restart a goal the user
       paused. The schema refuses both, and this is the test that notices if it stops. */
    const { goals, provider, ctx } = bring();
    await goals.start("s1", "ship the release notes", null);
    for (const args of [
      { status: "active", note: "carrying on" },
      { status: "paused", note: "having a rest" },
      { status: "complete", objective: "something easier", note: "done" },
      { status: "complete" },
      { status: "complete", note: "" },
    ]) {
      const r = await provider.call(ctx, UPDATE_GOAL_TOOL_NAME, args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(goals.get("s1")).toMatchObject({ status: "active", objective: "ship the release notes" });
  });

  it("refuses on a session with no goal rather than answering emptily", async () => {
    // A model told "there is no goal" by a SUCCESSFUL call has just learned its objective evaporated.
    const { provider, ctx } = bring();
    const r = await provider.call(ctx, UPDATE_GOAL_TOOL_NAME, { status: "complete", note: "done" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not pursuing a goal");
  });
});

describe("goal_status", () => {
  it("reports the objective, the turns and what is left of the budget", async () => {
    const { goals, provider, ctx } = bring();
    await goals.start("s1", "ship the release notes", 10_000);
    goals.onUsage("s1", { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 1 });
    goals.onUsage("s1", { costUsd: 0, inputTokens: 2_500, outputTokens: 0, numTurns: 2 });
    const r = await provider.call(ctx, GOAL_STATUS_TOOL_NAME, {});
    expect(text(r)).toContain("ship the release notes");
    expect(text(r)).toContain("7,500 of 10,000 tokens left");
  });

  it("says so when there is no ceiling, rather than printing a number that is not one", async () => {
    const { goals, provider, ctx } = bring();
    await goals.start("s1", "ship it", null);
    expect(text(await provider.call(ctx, GOAL_STATUS_TOOL_NAME, {}))).toContain("no token budget");
  });
});
