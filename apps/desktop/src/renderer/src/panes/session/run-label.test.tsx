import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EGG_RUN_LABELS, PLAN_RUN_LABEL, RUN_LABEL, runLabelFor } from "./run-label";
import { stampLabel } from "./timestamps";
import { Transcript } from "./Transcript";
import type { Block, Transcript as TranscriptModel } from "./transcript-model";

afterEach(cleanup);

describe("the word a run wears", () => {
  it("is one plain verb for every run with the switch off: Working, then Worked", () => {
    // The house pool read "Noodled for 13s", "Simmered for <1s" and "Made magic happen" under turns
    // that did ordinary work. THE mutant is any second entry coming back.
    for (let i = 0; i < 2_000; i++) expect(runLabelFor(1_756_900_000_000 + i * 37)).toBe(RUN_LABEL);
    expect(RUN_LABEL).toEqual({ present: "Working", past: "Worked" });
  });

  it("pairs a present tense with the past tense of the SAME phrase", () => {
    // The settled line is only legible as the resolution of the shimmer the reader was watching.
    for (const l of [RUN_LABEL, PLAN_RUN_LABEL]) {
      expect(l.present).not.toBe(l.past);
      expect(l.present.split(" ").slice(1)).toEqual(l.past.split(" ").slice(1));
    }
  });
});

describe("what an unlocked friend pack takes over", () => {
  const PACK = [
    { present: "Asking Alice", past: "Asked Alice" },
    { present: "Blaming Bob", past: "Blamed Bob" },
  ];

  it("takes the vocabulary over, so the house verbs stop showing up entirely", () => {
    /* THE mutant is the arrangement this replaced: the pack's lines joining the pool on a one-in-four
       roll, which spent three runs in four saying "Percolating" to a group that unlocked a pack to
       stop reading that. A single house verb in two thousand runs fails this. */
    for (let i = 0; i < 2_000; i++) {
      const label = runLabelFor(1_756_900_000_000 + i, undefined, true, PACK);
      expect(PACK, `seed +${i}`).toContain(label);
    }
  });

  it("uses every line in the pack rather than whichever one the roll favours", () => {
    const seen = new Set(Array.from({ length: 500 }, (_, i) => runLabelFor(1_756_900_000_000 + i, undefined, true, PACK).present));
    expect(seen).toEqual(new Set(PACK.map((l) => l.present)));
  });

  it("holds one line for the whole of a run, the way the house list does", () => {
    // Same reason as the house verbs: the shimmer re-renders on every delta and the settled line is
    // recomputed from the event log, so a name that re-rolled would resolve into a different friend.
    const seed = 1_756_900_000_123;
    const first = runLabelFor(seed, undefined, true, PACK);
    for (let i = 0; i < 50; i++) expect(runLabelFor(seed, undefined, true, PACK)).toEqual(first);
  });

  it("adds nothing at all with the eggs off", () => {
    // The switch is still the consent boundary. An unlocked pack is not a second way to turn the
    // feature on.
    for (let i = 0; i < 400; i++) {
      const label = runLabelFor(1_756_900_000_000 + i * 7, undefined, false, PACK);
      expect(PACK).not.toContain(label);
      expect(label).toBe(RUN_LABEL);
    }
  });

  it("hands the verbs back, unchanged, to a group that forgets the pack", () => {
    // Forgetting a pack is a thing Settings offers, so the state it returns to has to be the state
    // the switch alone gives — not a third arrangement that only exists after an unlock.
    for (let i = 0; i < 500; i++) {
      const seed = 1_756_900_000_000 + i * 37;
      expect(runLabelFor(seed, undefined, true, [])).toBe(runLabelFor(seed, undefined, true));
    }
  });

  it("does not put a name on a plan either, pack or no pack", () => {
    expect(runLabelFor(NAMED_SEED, "plan", true, PACK)).toBe(PLAN_RUN_LABEL);
  });

  it("ships no names of its own, which is what the packs are for", () => {
    /* Realm is open source; somebody's friends' nicknames are not Realm's to publish. THE mutant is
       a name typed back into this list "just as a default" — which would put it in the repository,
       in the app, and in every screenshot anyone takes. */
    for (const l of [...EGG_RUN_LABELS, RUN_LABEL]) {
      // The leading verb is capitalised on every label; a NAME shows up after it, which is where
      // "Summoning Mustafa" put one before the packs existed.
      const tail = l.present.split(" ").slice(1);
      expect(tail.filter((w) => /^[A-Z][a-z]{2,}$/.test(w)), l.present).toEqual([]);
    }
  });
});

