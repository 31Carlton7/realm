import { Icon } from "@realm/ui";
import { useRef } from "react";

/** How long a press on the mic is held before it is push-to-talk rather than a click. */
export const HOLD_MS = 350;

/**
 * The prompter's voice mode button, beside the mic that dictates. A click opens voice mode, listening hands-free; a press held past `HOLD_MS`
 * opens it already talking, and letting go sends what was said.
 */
export function VoiceButton({ name, onVoice }: { name: string; onVoice: (held: boolean) => void }) {
  const timer = useRef<number | null>(null);
  const heldOpen = useRef(false);
  const cancel = () => { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; } };
  return (
    <button type="button" className="icon-btn composer-attach composer-voice" aria-label="Voice mode"
      title={`Talk with ${name} (hold to talk)`}
      onPointerDown={(e) => {
        if (e.button > 0) return;
        heldOpen.current = false;
        cancel();
        timer.current = window.setTimeout(() => { timer.current = null; heldOpen.current = true; onVoice(true); }, HOLD_MS);
      }}
      onPointerLeave={cancel}
      onClick={() => {
        cancel();
        if (heldOpen.current) { heldOpen.current = false; return; }
        onVoice(false);
      }}>
      <Icon name="voiceWave" size={16} />
    </button>
  );
}
