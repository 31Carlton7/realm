import { hexToOklch, oklchToHex, srgb, type Oklch, type TerminalColorScheme } from "@realm/contracts";
import type { Mode } from "./theme";
import { lift, type ThemeName } from "./themes";

/**
 * A terminal's colours: the sixteen a program names by number, and the ink, cursor, selection and
 * faint text around them.
 *
 * Realm's own sixteen are drawn for the pane's ground in each face, the way its ink ramp is: one
 * lightness band per row, so no colour shouts over its neighbours, hues taken from the app's own
 * (its red, its green, its blue accent, and an amber that sits beside its orange), and every colour a
 * program prints text in clearing the 4.5 : 1 the app's own quiet text does — bright black included,
 * since it is the grey half the CLIs on this Mac print their secondary text in. A themed palette wears
 * its upstream's own terminal port instead, corrected along lightness to the face's floor within the
 * same budget a theme's other hues get, so Dracula's terminal is Dracula's.
 *
 * What it deliberately does NOT reach is the other 240. A powerlevel10k prompt draws in 256-colour and
 * truecolor codes, which never pass through the sixteen, so the prompt keeps the look its owner chose.
 * What holds those to a floor is xterm's own `minimumContrastRatio`, set low in the dark face — where
 * a prompt's colours were picked for a dark ground and only the illegible need help — and at AA in the
 * light one, where nearly everything a CLI prints was picked for a dark ground and fails.
 */

/** xterm's sixteen, in its order: black, red, green, yellow, blue, magenta, cyan, white, then bright. */
export const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;

/**
 * The floor each face holds a program's colours to. Realm's own sixteen are authored to AA in both
 * faces; this is the floor for everything else — a themed palette's corrected hues, and, through
 * `minimumContrastRatio`, every colour a program names itself.
 *
 * Three in dark, which every colour p10k's stock lean prompt draws already clears on Realm's dark
 * ground (see the p10k suite), so the prompt reaches the screen exactly as it was drawn while an
 * illegible colour still gets lifted. AA in light, as before this palette existed.
 */
export const TERMINAL_FLOOR: Record<Mode, number> = { dark: 3, light: 4.5 };

/** Realm's sixteen, per face, in OKLCH — the space the band was drawn in. Validated, not tuned by
 *  eye: the suite holds every text colour to 4.5 : 1 on the pane's canvas and on the dock's raised
 *  surface, in both faces. */
const REALM_ANSI: Record<Mode, readonly Oklch[]> = {
  dark: [
    // Black is a step ABOVE the ground rather than on it: p10k's rainbow prompt paints its status
    // and context segments in it, and a segment the colour of the ground is not a segment.
    { l: 0.32, c: 0.006, h: 265 },
    { l: 0.70, c: 0.150, h: 23 }, { l: 0.74, c: 0.135, h: 152 }, { l: 0.80, c: 0.120, h: 82 },
    // Blue sits as dark as the dock's surface lets it — p10k's rainbow writes its path in near-white
    // on it, and that is the label a darker blue would serve better.
    { l: 0.66, c: 0.145, h: 256 },
    { l: 0.72, c: 0.125, h: 322 }, { l: 0.77, c: 0.095, h: 205 }, { l: 0.84, c: 0.005, h: 265 },
    { l: 0.66, c: 0.010, h: 265 },
    { l: 0.78, c: 0.125, h: 23 }, { l: 0.82, c: 0.120, h: 152 }, { l: 0.87, c: 0.110, h: 86 },
    { l: 0.77, c: 0.115, h: 254 }, { l: 0.81, c: 0.105, h: 322 }, { l: 0.86, c: 0.085, h: 205 }, { l: 0.985, c: 0.001, h: 248 },
  ],
  light: [
    { l: 0.30, c: 0.008, h: 265 },
    { l: 0.53, c: 0.175, h: 25 }, { l: 0.505, c: 0.125, h: 150 }, { l: 0.54, c: 0.115, h: 70 },
    { l: 0.52, c: 0.180, h: 258 }, { l: 0.52, c: 0.170, h: 322 }, { l: 0.52, c: 0.095, h: 212 },
    // White is a light grey, the ground of a segment rather than ink — on near-white paper there is
    // no white a program could print text in.
    { l: 0.86, c: 0.006, h: 265 },
    { l: 0.53, c: 0.010, h: 265 },
    // Bright is brighter in CHROMA here, not in lightness: bold text is drawn in the bright row, and
    // a lighter row would make bold the faintest text on the page.
    { l: 0.545, c: 0.205, h: 25 }, { l: 0.52, c: 0.150, h: 150 }, { l: 0.55, c: 0.135, h: 72 },
    { l: 0.535, c: 0.205, h: 258 }, { l: 0.54, c: 0.195, h: 322 }, { l: 0.53, c: 0.110, h: 212 }, { l: 0.975, c: 0.003, h: 265 },
  ],
};

