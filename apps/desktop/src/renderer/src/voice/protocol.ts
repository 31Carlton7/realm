/** The `realmvoice` helper's wire (apps/desktop/native/RealmVoice.swift), as the renderer sees it. */

export type SystemVoice = { id: string; name: string; language: string; quality: number };

export type HelperStart =
  | { t: "ready"; stt: "analyzer" | "recognizer" | "none"; voice: string; voices: SystemVoice[] }
  | { t: "unavailable"; reason: string };

export type HelperEvent =
  | { t: "partial"; turn: number; text: string }
  | { t: "final"; turn: number; text: string }
  | { t: "audio"; id: string; rate: number; pcm: string }
  | { t: "spoken"; id: string }
  | { t: "error"; message: string };

export type HelperCommand =
  | { t: "listen"; turn: number }
  | { t: "end" }
  | { t: "cancel" }
  | { t: "speak"; id: string; text: string; voice?: string; rate?: number }
  | { t: "hush" };

/** The helper, by way of main. A seam: the tests hand in a fake. */
export interface SpeechHelper {
  microphone(): Promise<string>;
  start(): Promise<HelperStart>;
  command(command: HelperCommand): void;
  audio(pcm: Uint8Array): void;
  stop(): void;
  onEvent(cb: (event: HelperEvent) => void): () => void;
}

/** The desktop bridge's helper, where this build has one. */
export function desktopSpeechHelper(): SpeechHelper | null {
  const voice = window.realm?.voice;
  if (!voice) return null;
  return {
    microphone: () => voice.microphone(),
    start: () => voice.start() as Promise<HelperStart>,
    command: (command) => voice.command(command),
    audio: (pcm) => voice.audio(pcm),
    stop: () => voice.stop(),
    onEvent: (cb) => voice.onEvent((e) => cb(e as HelperEvent)),
  };
}

export function decodePcm(b64: string): Int16Array {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
}