describe("what a settled line may claim", () => {
  it("never says someone else took part in the turn", () => {
    /* The settled line is read as a record of the turn. THE mutant is "Got a second opinion", which
       read as a second model having reviewed the work, beside a run that consulted nobody. */
    const party = /\b(second opinion|review|consult|ask(ed|ing)? (a|an|the|someone)|group chat|team|colleague|friend|expert|human)/i;
    for (const l of [RUN_LABEL, ...EGG_RUN_LABELS, PLAN_RUN_LABEL]) {
      expect(l.present, l.present).not.toMatch(party);
      expect(l.past, l.past).not.toMatch(party);
    }
  });
});

/** A start time the second roll lands a friend's name on. */
const NAMED_SEED = 1_756_900_000_000;

describe("the friends the switch lets in", () => {

  it("leaves the verb of every run it does NOT rename exactly where it was", () => {
    // THE longer-pool mutant: append the friends to the house verb's pool instead of rolling apart.
    // Every seed lands on a different entry the moment the pool grows — and the settled line is
    // recomputed from the event log rather than stored, so the whole transcript would take new
    // verbs as the switch moved, retelling turns that happened weeks ago.
    for (let i = 0; i < 500; i++) {
      const seed = 1_756_900_000_000 + i * 37;
      const on = runLabelFor(seed, undefined, true);
      if (EGG_RUN_LABELS.includes(on)) continue;
      expect(on).toBe(runLabelFor(seed));
    }
  });

  it("names someone about one run in four, which is what keeps it a surprise", () => {
    const runs = Array.from({ length: 2_000 }, (_, i) => runLabelFor(1_756_900_000_000 + i * 1_000, undefined, true));
    const named = runs.filter((l) => EGG_RUN_LABELS.includes(l)).length;
    expect(named / runs.length).toBeGreaterThan(0.15);
    expect(named / runs.length).toBeLessThan(0.35);
  });

  it("uses all five names rather than whichever one the roll happens to favour", () => {
    const seen = new Set(Array.from({ length: 2_000 }, (_, i) => runLabelFor(1_756_900_000_000 + i, undefined, true))
      .filter((l) => EGG_RUN_LABELS.includes(l)));
    expect(seen.size).toBe(EGG_RUN_LABELS.length);
  });

  it("pairs its tenses the way the house list does", () => {
    for (const l of EGG_RUN_LABELS) {
      expect(l.present).not.toBe(l.past);
      expect(l.present.split(" ").slice(1)).toEqual(l.past.split(" ").slice(1));
    }
  });

});

const model = (blocks: Block[], run: TranscriptModel["run"] = null): TranscriptModel =>
  ({ blocks, run, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, feedback: {}, summary: null, promptHint: null });

