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
  /** The audio clock, in seconds; each run plays for `runS` after the last one queued. */
  now = 0;
  runS = 1;
  private until = 0;
  play() { this.played += 1; this.talking = true; const at = Math.max(this.now, this.until); this.until = at + this.runS; return at; }
  clock() { return this.now; }
  hush() { this.hushes += 1; this.talking = false; this.ducked = false; this.until = 0; }
  duck(on: boolean) { this.ducked = on; }
  bands() { return false; }
  stop() {}
  frames(level: number, ms: number) { for (let t = 0; t < ms; t += 20) { clock.now += 20; this.onFrame?.(level, new Int16Array(320)); } }
}

class FakeSession {
  t: Transcript = emptyTranscript();
  loaded = true;
  isBusy = false;
  sent: string[] = [];
  interrupts = 0;
  decided: { requestId: string; decision: string }[] = [];
  private listeners = new Set<() => void>();
  port = {
    transcript: () => (this.loaded ? this.t : null),
    busy: () => this.isBusy,
    subscribe: (cb: () => void) => { this.listeners.add(cb); return () => this.listeners.delete(cb); },
    send: async (text: string) => { this.sent.push(text); },
    interrupt: async () => { this.interrupts += 1; },
    decide: async (requestId: string, decision: "allow" | "deny") => { this.decided.push({ requestId, decision }); },
  };
  set(blocks: Block[], pendingPermissions: PendingPermission[] = []) { this.loaded = true; this.t = { ...emptyTranscript(), blocks, pendingPermissions }; for (const cb of this.listeners) cb(); }
}

const clock = { now: 0 };
let live: VoiceSession | null = null;
afterEach(() => { live?.stop(); live = null; vi.useRealTimers(); });

