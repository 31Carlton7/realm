import { dictationCleanUpOn } from "@realm/contracts";

/** Dictation's settings, kept as one row under `VOICE_PREFS_KEY`. */
export type VoicePrefs = {
  /** The microphone to listen with, by device id. Null listens with the system's default input. */
  microphone: string | null;
  /** Tidy dictated words with a model before they land in the draft. Off unless turned on: off,
   *  dictation never leaves the Mac. */
  cleanUp: boolean;
};

export { VOICE_PREFS_KEY } from "@realm/contracts";

export const DEFAULT_VOICE_PREFS: VoicePrefs = { microphone: null, cleanUp: false };

/** What is stored, made safe: anything missing or malformed falls back to the default. */
export function readVoicePrefs(stored: unknown): VoicePrefs {
  const v = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  return {
    microphone: typeof v["microphone"] === "string" && v["microphone"] ? v["microphone"] : null,
    cleanUp: dictationCleanUpOn(v),
  };
}
