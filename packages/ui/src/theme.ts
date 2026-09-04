import { THEME_VARS, themeVars, type ThemeName } from "./themes";

export type Mode = "light" | "dark";
export type Hsl = { h: number; s: number; l: number };

export function hexToHsl(hex: string): Hsl {
  const m = hex.replace("#", "");
  const n = parseInt(m.length === 3 ? m.split("").map((c) => c + c).join("") : m, 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  // Unrounded so hslToHex(hexToHsl(x)) === x; callers needing integers can round themselves.
  return { h, s: s * 100, l: l * 100 };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const S = s / 100, L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

/** The space colour, contrast-clamped so it stays legible on the mode's surfaces (dark: lightness
 *  clamped to [55, 75]; light: clamped to [35, 55]). The 25% saturation floor applies only when the
 *  input has real chroma (s >= 8); below that threshold hue is meaningless noise (black/white/grey),
 *  so flooring it would fabricate a colour the user never chose — achromatic input stays achromatic,
 *  relying on the lightness clamp alone for visibility. It feeds only the space dot and the
 *  space-strip glyph — the one identity pixel; never chrome.
 *
 *  Plan 9 W1: this is ALL the runtime palette that is left. The full design system — surfaces, ink
 *  ramp, borders, accent, semantic colours, shadows — is the Beautiful UI token set, static CSS in
 *  the renderer (theme/tokens.css, dark-first, flipped by `data-mode`), bridged onto the legacy
 *  `--rl-*` names in styles.css. This module no longer generates or writes any of those tokens. */
export function spaceColor(hex: string, mode: Mode): string {
  const h = hexToHsl(hex);
  const s = h.s >= 8 ? Math.max(h.s, 25) : h.s;
  return hslToHex(mode === "dark"
    ? { h: h.h, s, l: Math.min(75, Math.max(55, h.l)) }
    : { h: h.h, s, l: Math.min(55, Math.max(35, h.l)) });
}

/** How much of the window ground the sidebar paints over the macOS material, as a percentage. 82 is
 *  the value the sidebar has always used and the one the design was calibrated on; it lives here
 *  rather than in the stylesheet so there is exactly one of it. tokens.css declares 100% for the case
 *  where this module never runs, which is a different fact — a renderer that failed to boot should
 *  show an opaque sidebar, not a see-through one. */
export const DEFAULT_GROUND_ALPHA = 82;

/** Fully opaque at the top — which is what "off" means, since covering the material is the same as
 *  not having asked for it. The floor is where the ground stops carrying the sidebar's own text:
 *  screenshotting the built app over a bright desktop, the nav labels wash out somewhere below 55%,
 *  because past that point their legibility is a property of the user's wallpaper rather than of the
 *  palette. Apple's own sidebars go all the way to bare material and stay readable, so this is a
 *  judgement about Realm's denser sidebar and not a limit of the material — but it is a floor,
 *  because a control that can make the app's navigation unreadable is not a preference.
 *
 *  It cannot be checked automatically: the material is composited by the window server BELOW the web
 *  contents, so a CDP screenshot never sees it (see transparency-live.mjs). This number came from
 *  looking. */
export const GROUND_ALPHA_RANGE = { min: 55, max: 100 } as const;

export const clampGroundAlpha = (pct: number): number =>
  Math.round(Math.min(GROUND_ALPHA_RANGE.max, Math.max(GROUND_ALPHA_RANGE.min, pct)));

/** Writes the runtime tokens and stamps the mode and theme on the root. `data-mode` is what flips the
 *  CSS token blocks (and Tailwind's `dark:` variant, remapped onto it) between the dark and light BUI
 *  ramps; `data-theme` is a label for the stylesheet and the live checks to read, never a selector
 *  the palette hangs off.
 *
 *  A custom theme is a set of INLINE custom properties, which is what lets it win over both token
 *  blocks in tokens.css without a third block or a generated stylesheet. The default theme states
 *  none, so choosing `realm` clears the whole set and the app is back on the static CSS it has always
 *  been. Every name in THEME_VARS is cleared before the new set is written, or the properties a
 *  theme happens not to state would still be pointing at the theme before it.
 *
 *  `--ground-alpha` rides along rather than getting a writer of its own: `:root` has one owner, and
 *  the transparency and the palette change together often enough (every theme switch repaints the
 *  ground the alpha is applied to) that two writers would be two chances to leave them disagreeing.
 *  Note what it does NOT write: `--sidebar-ground`, the composed value the stylesheet actually reads.
 *  That composition stays in CSS so `prefers-reduced-transparency` can override it — an inline
 *  property would beat any media query, and the app already honours that preference in its fade
 *  bands. */
export function applyTheme(
  { space, mode, theme = "realm", groundAlpha = DEFAULT_GROUND_ALPHA }:
    { space: string; mode: Mode; theme?: ThemeName; groundAlpha?: number },
  root: HTMLElement = document.documentElement,
): void {
  root.style.setProperty("--rl-space", spaceColor(space, mode));
  root.style.setProperty("--ground-alpha", `${clampGroundAlpha(groundAlpha)}%`);
  root.dataset.mode = mode;
  root.dataset.theme = theme;
  const vars = themeVars(theme, mode);
  for (const name of THEME_VARS) {
    const value = vars[name];
    if (value === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
}
