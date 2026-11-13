/** The `realmvoice` helper's wire (apps/desktop/native/RealmVoice.swift), as the renderer sees it. */

export type HelperStart =
  | { t: "ready"; stt: "analyzer" | "recognizer" | "none" }
  | { t: "unavailable"; reason: string };

export type HelperEvent =
  /** Everything heard so far. The first `settled` characters are final: the recogniser will not
   *  change them. The rest it may still revise. */
  | { t: "partial"; turn: number; text: string; settled?: number }
  | { t: "final"; turn: number; text: string }
  | { t: "error"; message: string };

export type HelperCommand =
  | { t: "listen"; turn: number }
  | { t: "end" }
  | { t: "cancel" };

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
