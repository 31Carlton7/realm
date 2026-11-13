import { describe, expect, it } from "vitest";
import type { VoiceAudio } from "./audio-io";
import { DICTATION_PAUSE_MS, Dictation, type DictationEvents } from "./dictation";
import type { HelperCommand, HelperEvent, HelperStart, SpeechHelper } from "./protocol";

function fakes(opts: { grant?: string; ready?: HelperStart } = {}) {
  const commands: HelperCommand[] = [];
  const audioSent: Uint8Array[] = [];
  let emit: (e: HelperEvent) => void = () => {};
  let frame: (level: number, samples: Int16Array) => void = () => {};
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
    start: async (cb: typeof frame) => { frame = cb; },
    stop: () => { life.micStopped = true; },
  } as unknown as VoiceAudio;
  const seen = { partials: [] as string[], settled: [] as number[], levels: [] as number[], done: [] as string[], problems: [] as string[] };
  const events: DictationEvents = {
    partial: (t, settled) => { seen.partials.push(t); seen.settled.push(settled); },
    fetching: () => {},
    level: (l) => seen.levels.push(l),
    done: (t) => seen.done.push(t),
    problem: (m) => seen.problems.push(m),
  };
  let now = 0;
  const d = new Dictation({ helper, audio, events, now: () => now });
  const frames = (level: number, ms: number) => { for (let t = 0; t < ms; t += 64) { now += 64; frame(level, new Int16Array(1024)); } };
  return { d, commands, audioSent, seen, life, frames, emit: (e: HelperEvent) => emit(e) };
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

  it("stops on its own after a long pause once words were heard, never before the first word", async () => {
    const f = fakes();
    await f.d.start();
    f.frames(0.001, 400);
    f.frames(0.001, DICTATION_PAUSE_MS + 500);
    expect(f.commands.some((c) => c.t === "end")).toBe(false);
    f.frames(0.2, 600);
    f.emit({ t: "partial", turn: 1, text: "run the build" });
    f.frames(0.001, DICTATION_PAUSE_MS - 300);
    expect(f.commands.some((c) => c.t === "end")).toBe(false);
    f.frames(0.001, 600);
    expect(f.commands.at(-1)).toEqual({ t: "end" });
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
