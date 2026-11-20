import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The real `realmvoice` (native/RealmVoice.swift) on this Mac's recogniser, fed speech made by `say`:
 * nothing is played, no microphone is opened, and System Audio Recording is never read — the tests
 * hand the helper a grant that is not given, and REALM_VOICE_TAP_DRY_RUN stands where the tap would
 * be made. Runs where the helper is built and the speech model is already installed.
 */
const bin = process.env.REALM_VOICE_BIN ?? join(__dirname, "../../native/bin/realmvoice");
const runs = process.platform === "darwin" && existsSync(bin) && existsSync("/usr/bin/say");
const scratch = runs ? mkdtempSync(join(tmpdir(), "realmvoice-test-")) : "";
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

/** 16 kHz mono Int16 samples of `text`, spoken by `say` into a file. */
function speech(name: string, text: string): Buffer {
  const file = join(scratch, `${name}.wav`);
  execFileSync("/usr/bin/say", ["-o", file, "--data-format=LEI16@16000", text]);
  const wav = readFileSync(file);
  return wav.subarray(wav.indexOf("data") + 8);
}
const silence = (seconds: number) => Buffer.alloc(32_000 * seconds);

type Event = Record<string, unknown> & { t: string };

/** Starts the helper and answers its events once it has stopped, or null where the speech model is
 *  not installed (the test does not download it). */
async function transcribe(feed: (send: (line: unknown) => void) => void, { args = ["continuous"], grant = "not decided" } = {}) {
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, REALM_VOICE_SYSTEM_AUDIO: grant, REALM_VOICE_TAP_DRY_RUN: "1" } });
  const send = (line: unknown) => child.stdin.write(`${JSON.stringify(line)}\n`);
  const events: Event[] = [];
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const e = JSON.parse(line) as Event;
      if (e.t === "fetching") return null;
      events.push(e);
      if (e.t === "ready") feed(send);
      if (e.t === "stopped" || (args.length === 0 && e.t === "final")) break;
    }
  } finally {
    child.kill();
  }
  return events;
}

const audio = (source: string, samples: Buffer) => {
  const lines: unknown[] = [];
  for (let i = 0; i < samples.length; i += 3_200) lines.push({ t: "audio", source, pcm: samples.subarray(i, i + 3_200).toString("base64") });
  return lines;
};

type Line = { t: "line"; source: string; text: string; start: number; end: number; at: number };

describe.runIf(runs)("realmvoice continuous", () => {
  it("labels each line with its source, times it from the start, and carries on through a long silence", async (ctx) => {
    const me = Buffer.concat([speech("me-1", "Run the build and then run the tests."), silence(90), speech("me-2", "After that, open the pull request."), silence(1)]);
    const them = Buffer.concat([silence(1), speech("them", "Can you tell me how the pricing works for a team of twelve people?"), silence(1)]);
    const events = await transcribe((send) => {
      // The two sources interleaved, as two live feeds arrive.
      const a = audio("me", me), b = audio("them", them);
      for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) send(a[i]); if (b[i]) send(b[i]); }
      send({ t: "stop" });
    });
    if (!events) return ctx.skip();
    const ready = events[0] as Event & { startedAt: number };
    expect(ready).toMatchObject({ t: "ready", stt: "analyzer" });
    const lines = events.filter((e): e is Line => e.t === "line");
    const mine = lines.filter((l) => l.source === "me"), theirs = lines.filter((l) => l.source === "them");
    // THE MUTANT: a source's lines come out under the other's name.
    expect(mine.map((l) => l.text).join(" ")).toMatch(/build.*tests.*After that/i);
    expect(theirs.map((l) => l.text).join(" ")).toMatch(/pricing/i);
    expect(theirs.map((l) => l.text).join(" ")).not.toMatch(/build|after that/i);
    // THE MUTANT: no stop on silence — the recogniser ended after its first line, so 90 s of nothing
    // ended the transcript and the second sentence was never heard.
    const after = mine.find((l) => /after that/i.test(l.text))!;
    expect(after).toBeDefined();
    // THE MUTANT: times measured per line, or the offset dropped: the second sentence starts after
    // the 90 s of silence on the transcript's clock, and wall-clock time is that same instant.
    expect(after.start).toBeGreaterThan(90_000);
    for (const line of lines) {
      expect(line.end).toBeGreaterThan(line.start);
      expect(line.at).toBe(ready.startedAt + line.start);
    }
    for (const source of [mine, theirs]) {
      for (let i = 1; i < source.length; i++) expect(source[i]!.start).toBeGreaterThanOrEqual(source[i - 1]!.end);
    }
    expect(theirs[0]!.start).toBeGreaterThanOrEqual(500);
  }, 60_000);

  it("makes no tap without System Audio Recording, says why, and keeps transcribing", async (ctx) => {
    for (const [grant, state] of [["not decided", "needs permission"], ["denied", "denied"]]) {
      const events = await transcribe((send) => {
        send({ t: "tap" });
        for (const l of audio("me", speech("still", "Still listening."))) send(l);
        send({ t: "stop" });
      }, { grant });
      if (!events) return ctx.skip();
      expect(events.find((e) => e.t === "ready")).toMatchObject({ systemAudio: grant });
      // THE MUTANT: the grant check before the tap is gone, so the tap would be made (and macOS
      // would ask): the dry run says "dry run" where the real tap would have been created.
      expect(events.filter((e) => e.t === "tap")).toEqual([expect.objectContaining({ t: "tap", state })]);
      expect(events.some((e) => e.t === "line" && /still listening/i.test(String(e.text)))).toBe(true);
    }
  }, 60_000);

  it("leaves dictation as it was: no arguments is one utterance, finished on end", async (ctx) => {
    const events = await transcribe((send) => {
      send({ t: "listen", turn: 1 });
      for (const l of audio("me", speech("dictate", "Fix the login test."))) send({ t: "audio", pcm: (l as { pcm: string }).pcm });
      send({ t: "end" });
    }, { args: [] });
    if (!events) return ctx.skip();
    expect(events[0]).toEqual({ t: "ready", stt: "analyzer" });
    expect(events.at(-1)).toMatchObject({ t: "final", turn: 1, text: expect.stringMatching(/login test/i) });
    expect(events.some((e) => e.t === "line")).toBe(false);
  }, 60_000);
});
