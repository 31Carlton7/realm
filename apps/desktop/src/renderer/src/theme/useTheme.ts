import { useEffect, useLayoutEffect, useState } from "react";
import { applyTheme, paletteFromColor, type Mode } from "@realm/ui";

export type ThemePref = "system" | "light" | "dark";

/** Tracks the OS color scheme via `prefers-color-scheme`. Falls back to light where matchMedia is unavailable (tests). */
export function useSystemMode(): Mode {
  const mq = () => window.matchMedia?.("(prefers-color-scheme: dark)");
  const [mode, setMode] = useState<Mode>(() => (mq()?.matches ? "dark" : "light"));
  useEffect(() => {
    const m = mq(); if (!m) return;
    const fn = () => setMode(m.matches ? "dark" : "light");
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, []);
  return mode;
}

/** Resolves the effective mode from the user preference and writes the space palette to `:root`. */
export function useApplyTheme(color: string | null, pref: ThemePref): Mode {
  const sys = useSystemMode();
  const mode: Mode = pref === "system" ? sys : pref;
  // Layout effect so the first paint already carries the palette (no flash of default vars).
  useLayoutEffect(() => { applyTheme(paletteFromColor(color ?? "#7c6cff", mode)); }, [color, mode]);
  return mode;
}
