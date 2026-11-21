import { describe, expect, it } from "vitest";
import type { TranscriptEvents, TranscriptLine } from "../voice/transcript";
import { MeetingAssistant, type Listener } from "./assistant";
import type { AnswerEvent, AnswerRequest, MeetingRecord } from "./seams";

function rig(opts: { consented?: boolean; engine?: boolean } = {}) {
  const calls: string[] = [];
  const marks: boolean[] = [];
  const records: MeetingRecord[] = [];
  const asked: AnswerRequest[] = [];
  let answerEvents: ((e: AnswerEvent) => void) | null = null;
  let events: TranscriptEvents | null = null;
  let consented = opts.consented ?? true;
  let now = 1_000;
  const assistant = new MeetingAssistant({
    listen: (e): Listener => {
      events = e;
      calls.push("listen");
      return {
        start: async () => { calls.push("start"); },
        stop: async () => { calls.push("stop"); e.ended?.(); },
      };
    },
    consent: {
      read: async () => consented,
      accept: async () => { calls.push("accept"); consented = true; },
    },
    setListening: (on) => marks.push(on),
    summary: (r) => { records.push(r); },
    answers: opts.engine ? { answer: (req, onEvent) => { asked.push(req); answerEvents = onEvent; return () => calls.push("cancel"); } } : null,
    now: () => now,
  });
  const line = (source: "me" | "them", text: string, at: number): TranscriptLine => ({ source, text, start: at - 1_000, end: at - 500, at });
  return {
    assistant, calls, marks, records, asked,
    events: () => events!,
    answer: (e: AnswerEvent) => answerEvents!(e),
    line, tick: (ms: number) => { now += ms; },
    revoke: () => { consented = false; },
  };
}

