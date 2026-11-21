import { describe, expect, it } from "vitest";
import type { LiveAnswerEvent, MeetingNotesProgress, SaveMeetingNotesParams, SaveMeetingNotesResult } from "@realm/contracts";
import type { LiveAnswersApi } from "../voice/live-answers";
import type { VoiceAudio } from "../voice/audio-io";
import { MeetingTranscript, type TranscriptEvents, type TranscriptHelper, type TranscriptLine } from "../voice/transcript";
import { MeetingAssistant, customInfoText, type AssistantDeps, type Listener } from "./assistant";

type Asked = Parameters<LiveAnswersApi["answer"]>[0];

function rig(opts: {
  consented?: boolean; space?: string | null; save?: (p: SaveMeetingNotesParams) => Promise<SaveMeetingNotesResult>;
  listen?: (events: TranscriptEvents) => Listener;
  autoAnswers?: AssistantDeps["autoAnswers"];
} = {}) {
  const calls: string[] = [];
  const marks: boolean[] = [];
  const asked: Asked[] = [];
  const saved: SaveMeetingNotesParams[] = [];
  const cancelledSummaries: string[] = [];
  const opened: [string, string][] = [];
  const answerSubs = new Set<(e: LiveAnswerEvent) => void>();
  const progressSubs = new Set<(p: MeetingNotesProgress) => void>();
  let events: TranscriptEvents | null = null;
  let consented = opts.consented ?? true;
  let now = 1_000;
  let ids = 0;
  const answers: LiveAnswersApi = {
    answer: async (input) => { asked.push(input); return { answerId: `a${asked.length}` }; },
    cancel: async () => { calls.push("cancel answer"); },
    prepare: async () => { calls.push("prepare"); },
    stop: async () => { calls.push("stop answers"); },
    onEvent: (cb) => { answerSubs.add(cb); return () => answerSubs.delete(cb); },
  };
  const assistant = new MeetingAssistant({
    listen: (e): Listener => {
      events = e;
      calls.push("listen");
      if (opts.listen) return opts.listen(e);
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
    answers,
    notes: {
      save: async (p) => { calls.push("save"); saved.push(p); return opts.save ? opts.save(p) : { path: "meetings/m.md", summary: "written" }; },
      cancel: async (id) => { cancelledSummaries.push(id); },
      onProgress: (cb) => { progressSubs.add(cb); return () => progressSubs.delete(cb); },
    },
    spaceId: () => (opts.space === undefined ? "space-1" : opts.space),
    openFile: (space, path) => opened.push([space, path]),
    now: () => now,
    newId: () => `m${++ids}`,
    autoAnswers: opts.autoAnswers,
  });
  assistant.watchNotes();
  const line = (source: "me" | "them", text: string, at: number): TranscriptLine => ({ source, text, start: at - 1_000, end: at - 500, at });
  return {
    assistant, calls, marks, asked, saved, cancelledSummaries, opened, answerSubs, progressSubs,
    events: () => events!,
    answer: (e: LiveAnswerEvent) => { for (const cb of answerSubs) cb(e); },
    progress: (p: MeetingNotesProgress) => { for (const cb of progressSubs) cb(p); },
    line, tick: (ms: number) => { now += ms; },
    state: () => assistant.getState(),
  };
}

/** The helper on a Mac where Realm may not use the microphone. */
function deniedHelper(): TranscriptHelper {
  return {
    microphone: async () => "denied", start: async () => ({ t: "unavailable", reason: "unused" }),
    audio: () => {}, systemAudio: () => {}, finish: () => {}, stop: () => {}, onEvent: () => () => {},
  };
}
const silentAudio: VoiceAudio = { start: async () => {}, stop: () => {} };

describe("MeetingAssistant", () => {
  it("puts up the first-run sheet on a Start before it was accepted, and listens to nothing", async () => {
    const r = rig({ consented: false });
    await r.assistant.start();
    expect(r.state().sheet).toBe(true);
    expect(r.state().phase).toBe("idle");
    expect(r.calls).not.toContain("listen");
    expect(r.calls).not.toContain("prepare");
    expect(r.marks).toEqual([]);
  });

  it("keeps the acceptance, then starts the run the Start asked for", async () => {
    const r = rig({ consented: false });
    await r.assistant.start();
    await r.assistant.accept();
    expect(r.calls).toEqual(["accept", "prepare", "listen", "start"]);
    expect(r.state()).toMatchObject({ sheet: false, consented: true, phase: "listening" });
  });

  it("listens at once when the sheet was accepted before", async () => {
    const r = rig();
    await r.assistant.start();
    expect(r.state().sheet).toBe(false);
    expect(r.state().phase).toBe("listening");
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
    expect(r.state().phase).toBe("idle");
  });

  it("takes the mark down when the run ends on its own", async () => {
    const r = rig();
    await r.assistant.start();
    r.events().ended?.();
    expect(r.marks).toEqual([true, false]);
    expect(r.state().phase).toBe("idle");
  });

  it("shows Me and Them lines as they come, and a line replaces its side's partial", async () => {
    const r = rig();
    await r.assistant.start();
    r.events().partial("them", "what is");
    r.events().partial("me", "so");
    expect(r.state().partial).toEqual({ them: "what is", me: "so" });
    r.events().line(r.line("them", "What is the price?", 2_000));
    expect(r.state().partial).toEqual({ me: "so" });
    expect(r.state().lines.map((l) => `${l.source}: ${l.text}`)).toEqual(["them: What is the price?"]);
  });

  it("starts the live answers with listening, and hands them each line, so the other side's question is answered", async () => {
    const r = rig();
    r.assistant.addContext("I sell seats.");
    await r.assistant.start();
    expect(r.calls.filter((c) => c === "prepare")).toHaveLength(1);
    expect(r.answerSubs.size).toBe(1);
    r.events().line(r.line("them", "How many seats do you need to start?", 2_000));
    expect(r.asked).toEqual([{ lines: [r.line("them", "How many seats do you need to start?", 2_000)], customInfo: "I sell seats.", trigger: "question" }]);
  });

  it("asks a typed question through the answer key, with the question in that answer's custom info alone", async () => {
    const r = rig();
    r.assistant.addContext("Budget is fixed.");
    r.assistant.addContext("They want a pilot.");
    await r.assistant.start();
    r.events().line(r.line("me", "We can start small.", 2_000));
    r.assistant.ask("  What should I say about price?  ");
    expect(r.asked[0]).toEqual({
      lines: [r.line("me", "We can start small.", 2_000)],
      customInfo: "Budget is fixed.\nThey want a pilot.\n\nMy question now: What should I say about price?",
      trigger: "key",
    });
    expect(r.state().asked).toEqual([{ id: 1, text: "What should I say about price?", at: 1_000 }]);
    r.events().line(r.line("them", "Does that work for you?", 3_000));
    expect(r.asked[1]!.customInfo).toBe("Budget is fixed.\nThey want a pilot.");
  });

  it("sends a typed question alone when there is no custom info", async () => {
    const r = rig();
    await r.assistant.start();
    r.assistant.ask("Who is on the call?");
    expect(r.asked[0]!.customInfo).toBe("My question now: Who is on the call?");
  });

  it("subscribes to the answers for a question typed before listening starts", () => {
    const r = rig();
    r.assistant.ask("What is the agenda?");
    expect(r.answerSubs.size).toBe(1);
    r.answer({ answerId: "a1", t: "start", trigger: "key", model: null });
    r.answer({ answerId: "a1", t: "done", text: "Pricing, then the pilot." });
    expect(r.state().answer).toMatchObject({ text: "Pricing, then the pilot.", state: "done" });
  });

  it("ignores empty context and empty questions", () => {
    const r = rig();
    r.assistant.addContext("   ");
    r.assistant.ask("");
    expect(r.state().customInfo).toEqual([]);
    expect(r.state().asked).toEqual([]);
    expect(r.asked).toEqual([]);
  });

  it("streams the answer that started last, and drops what an older one still sends", async () => {
    const r = rig();
    await r.assistant.start();
    r.answer({ answerId: "a1", t: "start", trigger: "question", model: "claude-haiku-5-5" });
    r.answer({ answerId: "a1", t: "delta", text: "Twelve " });
    r.answer({ answerId: "a1", t: "delta", text: "seats" });
    expect(r.state().answer).toEqual({ id: "a1", trigger: "question", text: "Twelve seats", state: "streaming" });
    r.answer({ answerId: "a2", t: "start", trigger: "key", model: null });
    r.answer({ answerId: "a1", t: "delta", text: " to start." });
    r.answer({ answerId: "a1", t: "done", text: "Twelve seats to start." });
    expect(r.state().answer).toEqual({ id: "a2", trigger: "key", text: "", state: "streaming" });
    r.answer({ answerId: "a2", t: "delta", text: "On the " });
    r.answer({ answerId: "a2", t: "done", text: "On the annual plan." });
    expect(r.state().answer).toEqual({ id: "a2", trigger: "key", text: "On the annual plan.", state: "done" });
  });

  it("shows the sentence an answer failed with, and one that could not begin", async () => {
    const r = rig();
    await r.assistant.start();
    r.answer({ answerId: "a1", t: "start", trigger: "key", model: null });
    r.answer({ answerId: "a1", t: "error", message: "The model did not answer." });
    expect(r.state().answer).toMatchObject({ id: "a1", state: "failed", error: "The model did not answer." });
    r.answer({ answerId: "a2", t: "error", message: "Live answers run on Claude only. Codex is chosen for quick chat." });
    expect(r.state().answer).toMatchObject({ id: "a2", state: "failed", error: "Live answers run on Claude only. Codex is chosen for quick chat." });
  });

  it("takes a cancelled answer off the panel", async () => {
    const r = rig();
    await r.assistant.start();
    r.answer({ answerId: "a1", t: "start", trigger: "key", model: null });
    r.answer({ answerId: "a1", t: "delta", text: "Half" });
    r.answer({ answerId: "a1", t: "cancelled" });
    expect(r.state().answer).toBeNull();
  });

  it("cancels an answer dismissed while it streams, and only then", async () => {
    const r = rig();
    await r.assistant.start();
    r.answer({ answerId: "a1", t: "start", trigger: "key", model: null });
    r.assistant.dismissAnswer();
    expect(r.calls).toContain("cancel answer");
    expect(r.state().answer).toBeNull();
    r.answer({ answerId: "a1", t: "delta", text: "late" });
    expect(r.state().answer).toBeNull();
    r.calls.length = 0;
    r.answer({ answerId: "a2", t: "start", trigger: "key", model: null });
    r.answer({ answerId: "a2", t: "done", text: "Done." });
    r.assistant.dismissAnswer();
    expect(r.calls).not.toContain("cancel answer");
    expect(r.state().answer).toBeNull();
  });

  it("on Stop ends the live answers, then saves the notes with the transcript, the questions and the custom info", async () => {
    const r = rig();
    r.assistant.addContext("  I am pitching the stub plan.  ");
    r.assistant.addContext("Their CTO doubts the price.");
    await r.assistant.start();
    r.events().line(r.line("them", "Any questions?", 2_000));
    r.assistant.ask("What did they ask?");
    r.assistant.ask("Who decides?");
    r.tick(60_000);
    await r.assistant.stop();
    expect(r.calls.indexOf("stop answers")).toBeGreaterThan(-1);
    expect(r.calls.indexOf("stop answers")).toBeLessThan(r.calls.indexOf("save"));
    expect(r.saved).toEqual([{
      meetingId: "m1", spaceId: "space-1", title: "Meeting", startedAt: 1_000, endedAt: 61_000,
      lines: [r.line("them", "Any questions?", 2_000)],
      notes: "- Asked the assistant: What did they ask?\n- Asked the assistant: Who decides?",
      customInfo: "I am pitching the stub plan.\nTheir CTO doubts the price.",
    }]);
    expect(r.state().notes).toEqual({ meetingId: "m1", spaceId: "space-1", path: "meetings/m.md", stage: "saved", summary: "written" });
    expect(r.answerSubs.size).toBe(0);
  });

  it("saves nothing for a run in which nothing was heard or typed", async () => {
    const r = rig();
    await r.assistant.start();
    await r.assistant.stop();
    expect(r.calls).toContain("stop answers");
    expect(r.saved).toEqual([]);
    expect(r.state().notes).toBeNull();
  });

  it("says why the notes were not saved when no space is open", async () => {
    const r = rig({ space: null });
    await r.assistant.start();
    r.events().line(r.line("me", "Hello.", 2_000));
    await r.assistant.stop();
    expect(r.saved).toEqual([]);
    expect(r.state().problem).toBe("Realm could not save the notes: no space is open.");
  });

  it("says why the notes could not be saved", async () => {
    const r = rig({ save: async () => { throw new Error("the space has no folder"); } });
    await r.assistant.start();
    r.events().line(r.line("me", "Hello.", 2_000));
    await r.assistant.stop();
    expect(r.state().notes).toBeNull();
    expect(r.state().problem).toBe("Realm could not save the notes: the space has no folder");
  });

  it("shows the path while the summary is written, offers its cancel, and ends on the outcome", async () => {
    let finish!: (r: SaveMeetingNotesResult) => void;
    const r = rig({ save: () => new Promise((res) => { finish = res; }) });
    await r.assistant.start();
    r.events().line(r.line("me", "Hello.", 2_000));
    const stopping = r.assistant.stop();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.state().notes).toMatchObject({ meetingId: "m1", stage: "saving", path: null });
    r.progress({ meetingId: "other", spaceId: "space-1", path: "meetings/other.md", stage: "summarising" });
    expect(r.state().notes).toMatchObject({ stage: "saving", path: null });
    r.progress({ meetingId: "m1", spaceId: "space-1", path: "meetings/2026-11-20 1405 Meeting.md", stage: "summarising" });
    expect(r.state().notes).toMatchObject({ stage: "summarising", path: "meetings/2026-11-20 1405 Meeting.md" });
    r.assistant.cancelSummary();
    expect(r.cancelledSummaries).toEqual(["m1"]);
    finish({ path: "meetings/2026-11-20 1405 Meeting.md", summary: "cancelled" });
    await stopping;
    expect(r.state().notes).toMatchObject({ stage: "saved", summary: "cancelled" });
    r.progress({ meetingId: "m1", spaceId: "space-1", path: "meetings/x.md", stage: "summarising" });
    expect(r.state().notes).toMatchObject({ stage: "saved", path: "meetings/2026-11-20 1405 Meeting.md" });
    r.assistant.cancelSummary();
    expect(r.cancelledSummaries).toEqual(["m1"]);
  });

  it("opens the saved file in the space it was saved in", async () => {
    const r = rig();
    r.assistant.openNotes();
    expect(r.opened).toEqual([]);
    await r.assistant.start();
    r.events().line(r.line("me", "Hello.", 2_000));
    await r.assistant.stop();
    r.assistant.openNotes();
    expect(r.opened).toEqual([["space-1", "meetings/m.md"]]);
  });

  it("saves once, though the end is said twice", async () => {
    const r = rig();
    await r.assistant.start();
    r.events().line(r.line("me", "Hello.", 2_000));
    r.events().ended?.();
    await r.assistant.stop();
    await Promise.resolve(); await Promise.resolve();
    expect(r.saved).toHaveLength(1);
    expect(r.marks).toEqual([true, false]);
  });

  it("starts a new meeting after a Stop, and keeps what was typed before the first Start", async () => {
    const r = rig();
    r.assistant.ask("Before the call");
    await r.assistant.start();
    expect(r.state().asked).toHaveLength(1);
    r.events().line(r.line("me", "Hello.", 2_000));
    r.answer({ answerId: "a1", t: "start", trigger: "key", model: null });
    await r.assistant.stop();
    expect(r.state().lines).toHaveLength(1);
    expect(r.state().notes).not.toBeNull();
    r.tick(5_000);
    await r.assistant.start();
    expect(r.state()).toMatchObject({ lines: [], asked: [], answer: null, notes: null, startedAt: 6_000 });
  });

  it("drops lines from a run that has ended", async () => {
    const r = rig();
    await r.assistant.start();
    const old = r.events();
    await r.assistant.stop();
    old.line(r.line("them", "Late?", 3_000));
    old.partial("them", "Late");
    expect(r.state().lines).toEqual([]);
    expect(r.state().partial).toEqual({});
    expect(r.asked).toEqual([]);
  });

  it("takes the mark down and ends the answers when the page goes", async () => {
    const r = rig();
    await r.assistant.start();
    r.assistant.dispose();
    await Promise.resolve();
    expect(r.marks).toEqual([true, false]);
    expect(r.calls).toContain("stop answers");
    expect(r.calls).toContain("stop");
  });

  it("hears the notes' progress from watchNotes until its own off", () => {
    const r = rig();
    const before = r.progressSubs.size;
    const off = r.assistant.watchNotes();
    expect(r.progressSubs.size).toBe(before + 1);
    off();
    expect(r.progressSubs.size).toBe(before);
  });

  it("says why a Start failed, on the real transcript, and takes the mark down", async () => {
    const r = rig({ listen: (events) => new MeetingTranscript({ helper: deniedHelper(), audio: silentAudio, events, systemAudio: true }) });
    await r.assistant.start();
    expect(r.state().problem).toBe("Realm is not allowed to use the microphone. Turn it on in System Settings ▸ Privacy & Security ▸ Microphone.");
    expect(r.marks).toEqual([true, false]);
    expect(r.state().phase).toBe("idle");
  });

  it("saves nothing and clears nothing for a Start that never got to listen", async () => {
    let deny = true;
    const r = rig({
      listen: (events) => deny
        ? new MeetingTranscript({ helper: deniedHelper(), audio: silentAudio, events, systemAudio: true })
        : { start: async () => {}, stop: async () => { events.ended?.(); } },
    });
    r.assistant.addContext("They want a pilot.");
    r.assistant.ask("Before the call");
    await r.assistant.start();
    await Promise.resolve(); await Promise.resolve();
    expect(r.saved).toEqual([]);
    expect(r.state()).toMatchObject({ stoppedAt: null, notes: null, customInfo: ["They want a pilot."] });
    expect(r.state().asked.map((q) => q.text)).toEqual(["Before the call"]);
    // The retry is the same meeting: the question typed before the first Start is still in it.
    deny = false;
    await r.assistant.start();
    expect(r.state().asked.map((q) => q.text)).toEqual(["Before the call"]);
    await r.assistant.stop();
    expect(r.saved.map((m) => m.notes)).toEqual(["- Asked the assistant: Before the call"]);
    // After that meeting, a Start that fails leaves its words and its notes on screen.
    deny = true;
    await r.assistant.start();
    expect(r.state().asked).toHaveLength(1);
    expect(r.state().notes).toMatchObject({ meetingId: "m1", stage: "saved" });
    expect(r.saved).toHaveLength(1);
  });

  it("saves nothing for a run stopped before it got to listen", async () => {
    let opened!: () => void;
    const r = rig({ listen: (events) => ({ start: () => new Promise<void>((res) => { opened = res; }), stop: async () => { events.ended?.(); } }) });
    await r.assistant.load();
    r.assistant.ask("Before the call");
    const starting = r.assistant.start();
    expect(r.state().phase).toBe("starting");
    await r.assistant.stop();
    opened();
    await starting;
    expect(r.saved).toEqual([]);
    expect(r.state()).toMatchObject({ phase: "idle", stoppedAt: null });
    expect(r.state().asked).toHaveLength(1);
  });

  it("saves nothing for a run with custom info and no words", async () => {
    const r = rig();
    r.assistant.addContext("I am pitching the stub plan.");
    await r.assistant.start();
    await r.assistant.stop();
    expect(r.saved).toEqual([]);
    expect(r.state().notes).toBeNull();
  });

  it("ends the answers a question asked them for when the page goes, with nothing listening", async () => {
    const r = rig();
    r.assistant.ask("What is the agenda?");
    expect(r.answerSubs.size).toBe(1);
    r.assistant.dispose();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.calls).toContain("stop answers");
    expect(r.answerSubs.size).toBe(0);
  });

  it("joins the custom info in the order it was given", () => {
    expect(customInfoText(["one", "two"])).toBe("one\ntwo");
    expect(customInfoText([])).toBe("");
  });
});

