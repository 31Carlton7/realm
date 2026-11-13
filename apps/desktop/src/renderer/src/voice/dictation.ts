import type { VoiceAudio } from "./audio-io";
import type { HelperEvent, SpeechHelper } from "./protocol";
import { DEFAULT_TURN, TurnTaker } from "./turn-taking";

/** The silence after speech that ends dictation on its own: long enough to think mid-sentence. */
export const DICTATION_PAUSE_MS = 2_500;
/** A tenth of a second of audio per message to the helper. */
const BATCH_SAMPLES = 1_600;
/** Each dictation starts its own helper, so it is only ever the helper's first utterance. */
const TURN = 1;

export type DictationEvents = {
  /** Everything heard so far, as the recogniser has it now. Its first `settled` characters are final. */
  partial(text: string, settled: number): void;
  /** This Mac's speech model is being downloaded before its first use, `progress` 0–1 once Apple
   *  reports one. Listening starts once it is in, with a `partial` of nothing. */
  fetching(progress: number | null): void;
  /** The microphone's level, 0–1 RMS, once per frame while listening. */
  level(rms: number): void;
  /** What was said, once dictation has stopped. Empty when nothing was. */
  done(text: string): void;
  /** Dictation could not start, or broke. */
  problem(message: string): void;
};

/**
 * Speech typed into the prompter: one utterance from the click that starts it to the click, Esc or
 * long pause that ends it, through this Mac's own on-device recogniser. Nothing here sends anything
 * anywhere but the helper on this Mac; clean-up, if it is on, is the prompter's next step, and is
 * handed only the words.
 */
export class Dictation {
  private readonly pause = new TurnTaker({ ...DEFAULT_TURN, endOfTurnMs: DICTATION_PAUSE_MS });
  private offs: (() => void)[] = [];
  private outgoing: Int16Array[] = [];
  private outgoingSize = 0;
  private heard = "";
  private listening = false;
  private ending = false;
  private finished = false;

  constructor(private readonly deps: { helper: SpeechHelper; audio: VoiceAudio; events: DictationEvents; now?: () => number }) {}

  private now(): number { return this.deps.now?.() ?? performance.now(); }

  async start(): Promise<void> {
    const { helper, audio, events } = this.deps;
    if (await helper.microphone() !== "granted") {
      this.fail("Realm is not allowed to use the microphone. Turn it on in System Settings ▸ Privacy & Security ▸ Microphone.");
      return;
    }
    this.offs.push(helper.onEvent((e) => this.onHelper(e)));
    const ready = await helper.start();
    if (this.finished) return;
    if (ready.t === "unavailable" || ready.stt === "none") {
      this.fail(ready.t === "unavailable" ? ready.reason : "This Mac has no speech recognition for its language.");
      return;
    }
    helper.command({ t: "listen", turn: TURN });
    this.listening = true;
    try {
      await audio.start((level, samples) => this.onFrame(level, samples));
    } catch (e) {
      this.fail(`The microphone did not start: ${(e as Error).message}`);
      return;
    }
    if (this.finished) audio.stop();
    else events.partial("", 0);
  }

  /** Stop listening and finish what was heard: `done` follows once the recogniser has the last word. */
  stop(): void {
    if (this.finished || this.ending) return;
    if (!this.listening) { this.finish(""); return; }
    this.ending = true;
    this.flush();
    this.deps.audio.stop();
    this.deps.helper.command({ t: "end" });
  }

  /** Drop everything: the prompter is going away. */
  cancel(): void {
    if (this.finished) return;
    if (this.listening) this.deps.helper.command({ t: "cancel" });
    this.teardown();
  }

  private onFrame(level: number, samples: Int16Array): void {
    if (this.ending || this.finished) return;
    this.deps.events.level(level);
    this.outgoing.push(samples);
    this.outgoingSize += samples.length;
    if (this.outgoingSize >= BATCH_SAMPLES) this.flush();
    // Only the pause after words ends it: someone gathering their thoughts before the first word
    // is not done.
    for (const e of this.pause.frame(level, this.now())) {
      if (e.type === "end" && this.heard) this.stop();
    }
  }

  private flush(): void {
    if (this.outgoingSize === 0) return;
    const all = new Int16Array(this.outgoingSize);
    let at = 0;
    for (const chunk of this.outgoing) { all.set(chunk, at); at += chunk.length; }
    this.outgoing = [];
    this.outgoingSize = 0;
    this.deps.helper.audio(new Uint8Array(all.buffer));
  }

  private onHelper(e: HelperEvent): void {
    if (this.finished) return;
    if (e.t === "error") { this.fail(e.message); return; }
    if (e.t === "fetching") { this.deps.events.fetching(e.progress ?? null); return; }
    if ((e.t !== "partial" && e.t !== "final") || e.turn !== TURN) return;
    this.heard = e.text;
    if (e.t === "partial") { this.deps.events.partial(e.text, Math.min(e.settled ?? 0, e.text.length)); return; }
    this.finish(e.text);
  }

  private finish(text: string): void {
    this.teardown();
    this.deps.events.done(text.trim());
  }

  private fail(message: string): void {
    this.teardown();
    this.deps.events.problem(message);
  }

  private teardown(): void {
    this.finished = true;
    for (const off of this.offs) off();
    this.offs = [];
    this.deps.audio.stop();
    this.deps.helper.stop();
  }
}
