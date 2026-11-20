import { describe, expect, it } from "vitest";
import type { MeetingLine } from "@realm/contracts";
import { LIVE_ANSWER_WINDOW_MS, answerWindow, questionForMe } from "./live-answers";

// Shaped as RealmVoice's continuous mode hands lines over (M1's live run, Nov 20): one finished line
// per recogniser result, punctuated, `start`/`end` in ms since the transcript started.
const T0 = 1_795_207_765_432;
const line = (source: "me" | "them", text: string, start: number, end = start + 2_000): MeetingLine => ({ source, text, start, end, at: T0 + start });

describe("questionForMe", () => {
  it("finds the question the other side just asked", () => {
    const lines = [
      line("me", "Run the build and then run the tests.", 1086, 3186),
      line("them", "Can you tell me how the pricing works for a team of 12 people?", 5047, 8887),
    ];
    expect(questionForMe(lines)).toEqual({ text: "Can you tell me how the pricing works for a team of 12 people?", start: 5047, end: 8887 });
  });

  it("reads a sentence the recogniser cut across lines as one", () => {
    const lines = [
      line("them", "So if we went with the annual plan", 10_000),
      line("them", "would single sign on be included?", 12_500),
    ];
    expect(questionForMe(lines)).toEqual({ text: "So if we went with the annual plan would single sign on be included?", start: 10_000, end: 14_500 });
  });

  it("waits for a question that ends two lines later", () => {
    const first = line("them", "What would you do", 20_000);
    const second = line("them", "if the budget for the pilot", 22_100);
    const third = line("them", "doubled next quarter?", 24_300);
    expect(questionForMe([first])).toBeNull();
    expect(questionForMe([first, second])).toBeNull();
    expect(questionForMe([first, second, third])?.text).toBe("What would you do if the budget for the pilot doubled next quarter?");
  });

  it("never answers my own questions", () => {
    expect(questionForMe([line("me", "Does the annual plan include single sign on?", 0)])).toBeNull();
    expect(questionForMe([line("them", "We would want the annual plan.", 0), line("me", "Does it need single sign on?", 3_000)])).toBeNull();
  });

  it("leaves a question I have started answering", () => {
    const lines = [line("them", "How many seats do you need?", 0), line("me", "About twelve to start.", 3_000)];
    expect(questionForMe(lines)).toBeNull();
  });

  it("puts lines in the order they were said, not the order they finished", () => {
    // My answer started before their next line finished, and reached Realm after it.
    const lines = [line("them", "How many seats do you need?", 0), line("them", "Roughly.", 6_000), line("me", "About twelve.", 3_000)];
    expect(questionForMe(lines)).toBeNull();
  });

  it("ignores a question they went on to answer themselves", () => {
    expect(questionForMe([line("them", "What does that mean for us? It means we ship on Friday.", 0)])).toBeNull();
    expect(questionForMe([line("them", "So what changed?", 0), line("them", "Mostly the pricing.", 2_500)])).toBeNull();
  });

  it("ignores a tag on a statement", () => {
    expect(questionForMe([line("them", "That's the plan for the pilot, right?", 0)])).toBeNull();
    expect(questionForMe([line("them", "We ship on Friday.", 0), line("them", "You know?", 2_100)])).toBeNull();
    expect(questionForMe([line("them", "It covers the whole team, isn’t it?", 0)])).toBeNull();
  });

  it("takes a request to say something as a question", () => {
    expect(questionForMe([line("them", "Walk me through how the migration would work.", 0)])?.text).toBe("Walk me through how the migration would work.");
    expect(questionForMe([line("them", "We have twelve people. Tell me what the annual plan costs.", 0)])?.text).toBe("Tell me what the annual plan costs.");
  });

  it("does not take a statement as a question", () => {
    expect(questionForMe([line("them", "We would want the annual plan if it has single sign on.", 53_407, 56_287)])).toBeNull();
    expect(questionForMe([])).toBeNull();
  });
});

describe("answerWindow", () => {
  it("keeps the last three minutes before the newest line, in the order they were said", () => {
    expect(LIVE_ANSWER_WINDOW_MS).toBe(180_000);
    const old = line("them", "Thanks for joining.", 0, 2_000);
    const edge = line("me", "Happy to.", 18_000, 20_000);
    const recent = line("them", "How many seats?", 199_000, 200_000);
    const mine = line("me", "Let me check.", 195_000, 196_000);
    expect(answerWindow([old, edge, recent, mine])).toEqual([edge, mine, recent]);
  });

  it("is empty for no lines", () => {
    expect(answerWindow([])).toEqual([]);
  });
});
