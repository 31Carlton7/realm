import { describe, expect, it, vi } from "vitest";
import type { LayaAssistGate, LayaMode } from "@realm/contracts";
import type { ObservedElement } from "../mcp/act-observer";
import { createLayaAssist, harnessEvalOverride } from "./assist";
import type { LayaClient } from "./client";

/**
 * Assist's picker against a stubbed Laya client. What must die: a pick used below the fitted
 * threshold, a sensitive step Laya chose, a pick while the mode is not Assist or the gate is shut, a
 * busy server treated as "no answer" at once, and a wait that outlives its budget.
 */

const el = (id: string, label: string, role = "Button"): ObservedElement => ({ id, role, label });
const SCREEN = [el("0.0", "Apple Account"), el("0.1", "General"), el("0.2", "Bluetooth"), el("0.3", "Buy $4.99")];
const OPEN: LayaAssistGate = { available: true, reason: null, threshold: 0.8, accuracy: 0.97 };

function assist(o: { mode?: LayaMode; gate?: LayaAssistGate; ask?: LayaClient["ask"]; noClient?: boolean; budgetMs?: number } = {}) {
  const ask = vi.fn(o.ask ?? (async () => ({ answers: { target: { type: "choice", choice: "General", confidence: 0.93, probabilities: {} } }, ms: 14 })));
  const a = createLayaAssist({
    laya: {
      currentMode: () => o.mode ?? "assist",
      client: () => (o.noClient ? null : ({ ask } as unknown as LayaClient)),
      assistGate: () => o.gate ?? OPEN,
    },
    budgetMs: o.budgetMs ?? 1_500,
  });
  return { a, ask };
}

const choice = (label: string, confidence: number) =>
  async () => ({ answers: { target: { type: "choice" as const, choice: label, confidence, probabilities: {}, answer_confidence: confidence } }, ms: 11 }) as never;

describe("Assist's gate", () => {
  it("is shut unless the mode is Assist, whatever the evaluation says", () => {
    expect(assist({ mode: "shadow" }).a.gate()).toMatchObject({ available: false, reason: "Laya is not in Assist mode." });
  });

  it("passes the service's reason through when the evaluation has not earned it", () => {
    const gate = { available: false, reason: "The active checkpoint picks the right element 79% of the time on held-out steps. Assist needs 95%.", threshold: null, accuracy: 0.79 };
    expect(assist({ gate }).a.gate()).toEqual(gate);
  });

  it("is shut while Laya is not running, even with an evaluation that earned it", () => {
    expect(assist({ noClient: true }).a.gate()).toMatchObject({ available: false, reason: "Laya is not running right now." });
  });

  it("is open when all three hold", () => {
    expect(assist().a.gate()).toEqual(OPEN);
  });
});

