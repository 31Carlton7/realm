import { describe, expect, it } from "vitest";
import type { VoiceAudio } from "./audio-io";
import { MeetingTranscript, type TranscriptEvent, type TranscriptHelper, type TranscriptLine, type TranscriptSource, type TranscriptStart } from "./transcript";

function fakes(opts: { grant?: string; ready?: TranscriptStart | Promise<TranscriptStart>; systemAudio?: boolean } = {}) {
  const sent: { source: TranscriptSource; samples: number }[] = [];
  const calls: string[] = [];
  const listeners = new Set<(e: TranscriptEvent) => void>();
  const emit = (e: TranscriptEvent) => { for (const l of [...listeners]) l(e); };
  let frame: (level: number, samples: Int16Array) => void = () => {};
  const helper: TranscriptHelper = {
    microphone: async () => opts.grant ?? "granted",
    start: async () => opts.ready ?? { t: "ready", stt: "analyzer", startedAt: 1_000, systemAudio: "not decided" },
    audio: (source, pcm) => sent.push({ source, samples: pcm.byteLength / 2 }),
    systemAudio: () => calls.push("systemAudio"),
    finish: () => calls.push("finish"),
    stop: () => calls.push("stop"),
    onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
  const audio = {
    start: async (cb: typeof frame) => { calls.push("mic started"); frame = cb; },
    stop: () => calls.push("mic stopped"),
  } as unknown as VoiceAudio;
  const seen = { lines: [] as TranscriptLine[], partials: [] as string[], systemAudio: [] as string[], problems: [] as string[], ended: 0 };
  const t = new MeetingTranscript({
    helper, audio, systemAudio: opts.systemAudio ?? true,
    events: {
      line: (l) => seen.lines.push(l),
      partial: (source, text) => seen.partials.push(`${source}: ${text}`),
      systemAudio: (state) => seen.systemAudio.push(state),
      problem: (m) => seen.problems.push(m),
      ended: () => { seen.ended++; },
    },
  });
  const frames = (count: number, value = 0) => { for (let i = 0; i < count; i++) frame(0, new Int16Array(1024).fill(value)); };
  return { t, sent, calls, seen, frames, emit };
}

describe("MeetingTranscript", () => {
  it("sends the microphone to the helper as \"me\", a tenth of a second at a time", async () => {
    const f = fakes();
    await f.t.start();
    f.frames(4);
    // THE MUTANT: the microphone's samples go out as "them".
    expect(f.sent.map((s) => s.source)).toEqual(["me", "me"]);
    expect(f.sent.every((s) => s.samples >= 1_600)).toBe(true);
  });

  it("hands every line on with its source and its times, as the helper sent them", async () => {
    const f = fakes();
    await f.t.start();
    f.emit({ t: "partial", source: "them", text: "can you", start: 400 });
    f.emit({ t: "line", source: "them", text: "Can you tell me the price?", start: 400, end: 3_100, at: 1_400 });
    f.emit({ t: "line", source: "me", text: "Sure.", start: 3_500, end: 4_200, at: 4_500 });
    expect(f.seen.partials).toEqual(["them: can you"]);
    expect(f.seen.lines).toEqual([
      { source: "them", text: "Can you tell me the price?", start: 400, end: 3_100, at: 1_400 },
      { source: "me", text: "Sure.", start: 3_500, end: 4_200, at: 4_500 },
    ]);
  });

  it("keeps going through minutes of silence: only stop ends it", async () => {
    const f = fakes();
    await f.t.start();
    // Five minutes of nothing at 48 kHz, in 1024-sample frames.
    f.frames(Math.ceil((5 * 60 * 48_000) / 1024));
    expect(f.calls).not.toContain("finish");
    expect(f.calls).not.toContain("mic stopped");
    f.emit({ t: "line", source: "me", text: "Still here.", start: 300_000, end: 301_000, at: 301_000 });
    expect(f.seen.lines.map((l) => l.text)).toEqual(["Still here."]);
  });

  it("asks for the other side only when told to, and reports why it is not heard", async () => {
    const off = fakes({ systemAudio: false });
    await off.t.start();
    expect(off.calls).not.toContain("systemAudio");

    const on = fakes();
    await on.t.start();
    expect(on.calls).toContain("systemAudio");
    on.emit({ t: "tap", state: "needs permission" });
    expect(on.seen.systemAudio).toEqual(["needs permission"]);
    // The microphone goes on: the transcript is not stopped for want of the other side.
    expect(on.calls).not.toContain("finish");
  });

  it("stops: the last samples go out, the helper finishes its lines, then everything is let go", async () => {
    const f = fakes();
    await f.t.start();
    f.frames(1);
    const stopping = f.t.stop();
    expect(f.sent).toHaveLength(1);
    expect(f.calls).toEqual(["mic started", "systemAudio", "mic stopped", "finish"]);
    f.emit({ t: "line", source: "me", text: "Bye.", start: 0, end: 500, at: 1_000 });
    f.emit({ t: "stopped" });
    await stopping;
    expect(f.seen.lines.map((l) => l.text)).toEqual(["Bye."]);
    expect(f.calls.at(-1)).toBe("stop");
  });

  it("stops when the helper exits before it says \"stopped\"", async () => {
    const f = fakes();
    await f.t.start();
    const stopping = f.t.stop();
    // THE MUTANT: only "stopped" ends a stop, and this await never returns.
    f.emit({ t: "error", message: "The speech helper stopped." });
    await stopping;
    expect(f.seen.problems).toEqual(["The speech helper stopped."]);
    expect(f.calls.at(-1)).toBe("stop");
    f.emit({ t: "line", source: "me", text: "Late.", start: 0, end: 500, at: 1_000 });
    expect(f.seen.lines).toEqual([]);
  });

  it("stops when stop comes before the helper is ready, and it has no recogniser", async () => {
    let ready!: (r: TranscriptStart) => void;
    const f = fakes({ ready: new Promise((r) => { ready = r; }) });
    const starting = f.t.start();
    await new Promise((r) => setTimeout(r, 0));
    const stopping = f.t.stop();
    ready({ t: "ready", stt: "none", startedAt: 1_000, systemAudio: "not decided" });
    await starting;
    // THE MUTANT: the teardown a failed start does leaves the stop unresolved.
    await stopping;
    expect(f.calls).not.toContain("mic started");
    expect(f.calls.at(-1)).toBe("stop");
  });

  it("stops when stop comes before the helper is asked to start", async () => {
    const f = fakes();
    const starting = f.t.start();
    const stopping = f.t.stop();
    await starting;
    // THE MUTANT: start goes on to the helper, which never heard the finish and never says "stopped".
    await stopping;
    expect(f.calls).not.toContain("mic started");
    expect(f.calls.at(-1)).toBe("stop");
  });

  it("does not open the microphone when stop came while the helper was starting", async () => {
    let ready!: (r: TranscriptStart) => void;
    const f = fakes({ ready: new Promise((r) => { ready = r; }) });
    const starting = f.t.start();
    await new Promise((r) => setTimeout(r, 0));
    void f.t.stop();
    ready({ t: "ready", stt: "analyzer", startedAt: 1_000, systemAudio: "granted" });
    await starting;
    // THE MUTANT: start carries on past a stop, and the microphone opens after it.
    expect(f.calls).not.toContain("mic started");
    expect(f.calls).not.toContain("systemAudio");
  });

  it("goes on through an error the helper sends before it is ready", async () => {
    let ready!: (r: TranscriptStart) => void;
    const f = fakes({ ready: new Promise((r) => { ready = r; }) });
    const starting = f.t.start();
    await new Promise((r) => setTimeout(r, 0));
    f.emit({ t: "error", message: "The speech model for en_US could not be installed: offline" });
    ready({ t: "ready", stt: "analyzer", startedAt: 1_000, systemAudio: "not decided" });
    await starting;
    // THE MUTANT: any error with no source is taken for the helper exiting.
    expect(f.calls).toContain("mic started");
    expect(f.seen.problems).toHaveLength(1);
  });

  it("does not start without the microphone, or without a recogniser", async () => {
    const denied = fakes({ grant: "denied" });
    await denied.t.start();
    expect(denied.seen.problems[0]).toMatch(/not allowed to use the microphone/);
    expect(denied.calls).not.toContain("systemAudio");

    const none = fakes({ ready: { t: "unavailable", reason: "no helper" } });
    await none.t.start();
    expect(none.seen.problems).toEqual(["no helper"]);
  });

  it("says it ended once, whether it was stopped or could not start", async () => {
    const stopped = fakes();
    await stopped.t.start();
    const stopping = stopped.t.stop();
    stopped.emit({ t: "stopped" });
    await stopping;
    stopped.emit({ t: "stopped" });
    expect(stopped.seen.ended).toBe(1);

    const denied = fakes({ grant: "denied" });
    await denied.t.start();
    expect(denied.seen.ended).toBe(1);
  });
});
