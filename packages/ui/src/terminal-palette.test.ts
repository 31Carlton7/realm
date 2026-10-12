import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contrast, hexToOklch, parseOklch, srgb, type Oklch } from "@realm/contracts";
import { ANSI_NAMES, dimWeight, TERMINAL_FLOOR, THEME_TERMINALS, terminalPalette, XTERM_ANSI } from "./terminal-palette";
import { deriveVars, LIFT_BUDGET, REALM_SEED, THEMES, themeModes, type ThemeName } from "./themes";
import type { Mode } from "./theme";

const here = dirname(fileURLToPath(import.meta.url));

/** The tokens a face of a theme paints with. Realm's come out of its own seeds, which the theme suite
 *  pins to tokens.css — so these ARE the shipped grounds, not a copy of them. */
function tokens(theme: ThemeName, mode: Mode) {
  const def = THEMES.find((t) => t.name === theme)!;
  const seed = (mode === "dark" ? def.dark : def.light) ?? REALM_SEED[mode];
  const v = deriveVars(seed, mode);
  const at = (k: string): Oklch => parseOklch(v[k]!);
  return { canvas: at("--canvas"), surface: at("--surface"), ink: at("--ink"), ink2: at("--ink-2"), accent: at("--accent") };
}

const realm = (mode: Mode) => {
  const t = tokens("realm", mode);
  return { t, p: terminalPalette({ theme: "realm", mode, scheme: "realm", ground: t.canvas, ink: t.ink, ink2: t.ink2, accent: t.accent }) };
};

/** The colours a program prints TEXT in: every one but the ground's end of the grey ramp — black on
 *  the dark face, white and bright white on the light one. */
const textIndices = (mode: Mode): number[] => [...ANSI_NAMES.keys()].filter((i) => (mode === "dark" ? i !== 0 : i !== 7 && i !== 15));

const c = (hex: string, ground: Oklch): number => contrast(hexToOklch(hex), ground);
/** `fg` laid over `ground` at `w`, on the encoded channels — how the dim CSS composites. */
const mix = (fg: string, ground: Oklch, w: number): string => {
  const a = srgb(hexToOklch(fg)), b = srgb(ground);
  return `#${a.map((x, i) => Math.round((x * w + b[i]! * (1 - w)) * 255).toString(16).padStart(2, "0")).join("")}`;
};

