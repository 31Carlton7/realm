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
  mode: Mode; accent: string;
  frame: string; panel: string; raised: string; line: string; lineStrong: string;
  textBright: string; textDim: string; textFaint: string;
  danger: string; success: string; warning: string;
  terminalBg: string; shadow: string;
};

/** Flat Codex-style palette. Surfaces are fixed neutrals; the space colour survives only as `accent`,
 *  contrast-adjusted so it stays legible on the mode's surfaces (dark: lightness clamped to [55, 75];
 *  light: clamped to [35, 55]). The 25% saturation floor applies only when the input has real chroma
 *  (s >= 8); below that threshold hue is meaningless noise (black/white/grey), so flooring it would
 *  fabricate a colour the user never chose — achromatic input stays achromatic, relying on the
 *  lightness clamp alone for visibility. */
export function paletteFromColor(hex: string, mode: Mode): Palette {
  const h = hexToHsl(hex);
  const s = h.s >= 8 ? Math.max(h.s, 25) : h.s;
  const accent = hslToHex(mode === "dark"
    ? { h: h.h, s, l: Math.min(75, Math.max(55, h.l)) }
    : { h: h.h, s, l: Math.min(55, Math.max(35, h.l)) });
  if (mode === "dark") return {
    mode, accent,
    frame: "#131417", panel: "#1b1c20", raised: "#222329", line: "#26272c", lineStrong: "#33343b",
    textBright: "#ececf1", textDim: "#9a9ba5", textFaint: "#5e5f68",
    danger: "#f87171", success: "#6ee7a0", warning: "#e8963a",
    terminalBg: "#101114", shadow: "0 8px 24px rgba(0,0,0,.4)",
  };
  return {
    mode, accent,
    frame: "#f2f2f4", panel: "#ffffff", raised: "#ffffff", line: "#e3e3e8", lineStrong: "#d2d2d9",
    textBright: "#1c1c21", textDim: "#5f6068", textFaint: "#9a9aa4",
    danger: "#dc2626", success: "#16a34a", warning: "#c2701d",
    terminalBg: "#16171a", shadow: "0 8px 24px rgba(20,20,40,.14)",
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
