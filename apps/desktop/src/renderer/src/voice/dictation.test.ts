import { describe, expect, it } from "vitest";
import type { VoiceAudio } from "./audio-io";
import { Dictation, type DictationEvents } from "./dictation";
import type { HelperCommand, HelperEvent, HelperStart, SpeechHelper } from "./protocol";

function fakes(opts: { grant?: string; ready?: HelperStart; micFails?: string } = {}) {
  const commands: HelperCommand[] = [];
  const audioSent: Uint8Array[] = [];
  let emit: (e: HelperEvent) => void = () => {};
  let frame: (level: number, samples: Int16Array) => void = () => {};
  let lost: () => void = () => {};
  const life = { helperStopped: false, micStopped: false };
  const helper: SpeechHelper = {
    microphone: async () => opts.grant ?? "granted",
    start: async () => opts.ready ?? { t: "ready", stt: "analyzer" },
    command: (c) => commands.push(c),
    audio: (pcm) => audioSent.push(pcm),
    stop: () => { life.helperStopped = true; },
    onEvent: (cb) => { emit = cb; return () => { emit = () => {}; }; },
  };
  const audio = {
    start: async (cb: typeof frame, onLost?: () => void) => {
      if (opts.micFails) throw new Error(opts.micFails);
      frame = cb;
      lost = onLost ?? (() => {});
    },
    stop: () => { life.micStopped = true; },
  } as unknown as VoiceAudio;
  const seen = { partials: [] as string[], settled: [] as number[], levels: [] as number[], done: [] as string[], problems: [] as string[], heardAtProblem: [] as string[] };
  const events: DictationEvents = {
    partial: (t, settled) => { seen.partials.push(t); seen.settled.push(settled); },
    fetching: () => {},
    level: (l) => seen.levels.push(l),
    done: (t) => seen.done.push(t),
    problem: (m, heard) => { seen.problems.push(m); seen.heardAtProblem.push(heard); },
  };
  let now = 0;
  const d = new Dictation({ helper, audio, events, now: () => now });
  const frames = (level: number, ms: number) => { for (let t = 0; t < ms; t += 64) { now += 64; frame(level, new Int16Array(1024)); } };
  return { d, commands, audioSent, seen, life, frames, emit: (e: HelperEvent) => emit(e), loseMic: () => lost() };
}

