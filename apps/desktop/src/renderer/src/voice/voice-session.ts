import type { Transcript } from "../panes/session/transcript-model";
import type { VoiceAudio } from "./audio-io";
import { interpret, isEcho } from "./heard";
import { Narrator } from "./narrator";
import { decodePcm, type HelperEvent, type SpeechHelper } from "./protocol";
import { DEFAULT_TURN, TurnTaker, type TurnEvent } from "./turn-taking";
import type { VoicePrefs } from "./voice-prefs";

/** The session voice mode talks to, as far as voice mode needs it. */
export interface VoiceSessionPort {
  transcript(): Transcript;
  /** Running or waiting on a permission: a turn is in flight. */
  busy(): boolean;
  subscribe(cb: () => void): () => void;
  /** A message, marked as spoken. */
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  decide(requestId: string, decision: "allow" | "deny"): Promise<void>;
}

export type VoicePhase = "starting" | "listening" | "hearing" | "working" | "speaking" | "unavailable";

export type VoiceSnapshot = {
  phase: VoicePhase;
  /** What is being heard right now, as the recogniser has it so far. */
  partial: string;
  /** The last thing said to the agent, and the last sentence Realm said back. */
  heard: string | null;
  said: string | null;
  muted: boolean;
  held: boolean;
  /** Why voice mode cannot run, or the last thing that went wrong. */
  problem: string | null;
  /** The problem is the microphone grant, which System Settings can change. */
  microphoneDenied: boolean;
};

/** How much of the microphone is kept from before a turn is recognised as one: the onset the VAD
 *  needed to be sure, plus the first syllable it would otherwise clip. */
const PREROLL_SAMPLES = 16_000 * 0.4;
/** Samples per message to the helper: a tenth of a second. */
const BATCH_SAMPLES = 1_600;
/** How many of Realm's own recent sentences the echo check compares what it hears against. */
const RECENT = 6;

/**
 * One voice conversation with one session: the microphone's turns become messages, the reply is read
 * back as it streams, and speaking over it stops it.
 *
 * A barge-in is in two steps. When the level says the person has started talking over Realm, its
 * voice is turned down at once — that is what feels immediate — and only when the recogniser hears
 * words that are not Realm's own echo is it stopped. A cough, or an echo the canceller missed, turns
 * Realm back up instead of cutting it off.
 */
export class VoiceSession {
  private readonly turns = new TurnTaker();
  private readonly narrator: Narrator;
  private snapshot: VoiceSnapshot = { phase: "starting", partial: "", heard: null, said: null, muted: false, held: false, problem: null, microphoneDenied: false };
  private listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  private turn = 0;
  private listening = false;
  private bargePending = false;
  private preroll: Int16Array[] = [];
  private prerollSize = 0;
  private outgoing: Int16Array[] = [];
  private outgoingSize = 0;
  /** Sentences sent to the helper and not yet fully played: a hush drops them all. */
  private live = new Set<string>();
  private spoken = 0;
  private recent: string[] = [];
  private tick: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopped = false;
  private endOfTurnMs = DEFAULT_TURN.endOfTurnMs;

  constructor(private readonly deps: {
    helper: SpeechHelper; audio: VoiceAudio; session: VoiceSessionPort; agentName: string;
    /** Read as each frame and sentence goes, so a change in Settings applies mid-conversation. */
    prefs: () => VoicePrefs;
    now?: () => number;
  }) {
    this.narrator = new Narrator(deps.session.transcript().blocks.length, deps.agentName);
  }

  private now(): number { return this.deps.now?.() ?? performance.now(); }

  get state(): VoiceSnapshot { return this.snapshot; }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private update(patch: Partial<VoiceSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    next.phase = this.phaseOf(next);
    if ((Object.keys(next) as (keyof VoiceSnapshot)[]).every((k) => next[k] === this.snapshot[k])) return;
    this.snapshot = next;
    for (const cb of this.listeners) cb();
  }

