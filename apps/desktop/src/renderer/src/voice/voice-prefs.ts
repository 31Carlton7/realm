import { dictationCleanUpOn } from "@realm/contracts";

/** Voice mode's and dictation's settings, kept as one row under `VOICE_PREFS_KEY`. */
export type VoicePrefs = {
  /** The system voice to speak with, by identifier. Null speaks with the best one installed. */
  voice: string | null;
  /** The microphone to listen with, by device id. Null listens with the system's default input. */
  microphone: string | null;
  /** Speaking rate, as a multiple of the system's default. */
  rate: number;
  /** The pause after speech that sends the message. */
  endOfTurnMs: number;
  /** Listen without a press. Off, only push-to-talk starts a turn. */
  handsFree: boolean;
  /** Who speaks the replies. Only this Mac's own synthesizer today; a cloud voice would be a second
   *  value here, and an opt-in. */
  speech: "system";
  /** Tidy dictated words with a model before they land in the draft. Off unless turned on: off,
   *  dictation never leaves the Mac. */
  cleanUp: boolean;
};

export { VOICE_PREFS_KEY } from "@realm/contracts";

export const RATE_RANGE = { min: 0.8, max: 1.5, step: 0.05 } as const;
export const END_OF_TURN_RANGE = { min: 400, max: 2000, step: 100 } as const;

export const DEFAULT_VOICE_PREFS: VoicePrefs = { voice: null, microphone: null, rate: 1, endOfTurnMs: 700, handsFree: true, speech: "system", cleanUp: false };

const clamp = (v: unknown, r: { min: number; max: number }, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, v)) : fallback;

/** What is stored, made safe: anything missing or out of range falls back to the default. */
export function readVoicePrefs(stored: unknown): VoicePrefs {
  const v = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  return {
    voice: typeof v["voice"] === "string" && v["voice"] ? v["voice"] : null,
    microphone: typeof v["microphone"] === "string" && v["microphone"] ? v["microphone"] : null,
    rate: clamp(v["rate"], RATE_RANGE, DEFAULT_VOICE_PREFS.rate),
    endOfTurnMs: Math.round(clamp(v["endOfTurnMs"], END_OF_TURN_RANGE, DEFAULT_VOICE_PREFS.endOfTurnMs)),
    handsFree: typeof v["handsFree"] === "boolean" ? v["handsFree"] : DEFAULT_VOICE_PREFS.handsFree,
    speech: "system",
    cleanUp: dictationCleanUpOn(v),
  };
}
