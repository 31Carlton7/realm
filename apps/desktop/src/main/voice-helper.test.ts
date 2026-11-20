import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { TranscriptHelper, VoiceHelper, type VoiceOwner } from "./voice-helper";

/** A helper process that never runs: what main writes to it is kept, and `say` is its stdout. */
function fakeSpawn() {
  const runs: { args: readonly string[]; written: Record<string, unknown>[]; say(line: unknown): void }[] = [];
  const spawnHelper = ((_bin: string, args: readonly string[]) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    const run = { args, written: [] as Record<string, unknown>[], say: (line: unknown) => child.stdout.write(`${JSON.stringify(line)}\n`) };
    child.stdin.on("data", (d: Buffer) => { for (const l of d.toString().split("\n").filter(Boolean)) run.written.push(JSON.parse(l)); });
    runs.push(run);
    return child;
  }) as unknown as typeof spawn;
  return { spawnHelper, runs };
}

function owner(id = 1) {
  const sent: { channel: string; event: Record<string, unknown> }[] = [];
  const o: VoiceOwner = { id, isDestroyed: () => false, send: (channel, event) => sent.push({ channel, event: event as Record<string, unknown> }) };
  return { o, sent };
}

const flush = () => new Promise((r) => setImmediate(r));
const ready = (systemAudio: string) => ({ t: "ready", stt: "analyzer", startedAt: 1_795_000_000_000, systemAudio });

describe("VoiceHelper (dictation)", () => {
  it("starts the helper as dictation always has: no arguments, its own channel, its own commands", async () => {
    const f = fakeSpawn();
    const voice = new VoiceHelper(() => "/bin/realmvoice", f.spawnHelper);
    const { o, sent } = owner();
    const started = voice.start(o);
    f.runs[0]!.say({ t: "ready", stt: "analyzer" });
    expect(await started).toEqual({ t: "ready", stt: "analyzer" });
    expect(f.runs[0]!.args).toEqual([]);
    voice.command(o, { t: "listen", turn: 1 });
    voice.command(o, { t: "stop" });
    voice.audio(o, new Uint8Array([1, 0]));
    f.runs[0]!.say({ t: "final", turn: 1, text: "hi" });
    await flush();
    expect(f.runs[0]!.written).toEqual([{ t: "listen", turn: 1 }, { t: "audio", pcm: "AQA=" }]);
    expect(sent).toEqual([{ channel: "realm:voice", event: { t: "final", turn: 1, text: "hi" } }]);
  });
});

describe("TranscriptHelper (a meeting's transcript)", () => {
  async function started(systemAudio: string) {
    const f = fakeSpawn();
    const transcript = new TranscriptHelper(() => "/bin/realmvoice", f.spawnHelper);
    const w = owner();
    const start = transcript.start(w.o);
    f.runs[0]!.say(ready(systemAudio));
    await start;
    return { transcript, run: f.runs[0]!, ...w };
  }

  it("runs the helper's continuous mode, and sends each source's samples under its own name", async () => {
    const { transcript, run, o } = await started("not decided");
    expect(run.args).toEqual(["continuous"]);
    transcript.sourceAudio(o, "me", new Uint8Array([1, 0]));
    transcript.sourceAudio(o, "them", new Uint8Array([2, 0]));
    transcript.sourceAudio(o, "everyone", new Uint8Array([3, 0]));
    transcript.sourceAudio(owner(2).o, "me", new Uint8Array([4, 0]));
    await flush();
    // THE MUTANT: a source's name is dropped, or swapped, on the way to the helper.
    expect(run.written).toEqual([{ t: "audio", source: "me", pcm: "AQA=" }, { t: "audio", source: "them", pcm: "AgA=" }]);
  });

  it("passes lines through to the window untouched: source, text, start, end and wall-clock time", async () => {
    const { run, sent } = await started("not decided");
    const line = { t: "line", source: "them", text: "Can you tell me the price?", start: 388, end: 4_048, at: 1_795_000_000_388 };
    run.say(line);
    await flush();
    expect(sent).toEqual([{ channel: "realm:transcript", event: line }]);
  });

  it("only lets the window stop it, never dictation's commands", async () => {
    const { transcript, run, o } = await started("not decided");
    transcript.command(o, { t: "listen", turn: 1 });
    transcript.command(o, { t: "tap" });
    transcript.command(o, { t: "stop" });
    await flush();
    expect(run.written).toEqual([{ t: "stop" }]);
  });

  it("without System Audio Recording, makes no tap and says it needs permission", async () => {
    for (const [grant, state] of [["not decided", "needs permission"], ["denied", "denied"]] as const) {
      const { transcript, run, o, sent } = await started(grant);
      await transcript.systemAudio(o);
      await flush();
      // THE MUTANT: the tap is asked for whatever the grant — which is what raises macOS's prompt.
      expect(run.written, grant).toEqual([]);
      expect(sent, grant).toEqual([{ channel: "realm:transcript", event: { t: "tap", state } }]);
    }
  });

  it("with System Audio Recording granted, asks the helper for the tap", async () => {
    const { transcript, run, o, sent } = await started("granted");
    await transcript.systemAudio(o);
    await flush();
    expect(run.written).toEqual([{ t: "tap" }]);
    expect(sent).toEqual([]);
  });
});
