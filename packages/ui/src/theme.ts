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

const at = (h: number, s: number, l: number) => hslToHex({ h, s, l });

export type Palette = {
  mode: Mode; accent: string;
  sidebarBg: string; sidebarBg2: string; sidebarFg: string; sidebarMuted: string; sidebarItemHover: string; sidebarItemActive: string;
  surface: string; surface2: string; border: string; fg: string; muted: string; cardShadow: string; toolBg: string; userBubble: string;
  danger: string; success: string; warning: string;
};

/** Derive the full UI palette from a space's accent color. Sidebar tints follow the hue; content surfaces stay neutral. */
export function paletteFromColor(hex: string, mode: Mode): Palette {
  const b = hexToHsl(hex);
  // Near-gray accents (black, white, grays) get neutral sidebar tints instead of an arbitrary hue.
  const k = Math.min(1, b.s / 30);
  const h2 = (b.h + 40) % 360;
  if (mode === "light") return {
    mode, accent: hex, sidebarBg: at(b.h, 70 * k, 90), sidebarBg2: at(h2, 60 * k, 92), sidebarFg: "#1d1d1f", sidebarMuted: "#5c5c66",
    sidebarItemHover: "rgba(255,255,255,0.45)", sidebarItemActive: "rgba(255,255,255,0.85)", surface: "#ffffff", surface2: "#f6f6f8", border: "#e6e6ec", fg: "#1d1d1f", muted: "#6b6b76",
    cardShadow: "0 8px 30px rgba(20,20,40,0.12)", toolBg: "#fafafb", userBubble: "#f1f1f5", danger: "#dc2626", success: "#16a34a", warning: "#d97706",
  };
  return {
    mode, accent: hex, sidebarBg: at(b.h, 45 * k, 16), sidebarBg2: at(h2, 40 * k, 12), sidebarFg: "#ecebf3", sidebarMuted: "#a7a5b8",
    sidebarItemHover: "rgba(255,255,255,0.08)", sidebarItemActive: "rgba(255,255,255,0.16)", surface: "#141416", surface2: "#1b1b1f", border: "#2a2a30", fg: "#e8e8ea", muted: "#8b8f98",
    cardShadow: "0 8px 30px rgba(0,0,0,0.45)", toolBg: "#1a1a1e", userBubble: "#1e1e22", danger: "#f87171", success: "#6ee7a0", warning: "#fbbf24",
  };
}

/** `sidebarBg` → `--rl-sidebar-bg`, etc. `mode` is exposed via `data-mode`, not a variable. */
export function themeToCssVars(p: Palette): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) if (k !== "mode") out[`--rl-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`] = String(v);
  return out;
}

export function applyTheme(p: Palette, root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(themeToCssVars(p))) root.style.setProperty(k, v);
  root.dataset.mode = p.mode;
}
