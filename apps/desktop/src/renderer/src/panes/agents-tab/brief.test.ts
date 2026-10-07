import { describe, expect, it } from "vitest";
import { canSend, delegationBrief, type BriefPick } from "./brief";

/**
 * The instruction the Agents tab sends. Whatever model the session runs has to read it and end up
 * calling `agent_start` with the right `constraints.model` — so these pin that every shape of it
 * names the tool, the field, and each model by the name the server resolves.
 */

const luna: BriefPick = { label: "GPT-6 Luna", own: false, task: "" };
const fable: BriefPick = { label: "Claude Fable 5.1", own: false, task: "" };
const own: BriefPick = { label: "Claude Opus 5.5", own: true, task: "" };
const WORK = "Add a dark-mode toggle to Settings ▸ App, with tests.";

describe("delegationBrief", () => {
  it("one model: names the tool, the field and the model, then the work", () => {
    const text = delegationBrief({ work: WORK, picks: [luna], split: false });
    expect(text).toBe(`Build this with a sub-agent on GPT-6 Luna: start it with agent_start (constraints.model "GPT-6 Luna") and tell me what it did when it reports back.\n\nThe work:\n\n${WORK}`);
  });

  it("the session's own model is the one asked for by leaving the name out", () => {
    // Mutant: write the own model's label into constraints.model like any other — then a lead on
    // the harness default would be told to resolve a label like "Fable 5.1", which is not a model id.
    const text = delegationBrief({ work: WORK, picks: [own], split: false });
    expect(text).toContain("your own model (Claude Opus 5.5)");
    expect(text).toContain("leave constraints.model out");
    expect(text).not.toContain('constraints.model "Claude Opus 5.5"');
  });

  it("several models, unsplit: the agent splits the work, one sub-agent per model, all started before any wait", () => {
    const text = delegationBrief({ work: WORK, picks: [luna, fable], split: false });
    expect(text).toContain("Build this with sub-agents on GPT-6 Luna and Claude Fable 5.1.");
    expect(text).toContain("one for each model");
    expect(text).toContain("agent_start, setting constraints.model to that model's name");
    expect(text).toContain("Start every one before you wait on any, collect their reports with agent_wait");
    expect(text).toContain("constraints.newWorktree");
    expect(text.endsWith(`The work:\n\n${WORK}`)).toBe(true);
  });

  it("several models with the own model among them says how to start that one", () => {
    const text = delegationBrief({ work: WORK, picks: [luna, own], split: false });
    expect(text).toContain("on GPT-6 Luna and your own model (Claude Opus 5.5)");
    expect(text).toContain("For your own model (Claude Opus 5.5), leave constraints.model out.");
  });

  it("split by model: one line per model with its own part, in the order they were picked", () => {
    const text = delegationBrief({ work: WORK, split: true, picks: [
      { ...luna, task: "Write the toggle and its tests" }, { ...own, task: "Review it when Luna is done" }] });
    expect(text).toContain("one per task below");
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toEqual([
      "- GPT-6 Luna: Write the toggle and its tests",
      "- Your own model (Claude Opus 5.5), with constraints.model left out: Review it when Luna is done",
    ]);
  });

  it("a split model with no part of its own is still given one", () => {
    const text = delegationBrief({ work: WORK, split: true, picks: [{ ...luna, task: "Tests" }, fable] });
    expect(text).toContain("- Claude Fable 5.1: a part of the work below that you choose");
  });

  it("a plan handed over is called the plan, so the agent builds it rather than drafting another", () => {
    expect(delegationBrief({ work: "1. Do X", picks: [luna], split: false, fromPlan: true })).toContain("The plan:\n\n1. Do X");
  });
});

describe("canSend", () => {
  it("needs a model", () => {
    expect(canSend(WORK, [], false)).toBe(false);
  });

  it("needs something to build: the shared text, or a part for every model when split", () => {
    expect(canSend("   ", [luna], false)).toBe(false);
    expect(canSend(WORK, [luna], false)).toBe(true);
    expect(canSend("", [{ ...luna, task: "a" }, { ...fable, task: "b" }], true)).toBe(true);
    // Mutant: accept any one task — the model without one would be started on nothing.
    expect(canSend("", [{ ...luna, task: "a" }, fable], true)).toBe(false);
  });
});