describe("what the transcript says about the run", () => {

  it("settles into the same verb, past tense, with how long it took", () => {
    const startedAt = 1_756_900_000_123;
    render(<Transcript transcript={model([{ kind: "run", ms: 125_000, startedAt, ts: startedAt + 125_000 }])} sessionStatus="idle" onDecide={() => {}} />);
    // The pairing is the assertion: a settled line naming a different verb than the one that was on
    // screen a second ago reads as a message from somewhere else entirely.
    expect(screen.getByText(`${runLabelFor(startedAt).past} for 2m 5s`)).toBeTruthy();
    expect(document.querySelector(".msg-working")).toBeNull();
  });

  it("carries the switch to the line a run settles into, not only to the shimmer", () => {
    // THE dropped-argument mutant: pass the flag where the shimmer is and leave the settled call
    // reading the default. "Scheming…" would resolve into some other verb entirely a second later,
    // which reads as a line about a different run.
    const named = runLabelFor(NAMED_SEED, undefined, true);
    expect(EGG_RUN_LABELS).toContain(named);
    const { rerender } = render(<Transcript eggs sessionStatus="running" onDecide={() => {}}
      transcript={model([], { startedAt: NAMED_SEED, waitedMs: 0, waitingSince: null })} />);
    expect(document.querySelector(".msg-working")!.textContent).toBe(`${named.present}…`);
    rerender(<Transcript eggs sessionStatus="idle" onDecide={() => {}}
      transcript={model([{ kind: "run", ms: 4_000, startedAt: NAMED_SEED, ts: NAMED_SEED + 4_000 }])} />);
    expect(screen.getByText(`${named.past} for 4s`)).toBeTruthy();
  });

  it("says what it always said with the switch off", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}}
      transcript={model([{ kind: "run", ms: 4_000, startedAt: NAMED_SEED, ts: NAMED_SEED + 4_000 }])} />);
    expect(screen.getByText("Worked for 4s")).toBeTruthy();
  });

  it("a thinking block says Thinking… only while it is the live end of a running turn, and Thought after", () => {
    const a = 1_756_900_000_000, b = 1_756_900_500_000;
    const think = (ts: number) => ({ kind: "thinking" as const, messageId: `t${ts}`, text: "hmm", ts });
    // An interrupted turn's open thinking block, between two finished runs. THE mutant: the fixed
    // "Thinking…", an ellipsis promising more from a turn that stopped long ago.
    const { rerender } = render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([
      { kind: "run", ms: 4_000, startedAt: a, ts: a + 4_000 }, think(a + 5_000),
      { kind: "run", ms: 9_000, startedAt: b, ts: b + 9_000 },
    ])} />);
    expect([...document.querySelectorAll(".thinking-toggle")].map((el) => el.textContent)).toEqual(["Thought"]);
    // While the turn runs and the block is its last word, it is still being written.
    rerender(<Transcript sessionStatus="running" onDecide={() => {}}
      transcript={model([think(b)], { startedAt: b, waitedMs: 0, waitingSince: null })} />);
    expect([...document.querySelectorAll(".thinking-toggle")].map((el) => el.textContent)).toEqual(["Thinking…"]);
  });

  it("settles every finished turn on the one allowed verb, however many there are", () => {
    // The mechanical check behind the rule: a transcript of many turns, switch off, and no line under
    // any of them may open with a verb other than Worked.
    const runs: Block[] = Array.from({ length: 40 }, (_, i) => {
      const at = 1_756_900_000_000 + i * 61_237;
      return { kind: "run" as const, ms: 1_000 + i * 997, startedAt: at, ts: at + 1_000 + i * 997 };
    });
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model(runs)} />);
    const lines = [...document.querySelectorAll(".msg-run > span:first-child")].map((el) => el.textContent ?? "");
    expect(lines).toHaveLength(40);
    for (const line of lines) expect(line).toMatch(/^Worked for /);
  });

  it("keeps every run's line, so a scrolled-back turn still says what it cost", () => {
    const a = 1_756_900_000_000, b = 1_756_900_500_000;
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([
      { kind: "run", ms: 4_000, startedAt: a, ts: a + 4_000 },
      { kind: "run", ms: 9_000, startedAt: b, ts: b + 9_000 },
    ])} />);
    // The duration only — the finish time rides a span of its own beside it, which `textContent`
    // would otherwise fold into this string.
    expect([...document.querySelectorAll(".msg-run > span:first-child")].map((el) => el.textContent))
      .toEqual([`${runLabelFor(a).past} for 4s`, `${runLabelFor(b).past} for 9s`]);
    // And each line says WHEN it ended: a duration alone reads the same whether the run finished a
    // minute ago or last Tuesday.
    expect([...document.querySelectorAll(".msg-run-at")].map((el) => el.textContent))
      .toEqual([stampLabel(a + 4_000, Date.now()), stampLabel(b + 9_000, Date.now())]);
  });
});
