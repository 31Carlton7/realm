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

export type Palette = {
  mode: Mode;
  /** Ink: the fixed near-white (dark) / near-black (light) emphasis colour. Primary buttons, focus
   *  rings, active ticks, send button. Chrome is space-agnostic — never derived from the space colour. */
  accent: string;
  /** Text/icon colour on accent fills. */
  accentContrast: string;
  /** The space colour, contrast-clamped for the mode's surfaces. Feeds only the space dot and the
   *  space-strip glyph — the one identity pixel; never chrome. */
  space: string;
  frame: string; panel: string; raised: string; line: string; lineStrong: string;
  /** Translucent fill for hover states — reads on any surface, unlike surface-on-surface fills. */
  hover: string;
  /** Translucent fill for selected pills (replaces accent-tinted selection). */
  active: string;
  textBright: string; textDim: string; textFaint: string;
  danger: string; success: string; warning: string;
  terminalBg: string; shadow: string;
  /** 1px inset alpha hairline for floating surfaces — a box-shadow, composes with `shadow`. */
  edge: string;
};

/** Ink grayscale palette (design-language 2026-08-27 §3). Surfaces are fixed pure-neutral greys in
 *  both modes; the space colour no longer tints the ground and no longer produces the accent. It
 *  survives only as `space`, contrast-adjusted so it stays legible on the mode's surfaces (dark:
 *  lightness clamped to [55, 75]; light: clamped to [35, 55]). The 25% saturation floor applies only
 *  when the input has real chroma (s >= 8); below that threshold hue is meaningless noise
 *  (black/white/grey), so flooring it would fabricate a colour the user never chose — achromatic
 *  input stays achromatic, relying on the lightness clamp alone for visibility. */
export function paletteFromColor(hex: string, mode: Mode): Palette {
  const h = hexToHsl(hex);
  const s = h.s >= 8 ? Math.max(h.s, 25) : h.s;
  const space = hslToHex(mode === "dark"
    ? { h: h.h, s, l: Math.min(75, Math.max(55, h.l)) }
    : { h: h.h, s, l: Math.min(55, Math.max(35, h.l)) });
  if (mode === "dark") return {
    mode, space,
    accent: "#f2f2f2", accentContrast: "#111111",
    frame: "#121212", panel: "#1a1a1a", raised: "#222222", line: "#252525", lineStrong: "#333333",
    hover: "rgba(255,255,255,.06)", active: "rgba(255,255,255,.09)",
    textBright: "#f2f2f2", textDim: "#a0a0a0", textFaint: "#6f6f6f",
    danger: "#e5484d", success: "#46a758", warning: "#d9822b",
    terminalBg: "#0e0e0e",
    shadow: "0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.45)",
    edge: "inset 0 0 0 1px rgba(255,255,255,.07)",
  };
  return {
    mode, space,
    accent: "#181818", accentContrast: "#ffffff",
    frame: "#f4f4f4", panel: "#ffffff", raised: "#fafafa", line: "#e8e8e8", lineStrong: "#d6d6d6",
    hover: "rgba(0,0,0,.05)", active: "rgba(0,0,0,.07)",
    textBright: "#181818", textDim: "#606060", textFaint: "#8f8f8f",
    danger: "#d93036", success: "#2f9e44", warning: "#c2701d",
    terminalBg: "#141414", // terminals stay dark in light mode — corpus-consistent
    shadow: "0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(20,20,20,.10)",
    edge: "inset 0 0 0 1px rgba(0,0,0,.07)",
  };
}

/** `textBright` → `--rl-text-bright`, etc. `mode` is exposed via `data-mode`, not a variable. */
export function themeToCssVars(p: Palette): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) if (k !== "mode") out[`--rl-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`] = String(v);
  return out;
}

export function applyTheme(p: Palette, root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(themeToCssVars(p))) root.style.setProperty(k, v);
  root.dataset.mode = p.mode;
}
