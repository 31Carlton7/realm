import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyTranscript, type Block, type PendingPermission, type Transcript } from "../panes/session/transcript-model";
import type { VoiceAudio } from "./audio-io";
import type { HelperCommand, HelperEvent, SpeechHelper } from "./protocol";
import { DEFAULT_VOICE_PREFS, type VoicePrefs } from "./voice-prefs";
import { VoiceSession } from "./voice-session";

/** The helper: records what it was told and lets the test say what it heard. */
class FakeHelper implements SpeechHelper {
  commands: HelperCommand[] = [];
  audioBytes = 0;
  grant = "granted";
  private cb: ((e: HelperEvent) => void) | null = null;
  microphone = async () => this.grant;
  start = async () => ({ t: "ready" as const, stt: "analyzer" as const, voice: "v", voices: [] });
  command = (c: HelperCommand) => { this.commands.push(c); };
  audio = (pcm: Uint8Array) => { this.audioBytes += pcm.byteLength; };
  stop = () => {};
  onEvent = (cb: (e: HelperEvent) => void) => { this.cb = cb; return () => { this.cb = null; }; };
  emit(e: HelperEvent) { this.cb?.(e); }
  get turn(): number { return [...this.commands].reverse().find((c): c is Extract<HelperCommand, { t: "listen" }> => c.t === "listen")?.turn ?? 0; }
  types(): string[] { return this.commands.map((c) => c.t); }
  spoken(): string[] { return this.commands.flatMap((c) => (c.t === "speak" ? [c.text] : [])); }
}

/** The audio graph: frames are pushed by the test; Realm "talks" while `talking` is set. */
class FakeAudio implements VoiceAudio {
  talking = false;
  ducked = false;
  hushes = 0;
  played = 0;
  private onFrame: ((level: number, samples: Int16Array) => void) | null = null;
  async start(onFrame: (level: number, samples: Int16Array) => void) { this.onFrame = onFrame; }
  play() { this.played += 1; this.talking = true; }
  hush() { this.hushes += 1; this.talking = false; this.ducked = false; }
  duck(on: boolean) { this.ducked = on; }
  wave() { return false; }
  stop() {}
  frames(level: number, ms: number) { for (let t = 0; t < ms; t += 20) { clock.now += 20; this.onFrame?.(level, new Int16Array(320)); } }
}

class FakeSession {
  t: Transcript = emptyTranscript();
  isBusy = false;
  sent: string[] = [];
  interrupts = 0;
  decided: { requestId: string; decision: string }[] = [];
  private listeners = new Set<() => void>();
  port = {
    transcript: () => this.t,
    busy: () => this.isBusy,
    subscribe: (cb: () => void) => { this.listeners.add(cb); return () => this.listeners.delete(cb); },
    send: async (text: string) => { this.sent.push(text); },
    interrupt: async () => { this.interrupts += 1; },
    decide: async (requestId: string, decision: "allow" | "deny") => { this.decided.push({ requestId, decision }); },
  };
  set(blocks: Block[], pendingPermissions: PendingPermission[] = []) { this.t = { ...emptyTranscript(), blocks, pendingPermissions }; for (const cb of this.listeners) cb(); }
}

const clock = { now: 0 };
let live: VoiceSession | null = null;
afterEach(() => { live?.stop(); live = null; vi.useRealTimers(); });

async function boot(prefs: Partial<VoicePrefs> = {}) {
  const helper = new FakeHelper(), audio = new FakeAudio(), session = new FakeSession();
  const vs = new VoiceSession({ helper, audio, session: session.port, agentName: "Mina", prefs: () => ({ ...DEFAULT_VOICE_PREFS, ...prefs }), now: () => clock.now });
  live = vs;
  await vs.start();
  return { vs, helper, audio, session };
}

const VOICE = 0.1, QUIET = 0.001;