/**
 * Each themed palette's own terminal port, as its project publishes it — the copies iTerm2-Color-
 * Schemes (MIT) collects and Ghostty ships, read off Ghostty 1.x's theme files. One's are One Half
 * (sonph/onehalf, MIT © Son A. Pham), the port whose grounds are One's own; Solarized's are the
 * scheme's own iTerm2 files, bright row of base tones and all.
 *
 * Phosphor has no upstream, so it is drawn here from its own seeds, by its own rule: everything bends
 * toward the phosphor except red and yellow, which carry failure and warning.
 */
export const THEME_TERMINALS: Partial<Record<ThemeName, Partial<Record<Mode, readonly string[]>>>> = {
  one: {
    dark: ["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#dcdfe4",
      "#5d677a", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#dcdfe4"],
    light: ["#383a42", "#e45649", "#50a14f", "#c18401", "#0184bc", "#a626a4", "#0997b3", "#bababa",
      "#4f525e", "#e06c75", "#98c379", "#d8b36e", "#61afef", "#c678dd", "#56b6c2", "#ffffff"],
  },
  monokai: {
    dark: ["#272822", "#f92672", "#a6e22e", "#e6db74", "#fd971f", "#ae81ff", "#66d9ef", "#fdfff1",
      "#6e7066", "#f92672", "#a6e22e", "#e6db74", "#fd971f", "#ae81ff", "#66d9ef", "#fdfff1"],
  },
  dracula: {
    dark: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
      "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"],
  },
  nord: {
    dark: ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
      "#596377", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"],
  },
  solarized: {
    dark: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#335e69", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"],
    light: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#bbb5a2",
      "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"],
  },
  gruvbox: {
    dark: ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
      "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"],
    light: ["#fbf1c7", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#7c6f64",
      "#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#3c3836"],
  },
  catppuccin: {
    dark: ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
      "#585b70", "#f37799", "#89d88b", "#ebd391", "#74a8fc", "#f2aede", "#6bd7ca", "#bac2de"],
    light: ["#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be",
      "#6c6f85", "#de293e", "#49af3d", "#eea02d", "#456eff", "#fe85d8", "#2d9fa8", "#bcc0cc"],
  },
  github: {
    dark: ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
      "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"],
    light: ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781",
      "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"],
  },
  rosepine: {
    dark: ["#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4",
      "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4"],
    light: ["#f2e9e1", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279",
      "#9893a5", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279"],
  },
  phosphor: {
    dark: ["#1c2e22", "#ff6b6b", "#4ade80", "#f5b942", "#5eead4", "#a8f0c0", "#7dffb0", "#c9f7d8",
      "#4e7a5f", "#ff8a8a", "#86efac", "#fcd581", "#99f6e4", "#c9f7d8", "#a8f0c0", "#e9fdf0"],
  },
};

/** xterm's own sixteen (`DEFAULT_ANSI_COLORS`, xterm.js 5.5): what "My shell's" hands back, stated
 *  rather than left unset so faint text is drawn the same way under either answer. */
