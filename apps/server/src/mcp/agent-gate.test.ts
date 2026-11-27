import { describe, expect, it, vi } from "vitest";
import { askCard, refuseUnlessPersonTurn, requirePersonTurnAndCard } from "./agent-gate";

const words = { rule: "Teammates are made", where: "your chat", nothing: "Nothing was made." };

function deps(personTurn: boolean, allowed = true) {
  const gate = vi.fn(async () => (allowed ? { allowed: true as const } : { allowed: false as const, reason: "the user denied this action" }));
  return { sessions: { personStartedTurn: () => personTurn }, turnOrigin: () => "a schedule (\"Nightly\")", broker: { gate }, gate };
}

const text = (r: { content: unknown[] } | null) => (r?.content[0] as { text: string } | undefined)?.text;

describe("refuseUnlessPersonTurn", () => {
  it("lets a turn the person started through", () => {
    expect(refuseUnlessPersonTurn(deps(true), "s1", words)).toBeNull();
  });

  it("refuses any other turn, naming who started it and where the person should say it", () => {
    const r = refuseUnlessPersonTurn(deps(false), "s1", words);
    expect(r?.isError).toBe(true);
    expect(text(r)).toBe("refused: this turn was started by a schedule (\"Nightly\"), not by the person. Teammates are made only in a turn the person started; ask them to say it in your chat. Nothing was made.");
  });
});

describe("askCard", () => {
  it("shows a card Full access may skip, unless it is one that always shows", async () => {
    const d = deps(true);
    await askCard(d.broker, "s1", { toolKey: "teammate_create", title: "Add @scout", input: { name: "Scout" } });
    expect(d.gate).toHaveBeenLastCalledWith("s1", "teammate_create", "Add @scout", { name: "Scout" }, "teammate_create", {});
    await askCard(d.broker, "s1", { toolKey: "teammate_update", title: "Opus 5.5 → Sonnet 5.5", input: {}, always: true });
    expect(d.gate).toHaveBeenLastCalledWith("s1", "teammate_update", "Opus 5.5 → Sonnet 5.5", {}, "teammate_update", { alwaysPrompt: true });
  });

  it("returns the broker's reason when the card is declined", async () => {
    const r = await askCard(deps(true, false).broker, "s1", { toolKey: "k", title: "t", input: {} });
    expect(text(r)).toBe("the user denied this action");
  });
});

describe("requirePersonTurnAndCard", () => {
  it("never puts a card in front of the person in a turn they did not start", async () => {
    const d = deps(false);
    const r = await requirePersonTurnAndCard(d, "s1", words, { toolKey: "k", title: "t", input: {} });
    expect(text(r)).toMatch(/^refused: this turn was started by/);
    expect(d.gate).not.toHaveBeenCalled();
  });

  it("asks the card in the person's turn, and passes when they allow it", async () => {
    const d = deps(true);
    expect(await requirePersonTurnAndCard(d, "s1", words, { toolKey: "k", title: "t", input: {} })).toBeNull();
    expect(d.gate).toHaveBeenCalledOnce();
  });
});
