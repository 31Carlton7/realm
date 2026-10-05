import { describe, expect, it } from "vitest";
import { currentPrompt, opening, samePrompts, tickPositions, trackPrompts, TICK_PITCH, TRACK_SCALE } from "./scroll-track";
import { goalTurnLabel, type Block } from "./transcript-model";

const user = (text: string, ts: number, extra: Partial<Extract<Block, { kind: "user" }>> = {}): Block => ({ kind: "user", text, ts, ...extra });
const said = (text: string, ts: number): Block => ({ kind: "assistant", messageId: `m${ts}`, text, streaming: false, ts });
const run = (ts: number): Block => ({ kind: "run", ms: 1000, startedAt: ts - 1000, ts });

describe("the prompts on the track", () => {
  it("is one per prompt, in order, each with its first line, its time, and how the answer opened", () => {
    const prompts = trackPrompts([
      user("Fix the org access crash\nwith the stack trace below", 100),
      said("Fixed. The membership check ran before the org loaded.", 150),
      run(160),
      user("Now add a test", 200),
      said("Added `orgs.test.ts`.", 250),
      run(260),
    ], () => 0);
    expect(prompts.map((p) => [p.key, p.ts, p.title, p.reply])).toEqual([
      ["user:0", 100, "Fix the org access crash", "Fixed. The membership check ran before the org loaded."],
      ["user:3", 200, "Now add a test", "Added orgs.test.ts."],
    ]);
  });

  it("marks the turns that changed files, counted by the run line that closes each one", () => {
    const blocks = [user("a", 1), said("x", 2), run(3), user("b", 4), said("y", 5), run(6), user("c", 7)];
    // The transcript's Edited cards, by run line — here only the second turn has one.
    const prompts = trackPrompts(blocks, (i) => (i === 5 ? 2 : 0));
    expect(prompts.map((p) => p.edited)).toEqual([0, 2, 0]);
  });

  it("gives a message steered into a running turn the turn's edits, since its run line closes both", () => {
    const blocks = [user("start", 1), user("and also this", 2), said("done", 3), run(4)];
    expect(trackPrompts(blocks, (i) => (i === 3 ? 1 : 0)).map((p) => p.edited)).toEqual([0, 1]);
  });

  it("names what nobody typed as the bubble does, and a peer's question by who asked it", () => {
    const prompts = trackPrompts([
      user("…the goal's continuation prompt…", 1, { goal: "continuation" }),
      user("Which branch is the release on?", 2, { from: { sessionId: "s2", title: "Release notes" } }),
    ], () => 0);
    expect(prompts.map((p) => [p.title, p.from])).toEqual([[goalTurnLabel("continuation"), null], ["Which branch is the release on?", "Release notes"]]);
  });

  it("titles a message that carried only files with the files, and draws a picked element as its label", () => {
    const prompts = trackPrompts([
      user("", 1, { attachments: [{ path: "/tmp/shots/login.png", mime: "image/png" }, { path: "/tmp/spec.pdf", mime: "application/pdf" }] }),
      user("Make @[Sign in button] bigger", 2),
    ], () => 0);
    expect(prompts.map((p) => p.title)).toEqual(["login.png, spec.pdf", "Make Sign in button bigger"]);
  });

  it("says what a turn that failed before it answered died on, and nothing for one still waiting", () => {
    const prompts = trackPrompts([
      user("Run the migrations", 1), { kind: "error", message: "The agent's CLI exited before it answered.\nexit 1", ts: 2 }, run(3),
      user("Try again", 4),
    ], () => 0);
    expect(prompts.map((p) => p.reply)).toEqual(["The agent's CLI exited before it answered.", null]);
  });

  it("is the same list while it says the same thing, and a new one the moment a word of it changes", () => {
    const blocks = [user("a", 1), said("x", 2), user("b", 3)];
    const a = trackPrompts(blocks, () => 0);
    expect(samePrompts(a, trackPrompts(blocks, () => 0))).toBe(true);
    // A tool call landing in the last turn changes nothing the track draws.
    const tool: Block = { kind: "tool", toolUseId: "t1", name: "Read", input: {}, result: null, ts: 4 };
    expect(samePrompts(a, trackPrompts([...blocks, tool], () => 0))).toBe(true);
    expect(samePrompts(a, trackPrompts([user("a", 1), said("x!", 2), user("b", 3)], () => 0))).toBe(false);
    expect(samePrompts(a, trackPrompts([...blocks, run(5)], () => 3))).toBe(false);
  });
});