export const XTERM_ANSI: readonly string[] = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];

/**
 * The ends of the grey ramp — black, white, bright white — are a palette's own definition of a ground
 * and of an ink, and are left exactly as stated: Gruvbox Light's "black" IS its paper. Everything else
 * is a colour a program prints text in, and is held to the floor.
 */
const RAMP_ENDS = new Set([0, 7, 15]);

export type TerminalPalette = {
  /** Sixteen hex colours, in `ANSI_NAMES` order. */
  ansi: readonly string[];
  foreground: string;
  cursor: string;
  cursorAccent: string;
  /** Opaque, so xterm lays it at its own 30% — over a ground it measures against. */
  selection: string;
  /** Unfocused: the ink's grey rather than the accent, as a Mac text view greys an inactive selection. */
  selectionInactive: string;
  /** How much of its colour SGR-dim (faint) text keeps, 0–1: the step `--ink-2` takes down from
   *  `--ink` toward the ground, so faint terminal text is the app's own secondary ink. xterm's own
   *  answer is a flat half, which in the light face put faint text under 3.3 : 1. */
  dim: number;
  minimumContrastRatio: number;
};

const hexA = (o: Oklch, alpha: number): string => `${oklchToHex(o)}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;

/** The step from the ground to `ink2`, as a share of the step from the ground to `ink`, measured on
 *  the ENCODED channels — alpha composites there, and a dim colour is drawn as an alpha. */
export function dimWeight(ground: Oklch, ink: Oklch, ink2: Oklch): number {
  const [g, i, j] = [ground, ink, ink2].map((o) => srgb(o).reduce((a, b) => a + b, 0) / 3) as [number, number, number];
  const w = Math.abs(i - g) < 1e-3 ? 0.5 : (j - g) / (i - g);
  return Math.min(0.9, Math.max(0.4, +w.toFixed(3)));
}

/**
 * The palette for one face of one theme, on the ground it will actually be drawn on. `ground`, `ink`,
 * `ink2` and `accent` are the live tokens, so an override, the contrast control and an imported
 * theme all arrive already applied.
 */
export function terminalPalette({ theme, mode, scheme, ground, ink, ink2, accent }: {
  theme: ThemeName; mode: Mode; scheme: TerminalColorScheme;
  ground: Oklch; ink: Oklch; ink2: Oklch; accent: Oklch;
}): TerminalPalette {
  const around = {
    foreground: oklchToHex(ink), cursor: oklchToHex(ink), cursorAccent: oklchToHex(ground),
    selection: oklchToHex(accent), selectionInactive: hexA(ink, 0.18),
    dim: dimWeight(ground, ink, ink2),
  };
  if (scheme === "shell") {
    // xterm's palette and ink are drawn for a black ground, so the dark face is left to them entirely,
    // as it always was; the light face keeps the app's ink and the floor, without which none of it
    // is readable on paper.
    return mode === "light"
      ? { ...around, ansi: XTERM_ANSI, minimumContrastRatio: TERMINAL_FLOOR.light }
      : { ...around, ansi: XTERM_ANSI, foreground: "#ffffff", cursor: "#ffffff", minimumContrastRatio: 1 };
  }
  const stated = THEME_TERMINALS[theme]?.[mode];
  const ansi = theme === "realm" || !stated
    // Realm's own, exact — and for a theme with no port of its own (an import), Realm's held to
    // that theme's ground, which is the same correction a stated hue gets.
    ? REALM_ANSI[mode].map((o, i) => (theme === "realm" || RAMP_ENDS.has(i) ? o : lift(o, ground, 4.5)))
    : stated.map((hex, i) => (RAMP_ENDS.has(i) ? hexToOklch(hex) : lift(hexToOklch(hex), ground, TERMINAL_FLOOR[mode])));
  return { ...around, ansi: ansi.map(oklchToHex), minimumContrastRatio: TERMINAL_FLOOR[mode] };
}
