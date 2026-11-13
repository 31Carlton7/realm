/**
 * Dictation's microphone, in Web Audio. Each frame is handed on as its RMS level and as 16 kHz mono
 * samples, the helper's rate.
 */

const SPEECH_RATE = 16_000;

export interface VoiceAudio {
  start(onFrame: (level: number, samples: Int16Array) => void): Promise<void>;
  stop(): void;
}

function downsample(input: Float32Array, fromRate: number, toRate = SPEECH_RATE): Int16Array {
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

export class WebVoiceAudio implements VoiceAudio {
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;

  constructor(private readonly microphone: string | null = null) {}

  async start(onFrame: (level: number, samples: Int16Array) => void): Promise<void> {
    const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    // A chosen microphone that is unplugged falls back to the default input rather than leaving
    // dictation deaf.
    this.mic = await (this.microphone
      ? navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: this.microphone } } }).catch(() => navigator.mediaDevices.getUserMedia({ audio }))
      : navigator.mediaDevices.getUserMedia({ audio }));
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    const source = ctx.createMediaStreamSource(this.mic);
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
  }

  stop(): void {
    if (this.processor) this.processor.onaudioprocess = null;
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.mic = null;
  }
}
