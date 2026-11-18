import { useSyncExternalStore } from "react";
import { useApp } from "../state/store";
import { shownLook, supportsBackdropUrl, type Look } from "./look";

const REDUCE_TRANSPARENCY = "(prefers-reduced-transparency: reduce)";

function useReduceTransparency(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia?.(REDUCE_TRANSPARENCY);
      query?.addEventListener?.("change", changed);
      return () => query?.removeEventListener?.("change", changed);
    },
    () => window.matchMedia?.(REDUCE_TRANSPARENCY).matches ?? false,
  );
}

/** The Mac's Low Power Mode, which App stamps on the root as `data-low-power-mode`. */
function useLowPowerMode(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const watch = new MutationObserver(changed);
      watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-low-power-mode"] });
      return () => watch.disconnect();
    },
    () => document.documentElement.hasAttribute("data-low-power-mode"),
  );
}

/** The look the app is drawn in now: the setting, put back to plain by `shownLook`'s fallbacks. */
export function useLook(): Look {
  const pref = useApp((s) => s.look);
  const lowPower = useApp((s) => s.lowPower);
  const reduceTransparency = useReduceTransparency();
  const lowPowerMode = useLowPowerMode();
  return shownLook(pref, { reduceTransparency, lowPower, lowPowerMode, supportsBackdropUrl: supportsBackdropUrl() });
}