describe("VoiceSession", () => {
  it("turns a hands-free turn into a spoken message, sent after the pause", async () => {
    const { helper, audio, session } = await boot();
    audio.frames(QUIET, 400);
    audio.frames(VOICE, 600);
    expect(helper.types()).toContain("listen");
    // The pre-roll went with the turn: the first syllable is not clipped off.
    expect(helper.audioBytes).toBeGreaterThanOrEqual(16_000 * 0.4 * 2 * 0.9);
    helper.emit({ t: "partial", turn: helper.turn, text: "what changed" });
    audio.frames(QUIET, 800);
    expect(helper.types().at(-1)).toBe("end");
    helper.emit({ t: "final", turn: helper.turn, text: "What changed today?" });
    await vi.waitFor(() => expect(session.sent).toEqual(["What changed today?"]));
  });

  it("ignores a final from an older turn", async () => {
    const { helper, audio, session } = await boot();
    audio.frames(QUIET, 300);
    audio.frames(VOICE, 300);
    const old = helper.turn;
    audio.frames(QUIET, 800);
    audio.frames(VOICE, 300);
    // THE MUTANT: no turn check — a late final from the last utterance is sent in this one's place.
    helper.emit({ t: "final", turn: old, text: "stale words" });
    await Promise.resolve();
    expect(session.sent).toEqual([]);
  });

  it("reads the reply back as it streams, and nothing that was there before", async () => {
    const { helper, session } = await boot();
    session.set([{ kind: "user", text: "q", spoken: true, ts: 0 }, { kind: "assistant", messageId: "m", text: "It is four. And", streaming: true, ts: 0 }]);
    expect(helper.spoken()).toEqual(["It is four."]);
  });

  it("barges in in two steps: down at once, stopped only when real words arrive", async () => {
    const { helper, audio, session } = await boot();
    session.set([{ kind: "assistant", messageId: "m", text: "A long answer that goes on. And on", streaming: true, ts: 0 }]);
    const said = helper.spoken();
    expect(said.length).toBe(1);
    helper.emit({ t: "audio", id: "s1", rate: 22050, pcm: "AAAA" });
    expect(audio.talking).toBe(true);
    audio.frames(QUIET, 400);
    audio.frames(VOICE, 400);
    // Down, not stopped: it might be a cough.
    expect(audio.ducked).toBe(true);
    expect(audio.hushes).toBe(0);
    // Its own echo does not count.
    helper.emit({ t: "partial", turn: helper.turn, text: "a long answer" });
    expect(audio.hushes).toBe(0);
    // THE MUTANT: the partial is never checked — Realm talks over the person until they finish.
    helper.emit({ t: "partial", turn: helper.turn, text: "wait actually" });
    expect(audio.hushes).toBe(1);
    expect(helper.types()).toContain("hush");
    // And the rest of that reply is not read once it has been interrupted.
    session.set([{ kind: "assistant", messageId: "m", text: "A long answer that goes on. And on and on. More.", streaming: false, ts: 0 }]);
    expect(helper.spoken()).toEqual(said);
  });

  it("turns Realm back up when what interrupted it was only its own echo", async () => {
    const { helper, audio, session } = await boot();
    session.set([{ kind: "assistant", messageId: "m", text: "Two plus two is four. ", streaming: true, ts: 0 }]);
    helper.emit({ t: "audio", id: "s1", rate: 22050, pcm: "AAAA" });
    audio.frames(QUIET, 400);
    audio.frames(VOICE, 400);
    expect(audio.ducked).toBe(true);
    audio.frames(QUIET, 800);
    helper.emit({ t: "final", turn: helper.turn, text: "two is four" });
    await Promise.resolve();
    // THE MUTANT: an echo-only utterance is sent as a message — Realm answers itself.
    expect(session.sent).toEqual([]);
    expect(audio.ducked).toBe(false);
    expect(audio.hushes).toBe(0);
  });

  it("push-to-talk: a press stops Realm at once, and the release sends", async () => {
    const { vs, helper, audio, session } = await boot({ handsFree: false });
    session.set([{ kind: "assistant", messageId: "m", text: "Talking now. ", streaming: true, ts: 0 }]);
    helper.emit({ t: "audio", id: "s1", rate: 22050, pcm: "AAAA" });
    // Hands-free off: talking over it does nothing.
    audio.frames(VOICE, 600);
    expect(helper.types()).not.toContain("listen");
    vs.press();
    expect(audio.hushes).toBe(1);
    audio.frames(QUIET, 2000);
    expect(helper.types().at(-1)).not.toBe("end");
    vs.release();
    expect(helper.types().at(-1)).toBe("end");
    helper.emit({ t: "final", turn: helper.turn, text: "Use the other branch" });
    await vi.waitFor(() => expect(session.sent).toEqual(["Use the other branch"]));
  });

  it("answers a permission with yes or no, and reads it first", async () => {
    const { vs, helper, session } = await boot();
    const p: PendingPermission = { requestId: "r1", toolName: "Bash", input: {}, title: "Run `pnpm build`" };
    session.set([], [p]);
    expect(helper.spoken()).toEqual(["Mina asks to run pnpm build. Say yes or no."]);
    vs.press(); vs.release();
    helper.emit({ t: "final", turn: helper.turn, text: "Yes." });
    // THE MUTANT: the answer goes as a message, and the card waits forever.
    await vi.waitFor(() => expect(session.decided).toEqual([{ requestId: "r1", decision: "allow" }]));
    expect(session.sent).toEqual([]);
    vs.press(); vs.release();
    session.set([], [{ ...p, requestId: "r2" }]);
    helper.emit({ t: "final", turn: helper.turn, text: "no" });
    await vi.waitFor(() => expect(session.decided.at(-1)).toEqual({ requestId: "r2", decision: "deny" }));
  });

  it("stops Realm and the agent's turn on \"stop\", and sends nothing", async () => {
    const { vs, helper, audio, session } = await boot();
    session.isBusy = true;
    vs.press(); vs.release();
    helper.emit({ t: "final", turn: helper.turn, text: "Stop." });
    await vi.waitFor(() => expect(session.interrupts).toBe(1));
    expect(audio.hushes).toBeGreaterThan(0);
    expect(session.sent).toEqual([]);
  });

  it("never plays a sentence that was hushed", async () => {
    const { vs, helper, audio, session } = await boot();
    session.set([{ kind: "assistant", messageId: "m", text: "One. Two. ", streaming: true, ts: 0 }]);
    await vs.interrupt();
    // THE MUTANT: audio for a dropped sentence still plays when it arrives late.
    helper.emit({ t: "audio", id: "s2", rate: 22050, pcm: "AAAA" });
    expect(audio.played).toBe(0);
  });

  it("says why when the microphone is not allowed, and starts nothing", async () => {
    const helper = new FakeHelper();
    helper.grant = "denied";
    const vs = new VoiceSession({ helper, audio: new FakeAudio(), session: new FakeSession().port, agentName: "Claude", prefs: () => DEFAULT_VOICE_PREFS });
    live = vs;
    await vs.start();
    expect(vs.state).toMatchObject({ phase: "unavailable", microphoneDenied: true });
    expect(helper.commands).toEqual([]);
  });
});