  private phaseOf(s: VoiceSnapshot): VoicePhase {
    if (s.phase === "unavailable") return "unavailable";
    if (s.phase === "starting" && !this.started) return "starting";
    if (this.listening) return "hearing";
    if (this.deps.audio.talking || this.live.size > 0) return "speaking";
    if (this.deps.session.busy()) return "working";
    return "listening";
  }

  async start(): Promise<void> {
    const { helper, audio, session } = this.deps;
    const grant = await helper.microphone();
    if (grant !== "granted") {
      this.update({ phase: "unavailable", problem: "Realm is not allowed to use the microphone. Turn it on in System Settings ▸ Privacy & Security ▸ Microphone.", microphoneDenied: true });
      return;
    }
    this.offs.push(helper.onEvent((e) => this.onHelper(e)));
    const ready = await helper.start();
    if (this.stopped) return;
    if (ready.t === "unavailable" || ready.stt === "none") {
      this.update({ phase: "unavailable", problem: ready.t === "unavailable" ? ready.reason : "This Mac has no speech recognition for its language." });
      return;
    }
    try {
      await audio.start((level, samples) => this.onFrame(level, samples));
    } catch (e) {
      this.update({ phase: "unavailable", problem: `The microphone did not start: ${(e as Error).message}` });
      return;
    }
    if (this.stopped) { audio.stop(); return; }
    this.started = true;
    this.offs.push(session.subscribe(() => this.narrate()));
    // The phase reads the audio clock, which moves without telling anyone.
    this.tick = setInterval(() => this.update({}), 100);
    this.update({});
    this.narrate();
  }

  stop(): void {
    this.stopped = true;
    if (this.tick) clearInterval(this.tick);
    for (const off of this.offs) off();
    this.offs = [];
    this.deps.helper.command({ t: "hush" });
    if (this.listening) this.deps.helper.command({ t: "cancel" });
    this.deps.audio.stop();
    this.deps.helper.stop();
  }

  setMuted(muted: boolean): void {
    this.update({ muted });
    if (muted) this.handle(this.turns.frame(0, this.now(), { talking: this.deps.audio.talking, muted: true }));
  }

  /** Push-to-talk. A press while Realm is talking is unmistakable, so it stops it at once. */
  press(): void {
    if (!this.started) return;
    if (this.speaking()) this.hush();
    this.update({ held: true });
    this.handle(this.turns.press(false));
  }

  release(): void {
    this.update({ held: false });
    this.handle(this.turns.release());
  }

  /** Esc, the Stop button, or "stop": Realm stops talking, and the agent stops its turn. */
  async interrupt(): Promise<void> {
    this.hush();
    if (this.deps.session.busy()) await this.deps.session.interrupt();
  }

  /** Whether Realm is saying something, or about to. */
  speaking(): boolean { return this.deps.audio.talking || this.live.size > 0; }

  private onFrame(level: number, samples: Int16Array): void {
    this.preroll.push(samples);
    this.prerollSize += samples.length;
    while (this.prerollSize - (this.preroll[0]?.length ?? 0) >= PREROLL_SAMPLES) this.prerollSize -= this.preroll.shift()!.length;
    if (this.listening) this.queueAudio(samples);
    const prefs = this.deps.prefs();
    if (prefs.endOfTurnMs !== this.endOfTurnMs) { this.endOfTurnMs = prefs.endOfTurnMs; this.turns.configure({ ...DEFAULT_TURN, endOfTurnMs: prefs.endOfTurnMs }); }
    const deaf = this.snapshot.muted || !prefs.handsFree;
    this.handle(this.turns.frame(level, this.now(), { talking: this.speaking(), muted: deaf }));
  }

  private queueAudio(samples: Int16Array): void {
    this.outgoing.push(samples);
    this.outgoingSize += samples.length;
    if (this.outgoingSize >= BATCH_SAMPLES) this.flushAudio();
  }

