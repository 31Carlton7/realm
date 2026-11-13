import { VOICE_PREFS_KEY, dictationCleanUpOn, type DictationCleanResult } from "@realm/contracts";
import type { CleanedDictation } from "@realm/adapters";

export type DictationCleanup = (raw: string) => Promise<CleanedDictation>;

/** The longest the prompter waits for the model before it keeps the raw words. Each call starts the
 *  Claude CLI afresh, which is most of the wait: about 8 s on a loaded Mac, for a second of model. */
const TIMEOUT_MS = 15_000;

/**
 * `dictation.clean`: the switch is read here, on every call, rather than trusted from the renderer,
 * so with Clean up dictation off no text leaves the Mac whatever asked. Every failure hands back the
 * raw words, with the reason, and the prompter says so.
 */
export class DictationCleaner {
  constructor(private readonly deps: { settings: { get(key: string): unknown }; cleanup?: DictationCleanup; timeoutMs?: number }) {}

  async clean(text: string): Promise<DictationCleanResult> {
    if (!dictationCleanUpOn(this.deps.settings.get(VOICE_PREFS_KEY))) return { outcome: "off", text };
    const { cleanup } = this.deps;
    if (!cleanup) return { outcome: "failed", text, reason: "unavailable" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), this.deps.timeoutMs ?? TIMEOUT_MS); });
    try {
      const done = await Promise.race([cleanup(text), late]);
      return done.outcome === "cleaned" ? done : { outcome: "kept", text, reason: done.reason };
    } catch (e) {
      return { outcome: "failed", text, reason: (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}