describe("MeetingAssistant", () => {
  it("puts up the first-run sheet on a Start before it was accepted, and listens to nothing", async () => {
    const r = rig({ consented: false });
    await r.assistant.start();
    expect(r.assistant.getState().sheet).toBe(true);
    expect(r.assistant.getState().phase).toBe("idle");
    expect(r.calls).not.toContain("listen");
    expect(r.marks).toEqual([]);
  });

  it("keeps the acceptance, then starts the run the Start asked for", async () => {
    const r = rig({ consented: false });
    await r.assistant.start();
    await r.assistant.accept();
    expect(r.calls).toEqual(["accept", "listen", "start"]);
    expect(r.assistant.getState()).toMatchObject({ sheet: false, consented: true, phase: "listening" });
  });

  it("listens at once when the sheet was accepted before", async () => {
    const r = rig();
    await r.assistant.start();
    expect(r.assistant.getState().sheet).toBe(false);
    expect(r.assistant.getState().phase).toBe("listening");
  });

  it("puts the mark up before the microphone opens and takes it down on Stop", async () => {
    const r = rig();
    await r.assistant.load();
    const started = r.assistant.start();
    // listen() ran synchronously, start() is in flight: the mark is already up.
    expect(r.marks).toEqual([true]);
    await started;
    await r.assistant.stop();
    expect(r.marks).toEqual([true, false]);
    expect(r.assistant.getState().phase).toBe("idle");
  });

  it("takes the mark down when the run ends on its own", async () => {
    const r = rig();
    await r.assistant.start();
    r.events().ended?.();
    expect(r.marks).toEqual([true, false]);
    expect(r.assistant.getState().phase).toBe("idle");
  });

  it("shows Me and Them lines as they come, and a line replaces its side's partial", async () => {
    const r = rig();
    await r.assistant.start();
    r.events().partial("them", "what is");
    r.events().partial("me", "so");
    expect(r.assistant.getState().partial).toEqual({ them: "what is", me: "so" });
    r.events().line(r.line("them", "What is the price?", 2_000));
    expect(r.assistant.getState().partial).toEqual({ me: "so" });
    expect(r.assistant.getState().lines.map((l) => `${l.source}: ${l.text}`)).toEqual(["them: What is the price?"]);
  });

  it("hands transcript, notes and custom info to the summary hook on Stop", async () => {
    const r = rig();
    r.assistant.addContext("  I am pitching the stub plan.  ");
    await r.assistant.start();
    r.events().line(r.line("them", "Any questions?", 2_000));
    r.assistant.ask("What did they ask?");
    await r.assistant.stop();
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toEqual({
      transcript: [r.line("them", "Any questions?", 2_000)],
      notes: [{ question: "What did they ask?", answer: "", at: 1_000 }],
      customInfo: ["I am pitching the stub plan."],
    });
  });

  it("hands the run over once, though the end is said twice", async () => {
    const r = rig();
    await r.assistant.start();
    r.events().ended?.();
    await r.assistant.stop();
    expect(r.records).toHaveLength(1);
    expect(r.marks).toEqual([true, false]);
  });

  it("ignores empty context and empty questions", () => {
    const r = rig();
    r.assistant.addContext("   ");
    r.assistant.ask("");
    expect(r.assistant.getState().customInfo).toEqual([]);
    expect(r.assistant.getState().questions).toEqual([]);
  });

  it("marks a question unanswered when no engine is plugged in", () => {
    const r = rig();
    r.assistant.ask("Who is on the call?");
    expect(r.assistant.getState().questions[0]).toMatchObject({ question: "Who is on the call?", state: "unanswered" });
  });

  it("streams an engine's answer into its question, with the transcript and context it read", async () => {
    const r = rig({ engine: true });
    r.assistant.addContext("Budget is fixed.");
    await r.assistant.start();
    r.events().line(r.line("them", "Can you go lower?", 2_000));
    r.assistant.ask("What should I say?");
    expect(r.asked[0]).toEqual({ question: "What should I say?", transcript: [r.line("them", "Can you go lower?", 2_000)], customInfo: ["Budget is fixed."] });
    r.answer({ t: "text", text: "The budget " });
    r.answer({ t: "text", text: "is fixed." });
    expect(r.assistant.getState().questions[0]).toMatchObject({ answer: "The budget is fixed.", state: "streaming" });
    r.answer({ t: "done" });
    expect(r.assistant.getState().questions[0]!.state).toBe("done");
  });

  it("says why an answer failed", () => {
    const r = rig({ engine: true });
    r.assistant.ask("Anything?");
    r.answer({ t: "error", message: "The model did not answer." });
    expect(r.assistant.getState().questions[0]).toMatchObject({ state: "failed", error: "The model did not answer." });
  });

  it("starts a new meeting after a Stop, and keeps what was typed before the first Start", async () => {
    const r = rig();
    r.assistant.ask("Before the call");
    await r.assistant.start();
    expect(r.assistant.getState().questions).toHaveLength(1);
    r.events().line(r.line("me", "Hello.", 2_000));
    await r.assistant.stop();
    expect(r.assistant.getState().lines).toHaveLength(1);
    r.tick(5_000);
    await r.assistant.start();
    expect(r.assistant.getState().lines).toEqual([]);
    expect(r.assistant.getState().questions).toEqual([]);
    expect(r.assistant.getState().startedAt).toBe(6_000);
  });

  it("drops lines from a run that has ended", async () => {
    const r = rig();
    await r.assistant.start();
    const old = r.events();
    await r.assistant.stop();
    old.line(r.line("them", "Late.", 3_000));
    expect(r.assistant.getState().lines).toEqual([]);
  });

  it("takes the mark down and cancels answers when the page goes", async () => {
    const r = rig({ engine: true });
    await r.assistant.start();
    r.assistant.ask("Anything?");
    r.assistant.dispose();
    expect(r.marks).toEqual([true, false]);
    expect(r.calls).toContain("cancel");
    expect(r.calls).toContain("stop");
  });
});