describe("Realm's sixteen", () => {
  it("print every text colour at AA on the pane's ground and on the dock's raised one, in both faces", () => {
    // THE mutant this kills is any one hand-edit to the band: a "warmer" red or a deeper blue that
    // looks right in one face and drops a row under 4.5 on the other ground.
    for (const mode of ["dark", "light"] as const) {
      const { t, p } = realm(mode);
      for (const i of textIndices(mode)) {
        for (const [name, ground] of [["canvas", t.canvas], ["surface", t.surface]] as const) {
          expect(c(p.ansi[i]!, ground), `${mode} ${ANSI_NAMES[i]} on ${name}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("hold bright black and blue — the two dark palettes usually let go of — to that floor too", () => {
    // Bright black is where the CLIs on this Mac print their secondary text (ratatui's DarkGray,
    // zsh-autosuggestions), and blue is what `ls` prints every directory in. xterm's stock pair
    // measures 2.31 and 2.85 on the dark canvas.
    const { t, p } = realm("dark");
    expect(c(XTERM_ANSI[8]!, t.canvas)).toBeLessThan(2.5);
    for (const i of [4, 8, 12]) expect(c(p.ansi[i]!, t.surface), ANSI_NAMES[i]).toBeGreaterThanOrEqual(4.5);
  });

  it("keep the bright row a visible step off the normal one on the dark face", () => {
    const { t, p } = realm("dark");
    for (let i = 1; i <= 6; i++) expect(c(p.ansi[i + 8]!, t.canvas) / c(p.ansi[i]!, t.canvas), ANSI_NAMES[i]).toBeGreaterThan(1.25);
  });

  it("draw the ink, cursor and inverse video from the app's own tokens", () => {
    for (const mode of ["dark", "light"] as const) {
      const { t, p } = realm(mode);
      expect(hexToOklch(p.foreground).l).toBeCloseTo(t.ink.l, 2);
      expect(p.cursor).toBe(p.foreground);
      // Text under a block cursor is drawn in the ground, so the cell reads as a cut-out.
      expect(hexToOklch(p.cursorAccent).l).toBeCloseTo(t.canvas.l, 2);
    }
  });
});

describe("faint text", () => {
  it("is the app's secondary ink: the step --ink-2 takes from --ink, applied to whatever is dim", () => {
    // xterm's own answer is a flat half. THE mutant: return 0.5 — dim text in the light face then
    // reads at 3.2 : 1, under the floor the rest of the app's quiet text clears.
    for (const mode of ["dark", "light"] as const) {
      const { t, p } = realm(mode);
      const dim = mix(p.foreground, t.canvas, p.dim);
      expect(c(dim, t.canvas), mode).toBeGreaterThanOrEqual(4.5);
      // ...and is still faint: well short of the ink it was dimmed from.
      expect(c(dim, t.canvas), mode).toBeLessThan(c(p.foreground, t.canvas) / 1.8);
      expect(c(dim, t.canvas), mode).toBeCloseTo(contrast(t.ink2, t.canvas), 0);
    }
    expect(realm("dark").p.dim).toBeCloseTo(0.65, 2);
    expect(realm("light").p.dim).toBeCloseTo(0.737, 2);
  });

  it("stays inside a sane band whatever a theme's inks are", () => {
    const g = hexToOklch("#101010");
    expect(dimWeight(g, g, g)).toBe(0.5); // no step to measure: xterm's own half
    expect(dimWeight(g, hexToOklch("#ffffff"), hexToOklch("#fefefe"))).toBeLessThanOrEqual(0.9);
    expect(dimWeight(g, hexToOklch("#ffffff"), g)).toBeGreaterThanOrEqual(0.4);
  });
});

/**
 * powerlevel10k, as its two stock styles actually draw — captured from `zsh -i` with
 * `config/p10k-lean.zsh` and `config/p10k-rainbow.zsh` (powerlevel10k as Homebrew ships it), a
 * scratch ZDOTDIR and a scratch HOME, in a git repo with one modified and one untracked file, then
 * `false` and `sleep 3.2` so the error and duration segments draw too.
 */
const sample = (name: string) => readFileSync(join(here, "fixtures", name), "utf8");

type Spec = { kind: "default" } | { kind: "index"; n: number };
type Run = { fg: Spec; bg: Spec; text: string };

/** Powerline separators and box drawing are shapes, not text — xterm leaves them out of its contrast
 *  floor for the same reason (`treatGlyphAsBackgroundColor`), and a triangle in the next segment's
 *  colour is not a word anyone has to read. */
const SHAPE = /^[\u{e0a0}-\u{e0d7}\u2500-\u259f\s]+$/u;

/** Every visible run of text, with the colours SGR gave it. Only what a prompt uses: 30–37, 90–97,
 *  40–47, 38;5;n, 48;5;n, 39, 49, 0. */
function runs(ansi: string): Run[] {
  const out: Run[] = [];
  let fg: Spec = { kind: "default" }, bg: Spec = { kind: "default" };
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|([^\x1b]+)/g;
  for (const m of ansi.matchAll(re)) {
    if (m[2] !== undefined) {
      const text = m[2].replace(/[\r\n\b]/g, "");
      if (text.trim() && !SHAPE.test(text)) out.push({ fg, bg, text });
      continue;
    }
    if (m[1] === undefined) continue;
    const ps = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      if (p === 0) { fg = { kind: "default" }; bg = { kind: "default" }; }
      else if (p === 39) fg = { kind: "default" };
      else if (p === 49) bg = { kind: "default" };
      else if (p >= 30 && p <= 37) fg = { kind: "index", n: p - 30 };
      else if (p >= 90 && p <= 97) fg = { kind: "index", n: p - 82 };
      else if (p >= 40 && p <= 47) bg = { kind: "index", n: p - 40 };
      else if ((p === 38 || p === 48) && ps[i + 1] === 5) { const s: Spec = { kind: "index", n: ps[i + 2]! }; if (p === 38) fg = s; else bg = s; i += 2; }
    }
  }
  return out;
}

/** xterm's 256-colour cube and grey ramp, for the codes the sixteen do not cover. */
const xterm256 = (n: number): string => {
  if (n >= 232) { const v = 8 + 10 * (n - 232); return `#${v.toString(16).padStart(2, "0").repeat(3)}`; }
  const k = n - 16, steps = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
  return `#${[Math.floor(k / 36), Math.floor(k / 6) % 6, k % 6].map((s) => steps[s]!.toString(16).padStart(2, "0")).join("")}`;
};

describe("a powerlevel10k prompt keeps its own look", () => {

  it("and every one of those clears the dark floor on Realm's ground, so xterm draws it exactly as p10k chose it", () => {
    // THE mutant: raise the dark floor to AA. Lean's path blue (31) and duration olive (101) then
    // measure under it and get lightened — the owner's own prompt, repainted by the terminal.
    const { t, p } = realm("dark");
    for (const n of [31, 39, 76, 101, 178, 196]) expect(c(xterm256(n), t.canvas), `38;5;${n}`).toBeGreaterThanOrEqual(p.minimumContrastRatio);
    expect(c(xterm256(31), t.canvas)).toBeLessThan(4.5);
  });

  it("rainbow paints its segments in the sixteen, and Realm's carry the text p10k writes on them", () => {
    const { t, p } = realm("dark");
    const colour = (s: Spec, fallback: string): string => (s.kind === "default" ? fallback : s.n < 16 ? p.ansi[s.n]! : xterm256(s.n));
    const pairs = runs(sample("p10k-rainbow.ans")).filter((r) => r.bg.kind === "index" && r.bg.n < 16);
    const seen = new Set(pairs.map((r) => `${r.fg.kind === "index" ? r.fg.n : "fg"}/${(r.bg as { n: number }).n}`));
    // The pairs the capture actually drew: the path on blue, git on yellow, ✔ on black, ✘ on red.
    for (const k of ["254/4", "255/4", "0/3", "2/0", "3/1"]) expect(seen, k).toContain(k);
    for (const r of pairs) {
      const fg = colour(r.fg, p.foreground), bg = colour(r.bg, "#000000");
      const pair = `${r.fg.kind === "index" ? r.fg.n : "fg"}/${(r.bg as { n: number }).n} "${r.text}"`;
      const ratio = c(fg, hexToOklch(bg));
      if (r.fg.kind === "index" && (r.fg.n === 254 || r.fg.n === 255)) {
        // The path: near-white on blue, a little under the floor, and the floor reaches it by
        // whitening text p10k already drew near-white — it never has to flip the path to black.
        expect(ratio, pair).toBeGreaterThan(2.4);
        expect(c("#ffffff", hexToOklch(bg)), pair).toBeGreaterThanOrEqual(TERMINAL_FLOOR.dark);
      } else if (r.fg.kind === "index" && r.fg.n === 3 && (r.bg as { n: number }).n === 1) {
        // ✘ in yellow on red is p10k's own low-contrast choice — 2.35 in xterm's stock palette too.
        expect(ratio, pair).toBeGreaterThan(1.4);
      } else {
        expect(ratio, pair).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(t.canvas.l).toBeLessThan(0.3);
  });
});

describe("a themed palette", () => {
  const faces = THEMES.filter((t) => t.name !== "realm").flatMap((theme) => themeModes(theme.name).map((mode) => ({ theme: theme.name, mode })));

  it("wears its own terminal port, corrected toward the face's floor along lightness, never past the budget", () => {
    // A stated hue is the theme's. Where upstream drew a colour too faint for paper — One Half
    // Light's bright row is its dark palette, Latte's yellows are 2 : 1 — the lift stops at the
    // budget a theme's other hues get, and the render floor (xterm's, at AA on the light face) does
    // the rest per cell. Every dark face clears outright.
    for (const { theme, mode } of faces) {
      const t = tokens(theme, mode);
      const p = terminalPalette({ theme, mode, scheme: "realm", ground: t.canvas, ink: t.ink, ink2: t.ink2, accent: t.accent });
      const stated = THEME_TERMINALS[theme]![mode]!;
      expect(p.ansi, `${theme}/${mode}`).toHaveLength(16);
      for (const i of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14]) {
        const from = hexToOklch(stated[i]!), to = hexToOklch(p.ansi[i]!);
        const label = `${theme}/${mode} ${ANSI_NAMES[i]} ${stated[i]} → ${p.ansi[i]}`;
        // The lift holds hue; what moves it at all is sRGB clipping a saturated colour taken darker.
        expect(Math.abs(((to.h - from.h + 540) % 360) - 180), label).toBeLessThan(10);
        if (c(p.ansi[i]!, t.canvas) >= TERMINAL_FLOOR[mode] - 0.02) continue;
        expect(mode, label).toBe("light");
        expect(Math.abs(to.l - from.l), label).toBeGreaterThan(LIFT_BUDGET - 0.01);
      }
      expect(p.minimumContrastRatio).toBe(TERMINAL_FLOOR[mode]);
    }
  });

  it("is Dracula's own where Dracula's already clears, and corrected only in lightness where it does not", () => {
    const t = tokens("dracula", "dark");
    const p = terminalPalette({ theme: "dracula", mode: "dark", scheme: "realm", ground: t.canvas, ink: t.ink, ink2: t.ink2, accent: t.accent });
    expect(p.ansi[2]).toBe("#50fa7b"); // green clears by a mile: untouched
    // Bright black (Dracula's comment grey) is under the floor; it moves in L and keeps its hue.
    const from = hexToOklch("#6272a4"), to = hexToOklch(p.ansi[8]!);
    expect(to.l).toBeGreaterThan(from.l);
    expect(to.h).toBeCloseTo(from.h, 0);
  });

  it("borrows Realm's sixteen for an imported theme, held to that theme's ground", () => {
    const t = tokens("nord", "dark");
    const p = terminalPalette({ theme: "my-import", mode: "dark", scheme: "realm", ground: t.canvas, ink: t.ink, ink2: t.ink2, accent: t.accent });
    for (const i of textIndices("dark").filter((i) => i !== 7 && i !== 15)) expect(c(p.ansi[i]!, t.canvas), ANSI_NAMES[i]).toBeGreaterThanOrEqual(4.49);
  });
});

describe("My shell's", () => {
  it("is xterm's own palette, untouched by any floor on the dark face, and readable on the light one", () => {
    const d = realm("dark").t;
    const dark = terminalPalette({ theme: "realm", mode: "dark", scheme: "shell", ground: d.canvas, ink: d.ink, ink2: d.ink2, accent: d.accent });
    expect(dark.ansi).toEqual(XTERM_ANSI);
    expect(dark.minimumContrastRatio).toBe(1);
    expect(dark.foreground).toBe("#ffffff");
    const l = realm("light").t;
    const light = terminalPalette({ theme: "realm", mode: "light", scheme: "shell", ground: l.canvas, ink: l.ink, ink2: l.ink2, accent: l.accent });
    expect(light.ansi).toEqual(XTERM_ANSI);
    expect(light.minimumContrastRatio).toBe(4.5);
    expect(hexToOklch(light.foreground).l).toBeCloseTo(l.ink.l, 2);
  });

  it("is a different palette from Realm's — the setting has to change something", () => {
    expect(realm("dark").p.ansi).not.toEqual(XTERM_ANSI);
  });
});