describe("Dictation", () => {
  it("listens from the click, hands the audio to the helper on this Mac, and finishes on stop", async () => {
    const f = fakes();
    await f.d.start();
    expect(f.commands).toEqual([{ t: "listen", turn: 1 }]);
    f.frames(0.1, 300);
    expect(f.audioSent.length).toBeGreaterThan(0);
    f.emit({ t: "partial", turn: 1, text: "fix the" });
    expect(f.seen.partials.at(-1)).toBe("fix the");
    f.d.stop();
    expect(f.commands.at(-1)).toEqual({ t: "end" });
    expect(f.life.micStopped).toBe(true);
    f.emit({ t: "final", turn: 1, text: " fix the login test " });
    expect(f.seen.done).toEqual(["fix the login test"]);
    expect(f.life.helperStopped).toBe(true);
  });

  it("keeps listening through any pause, before the first word or after it", async () => {
    const f = fakes();
    await f.d.start();
    f.frames(0.001, 10_000);
    f.frames(0.2, 600);
    f.emit({ t: "partial", turn: 1, text: "run the build" });
    f.frames(0.001, 60_000);
    expect(f.commands).toEqual([{ t: "listen", turn: 1 }]);
    expect(f.life.micStopped).toBe(false);
    expect(f.seen.done).toEqual([]);
  });

  it("starts the recogniser again when it ends on its own, keeping what it heard", async () => {
    const f = fakes();
    await f.d.start();
    f.emit({ t: "partial", turn: 1, text: "run the build", settled: 4 });
    f.frames(0.001, 5_000);
    f.emit({ t: "final", turn: 1, text: "run the build" });
    expect(f.seen.done).toEqual([]);
    expect(f.commands.at(-1)).toEqual({ t: "listen", turn: 2 });
    expect(f.life.micStopped).toBe(false);
    expect(f.life.helperStopped).toBe(false);
    expect(f.seen.partials.at(-1)).toBe("run the build");
    // A late word from the utterance that ended is not heard twice.
    f.emit({ t: "partial", turn: 1, text: "run the build again" });
    expect(f.seen.partials.at(-1)).toBe("run the build");
    f.emit({ t: "partial", turn: 2, text: "and the tests", settled: 3 });
    expect(f.seen.partials.at(-1)).toBe("run the build and the tests");
    expect(f.seen.settled.at(-1)).toBe("run the build and".length);
    f.frames(0.001, 5_000);
    f.emit({ t: "final", turn: 2, text: "and the tests" });
    expect(f.commands.at(-1)).toEqual({ t: "listen", turn: 3 });
    f.d.stop();
    expect(f.commands.at(-1)).toEqual({ t: "end" });
    f.emit({ t: "final", turn: 3, text: "" });
    expect(f.seen.done).toEqual(["run the build and the tests"]);
    expect(f.life.helperStopped).toBe(true);
  });

  it("gives up with a problem when the recogniser keeps ending as soon as it starts", async () => {
    const f = fakes();
    await f.d.start();
    f.emit({ t: "partial", turn: 1, text: "hello" });
    f.frames(0.001, 5_000);
    for (let turn = 1; turn <= 3; turn++) {
      expect(f.seen.problems).toEqual([]);
      f.emit({ t: "final", turn, text: turn === 1 ? "hello" : "" });
      f.frames(0.001, 64);
    }
    expect(f.commands.filter((c) => c.t === "listen").length).toBe(4);
    f.emit({ t: "final", turn: 4, text: "" });
    expect(f.seen.problems).toEqual([expect.stringMatching(/keeps stopping/)]);
    expect(f.seen.heardAtProblem).toEqual(["hello"]);
    expect(f.life.micStopped).toBe(true);
    expect(f.life.helperStopped).toBe(true);
  });

  it("stops, keeping what was heard, when the microphone goes away", async () => {
    const f = fakes();
    await f.d.start();
    f.emit({ t: "partial", turn: 1, text: "fix the" });
    f.loseMic();
    expect(f.life.micStopped).toBe(true);
    expect(f.commands.at(-1)).toEqual({ t: "end" });
    f.emit({ t: "final", turn: 1, text: "fix the" });
    expect(f.seen.done).toEqual(["fix the"]);
  });

  it("stops with the helper's problem when the recogniser breaks", async () => {
    const f = fakes();
    await f.d.start();
    f.emit({ t: "error", message: "The speech helper stopped." });
    expect(f.seen.problems).toEqual(["The speech helper stopped."]);
    expect(f.seen.heardAtProblem).toEqual([""]);
    expect(f.life.micStopped).toBe(true);
  });

  it("hands over what was heard, kept words and the last partial, when the helper breaks minutes in", async () => {
    const f = fakes();
    await f.d.start();
    f.emit({ t: "partial", turn: 1, text: "run the build" });
    f.frames(0.001, 5_000);
    f.emit({ t: "final", turn: 1, text: "run the build" });
    f.emit({ t: "partial", turn: 2, text: "and the tests", settled: 3 });
    f.frames(0.1, 300_000);
    f.emit({ t: "error", message: "Transcription stopped: boom" });
    expect(f.seen.problems).toEqual(["Transcription stopped: boom"]);
    expect(f.seen.heardAtProblem).toEqual(["run the build and the tests"]);
    expect(f.seen.done).toEqual([]);
    expect(f.life.helperStopped).toBe(true);
  });

  it("lands the words once when the helper sends its error and then the turn's final", async () => {
    const f = fakes();
    await f.d.start();
    f.emit({ t: "partial", turn: 1, text: "fix the login" });
    // RealmVoice.swift: a throwing analyzer emits `error`, then `final` with the same words.
    f.emit({ t: "error", message: "Transcription stopped: boom" });
    f.emit({ t: "final", turn: 1, text: "fix the login" });
    expect(f.seen.heardAtProblem).toEqual(["fix the login"]);
    expect(f.seen.problems.length).toBe(1);
    expect(f.seen.done).toEqual([]);
  });

  it("hands over what was heard when the helper breaks while finishing after stop", async () => {
    const f = fakes();
    await f.d.start();
    f.emit({ t: "partial", turn: 1, text: "fix the login" });
    f.d.stop();
    f.emit({ t: "error", message: "Transcription stopped: boom" });
    expect(f.seen.heardAtProblem).toEqual(["fix the login"]);
    expect(f.seen.done).toEqual([]);
  });

  it("says why when the microphone will not open", async () => {
    const f = fakes({ micFails: "Permission denied" });
    await f.d.start();
    expect(f.seen.problems).toEqual(["The microphone did not start: Permission denied"]);
    expect(f.life.helperStopped).toBe(true);
  });

  it("says why when the microphone is not allowed, and opens nothing", async () => {
    const f = fakes({ grant: "denied" });
    await f.d.start();
    expect(f.seen.problems[0]).toMatch(/not allowed to use the microphone/);
    expect(f.commands).toEqual([]);
  });

  it("cancel drops what was heard", async () => {
    const f = fakes();
    await f.d.start();
    f.d.cancel();
    expect(f.commands.at(-1)).toEqual({ t: "cancel" });
    f.emit({ t: "final", turn: 1, text: "late" });
    expect(f.seen.done).toEqual([]);
  });

  it("passes on how much of what was heard is final, and the microphone's level", async () => {
    const f = fakes();
    await f.d.start();
    f.emit({ t: "partial", turn: 1, text: "fix the login", settled: 8 });
    expect(f.seen.settled.at(-1)).toBe(8);
    // A recogniser that says nothing of it: nothing is final until the end.
    f.emit({ t: "partial", turn: 1, text: "fix the login test" });
    expect(f.seen.settled.at(-1)).toBe(0);
    f.emit({ t: "partial", turn: 1, text: "fix", settled: 40 });
    expect(f.seen.settled.at(-1)).toBe(3);
    f.frames(0.05, 64);
    expect(f.seen.levels).toEqual([0.05]);
  });
});
