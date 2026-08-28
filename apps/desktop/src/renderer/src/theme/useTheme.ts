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

/** How long the no-transition guard holds. Long enough for the new palette to paint, short enough
 *  that a hover started right after a theme switch still animates. */
const SETTLE_MS = 60;

/** §6 does not animate theme/mode switching. Rewriting the palette changes the computed value of
 *  every colour at once, and the surfaces that carry a 100ms hover transition (rows, buttons, chips)
 *  would tween to the new theme while everything else snapped — a smear, not a transition. Suppress
 *  transitions for a beat around the swap so the whole window changes in one frame. */
export function suppressTransitions(root: HTMLElement, ms = SETTLE_MS): () => void {
  root.setAttribute("data-theme-switching", "");
  const id = setTimeout(() => root.removeAttribute("data-theme-switching"), ms);
  return () => { clearTimeout(id); root.removeAttribute("data-theme-switching"); };
}

/** Resolves the effective mode from the user preference and writes the space palette to `:root`. */
export function useApplyTheme(color: string | null, pref: ThemePref): Mode {
  const sys = useSystemMode();
  const mode: Mode = pref === "system" ? sys : pref;
  // Layout effect so the first paint already carries the palette (no flash of default vars).
  useLayoutEffect(() => {
    const done = suppressTransitions(document.documentElement);
    applyTheme(paletteFromColor(color ?? "#7c6cff", mode));
    return done;
  }, [color, mode]);
  return mode;
}
