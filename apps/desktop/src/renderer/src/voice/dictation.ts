import type { VoiceAudio } from "./audio-io";
import type { HelperEvent, SpeechHelper } from "./protocol";

/** A tenth of a second of audio per message to the helper. */
const BATCH_SAMPLES = 1_600;
/** A recogniser that ends this soon after it was started again is broken, not done with a pause. */
const QUICK_END_MS = 1_000;
/** Ends in a row, each this quick, after which dictation stops with a problem instead of trying again:
 *  about three seconds of retrying, short enough that the person is not left talking to nothing. */
const QUICK_ENDS = 3;

/**
 * `text` without a full stop the recogniser adds on its own after a long pause, to a sentence it
 * has already ended and settled (#551).
 */
function withoutStrayStop(text: string, settled: number): string {
  const kept = text.slice(0, settled);
  return /[.!?]$/.test(kept) && /^\s*[.!?]+$/.test(text.slice(settled)) ? kept : text;
}

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
  /** Dictation could not start, or broke. `heard` is what it had heard by then, as the recogniser
   *  had it, and empty when nothing was. */
  problem(message: string, heard: string): void;
};

/**
 * Speech typed into the prompter, from the click that starts it to the click or Esc that ends it,
 * through this Mac's own on-device recogniser. When the recogniser ends an utterance on its own, it
 * is started on the next one and the words carry over, so no pause ends dictation. Nothing here
 * sends anything anywhere but the helper on this Mac; clean-up, if it is on, is the prompter's next
 * step, and is handed only the words.
 */
export class Dictation {
  private offs: (() => void)[] = [];
  private outgoing: Int16Array[] = [];
  private outgoingSize = 0;
  /** Each dictation starts its own helper, so its utterances count from 1. */
  private turn = 0;
  /** The words of the utterances the recogniser has already ended. */
  private kept = "";
  /** The kept words and the last partial: what was heard, should the helper break before a final. */
  private heard = "";
  /** How much of this utterance the recogniser has settled, as of its last partial. */
  private settled = 0;
  private listenedAt = 0;
  private quickEnds = 0;
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
    this.listen();
    this.listening = true;
    try {
      await audio.start((level, samples) => this.onFrame(level, samples), () => this.stop());
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
  }

  private listen(): void {
    this.turn += 1;
    this.settled = 0;
    this.listenedAt = this.now();
    this.deps.helper.command({ t: "listen", turn: this.turn });
  }

  private withKept(text: string): string {
    return [this.kept, text].filter(Boolean).join(" ");
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
    if (e.t === "error") { this.fail(e.message, this.heard); return; }
    if (e.t === "fetching") { this.deps.events.fetching(e.progress ?? null); return; }
    if ((e.t !== "partial" && e.t !== "final") || e.turn !== this.turn) return;
    if (e.t === "partial") this.settled = Math.min(e.settled ?? 0, e.text.length);
    const text = withoutStrayStop(e.text, this.settled);
    const words = this.withKept(text);
    this.heard = words;
    if (e.t === "partial") {
      this.deps.events.partial(words, this.settled ? words.length - text.length + this.settled : this.kept.length);
      return;
    }
    if (this.ending) { this.finish(words); return; }
    this.quickEnds = this.now() - this.listenedAt < QUICK_END_MS ? this.quickEnds + 1 : 0;
    if (this.quickEnds >= QUICK_ENDS) { this.fail("Dictation stopped: this Mac's recogniser keeps stopping as soon as it starts.", words); return; }
    this.kept = words;
    this.listen();
    this.deps.events.partial(this.kept, this.kept.length);
  }

  private finish(text: string): void {
    this.teardown();
    this.deps.events.done(text.trim());
  }

  private fail(message: string, heard = ""): void {
    this.teardown();
    this.deps.events.problem(message, heard.trim());
  }

  private teardown(): void {
    this.finished = true;
    for (const off of this.offs) off();
    this.offs = [];
    this.deps.audio.stop();
    this.deps.helper.stop();
  }
}
