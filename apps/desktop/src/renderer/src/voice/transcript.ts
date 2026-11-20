import type { VoiceAudio } from "./audio-io";

/** A meeting's transcript: the `realmvoice` helper's continuous mode (apps/desktop/native/RealmVoice.swift),
 *  as the renderer sees it. "me" is this window's microphone, "them" the other side of the call. */
export type TranscriptSource = "me" | "them";

/** One finished line. `start` and `end` are milliseconds since the transcript started; `at` is the
 *  wall-clock time of `start`, in epoch milliseconds. */
export type TranscriptLine = { source: TranscriptSource; text: string; start: number; end: number; at: number };

/** Hearing "them" through this Mac's sound output. `needs permission`: System Audio Recording has not
 *  been granted, so no tap was made and nothing was asked for. */
export type SystemAudioState = "capturing" | "needs permission" | "denied" | "failed";

export type TranscriptStart =
  | { t: "ready"; stt: "analyzer" | "none"; startedAt: number; systemAudio: "granted" | "denied" | "not decided" }
  | { t: "unavailable"; reason: string };

export type TranscriptEvent =
  | { t: "fetching"; progress?: number }
  | { t: "partial"; source: TranscriptSource; text: string; start: number }
  | ({ t: "line" } & TranscriptLine)
  | { t: "tap"; state: SystemAudioState; message?: string }
  | { t: "error"; source?: TranscriptSource; message: string }
  | { t: "stopped" };

/** The helper, by way of main. A seam: the tests hand in a fake. */
export interface TranscriptHelper {
  microphone(): Promise<string>;
  start(): Promise<TranscriptStart>;
  audio(source: TranscriptSource, pcm: Uint8Array): void;
  systemAudio(): void;
  /** Finish every source's last line; `stopped` follows. */
  finish(): void;
  stop(): void;
  onEvent(cb: (event: TranscriptEvent) => void): () => void;
}

/** The desktop bridge's helper, where this build has one. */
export function desktopTranscriptHelper(): TranscriptHelper | null {
  const transcript = window.realm?.transcript;
  const voice = window.realm?.voice;
  if (!transcript || !voice) return null;
  return {
    microphone: () => voice.microphone(),
    start: () => transcript.start() as Promise<TranscriptStart>,
    audio: (source, pcm) => transcript.audio(source, pcm),
    systemAudio: () => transcript.systemAudio(),
    finish: () => transcript.command({ t: "stop" }),
    stop: () => transcript.stop(),
    onEvent: (cb) => transcript.onEvent((e) => cb(e as TranscriptEvent)),
  };
}

export type TranscriptEvents = {
  line(line: TranscriptLine): void;
  /** The line a source is in the middle of, as the recogniser has it now. */
  partial(source: TranscriptSource, text: string): void;
  systemAudio(state: SystemAudioState, message?: string): void;
  problem(message: string): void;
};

/** A tenth of a second of audio per message to the helper, as dictation sends it. */
const BATCH_SAMPLES = 1_600;

/**
 * A meeting's transcript, from Start to Stop. "me" is heard through the microphone exactly as
 * dictation hears it; "them" through this Mac's sound output when `systemAudio` is asked for and
 * granted. Neither ends on a pause: the helper's recognisers run until `stop`.
 */
export class MeetingTranscript {
  private offs: (() => void)[] = [];
  private outgoing: Int16Array[] = [];
  private outgoingSize = 0;
  private stopped: Promise<void> | null = null;
  private settle: (() => void) | null = null;
  private ready = false;
  private finished = false;

  constructor(private readonly deps: { helper: TranscriptHelper; audio: VoiceAudio; events: TranscriptEvents; systemAudio: boolean }) {}

  async start(): Promise<void> {
    const { helper, audio, events } = this.deps;
    if (await helper.microphone() !== "granted") {
      this.fail("Realm is not allowed to use the microphone. Turn it on in System Settings ▸ Privacy & Security ▸ Microphone.");
      return;
    }
    // Main drops a finish sent before the helper is started, so nothing would say "stopped".
    if (this.stopped) { this.teardown(); return; }
    this.offs.push(helper.onEvent((e) => this.onHelper(e)));
    const ready = await helper.start();
    if (this.finished) return;
    if (ready.t === "unavailable" || ready.stt === "none") {
      this.fail(ready.t === "unavailable" ? ready.reason : "This Mac has no speech recognition for its language.");
      return;
    }
    this.ready = true;
    if (this.stopped) return;
    try {
      await audio.start((_level, samples) => this.onFrame(samples), () => events.problem("The microphone went away. The other side is still being transcribed."));
    } catch (e) {
      this.fail(`The microphone did not start: ${(e as Error).message}`);
      return;
    }
    if (this.finished) { audio.stop(); return; }
    if (this.deps.systemAudio) helper.systemAudio();
  }

  /** Stop listening, and resolve once the helper has handed over the last lines, or has gone. */
  stop(): Promise<void> {
    if (this.finished) return Promise.resolve();
    this.stopped ??= new Promise<void>((resolve) => {
      this.settle = resolve;
      this.flush();
      this.deps.audio.stop();
      this.deps.helper.finish();
    });
    return this.stopped;
  }

  private onFrame(samples: Int16Array): void {
    if (this.stopped || this.finished) return;
    this.outgoing.push(samples);
    this.outgoingSize += samples.length;
    if (this.outgoingSize >= BATCH_SAMPLES) this.flush();
  }

  private flush(): void {
    if (this.outgoingSize === 0) return;
    const all = new Int16Array(this.outgoingSize);
    let at = 0;
    for (const chunk of this.outgoing) { all.set(chunk, at); at += chunk.length; }
    this.outgoing = [];
    this.outgoingSize = 0;
    this.deps.helper.audio("me", new Uint8Array(all.buffer));
  }

  private onHelper(e: TranscriptEvent): void {
    if (this.finished) return;
    const { events } = this.deps;
    if (e.t === "line") events.line({ source: e.source, text: e.text, start: e.start, end: e.end, at: e.at });
    else if (e.t === "partial") events.partial(e.source, e.text);
    else if (e.t === "tap") events.systemAudio(e.state, e.message);
    else if (e.t === "error") events.problem(e.message);
    // An error with no source after ready is main's word that the helper exited.
    if (e.t === "stopped" || (e.t === "error" && !e.source && this.ready)) this.teardown();
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
    this.settle?.();
    this.settle = null;
  }
}
