/**
 * Voice mode's microphone and speaker, in Web Audio.
 *
 * Capture asks Chromium for echo cancellation, and playback goes through the same audio context, so
 * what Realm says is the canceller's reference and mostly never reaches the turn-taking at all. Each
 * frame of the microphone is handed on as its RMS level and as 16 kHz mono samples, the helper's rate.
 */

export const SPEECH_RATE = 16_000;

export interface VoiceAudio {
  start(onFrame: (level: number, samples: Int16Array) => void): Promise<void>;
  /** Queue one run of Realm's voice after what is already queued; returns when it will start, on
   *  the audio clock. */
  play(samples: Int16Array, rate: number): number;
  /** The audio clock, in seconds. */
  clock(): number;
  /** Stop what is playing and everything scheduled after it. */
  hush(): void;
  /** Turn Realm's voice down while it is not yet clear the person is interrupting. */
  duck(on: boolean): void;
  /** Whether Realm's voice is playing, or has only just stopped (its echo is still in the room). */
  readonly talking: boolean;
  /** How loud each band of the speech range is on one side right now, 0–1, one per slot of `into`.
   *  False before start. */
  bands(side: "mine" | "realm", into: Float32Array): boolean;
  stop(): void;
}

/** How long after the last sample Realm still counts as talking: the room's reverberation. */
const TAIL_S = 0.15;

export function downsample(input: Float32Array, fromRate: number, toRate = SPEECH_RATE): Int16Array {
  const ratio = fromRate / toRate;
  const out = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    // The mean of the samples each output one stands for: a box filter, enough against aliasing for speech.
    const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    const v = sum / Math.max(1, end - start);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

export function rms(input: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i]! * input[i]!;
  return Math.sqrt(sum / Math.max(1, input.length));
}

/** Where a voice's energy is: from its fundamental to the top of its consonants. */
const SPEECH_LOW_HZ = 90, SPEECH_HIGH_HZ = 4_000;

/**
 * An analyser's bins folded into `into.length` bands across the speech range, spaced evenly in pitch
 * rather than in hertz, so the low bands are not one bin wide and the high ones a hundred. Each band
 * is the mean of its bins, 0–1.
 */
export function speechBands(bins: Uint8Array, hzPerBin: number, into: Float32Array): void {
  const n = into.length;
  for (let b = 0; b < n; b++) {
    const lo = Math.floor((SPEECH_LOW_HZ * (SPEECH_HIGH_HZ / SPEECH_LOW_HZ) ** (b / n)) / hzPerBin);
    const hi = Math.max(lo + 1, Math.floor((SPEECH_LOW_HZ * (SPEECH_HIGH_HZ / SPEECH_LOW_HZ) ** ((b + 1) / n)) / hzPerBin));
    let sum = 0;
    for (let i = lo; i < hi && i < bins.length; i++) sum += bins[i]!;
    into[b] = sum / (hi - lo) / 255;
  }
}

export class WebVoiceAudio implements VoiceAudio {
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private gain: GainNode | null = null;
  private mineAnalyser: AnalyserNode | null = null;
  private realmAnalyser: AnalyserNode | null = null;
  private bins = new Uint8Array(512);
  private playing = new Set<AudioBufferSourceNode>();
  private until = 0;

  async start(onFrame: (level: number, samples: Int16Array) => void): Promise<void> {
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    const source = ctx.createMediaStreamSource(this.mic);
    this.mineAnalyser = ctx.createAnalyser();
    this.mineAnalyser.fftSize = 1024;
    this.mineAnalyser.smoothingTimeConstant = 0.6;
    source.connect(this.mineAnalyser);
    // A ScriptProcessor rather than a worklet: a worklet's module has to be fetched, and the window's
    // page is a file the renderer's CSP and file:// both make awkward to fetch from. This one writes
    // nothing to its output, so the microphone is never played back.
    this.processor = ctx.createScriptProcessor(1024, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      onFrame(rms(input), downsample(input, ctx.sampleRate));
    };
    source.connect(this.processor);
    this.processor.connect(ctx.destination);
    this.gain = ctx.createGain();
    this.realmAnalyser = ctx.createAnalyser();
    this.realmAnalyser.fftSize = 1024;
    this.realmAnalyser.smoothingTimeConstant = 0.6;
    this.gain.connect(this.realmAnalyser);
    this.realmAnalyser.connect(ctx.destination);
  }

  play(samples: Int16Array, rate: number): number {
    const ctx = this.ctx;
    if (!ctx || !this.gain || samples.length === 0) return this.clock();
    const buffer = ctx.createBuffer(1, samples.length, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i]! / 32768;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    const at = Math.max(ctx.currentTime + 0.02, this.until);
    node.start(at);
    this.until = at + buffer.duration;
    this.playing.add(node);
    node.onended = () => this.playing.delete(node);
    return at;
  }

  clock(): number { return this.ctx?.currentTime ?? 0; }

  hush(): void {
    for (const node of this.playing) { try { node.stop(); } catch { /* not started */ } }
    this.playing.clear();
    this.until = 0;
    this.duck(false);
  }

  duck(on: boolean): void {
    if (!this.ctx || !this.gain) return;
    this.gain.gain.setTargetAtTime(on ? 0.2 : 1, this.ctx.currentTime, 0.03);
  }

  get talking(): boolean {
    return !!this.ctx && this.until > 0 && this.ctx.currentTime < this.until + TAIL_S;
  }

  bands(side: "mine" | "realm", into: Float32Array): boolean {
    const analyser = side === "mine" ? this.mineAnalyser : this.realmAnalyser;
    if (!analyser || !this.ctx) return false;
    analyser.getByteFrequencyData(this.bins);
    speechBands(this.bins, this.ctx.sampleRate / analyser.fftSize, into);
    return true;
  }

  stop(): void {
    this.hush();
    if (this.processor) this.processor.onaudioprocess = null;
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.mic = null;
  }
}