describe("resolving a described target", () => {
  it("picks the element Laya chose when it clears the fitted threshold and is not sensitive", async () => {
    const { a, ask } = assist();
    const r = await a.resolve("the general settings", "open General", SCREEN, "simulator_tap");
    expect(r).toMatchObject({ kind: "pick", element: { id: "0.1", label: "General" }, confidence: 0.93 });
    // Asked in the shadow's own words — the wording the evaluation fitted the threshold on.
    expect(ask.mock.calls[0]![0]).toBe("Goal: the general settings.");
    expect(ask.mock.calls[0]![1]).toMatchObject({ target: { type: "choice", instructions: "Which on-screen element should be tapped to: the general settings?" } });
  });

  it("hands the choice back, with its best guess, when Laya is below the threshold", async () => {
    // THE MUTANT: compare against the accuracy, or not at all. A 0.79 pick then taps at 79% odds.
    const { a } = assist({ ask: choice("Bluetooth", 0.79) });
    const r = await a.resolve("pair my AirPods", "pair AirPods", SCREEN, "simulator_tap");
    expect(r).toMatchObject({ kind: "ask-agent", why: "unsure", best: { element: { id: "0.2" }, confidence: 0.79 } });
    expect(r.kind === "ask-agent" && r.candidates.map((c) => c.id)).toContain("0.2");
  });

  it("never picks a sensitive step, however sure Laya is", async () => {
    const { a } = assist({ ask: choice("Buy $4.99", 0.99) });
    const r = await a.resolve("the upgrade", "get the upgrade", SCREEN, "simulator_tap");
    expect(r).toMatchObject({ kind: "ask-agent", why: "sensitive", matched: "buy", best: { element: { id: "0.3" } } });
  });

  it("reads the intent as well as the words for the sensitive rule", async () => {
    const { a } = assist({ ask: choice("General", 0.99) });
    // Laya's pick is innocent; the step the agent says it is taking is not.
    expect(await a.resolve("the general row", "delete the account", SCREEN, "simulator_tap")).toMatchObject({ kind: "ask-agent", why: "sensitive", matched: "delete" });
  });

  it("never picks a like in an app other people see it in, and picks the same kind of tap anywhere else", async () => {
    const feed = [el("0.0", "Home"), el("0.1", "Like"), el("0.2", "Reels")];
    // THE MUTANT: judge the pick without its app. Assist likes a stranger's post on the user's account.
    expect(await assist({ ask: choice("Like", 0.99) }).a.resolve("the heart", "show that I enjoyed it", feed, "simulator_tap", "Instagram"))
      .toMatchObject({ kind: "ask-agent", why: "sensitive", matched: "like" });
    expect(await assist({ ask: choice("Like", 0.99) }).a.resolve("the heart", "show that I enjoyed it", feed, "simulator_tap", "Photos"))
      .toMatchObject({ kind: "pick", element: { label: "Like" } });
  });

  it("waits out a busy server within its budget, and uses the answer that comes", async () => {
    const ask = vi.fn()
      .mockRejectedValueOnce(new Error("laya-serve answered 503: busy"))
      .mockRejectedValueOnce(new Error("laya-serve answered 503: busy"))
      .mockImplementationOnce(choice("General", 0.95));
    const { a } = assist({ ask });
    expect(await a.resolve("general", "open General", SCREEN, "simulator_tap")).toMatchObject({ kind: "pick", element: { id: "0.1" } });
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("gives up on any other failure at once, and on a busy server when its budget is spent", async () => {
    const broken = vi.fn().mockRejectedValue(new Error("laya-serve answered 500: boom"));
    expect(await assist({ ask: broken }).a.resolve("general", "open General", SCREEN, "simulator_tap")).toMatchObject({ kind: "ask-agent", why: "no-answer" });
    expect(broken).toHaveBeenCalledTimes(1);

    const busy = vi.fn().mockRejectedValue(new Error("laya-serve answered 503: busy"));
    const started = Date.now();
    expect(await assist({ ask: busy, budgetMs: 250 }).a.resolve("general", "open General", SCREEN, "simulator_tap")).toMatchObject({ kind: "ask-agent", why: "no-answer" });
    // THE MUTANT: retry forever. A step then hangs on a server that is busy for good.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(busy.mock.calls.length).toBeGreaterThan(1);
  });

  it("asks nothing when nothing on the screen can be named, and says so", async () => {
    const { a, ask } = assist();
    expect(await a.resolve("general", "open General", [el("0.9", "", "Other")], "simulator_tap")).toMatchObject({ kind: "ask-agent", why: "no-candidates" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks nothing while the gate is shut, and hands the candidates back", async () => {
    const { a, ask } = assist({ mode: "shadow" });
    expect(await a.resolve("general", "open General", SCREEN, "simulator_tap")).toMatchObject({ kind: "ask-agent", why: "no-answer" });
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("the harness-only evaluation override", () => {
  it("is honored only in a harness — a user's Realm cannot open Assist with an environment variable", () => {
    expect(harnessEvalOverride({ REALM_LAYA_EVAL_OVERRIDE: "/tmp/x.json" })).toBeUndefined();
    expect(harnessEvalOverride({ REALM_ENABLE_FAKE_AGENT: "1" })).toBeUndefined();
    expect(typeof harnessEvalOverride({ REALM_ENABLE_FAKE_AGENT: "1", REALM_LAYA_EVAL_OVERRIDE: "/tmp/x.json" })).toBe("function");
  });

  it("reads nothing it cannot parse as a report", () => {
    const read = harnessEvalOverride({ REALM_ENABLE_FAKE_AGENT: "1", REALM_LAYA_EVAL_OVERRIDE: "/nonexistent/eval.json" })!;
    expect(read()).toBeNull();
  });
});