describe("how an answer opens", () => {
  it("is the words a reader sees: no heading, list or quote marks, emphasis or code ticks, a link as its text", () => {
    expect(opening("## Verified\n\n- **`getOrgMembership()`** now runs first\n> see [the PR](https://x.test/1)"))
      .toBe("Verified\ngetOrgMembership() now runs first\nsee the PR");
  });

  it("leaves code out, a fence still open mid-stream included", () => {
    expect(opening("```ts\nconst a = 1;\n```\nThat sets it.")).toBe("That sets it.");
    expect(opening("Here is the patch:\n```diff\n- old\n+ new")).toBe("Here is the patch:");
  });

  it("stops at what three lines can show, at a word, and says so", () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const text = opening(long)!;
    expect(text.length).toBeLessThanOrEqual(241);
    expect(text.endsWith("…")).toBe(true);
    expect(long.startsWith(text.slice(0, -1))).toBe(true);
    expect(text.slice(0, -1)).not.toMatch(/\s$/);
  });

  it("is nothing while there are no words", () => {
    expect(opening("")).toBeNull();
    expect(opening("```\nonly code\n```")).toBeNull();
    expect(opening("---\n\n")).toBeNull();
  });
});

describe("where the ticks sit", () => {
  it("spaces a log of short turns evenly, a pitch apart", () => {
    expect(tickPositions([44, 180, 300, 420], 600)).toEqual([0, TICK_PITCH, 2 * TICK_PITCH, 3 * TICK_PITCH]);
  });

  it("maps a long turn to a gap as long as the turn, at the track's scale", () => {
    const at = tickPositions([44, 144, 4144, 4244], 600);
    expect(at[1]).toBe(TICK_PITCH);
    expect(at[2]! - at[1]!).toBeCloseTo(4000 * TRACK_SCALE);
    expect(at[3]! - at[2]!).toBe(TICK_PITCH);
  });

  it("fits a scrollback longer than the room by shrinking the long gaps, and keeps the short ones a pitch apart", () => {
    const offsets = [0, 100, 40_100, 40_200, 80_200];
    const at = tickPositions(offsets, 300);
    expect(at.at(-1)!).toBeCloseTo(300, 0);
    expect(at[1]! - at[0]!).toBeCloseTo(TICK_PITCH);
    expect(at[3]! - at[2]!).toBeCloseTo(TICK_PITCH);
    // The two long turns were the same length, and still are.
    expect(at[2]! - at[1]!).toBeCloseTo(at[4]! - at[3]!, 1);
  });

  it("spaces more prompts than the room has pitches for evenly, across all of it", () => {
    const offsets = Array.from({ length: 101 }, (_, i) => i * 3000);
    const at = tickPositions(offsets, 400);
    expect(at.at(-1)!).toBeCloseTo(400, 6);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeCloseTo(4, 6);
  });

  it("keeps the order of the log even when two prompts measure out of it", () => {
    const at = tickPositions([0, 500, 480, 900], 600);
    for (let i = 1; i < at.length; i++) expect(at[i]!).toBeGreaterThan(at[i - 1]!);
  });
});

describe("which prompt is being read", () => {
  const offsets = [44, 800, 1600, 2400];
  const view = (top: number, height = 600, scrollHeight = 3000) => ({ top, height, scrollHeight, inset: 44 });

  it("is the last prompt to have come up past a third of the way down the log", () => {
    expect(currentPrompt(offsets, view(0))).toBe(0);
    expect(currentPrompt(offsets, view(599))).toBe(0); // 800 is 1px under the line
    expect(currentPrompt(offsets, view(600))).toBe(1);
    expect(currentPrompt(offsets, view(1500))).toBe(2);
  });

  it("is the prompt a jump just brought to rest at the top, however short the pane", () => {
    // A jump lands a row at the log's top padding; a pane this short has its third ABOVE that.
    expect(currentPrompt(offsets, view(800 - 44, 90))).toBe(1);
  });

  it("is the first prompt at the very top of the log, however soon the second follows it", () => {
    // A one-line first turn puts the second prompt above the reading line at once.
    expect(currentPrompt([44, 150, 1600, 2400], view(0))).toBe(0);
    expect(currentPrompt([44, 150, 1600, 2400], view(10))).toBe(1);
    // …and a log too short to scroll at all is at its end, where the newest prompt is the one read.
    expect(currentPrompt([44, 150, 300], view(0, 600, 590))).toBe(2);
  });

  it("is the last one on screen once the log is at its end, or a short last turn could never be current", () => {
    expect(currentPrompt(offsets, view(2400, 600, 3000))).toBe(3);
    // At the end with the last row only partly in: still the last one on screen that has room to be.
    expect(currentPrompt([44, 800, 2390], view(1800, 600, 2400))).toBe(1);
  });

  it("is nothing on an empty track", () => {
    expect(currentPrompt([], view(0))).toBe(-1);
  });
});