const settle = () => new Promise((res) => setTimeout(res, 0));

describe("the assistant's keys", () => {
  it("R and every key but scrolling turn the panel to the assistant", async () => {
    for (const action of ["toggle", "listen", "answer", "type"] as const) {
      const r = rig();
      await r.assistant.load();
      expect(r.state().shown).toBe(false);
      r.assistant.key(action);
      expect(r.state().shown).toBe(true);
    }
  });

  it("L starts listening through Start, mark first, and L again stops it", async () => {
    const r = rig();
    await r.assistant.load();
    r.assistant.key("listen");
    await settle();
    expect(r.state().phase).toBe("listening");
    expect(r.marks).toEqual([true]);
    r.assistant.key("listen");
    await settle();
    expect(r.state().phase).toBe("idle");
    expect(r.marks).toEqual([true, false]);
  });

  it("L before the first-run sheet was accepted puts it up, and a second L does not accept it", async () => {
    const r = rig({ consented: false });
    await r.assistant.load();
    r.assistant.key("listen");
    await settle();
    r.assistant.key("listen");
    await settle();
    expect(r.state().sheet).toBe(true);
    expect(r.state().phase).toBe("idle");
    expect(r.calls).not.toContain("accept");
    expect(r.calls).not.toContain("listen");
    expect(r.marks).toEqual([]);
  });

  it("G asks for an answer on the answer key, with no Start", async () => {
    const r = rig();
    await r.assistant.load();
    r.assistant.key("answer");
    await settle();
    expect(r.asked.map((a) => a.trigger)).toEqual(["key"]);
    expect(r.answerSubs.size).toBe(1);
    expect(r.state().phase).toBe("idle");
  });

  it("G while listening answers from the words heard", async () => {
    const r = rig();
    await r.assistant.start();
    r.events().line(r.line("them", "We have a budget of ten.", 2_000));
    r.assistant.key("answer");
    await settle();
    expect(r.asked.at(-1)).toMatchObject({ trigger: "key", lines: [{ text: "We have a budget of ten." }] });
  });

  it("T counts a press, so the prompter takes the keyboard each time", () => {
    const r = rig();
    r.assistant.key("type");
    r.assistant.key("type");
    expect(r.state().typeKeyPresses).toBe(2);
    expect(r.asked).toEqual([]);
  });

  it("J and K scroll down and up, and leave the view as it is", () => {
    const r = rig();
    const moved: number[] = [];
    const off = r.assistant.onScroll((direction) => moved.push(direction));
    r.assistant.key("scrollDown");
    r.assistant.key("scrollUp");
    expect(moved).toEqual([1, -1]);
    expect(r.state().shown).toBe(false);
    off();
    r.assistant.key("scrollDown");
    expect(moved).toEqual([1, -1]);
  });

  it("the chat's button shows the assistant and goes back", () => {
    const r = rig();
    r.assistant.show(true);
    expect(r.state().shown).toBe(true);
    r.assistant.show(false);
    expect(r.state().shown).toBe(false);
  });
});

