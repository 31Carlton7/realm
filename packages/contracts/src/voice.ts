/** Voice's settings row: the renderer's `VoicePrefs` (apps/desktop/.../voice/voice-prefs.ts). */
export const VOICE_PREFS_KEY = "ui.voice";

/** The longest dictation `dictation.clean` takes: a few minutes of talking. */
export const DICTATION_MAX = 4000;

/** Whether Settings ▸ Voice ▸ Clean up dictation is on. Off unless the row says `true`. */
export function dictationCleanUpOn(stored: unknown): boolean {
  return !!stored && typeof stored === "object" && (stored as Record<string, unknown>)["cleanUp"] === true;
}

/** `dictation.clean`'s answer. Anything but `cleaned` hands back the raw words. */
export type DictationCleanResult = { outcome: "off" | "cleaned" | "kept" | "failed"; text: string; reason?: string };
