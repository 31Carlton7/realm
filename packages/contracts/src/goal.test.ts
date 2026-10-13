import { describe, expect, it } from "vitest";
import { goalContinuationPrompt, goalToolWireName, goalTurnLine, parseGoalSentinel } from "./goal";

const goal = { objective: "ship the release notes", turns: 2, tokensUsed: 0, tokenBudget: null };

describe("goalContinuationPrompt", () => {
  it("names update_goal the way this agent will find it", () => {
    // THE MUTANT: hand the prompt the bare `update_goal`. Claude lists it as
    // `mcp__realm__realm-goal__update_goal` behind ToolSearch, searches for the bare name, finds
    // nothing, and the goal keeps continuing past done.
    expect(goalContinuationPrompt(goal, goalToolWireName("claude"))).toContain("`mcp__realm__realm-goal__update_goal`");
    expect(goalContinuationPrompt(goal, goalToolWireName("codex"))).toContain("`realm-goal__update_goal`");
  });

  it("tells a session with no goal tool the line that ends the goal instead", () => {
    const text = goalContinuationPrompt(goal, null);
    expect(text).toContain("GOAL COMPLETE:");
    expect(text).toContain("GOAL BLOCKED:");
    expect(text).not.toContain("update_goal`");
    // …and a session WITH the tool is not told both ways.
    expect(goalContinuationPrompt(goal, "realm-goal__update_goal")).not.toContain("GOAL COMPLETE:");
  });

  it("says which turn this is with the line the scripted adapter keys on", () => {
    expect(goalContinuationPrompt(goal, null)).toContain(goalTurnLine(3));
  });
});

describe("parseGoalSentinel", () => {
  it("reads a line that starts with the marker", () => {
    expect(parseGoalSentinel("Wrote the notes.\nGOAL COMPLETE: Released 1.2.0.\n")).toEqual({ status: "complete", note: "Released 1.2.0." });
    expect(parseGoalSentinel("GOAL BLOCKED: the registry is down")).toEqual({ status: "blocked", note: "the registry is down" });
  });

  it("ignores the marker mid-sentence, and one with no note", () => {
    // A reply that talks ABOUT the convention must not end the goal it is talking about.
    expect(parseGoalSentinel("When done I will write GOAL COMPLETE: and stop.")).toBeNull();
    expect(parseGoalSentinel("GOAL COMPLETE:   ")).toBeNull();
    expect(parseGoalSentinel("goal complete: lower case")).toBeNull();
  });
});