describe("the auto-answers switch", () => {
  const question = (r: ReturnType<typeof rig>) => r.events().line(r.line("them", "What does it cost?", 2_000));

  it("starts on, and a question from the other side is answered without a key", async () => {
    const r = rig();
    expect(r.state().autoAnswers).toBe(true);
    await r.assistant.start();
    question(r);
    await settle();
    expect(r.asked.map((a) => a.trigger)).toEqual(["question"]);
  });

  it("off, a question waits for the answer key", async () => {
    const r = rig();
    await r.assistant.start();
    r.assistant.setAutoAnswers(false);
    question(r);
    await settle();
    expect(r.asked).toEqual([]);
    expect(r.state().autoAnswers).toBe(false);
    r.assistant.key("answer");
    await settle();
    expect(r.asked.map((a) => a.trigger)).toEqual(["key"]);
  });

  it("keeps the switch as a setting, and reads it back at load", async () => {
    const written: boolean[] = [];
    const r = rig({ autoAnswers: { read: async () => false, write: async (on) => { written.push(on); } } });
    await r.assistant.load();
    expect(r.state().autoAnswers).toBe(false);
    await r.assistant.start();
    question(r);
    await settle();
    expect(r.asked).toEqual([]);
    r.assistant.setAutoAnswers(true);
    expect(written).toEqual([true]);
    r.events().line(r.line("them", "And when could you start?", 3_000));
    await settle();
    expect(r.asked.map((a) => a.trigger)).toEqual(["question"]);
  });

  it("starts on when the setting cannot be read", async () => {
    const r = rig({ autoAnswers: { read: async () => { throw new Error("no socket"); }, write: async () => {} } });
    await r.assistant.load();
    expect(r.state().autoAnswers).toBe(true);
  });
});
