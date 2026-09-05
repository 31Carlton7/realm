import { useEffect, useLayoutEffect, useState } from "react";
import { DEFAULT_GROUND_ALPHA, DEFAULT_SELECTION, applyTheme, paletteFor, type Mode, type ThemeSelection } from "@realm/ui";

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

/** The face on screen: the preference, resolved against the OS only where it defers to it. Every
 *  control that offers "the palette for the mode you are looking at" needs this same answer, and one
 *  of them computing it differently would set the slot the user is not seeing. */
export function useResolvedMode(pref: ThemePref): Mode {
  const sys = useSystemMode();
  return pref === "system" ? sys : pref;
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

/** Resolves the two axes — the user's light/dark preference, and the palette that face wears — and
 *  stamps the result (plus the space colour) on `:root`. On the default theme the palette is still
 *  static CSS (BUI tokens in theme/tokens.css keyed on `data-mode`) and the only runtime writes are
 *  `--rl-space` and the two attributes.
 *
 *  The mode is now the preference and nothing else. A palette used to be able to pin it — the only
 *  way a single selection could honour "Monokai, which has no light face" — and with a slot per face
 *  there is no such conflict to resolve: each slot is offered only palettes that have its face. */
export function useApplyTheme(color: string | null, pref: ThemePref,
  themes: ThemeSelection = DEFAULT_SELECTION, groundAlpha: number = DEFAULT_GROUND_ALPHA): Mode {
  const mode = useResolvedMode(pref);
  const theme = paletteFor(themes, mode);
  // Layout effect so the first paint already carries the mode (no flash of default vars).
  useLayoutEffect(() => {
    const done = suppressTransitions(document.documentElement);
    applyTheme({ space: color ?? "#7c6cff", mode, theme, groundAlpha });
    return done;
  }, [color, mode, theme, groundAlpha]);
  return mode;
}

/** macOS is the only platform with a material behind the window, so it is the only one where the
 *  sidebar's transparency reveals anything. An unknown platform answers false: this gates a control
 *  that would otherwise do nothing visible, and a control that appears and does nothing is worse
 *  than one that explains why it is not there. */
export const hasWindowMaterial = (): boolean => window.realm?.platform === "darwin";
