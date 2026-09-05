import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_LABELS, runLabelFor } from "./run-label";
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

const model = (blocks: Block[], run: TranscriptModel["run"] = null): TranscriptModel =>
  ({ blocks, run, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, feedback: {} });

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

  it("keeps every run's line, so a scrolled-back turn still says what it cost", () => {
    const a = 1_756_900_000_000, b = 1_756_900_500_000;
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([
      { kind: "run", ms: 4_000, startedAt: a, ts: a + 4_000 },
      { kind: "run", ms: 9_000, startedAt: b, ts: b + 9_000 },
    ])} />);
    expect([...document.querySelectorAll(".msg-run")].map((el) => el.textContent))
      .toEqual([`${runLabelFor(a).past} for 4s`, `${runLabelFor(b).past} for 9s`]);
  });
});
