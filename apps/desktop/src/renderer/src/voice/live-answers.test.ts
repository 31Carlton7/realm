import { describe, expect, it } from "vitest";
import type { LiveAnswerEvent, LiveAnswerTrigger } from "@realm/contracts";
import { MeetingAnswers, type LiveAnswersApi } from "./live-answers";
import type { TranscriptLine } from "./transcript";

function fakeApi() {
  const asked: { lines: TranscriptLine[]; customInfo: string; trigger: LiveAnswerTrigger }[] = [];
  const calls: string[] = [];
  let listener: ((e: LiveAnswerEvent) => void) | null = null;
  const api: LiveAnswersApi = {
    answer: async (input) => { asked.push(input); return { answerId: `a${asked.length}` }; },
    cancel: async () => { calls.push("cancel"); },
    prepare: async () => { calls.push("prepare"); },
    stop: async () => { calls.push("stop"); },
    onEvent: (cb) => { listener = cb; return () => { listener = null; calls.push("off"); }; },
  };
  return { api, asked, calls, emit: (e: LiveAnswerEvent) => listener?.(e) };
}

const line = (source: "me" | "them", text: string, start: number, end = start + 2_000): TranscriptLine => ({ source, text, start, end, at: 1_795_207_765_432 + start });

function meeting(auto = true, info = "I'm pitching the annual plan.") {
  const f = fakeApi();
  const heard: LiveAnswerEvent[] = [];
  let customInfo = info;
  const answers = new MeetingAnswers({ api: f.api, auto, customInfo: () => customInfo, onEvent: (e) => heard.push(e) });
  answers.start();
  return { ...f, answers, heard, setInfo: (s: string) => { customInfo = s; } };
}

describe("MeetingAnswers", () => {
  it("starts the engine as listening starts, and passes the answer's steps on", () => {
    const m = meeting();
    expect(m.calls).toEqual(["prepare"]);
    m.emit({ answerId: "a1", t: "delta", text: "About" });
    expect(m.heard).toEqual([{ answerId: "a1", t: "delta", text: "About" }]);
  });

  it("asks once when the other side asks a question, with the window and the custom info", () => {
    const m = meeting();
    m.answers.line(line("me", "Thanks for having me.", 0));
    m.answers.line(line("them", "How many seats", 3_000));
    expect(m.asked).toEqual([]);
    m.answers.line(line("them", "do you need?", 5_100));
    expect(m.asked).toHaveLength(1);
    expect(m.asked[0]).toMatchObject({ trigger: "question", customInfo: "I'm pitching the annual plan." });
    expect(m.asked[0]!.lines.map((l) => l.text)).toEqual(["Thanks for having me.", "How many seats", "do you need?"]);
    // The same question read again, as my own line arrives out of order, is not asked twice.
    m.answers.line(line("me", "Sure.", 1_000));
    expect(m.asked).toHaveLength(1);
  });

  it("asks again for a newer question, which the server answers in place of the last", () => {
    const m = meeting();
    m.answers.line(line("them", "How many seats do you need?", 0));
    m.answers.line(line("them", "And when would you start?", 2_500));
    expect(m.asked.map((a) => a.lines.at(-1)!.text)).toEqual(["How many seats do you need?", "And when would you start?"]);
  });

  it("does not ask for my own questions", () => {
    const m = meeting();
    m.answers.line(line("me", "How many seats do you need?", 0));
    expect(m.asked).toEqual([]);
  });

  it("with auto off, asks only on the key, reading the custom info as it is then", async () => {
    const m = meeting(false);
    m.answers.line(line("them", "How many seats do you need?", 0));
    expect(m.asked).toEqual([]);
    m.setInfo("Twelve seats, SSO is a must.");
    await m.answers.askNow();
    expect(m.asked).toEqual([{ lines: [line("them", "How many seats do you need?", 0)], customInfo: "Twelve seats, SSO is a must.", trigger: "key" }]);
    m.answers.setAuto(true);
    m.answers.line(line("them", "And when would you start?", 2_500));
    expect(m.asked).toHaveLength(2);
  });

  it("keeps only the lines an answer reads", async () => {
    const m = meeting(false);
    m.answers.line(line("them", "Thanks for joining.", 0));
    m.answers.line(line("them", "How many seats do you need?", 400_000));
    await m.answers.askNow();
    expect(m.asked[0]!.lines.map((l) => l.text)).toEqual(["How many seats do you need?"]);
  });

  it("tells the server the meeting is over, and stops listening, on stop", async () => {
    const m = meeting();
    await m.answers.stop();
    expect(m.calls).toEqual(["prepare", "stop", "off"]);
    m.emit({ answerId: "a1", t: "cancelled" });
    expect(m.heard).toEqual([]);
  });

  it("says why when the ask itself fails", async () => {
    const m = meeting(false);
    m.api.answer = async () => { throw new Error("the socket is closed"); };
    await m.answers.askNow();
    expect(m.heard).toEqual([{ answerId: "", t: "error", message: "the socket is closed" }]);
  });
});
