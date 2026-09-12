import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EGG_RUN_LABELS, PLAN_RUN_LABEL, RUN_LABELS, runLabelFor } from "./run-label";
import { finishedAt } from "./tool-group";
import { Transcript } from "./Transcript";
import type { Block, Transcript as TranscriptModel } from "./transcript-model";

afterEach(cleanup);

describe("the word a run wears", () => {
  it("is the same word every time it is asked for the same run", () => {
    // The whole point of seeding on the start time: the live label re-renders on every streaming
    // delta, and the settled line is rebuilt from the event log on every reload. A Math.random()
    // here would pass a snapshot test and still show the reader three different verbs per run.
    const seed = 1_756_900_000_123;
    const first = runLabelFor(seed);
    for (let i = 0; i < 50; i++) expect(runLabelFor(seed)).toEqual(first);
  });

  it("spreads across the list for starts a few milliseconds apart", () => {
    // Runs start whenever the user hits send, so consecutive seeds differ only in their low bits.
    // `seed % length` would walk the list in lockstep and every prompt of a session would step to
    // the next verb in order — recognisably a counter, not a surprise.
    const words = new Set(Array.from({ length: 40 }, (_, i) => runLabelFor(1_756_900_000_000 + i).present));
    expect(words.size).toBeGreaterThan(8);
  });

  it("does not walk the list in a fixed stride as prompts go by", () => {
    // The bar `seed % RUN_LABELS.length` clears the test above and still fails the user: prompts a
    // constant interval apart step a constant distance down the list, so a session's verbs arrive in
    // a visible marching order. Hashing first is what makes the sequence read as a shuffle.
    const at = (i: number) => RUN_LABELS.indexOf(runLabelFor(1_756_900_000_000 + i * 1_000));
    const deltas = Array.from({ length: 30 }, (_, i) => (at(i + 1) - at(i) + RUN_LABELS.length) % RUN_LABELS.length);
    expect(new Set(deltas).size).toBeGreaterThan(1);
  });

  it("pairs a present tense with the past tense of the SAME phrase", () => {
    // "Cooking…" must settle into "Cooked for 2m", not into some unrelated verb: the line is only
    // legible as the resolution of the shimmer the reader was already watching.
    expect(RUN_LABELS.length).toBeGreaterThan(0);
    for (const l of RUN_LABELS) {
      expect(l.present).not.toBe(l.past);
      // Multi-word labels ("Making things shake" → "Made things shake") keep their tail intact.
      expect(l.present.split(" ").slice(1)).toEqual(l.past.split(" ").slice(1));
    }
  });
});

describe("what an unlocked friend pack adds", () => {
  const PACK = [
    { present: "Asking Alice", past: "Asked Alice" },
    { present: "Blaming Bob", past: "Blamed Bob" },
  ];

  it("joins the house pool rather than replacing it", () => {
    // A group that unlocked a pack should still see the shipped jokes: a pool that swapped wholesale
    // would make "did it work?" a question you answer by counting.
    const seen = new Set(Array.from({ length: 3_000 }, (_, i) => runLabelFor(1_756_900_000_000 + i, undefined, true, PACK).present));
    for (const l of EGG_RUN_LABELS) expect(seen, l.present).toContain(l.present);
    for (const l of PACK) expect(seen, l.present).toContain(l.present);
  });

  it("adds nothing at all with the eggs off", () => {
    // The switch is still the consent boundary. An unlocked pack is not a second way to turn the
    // feature on.
    for (let i = 0; i < 400; i++) {
      const label = runLabelFor(1_756_900_000_000 + i * 7, undefined, false, PACK);
      expect(PACK).not.toContain(label);
      expect(RUN_LABELS).toContain(label);
    }
  });

  it("leaves the verb of a run it does not rename exactly where it was", () => {
    // The same guarantee the eggs themselves carry, now with a pack in the pool: unlocking one must
    // not retell every past turn in the transcript, which is recomputed rather than stored.
    for (let i = 0; i < 500; i++) {
      const seed = 1_756_900_000_000 + i * 37;
      const withPack = runLabelFor(seed, undefined, true, PACK);
      if (EGG_RUN_LABELS.includes(withPack) || PACK.includes(withPack)) continue;
      expect(withPack).toBe(runLabelFor(seed));
    }
  });

  it("ships no names of its own, which is what the packs are for", () => {
    /* Realm is open source; somebody's friends' nicknames are not Realm's to publish. THE mutant is
       a name typed back into this list "just as a default" — which would put it in the repository,
       in the app, and in every screenshot anyone takes. */
    for (const l of [...EGG_RUN_LABELS, ...RUN_LABELS]) {
      // The leading verb is capitalised on every label; a NAME shows up after it, which is where
      // "Summoning Mustafa" put one before the packs existed.
      const tail = l.present.split(" ").slice(1);
      expect(tail.filter((w) => /^[A-Z][a-z]{2,}$/.test(w)), l.present).toEqual([]);
    }
  });
});

/** A start time the second roll lands a friend's name on, and one it does not. */
const NAMED_SEED = 1_756_900_000_000;
const PLAIN_SEED = 1_756_900_000_001;

describe("the friends the switch lets in", () => {
  it("is the function it was before they existed while the switch is off", () => {
    for (let i = 0; i < 500; i++) {
      const seed = 1_756_900_000_000 + i * 37;
      expect(runLabelFor(seed, undefined, false)).toBe(runLabelFor(seed));
      expect(RUN_LABELS).toContain(runLabelFor(seed, undefined, false));
    }
  });

  it("leaves the verb of every run it does NOT rename exactly where it was", () => {
    // THE longer-pool mutant: append the friends to RUN_LABELS instead of rolling a second time.
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

  it("does not put a name on a plan, which is information rather than colour", () => {
    expect(runLabelFor(NAMED_SEED, "plan", true)).toBe(PLAN_RUN_LABEL);
  });
});

const model = (blocks: Block[], run: TranscriptModel["run"] = null): TranscriptModel =>
  ({ blocks, run, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, feedback: {}, summary: null, promptHint: null });

describe("what the transcript says about the run", () => {
  it("shimmers this run's verb while it works, not a generic `Working…`", () => {
    const startedAt = 1_756_900_000_123;
    render(<Transcript transcript={model([], { startedAt, waitedMs: 0, waitingSince: null })} sessionStatus="running" onDecide={() => {}} />);
    expect(document.querySelector(".msg-working")!.textContent).toBe(`${runLabelFor(startedAt).present}…`);
  });

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
    expect(screen.getByText(`${runLabelFor(NAMED_SEED).past} for 4s`)).toBeTruthy();
    expect(RUN_LABELS).toContain(runLabelFor(NAMED_SEED));
  });

  it("leaves a run the roll passed over alone, switch or no switch", () => {
    // The friends are one run in four. The other three are the app talking the way it always does.
    expect(EGG_RUN_LABELS).not.toContain(runLabelFor(PLAIN_SEED, undefined, true));
    render(<Transcript eggs sessionStatus="idle" onDecide={() => {}}
      transcript={model([{ kind: "run", ms: 4_000, startedAt: PLAIN_SEED, ts: PLAIN_SEED + 4_000 }])} />);
    expect(screen.getByText(`${runLabelFor(PLAIN_SEED).past} for 4s`)).toBeTruthy();
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
      .toEqual([finishedAt(a + 4_000), finishedAt(b + 9_000)]);
  });
});
