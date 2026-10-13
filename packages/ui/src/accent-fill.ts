import { contrast, emitted, luminance, type Oklch } from "@realm/contracts";

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** `accent` walked along L, away from `label`, until the label clears the target or `budget` runs
 *  out. Hue and chroma stay: the fill is still the theme's colour, only deeper or brighter. */
function deepen(accent: Oklch, label: Oklch, budget: number): Oklch {
  const dir = luminance(accent) >= luminance(label) ? 1 : -1;
  const g = emitted(label);
  let best = accent;
  for (let d = 0; d <= budget + 1e-9; d += 0.002) {
    best = { ...accent, l: clamp(accent.l + dir * d, 0, 1) };
    if (contrast(emitted(best), g) >= ON_ACCENT_TARGET) return best;
  }
  return best;
}

/** A filled accent control — a primary button, the send circle, a checked box — and the word on it.
 *  The accent itself is a mid blue in most palettes, and white on a mid blue is under 3:1 (Realm's
 *  own dark #3d9aff measured 2.89), so the fill is SOLVED for its label rather than borrowed from
 *  the accent: keep the hue and chroma, deepen L until the label clears `ON_ACCENT_TARGET`. White is
 *  preferred — Realm's buttons are white on blue — for as long as the fill can stay within
 *  `FILL_BUDGET` of the accent; past that the fill would read as a different colour, so the label
 *  goes dark instead and the fill brightens (Dracula's lavender, Nord's frost). Hover and press move
 *  the fill AWAY from its label, one step and two, so neither state can ever read worse than rest. */
export type AccentFill = { label: Oklch; fill: Oklch; hover: Oklch; press: Oklch };
export const WHITE: Oklch = { l: 1, c: 0, h: 0 };
const BLACK: Oklch = { l: 0, c: 0, h: 0 };
/** AA's 4.5, plus room for the bevel's top highlight and a squircle's antialiased rim, which both
 *  lighten pixels the label sits on. */
export const ON_ACCENT_TARGET = 5;
/** How far a fill may deepen from the accent to keep a white label. Realm's dark blue needs 0.14. */
export const FILL_BUDGET = 0.16;
/** ΔL of hover and press from rest, away from the label. */
export const FILL_STATES = { hover: 0.04, press: 0.09 } as const;

export function accentFill(accent: Oklch, { dark, light = WHITE, prefer = "light" }:
  { dark: Oklch; light?: Oklch; prefer?: "light" | "dark" }): AccentFill {
  const attempts: [Oklch, number][] = prefer === "light"
    ? [[light, FILL_BUDGET], [dark, 1], [BLACK, 1]]
    : [[dark, FILL_BUDGET], [light, 1], [BLACK, 1]];
  let label = attempts[0]![0], fill = accent;
  for (const [l, budget] of attempts) {
    [label, fill] = [l, deepen(accent, l, budget)];
    if (contrast(emitted(fill), emitted(l)) >= ON_ACCENT_TARGET) break;
  }
  const away = luminance(label) > luminance(fill) ? -1 : 1;
  /* A fill already at the end of the axis (a near-white accent under a dark label) has nowhere
     further to go, so its states step back towards the label — which, that far out, costs nothing
     the target cares about. */
  const at = (d: number): Oklch => {
    const l = fill.l + away * d;
    return { ...fill, l: l < 0 || l > 1 ? clamp(fill.l - away * d, 0, 1) : l };
  };
  return { label, fill, hover: at(FILL_STATES.hover), press: at(FILL_STATES.press) };
}