  private flushAudio(): void {
    if (this.outgoingSize === 0) return;
    const all = new Int16Array(this.outgoingSize);
    let at = 0;
    for (const chunk of this.outgoing) { all.set(chunk, at); at += chunk.length; }
    this.outgoing = [];
    this.outgoingSize = 0;
    this.deps.helper.audio(new Uint8Array(all.buffer));
  }

  private handle(events: TurnEvent[]): void {
    const { helper, audio } = this.deps;
    for (const e of events) {
      if (e.type === "start") {
        this.turn += 1;
        this.listening = true;
        helper.command({ t: "listen", turn: this.turn });
        // The pre-roll already ends with this frame's samples, so it goes alone.
        for (const chunk of this.preroll) this.queueAudio(chunk);
        this.flushAudio();
        if (e.barge) { this.bargePending = true; audio.duck(true); }
        this.update({ partial: "" });
      } else if (e.type === "end") {
        this.flushAudio();
        helper.command({ t: "end" });
        this.listening = false;
        this.update({});
      } else {
        helper.command({ t: "cancel" });
        this.listening = false;
        this.outgoing = [];
        this.outgoingSize = 0;
        if (this.bargePending) { this.bargePending = false; audio.duck(false); }
        this.update({ partial: "" });
      }
    }
  }

  private onHelper(e: HelperEvent): void {
    if (this.stopped) return;
    if (e.t === "audio") { if (this.live.has(e.id)) this.deps.audio.play(decodePcm(e.pcm), e.rate); return; }
    if (e.t === "spoken") { this.live.delete(e.id); return; }
    if (e.t === "error") { this.update({ problem: e.message }); return; }
    if (e.turn !== this.turn) return;
    if (e.t === "partial") {
      this.update({ partial: e.text });
      if (this.bargePending && !isEcho(e.text, this.recent)) this.barge();
      return;
    }
    void this.finish(e.text);
  }

  /** The person really is talking over Realm: stop, and do not go back to the reply it was reading. */
  private barge(): void {
    this.bargePending = false;
    this.hush();
  }

  private async finish(text: string): Promise<void> {
    if (this.bargePending) {
      this.bargePending = false;
      if (!text.trim() || isEcho(text, this.recent)) { this.deps.audio.duck(false); this.update({ partial: "" }); return; }
      this.hush();
    }
    const { session } = this.deps;
    const pending = session.transcript().pendingPermissions.find((p) => !p.ask);
    const heard = interpret(text, { permissionPending: !!pending });
    this.update({ partial: "" });
    if (heard.kind === "nothing") return;
    if (heard.kind === "stop") { await this.interrupt(); this.update({ heard: text }); return; }
    if (heard.kind === "answer" && pending) { this.update({ heard: text }); await session.decide(pending.requestId, heard.decision); return; }
    if (heard.kind === "message") { this.update({ heard: heard.text }); await session.send(heard.text); }
  }

  /** Stop Realm's voice, drop what was queued, and skip the rest of what was being read. */
  private hush(): void {
    this.deps.helper.command({ t: "hush" });
    this.deps.audio.hush();
    this.live.clear();
    this.narrator.skipTo(this.deps.session.transcript().blocks.length);
    this.update({});
  }

  private narrate(): void {
    if (!this.started || this.stopped) return;
    const lines = this.narrator.next(this.deps.session.transcript(), this.now(), !this.speaking());
    for (const text of lines) this.say(text);
    this.update({});
  }

  private say(text: string): void {
    const id = `s${++this.spoken}`;
    this.live.add(id);
    this.recent = [...this.recent, text].slice(-RECENT);
    const { voice, rate } = this.deps.prefs();
    this.deps.helper.command({ t: "speak", id, text, ...(voice ? { voice } : {}), rate });
    this.update({ said: text });
  }
}