async function boot(prefs: Partial<VoicePrefs> = {}, opts: { loaded?: boolean } = {}) {
  const helper = new FakeHelper(), audio = new FakeAudio(), session = new FakeSession();
  session.loaded = opts.loaded ?? true;
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

  it("reads nothing of a transcript that loads after voice mode opened, only what comes after", async () => {
    const { helper, session } = await boot({}, { loaded: false });
    const before: Block[] = [{ kind: "user", text: "hi", ts: 0 }, { kind: "assistant", messageId: "old", text: "What do you need?", streaming: false, ts: 0 }];
    // THE MUTANT: the narrator starts from the top of a transcript that was empty only because it had
    // not loaded — the greeting is read out, and the person's first words are taken for a barge-in.
    session.set(before);
    expect(helper.spoken()).toEqual([]);
    session.set([...before, { kind: "user", text: "q", spoken: true, ts: 1 }, { kind: "assistant", messageId: "m", text: "Four. ", streaming: true, ts: 1 }]);
    expect(helper.spoken()).toEqual(["Four."]);
  });

  it("shows each sentence as the speakers reach it, not when it was queued", async () => {
    vi.useFakeTimers();
    const { vs, helper, audio, session } = await boot();
    session.set([{ kind: "assistant", messageId: "m", text: "First one. Second one. ", streaming: true, ts: 0 }]);
    expect(helper.spoken()).toEqual(["First one.", "Second one."]);
    helper.emit({ t: "audio", id: "s1", rate: 22050, pcm: "AAAA" });
    helper.emit({ t: "audio", id: "s2", rate: 22050, pcm: "AAAA" });
    vi.advanceTimersByTime(100);
    // THE MUTANT: the caption is the last sentence sent to the helper — it runs ahead of the voice.
    expect(vs.state.said).toBe("First one.");
    audio.now = 1.2;
    vi.advanceTimersByTime(100);
    expect(vs.state.said).toBe("Second one.");
    audio.talking = false;
    helper.emit({ t: "spoken", id: "s1" });
    helper.emit({ t: "spoken", id: "s2" });
    vi.advanceTimersByTime(100);
    expect(vs.state).toMatchObject({ phase: "listening", said: null });
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
    session.set([], [{ ...p, requestId: "r2" }]);
    vs.press(); vs.release();
    helper.emit({ t: "final", turn: helper.turn, text: "no" });
    await vi.waitFor(() => expect(session.decided.at(-1)).toEqual({ requestId: "r2", decision: "deny" }));
  });

  describe("answering a card out loud", () => {
    const card = (requestId: string, command = "pnpm build"): PendingPermission => ({ requestId, toolName: "Bash", input: {}, title: `Run \`${command}\`` });
    /** A whole utterance, from press to the recogniser's final. */
    const utter = (vs: VoiceSession, helper: FakeHelper, text: string) => { vs.press(); vs.release(); helper.emit({ t: "final", turn: helper.turn, text }); };
    /** Everything `finish` awaits has settled. */
    const settled = () => new Promise((r) => setTimeout(r, 0));

    it("answers with allow once on a longer yes, then sends the rest as the next message", async () => {
      const { vs, helper, session } = await boot();
      const order: string[] = [];
      session.port.decide = async (requestId, decision) => { order.push(`decide ${decision}`); session.decided.push({ requestId, decision }); };
      session.port.send = async (text) => { order.push(`send ${text}`); session.sent.push(text); };
      session.set([], [card("r1")]);
      utter(vs, helper, "Yeah, make sure you allow all bash.");
      await settled();
      expect(session.decided).toEqual([{ requestId: "r1", decision: "allow" }]);
      expect(session.sent).toEqual(["make sure you allow all bash."]);
      // THE MUTANT: the rest goes first, and is queued behind the card it was meant to follow.
      expect(order).toEqual(["decide allow", "send make sure you allow all bash."]);
      expect(helper.spoken().at(-1)).toBe("Allowed once.");
    });

    it("denies on a longer no, and sends a verb's sentence whole", async () => {
      const { vs, helper, session } = await boot();
      session.set([], [card("r1", "pnpm migrate")]);
      utter(vs, helper, "Don't run the migration");
      await settled();
      expect(session.decided).toEqual([{ requestId: "r1", decision: "deny" }]);
      // THE MUTANT: the opener comes off — the agent is told "run the migration".
      expect(session.sent).toEqual(["Don't run the migration"]);
      expect(helper.spoken().at(-1)).toBe("Denied.");
    });

    it.each(["Yes but not that file", "Yes... actually no", "No wait, yes", "Don't... okay do it", "Not yet", "What does that do?"])("leaves the card open on %s, asks again, and sends nothing", async (said) => {
      const { vs, helper, session } = await boot();
      session.set([], [card("r1")]);
      utter(vs, helper, said);
      await settled();
      expect(session.decided).toEqual([]);
      expect(session.sent).toEqual([]);
      expect(helper.spoken().at(-1)).toBe("Say yes or no.");
    });

    it.each(["Always allow", "Yes, always allow it", "Allow always"])("allows only once on %s, and says so", async (said) => {
      const { vs, helper, session } = await boot();
      session.set([], [card("r1")]);
      utter(vs, helper, said);
      await settled();
      expect(session.decided).toEqual([{ requestId: "r1", decision: "allow" }]);
      expect(session.sent).toEqual([]);
      expect(helper.spoken().at(-1)).toBe("Allowed once.");
    });

    it("never answers on a partial, however clear", async () => {
      const { vs, helper, session } = await boot();
      session.set([], [card("r1")]);
      vs.press();
      helper.emit({ t: "partial", turn: helper.turn, text: "yes" });
      helper.emit({ t: "partial", turn: helper.turn, text: "yes go ahead" });
      await settled();
      expect(session.decided).toEqual([]);
      expect(session.sent).toEqual([]);
      // The person goes on, and takes it back: only now is there an answer to read.
      vs.release();
      helper.emit({ t: "final", turn: helper.turn, text: "Yes go ahead but not that file" });
      await settled();
      expect(session.decided).toEqual([]);
    });

    it("never answers on a barge-in: the card is read over, and only the finished words count", async () => {
      const { helper, audio, session } = await boot();
      session.set([], [card("r1")]);
      helper.emit({ t: "audio", id: "s1", rate: 22050, pcm: "AAAA" });
      audio.frames(QUIET, 400);
      audio.frames(VOICE, 400);
      expect(audio.ducked).toBe(true);
      // Real words, so it stops talking, and nothing is answered by having done so.
      helper.emit({ t: "partial", turn: helper.turn, text: "yeah go ahead" });
      expect(audio.hushes).toBe(1);
      await settled();
      expect(session.decided).toEqual([]);
      audio.frames(QUIET, 800);
      helper.emit({ t: "final", turn: helper.turn, text: "Yeah, go ahead and run it." });
      await settled();
      expect(session.decided).toEqual([{ requestId: "r1", decision: "allow" }]);
      expect(session.sent).toEqual(["go ahead and run it."]);
    });

    it("does not take Realm's own echo for an answer", async () => {
      const { helper, audio, session } = await boot();
      session.set([], [card("r1")]);
      helper.emit({ t: "audio", id: "s1", rate: 22050, pcm: "AAAA" });
      audio.frames(QUIET, 400);
      audio.frames(VOICE, 400);
      audio.frames(QUIET, 800);
      helper.emit({ t: "final", turn: helper.turn, text: "yes or no" });
      await settled();
      expect(session.decided).toEqual([]);
      expect(helper.spoken()).toEqual(["Mina asks to run pnpm build. Say yes or no."]);
    });

    it("answers only the card being read when several are open", async () => {
      const { vs, helper, session } = await boot();
      session.set([], [card("r1"), card("r2", "rm -rf dist")]);
      expect(helper.spoken()).toEqual(["Mina asks to run pnpm build. Say yes or no."]);
      utter(vs, helper, "Yes");
      await settled();
      expect(session.decided).toEqual([{ requestId: "r1", decision: "allow" }]);
      session.set([], [card("r2", "rm -rf dist")]);
      expect(helper.spoken().at(-1)).toBe("Mina asks to run rm -rf dist. Say yes or no.");
      utter(vs, helper, "No");
      await settled();
      expect(session.decided.at(-1)).toEqual({ requestId: "r2", decision: "deny" });
    });

    it("does not answer a card that opened while the person was already talking", async () => {
      const { vs, helper, session } = await boot();
      vs.press();
      session.set([], [card("r1")]);
      vs.release();
      helper.emit({ t: "final", turn: helper.turn, text: "Yes, that sounds right" });
      await settled();
      // Words begun before the card was read are about something else: they go as they would have.
      expect(session.decided).toEqual([]);
      expect(session.sent).toEqual(["Yes, that sounds right"]);
    });

    it("leaves a question alone, and sends what is said as a message", async () => {
      const { vs, helper, session } = await boot();
      session.set([], [{ requestId: "q", toolName: "AskUserQuestion", input: {}, title: "Which branch?", ask: { questions: [] } as never }]);
      utter(vs, helper, "Yes, the main one");
      await settled();
      expect(session.decided).toEqual([]);
      expect(session.sent).toEqual(["Yes, the main one"]);
    });

    it("sends everything as it always did with no card open", async () => {
      const { vs, helper, session } = await boot();
      utter(vs, helper, "Yes but not that file");
      await settled();
      expect(session.decided).toEqual([]);
      expect(session.sent).toEqual(["Yes but not that file"]);
      expect(helper.spoken()).toEqual([]);
    });
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
