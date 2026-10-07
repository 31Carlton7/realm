import { useEffect, useRef } from "react";
import type { StoreApi } from "zustand";
import type { AppState } from "./state/store";

/**
 * The one egg you have to find, and the only thing that unlocks the palette it pays out.
 *
 * Not a `hotkeys.ts` binding: that table matches one chord on one event, and this is a sequence.
 * Its guard would also be wrong here — bindings are swallowed inside inputs, and the sequence has
 * to land wherever the person happens to be typing.
 *
 * Nothing is ever consumed. The arrow keys belong to whatever has focus — a list, a transcript, the
 * composer's own caret — and an egg that ate them would be a bug long before anyone found it.
 */
const SEQUENCE = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

export function useKonami(store: StoreApi<AppState>) {
  const typed = useRef<string[]>([]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Read per-event rather than closed over: the switch can move while the app is open, and the
      // listener must not have to be torn down and rebuilt to notice.
      const s = store.getState();
      if (!s.easterEggs || s.konamiUnlocked) return;
      // A modifier means the key is part of some other gesture, and letters arrive in whatever case
      // shift left them in.
      if (e.metaKey || e.ctrlKey || e.altKey) { typed.current = []; return; }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      typed.current = [...typed.current, key].slice(-SEQUENCE.length);
      if (typed.current.length < SEQUENCE.length) return;
      if (!SEQUENCE.every((k, i) => typed.current[i] === k)) return;
      typed.current = [];
      void s.run(() => s.unlockKonami());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
}
