import { contrast, css, hexToOklch, luminance, type Oklch } from "./oklch";
import type { Mode } from "./theme";

/** Custom themes.
 *
 *  Realm already had one colour axis — light / dark / system — and a theme is a SECOND axis, not a
 *  replacement for it. `themePref` still says which mode the user wants; a theme says what the
 *  palette looks like in that mode. The two compose through `resolveMode`: a theme that has both
 *  faces takes whichever mode the preference resolves to, and a theme with only a dark face pins the
 *  window dark WITHOUT touching the preference, so switching back to Realm restores "system" intact.
 *  That is why themes carry `dark`/`light` as nullable seeds rather than a single palette and a
 *  boolean — "Monokai has no light variant" is a fact about the theme, and the UI can say it.
 *
 *  `realm` is the palette in theme/tokens.css and states NO seeds. Selecting it means writing no
 *  overrides at all, so the default experience is byte-for-byte the static CSS it has always been —
 *  the theme mechanism cannot regress the theme nobody chose. */

/** What a theme has to state. Everything else in the 85-property token set is derived from these —
 *  see `themeVars` — because a palette is a set of RELATIONSHIPS (a surface ladder, an ink ramp, a
 *  border overlay ramp) and only the anchors of those relationships are a matter of taste.
 *
 *  The border ramp, the shadow stacks and the scrims state nothing here on purpose: tembo's ramps are
 *  ALPHA overlays over whatever ground they land on, so they already follow a repainted surface. That
 *  is the property that makes a twelve-value seed enough. */
export type SyntaxSeed = {
  /** Comments and doc tags. The one syntax colour allowed to sit near the ground. */
  comment: string;
  /** Keywords, storage, literals, HTML tag names. */
  keyword: string;
  /** Strings, regexes, and the additions in a diff. */
  string: string;
  /** Numbers, symbols, links, template holes. */
  number: string;
  /** The name being DEFINED: functions, classes, sections, `#id` selectors. */
  title: string;
  /** Types, built-ins and parameters. */
  type: string;
  /** Attributes, properties, `.class` selectors. */
  attr: string;
};

export type ThemeSeed = {
  /** The window ground. The whole surface ladder is this colour at other lightnesses, so its HUE and
   *  CHROMA are what make a theme's greys look like that theme's greys rather than Realm's. */
  bg: string;
  /** Primary UI ink — chrome, not code. Deliberately brighter than an editor's foreground in most of
   *  these themes: `--ink-2` derives from it and lands on the editor foreground of its own accord. */
  ink: string;
  /** The one hue the app uses for itself: primary buttons, focus rings, links, carets, active ticks. */
  accent: string;
  /** State colours. A theme states them because "green means it worked" has to survive a repaint,
   *  and every one of these palettes has its own green. */
  green: string;
  orange: string;
  red: string;
  syntax: SyntaxSeed;
};

export type ThemeDef = {
  name: ThemeName;
  label: string;
  /** Provenance for a vendored palette: upstream, licence, holder. Null only for `realm`, which is
   *  not vendored from anywhere. */
  credit: string | null;
  /** One line for the picker — what the theme IS, not an advertisement for it. */
  blurb: string;
  dark: ThemeSeed | null;
  light: ThemeSeed | null;
};

export type ThemeName = "realm" | "one" | "monokai" | "dracula" | "nord" | "solarized" | "gruvbox";

/* ── how a seed becomes a palette ──────────────────────────────────────────────
 * Every constant below was MEASURED off the shipped palette in theme/tokens.css, so a derived theme
 * reproduces the shape of a ramp the design already validated instead of inventing a new one. They
 * differ per mode because the shipped ramps do: dark surfaces climb away from the ground and gain a
 * little chroma as they climb, while light surfaces mostly sink below the page and hold the paper's
 * tint. Changing a number here retunes every theme at once, which is the point — there is no
 * per-theme surface ladder to drift. */
type SurfaceStep = "canvas" | "surface" | "inset" | "hover" | "hover-2" | "field" | "stripe-bg" | "tooltip-bg" | "tooltip-border";

type Ramp = {
  /** Lightness offsets from `bg`, in OKLCH L. */
  surfaces: Record<SurfaceStep, number>;
  /** Chroma offsets for the same steps, ADDED rather than multiplied. The shipped dark ramp gains
   *  0.002–0.003 of chroma as it climbs, off a ground whose own chroma is 0.004; expressed as a
   *  multiplier that reads as ×1.75, which on a ground with real chroma of its own (Solarized's
   *  0.05) would be a hue shift rather than the faint warming the ramp actually does. */
  chroma: Partial<Record<SurfaceStep, number>>;
  /** How far `--ink-2` and `--ink-3` sit below `--ink`, as an exponent on the ink's own contrast
   *  against the ground it has to survive: contrast(ink-2) = contrast(ink) ** ink2. Measured off the
   *  shipped ramp, and an exponent rather than a lightness fraction because the shipped palette's
   *  span (near-white ink over a near-black page) is far wider than any of these themes': copying
   *  its LIGHTNESS fractions onto a ground half as dark collapses the ramp to nothing, while
   *  copying its CONTRAST structure reproduces what the ramp is for. */
  ink2: number;
  ink3: number;
  /** `--accent-ink` (links, accent text on a surface): a step from the accent towards the ink, with
   *  its chroma pulled back so a hyperlink is not louder than the button it sits beside. */
  accentInk: { step: number; chroma: number };
  /** The 8% wash behind an accent chip. Dark tints are the hue at low alpha over the surface; light
   *  tints are the hue at PAPER lightness, because alpha over near-white washes out to nothing. */
  tint: { alpha: number } | { lightness: number; chroma: number };
  /** Chart ground clamp — see `--chart-surface` below. */
  chartL: { min: number; max: number };
};

const DARK: Ramp = {
  surfaces: { canvas: 0.022, surface: 0.051, inset: 0.034, hover: 0.08, "hover-2": 0.109, field: 0.084, "stripe-bg": 0.017, "tooltip-bg": -0.027, "tooltip-border": 0.099 },
  chroma: { surface: 0.002, hover: 0.002, "hover-2": 0.003, field: 0.002, "tooltip-border": 0.002 },
  ink2: 0.66,
  ink3: 0.37,
  accentInk: { step: 0.38, chroma: 0.65 },
  tint: { alpha: 0.15 },
  chartL: { min: 0, max: 0.245 },
};

const LIGHT: Ramp = {
  surfaces: { canvas: -0.024, surface: 0.015, inset: -0.006, hover: -0.015, "hover-2": -0.052, field: -0.024, "stripe-bg": -0.015, "tooltip-bg": 0, "tooltip-border": 0 },
  chroma: {},
  ink2: 0.62,
  ink3: 0.33,
  accentInk: { step: 0.185, chroma: 0.91 },
  tint: { lightness: 0.959, chroma: 0.105 },
  chartL: { min: 0.97, max: 1 },
};

/** The contrast every derived colour is held to, and the roles they belong to. These are WCAG
 *  numbers, not Realm's: the shipped palette clears all of them with room (its worst pairing is
 *  --ink-2 at 5.2:1), and holding a vendored palette to Realm's headroom instead would mean
 *  repainting it into something that is no longer that palette. `ink3` is the one number taken from
 *  Realm rather than from WCAG — the shipped light `--ink-3` measures 2.43:1 on `--canvas`, so a
 *  higher floor would fail the default theme, and "no custom theme is less legible than the one that
 *  ships" is the honest claim to make about a hint tier. */
export const CONTRAST_FLOOR = {
  /** Primary UI text on every ground it lands on. WCAG AA for body copy. */
  ink: 4.5,
  /** The secondary tier (`--rl-text-dim`): labels, metadata, the dim half of a row. AA large. */
  ink2: 3,
  /** Hints, placeholders, timestamps. */
  ink3: 2.4,
  /** Accent and the three semantic hues, on the card ground they are drawn against. */
  chrome: 2.9,
  /** Every syntax colour, on the code card. */
  syntax: 2.7,
  /** Accent TEXT — links, an accent label on a card — which is body text and is held to AA. */
  accentInk: 4.5,
  /** The label written on an accent fill. */
  onAccent: 4.5,
  /** The eight chart series on `--chart-surface`. Dark only: the light set ships three slots below
   *  3:1 against a standing obligation documented in tokens.css (the breakdown table beside every
   *  chart), and a custom theme does not get to inherit that obligation quietly. */
  series: 3,
} as const;

/** How far a stated colour may be pushed to meet its floor. A theme states hues; this budget is what
 *  separates "the palette lifted Nord's red half a step so error text is readable on Nord's own
 *  surface" from "the palette invented a colour and called it Nord". A seed that needs more than
 *  this is a bug in the theme, and the contrast suite says so by name. */
const LIFT_BUDGET = 0.12;

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
/** A step along the L axis, holding hue and offsetting chroma. Lightness is clamped to the display's
 *  range rather than allowed to wrap: a theme whose ground is already near black would otherwise
 *  derive a `--tooltip-bg` blacker than black and quietly lose the step. */
const step = (base: Oklch, dl: number, dc = 0): Oklch =>
  ({ l: clamp(base.l + dl, 0, 1), c: Math.max(0, base.c + dc), h: base.h });

/** Move `o` along L, AWAY from `ground`, until it clears `floor` against it — or until the budget
 *  runs out, in which case the best effort is returned and the contrast suite fails the theme.
 *  Hue and chroma are untouched: what a theme states is a colour's identity, and identity is the one
 *  thing a correctness fix must not quietly edit. */
function lift(o: Oklch, ground: Oklch, floor: number, budget = LIFT_BUDGET): Oklch {
  const dir = luminance(o) >= luminance(ground) ? 1 : -1;
  let best = o;
  for (let d = 0; d <= budget + 1e-9; d += 0.002) {
    best = { ...o, l: clamp(o.l + dir * d, 0, 1) };
    if (contrast(best, ground) >= floor) return best;
  }
  return best;
}

/** The lightness at which `o` sits `exp` of the way down the ink's contrast ladder against `ground`,
 *  never dimmer than `floor`. Solved by walking L rather than inverting the transfer function: the
 *  walk is exact to a step no display can resolve, and it stays correct where the naive inverse does
 *  not — at the gamut boundary, where raising L stops raising luminance. */
function inkStep(ink: Oklch, ground: Oklch, exp: number, floor: number): Oklch {
  const target = Math.max(floor, contrast(ink, ground) ** exp);
  const dir = luminance(ink) >= luminance(ground) ? -1 : 1;
  let best = ink;
  for (let d = 0; d <= 1; d += 0.002) {
    const next = { ...ink, l: clamp(ink.l + dir * d, 0, 1) };
    if (contrast(next, ground) < target) break;
    best = next;
  }
  return best;
}

/** Every custom property a theme writes. Exported because `applyTheme` has to be able to REMOVE the
 *  full set when the user returns to `realm` — a switch that only overwrote would leave whichever
 *  properties the new theme happened not to state pointing at the old one's values. */
export const THEME_VARS = [
  "--page", "--canvas", "--surface", "--inset", "--hover", "--hover-2", "--field", "--stripe-bg",
  "--ink", "--ink-2", "--ink-3",
  "--accent", "--accent-ink", "--accent-tint", "--rl-accent-contrast",
  "--green", "--green-tint", "--orange", "--orange-tint", "--red", "--red-tint",
  "--tooltip-bg", "--tooltip-fg", "--tooltip-muted", "--tooltip-border",
  "--chart-surface",
  "--syn-fg", "--syn-comment", "--syn-keyword", "--syn-string", "--syn-number",
  "--syn-title", "--syn-type", "--syn-attr", "--syn-meta", "--syn-deleted",
] as const;

/** The palette a seed expands to: `THEME_VARS` → CSS colour. `themeVars` is pure and cheap enough to
 *  call on every switch, which is why the derived palette is not precomputed into a stylesheet — a
 *  generated CSS file would have to be regenerated, checked in, and then checked for staleness. */
export function themeVars(name: ThemeName, mode: Mode): Record<string, string> {
  const seed = seedFor(name, mode);
  if (!seed) return {};
  const r = mode === "dark" ? DARK : LIGHT;
  const bg = hexToOklch(seed.bg);
  const ink = hexToOklch(seed.ink);

  const surf = (k: SurfaceStep): Oklch => step(bg, r.surfaces[k], r.chroma[k] ?? 0);
  const surface = surf("surface");
  /** The ground a tier has the least contrast against — its binding case, whichever step of the
   *  ladder that turns out to be, so the derivation does not have to know that dark ramps climb and
   *  light ramps sink. The tiers differ because the stylesheet's pairings do: `--ink-2` never lands
   *  on `--hover-2` or `--field`, and `--ink-3` never leaves the resting surfaces. */
  const worst = (steps: SurfaceStep[]): Oklch =>
    [bg, ...steps.map(surf)].reduce((a, b) => (contrast(ink, a) <= contrast(ink, b) ? a : b));

  /** A tint is the same hue as the colour it stands behind, at whatever strength that mode's grounds
   *  can actually show. */
  const tint = (o: Oklch): string =>
    "alpha" in r.tint ? css(o, r.tint.alpha) : css({ l: r.tint.lightness, c: o.c * r.tint.chroma, h: o.h });

  /** The label on an accent fill, and the fill it is legible on. Realm writes white on its accent in
   *  both modes because its accent is a mid blue in both; a theme whose accent is Monokai's pink or
   *  One Light's blue cannot keep that unchanged, so the pair is SOLVED rather than assumed: try the
   *  theme's own ink and its own ground as the label, lift the fill away from each until the label
   *  clears, and keep whichever needed the smaller move. A button is the one place in the app where
   *  colour is load-bearing for reading a word. */
  const seedAccent = hexToOklch(seed.accent);
  const candidates = [ink, bg].map((label) => {
    const fill = lift(seedAccent, label, CONTRAST_FLOOR.onAccent);
    return { label, fill, moved: Math.abs(fill.l - seedAccent.l), ok: contrast(fill, surface) >= CONTRAST_FLOOR.chrome };
  });
  /* Both floors, not one. Lifting the fill to carry a dark label pushes it TOWARDS a light card, so
   * satisfying the button can cost the accent its own legibility as a link or a focus ring on that
   * card — which is exactly what Solarized Light does if the label is chosen on the button alone.
   * Prefer a label that leaves both true; among those, the one that moved the stated hue least. */
  const viable = candidates.filter((c) => c.ok);
  const best = (viable.length ? viable : candidates).reduce((a, b) => (b.moved < a.moved ? b : a));
  const accent = best.fill, onAccent = best.label;

  /** The eight `--series-*` are a dataviz palette with a documented ΔE and contrast guarantee against
   *  a ground of a specific lightness (tokens.css), so they are NOT themed — a hue swapped for taste
   *  breaks a promise about colour-vision deficiency that has nothing to do with taste. What moves
   *  instead is the ground: the Usage cards take a chart surface that carries the theme's hue but is
   *  clamped back into the band the palette was validated in. Without the clamp every theme here
   *  fails slot 6 (#008300 needs a ground at or below Realm's own #232427 to clear 3:1), which is a
   *  property of the series, not of the themes. */
  const chart = { ...surface, l: clamp(surface.l, r.chartL.min, r.chartL.max) };

  const ink2 = inkStep(ink, worst(["canvas", "surface", "inset", "hover"]), r.ink2, CONTRAST_FLOOR.ink2);
  const ink3 = inkStep(ink, worst(["canvas", "surface", "inset"]), r.ink3, CONTRAST_FLOOR.ink3);

  /** Chrome and syntax are stated as hues and corrected as lightnesses. Every one of these lands on
   *  `--surface` — semantic text and chips on a card, code inside `.md-code` — so that is the ground
   *  they are held against. */
  const onSurface = (hex: string, floor: number): string => css(lift(hexToOklch(hex), surface, floor));
  const syn = (k: keyof SyntaxSeed): string => onSurface(seed.syntax[k], CONTRAST_FLOOR.syntax);
  const semantic = (hex: string): Oklch => lift(hexToOklch(hex), surface, CONTRAST_FLOOR.chrome);
  const [green, orange, red] = [semantic(seed.green), semantic(seed.orange), semantic(seed.red)];
  const comment = syn("comment");

  return {
    "--page": css(bg),
    "--canvas": css(surf("canvas")),
    "--surface": css(surface),
    "--inset": css(surf("inset")),
    "--hover": css(surf("hover")),
    "--hover-2": css(surf("hover-2")),
    "--field": css(surf("field")),
    "--stripe-bg": css(surf("stripe-bg")),

    "--ink": css(ink),
    "--ink-2": css(ink2),
    "--ink-3": css(ink3),

    "--accent": css(accent),
    "--accent-ink": css(lift({ l: accent.l + (ink.l - accent.l) * r.accentInk.step, c: accent.c * r.accentInk.chroma, h: accent.h }, surface, CONTRAST_FLOOR.accentInk)),
    "--accent-tint": tint(accent),
    "--rl-accent-contrast": css(onAccent),

    "--green": css(green),
    "--green-tint": tint(green),
    "--orange": css(orange),
    "--orange-tint": tint(orange),
    "--red": css(red),
    "--red-tint": tint(red),

    /* A tooltip is an inverted chip in light mode and a recessed one in dark — the shipped palette's
     * own asymmetry, kept: in light mode the chip is the INK colour with the page written on it. */
    "--tooltip-bg": mode === "dark" ? css(surf("tooltip-bg")) : css(step(ink, 0.025)),
    "--tooltip-fg": mode === "dark" ? css(ink) : css(step(bg, -0.009)),
    "--tooltip-muted": mode === "dark" ? css(ink2) : css({ l: 0.731, c: ink.c, h: ink.h }),
    "--tooltip-border": mode === "dark" ? css(surf("tooltip-border")) : css(step(ink, 0.109)),

    "--chart-surface": css(chart),

    /* Syntax. `--syn-fg` is the ink ramp's second step rather than a seed: code body is body text,
     * and every one of these palettes sets its editor foreground within a hair of where --ink-2
     * already lands. `--syn-meta` shares the comment colour and `--syn-deleted` the red, exactly as
     * the base mapping in tokens.css does. */
    "--syn-fg": css(ink2),
    "--syn-comment": comment,
    "--syn-keyword": syn("keyword"),
    "--syn-string": syn("string"),
    "--syn-number": syn("number"),
    "--syn-title": syn("title"),
    "--syn-type": syn("type"),
    "--syn-attr": syn("attr"),
    "--syn-meta": comment,
    "--syn-deleted": css(red),
  };
}

const seedFor = (name: ThemeName, mode: Mode): ThemeSeed | null => {
  const def = THEMES.find((t) => t.name === name);
  return (mode === "dark" ? def?.dark : def?.light) ?? null;
};

/** Which modes a theme actually has a palette for. `realm` has both and states neither — it IS
 *  tokens.css, whose two blocks the mode attribute already flips. */
export function themeModes(name: ThemeName): Mode[] {
  if (name === "realm") return ["dark", "light"];
  const def = THEMES.find((t) => t.name === name);
  return [...(def?.dark ? (["dark"] as const) : []), ...(def?.light ? (["light"] as const) : [])];
}

/** The composition rule for the two axes. A theme with one face pins the window to it; the MODE
 *  PREFERENCE is untouched, so it comes back the moment a two-faced theme is chosen again. */
export function resolveMode(name: ThemeName, mode: Mode): Mode {
  const modes = themeModes(name);
  return modes.includes(mode) ? mode : (modes[0] ?? mode);
}

/** Realm's own window, card, accent and string colours, copied from theme/tokens.css.
 *  The picker cannot read them off the document: by the time it renders under any other theme the
 *  live `var(--page)` is THAT theme's page, so a preview built from computed styles would draw every
 *  card in the colours of whichever palette is already on. Copied, therefore, and pinned by a test
 *  against the stylesheet so the copy cannot drift. */
const REALM_SWATCHES: Record<Mode, [string, string, string, string]> = {
  dark: ["oklch(0.209 0.004 264.477)", "oklch(0.26 0.006 271.191)", "oklch(0.68 0.173 253.301)", "oklch(0.705 0.154 153.814)"],
  light: ["oklch(0.985 0.001 286.376)", "oklch(1 0 0)", "oklch(0.626 0.205 254.947)", "oklch(0.603 0.155 150.883)"],
};

/** The four colours a picker shows for a theme: the window, the card that floats on it, the accent,
 *  and the one syntax hue that says most about a code palette. */
export function themeSwatches(name: ThemeName, mode: Mode): [string, string, string, string] {
  const v = themeVars(name, resolveMode(name, mode));
  if (!v["--page"]) return REALM_SWATCHES[mode];
  return [v["--page"]!, v["--surface"]!, v["--accent"]!, v["--syn-string"]!];
}

export function isThemeName(x: unknown): x is ThemeName {
  return typeof x === "string" && THEMES.some((t) => t.name === x);
}

export const THEMES: readonly ThemeDef[] = [
  {
    name: "realm",
    label: "Realm",
    credit: null,
    blurb: "The cool near-neutral palette Realm ships with.",
    // No seeds: theme/tokens.css is this theme, and choosing it writes nothing.
    dark: null,
    light: null,
  },
  {
    /* One — atom/one-dark-syntax and atom/one-light-syntax, MIT © GitHub Inc. Hex values read off
     * those two packages' settings files. `ink` is the Atom ONE UI foreground (#d7dae0), not the
     * syntax foreground (#abb2bf): --ink is chrome, and the ink ramp's second step lands on #abb2bf
     * by itself, which is a fair check that the ramp is the right shape. */
    name: "one",
    label: "One",
    credit: "Atom One Dark / One Light — MIT © GitHub, Inc.",
    blurb: "Atom's One, in both of its faces.",
    dark: {
      bg: "#282c34", ink: "#d7dae0", accent: "#61afef",
      green: "#98c379", orange: "#d19a66", red: "#e06c75",
      syntax: { comment: "#7f848e", keyword: "#c678dd", string: "#98c379", number: "#d19a66", title: "#61afef", type: "#e5c07b", attr: "#56b6c2" },
    },
    light: {
      bg: "#fafafa", ink: "#383a42", accent: "#4078f2",
      green: "#50a14f", orange: "#986801", red: "#e45649",
      syntax: { comment: "#8e8f96", keyword: "#a626a4", string: "#50a14f", number: "#986801", title: "#4078f2", type: "#c18401", attr: "#0184bc" },
    },
  },
  {
    /* Monokai — microsoft/vscode, extensions/theme-monokai (MIT © Microsoft), itself a port of
     * Wimer Hazenberg's Monokai. Dark only, and honestly so: there is no upstream Monokai light. The
     * seed choices worth naming, because Monokai does not map one-to-one onto seven roles — numbers
     * take the violet (#ae81ff), attributes the same lime as function names, and the app accent is
     * the signature pink even though that costs a dark button label rather than a white one. */
    name: "monokai",
    label: "Monokai",
    credit: "Monokai — MIT © Microsoft (VS Code), after Wimer Hazenberg",
    blurb: "The classic Monokai. Dark only.",
    dark: {
      bg: "#272822", ink: "#f8f8f2", accent: "#f92672",
      green: "#a6e22e", orange: "#fd971f", red: "#f92672",
      syntax: { comment: "#8f907e", keyword: "#f92672", string: "#e6db74", number: "#ae81ff", title: "#a6e22e", type: "#66d9ef", attr: "#a6e22e" },
    },
    light: null,
  },
  {
    /* Dracula — dracula/visual-studio-code, MIT © Dracula Theme. Dark only on purpose: Dracula's
     * light counterpart (Alucard) ships with the paid Dracula PRO and is not ours to vendor. */
    name: "dracula",
    label: "Dracula",
    credit: "Dracula — MIT © Dracula Theme",
    blurb: "Dracula's purple night. Dark only.",
    dark: {
      bg: "#282a36", ink: "#f8f8f2", accent: "#bd93f9",
      green: "#50fa7b", orange: "#ffb86c", red: "#ff5555",
      syntax: { comment: "#7f8ec0", keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9", title: "#50fa7b", type: "#8be9fd", attr: "#50fa7b" },
    },
    light: null,
  },
  {
    /* Nord — arcticicestudio/nord, MIT © Sven Greb. Dark only: Nord is specified as one palette
     * (Polar Night grounds, Snow Storm ink), and the "Nord Light" builds in the wild are community
     * inversions rather than upstream. Comments are #616e88, the brightened value Nord's own
     * editor ports moved to — nord3 (#4c566a) does not clear the contrast floor on nord0. */
    name: "nord",
    label: "Nord",
    credit: "Nord — MIT © Sven Greb",
    blurb: "Arctic blue-greys. Dark only.",
    dark: {
      bg: "#2e3440", ink: "#eceff4", accent: "#88c0d0",
      green: "#a3be8c", orange: "#d08770", red: "#bf616a",
      syntax: { comment: "#7c8aa5", keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead", title: "#88c0d0", type: "#8fbcbb", attr: "#d8dee9" },
    },
    light: null,
  },
  {
    /* Solarized — altercation/solarized, MIT © Ethan Schoonover. Both faces, which is the whole point
     * of Solarized: one set of accent hues over two symmetric grounds.
     * Two deviations from the reference, both forced by the contrast floor and both in the same
     * direction — Solarized's own text tones are tuned for a code editor, not for UI chrome:
     *   - `ink` is base2/base02 rather than base0/base00, so primary UI text clears 7:1.
     *   - the LIGHT comment is #7a8a8a, one step down from base1 (#93a1a1), which reads 2.46:1 on
     *     base3 and is the one value in this set that could not be vendored as written. */
    name: "solarized",
    label: "Solarized",
    credit: "Solarized — MIT © Ethan Schoonover",
    blurb: "Ethan Schoonover's symmetric pair.",
    dark: {
      bg: "#002b36", ink: "#eee8d5", accent: "#268bd2",
      green: "#859900", orange: "#cb4b16", red: "#dc322f",
      syntax: { comment: "#657b83", keyword: "#859900", string: "#2aa198", number: "#d33682", title: "#268bd2", type: "#b58900", attr: "#6c71c4" },
    },
    light: {
      bg: "#fdf6e3", ink: "#073642", accent: "#268bd2",
      green: "#859900", orange: "#cb4b16", red: "#dc322f",
      syntax: { comment: "#7a8a8a", keyword: "#859900", string: "#2aa198", number: "#d33682", title: "#268bd2", type: "#b58900", attr: "#6c71c4" },
    },
  },
  {
    /* Gruvbox — morhetz/gruvbox, MIT © Pavel Pertsev. Both faces. Gruvbox paints strings and function
     * names the same green upstream; here the title takes the yellow it uses for types, because two
     * roles sharing one hue in a nine-token mapping loses a distinction the mapping exists to make. */
    name: "gruvbox",
    label: "Gruvbox",
    credit: "Gruvbox — MIT © Pavel Pertsev",
    blurb: "Warm retro contrast, light and dark.",
    dark: {
      bg: "#282828", ink: "#ebdbb2", accent: "#83a598",
      green: "#b8bb26", orange: "#fe8019", red: "#fb4934",
      syntax: { comment: "#a89984", keyword: "#fb4934", string: "#b8bb26", number: "#d3869b", title: "#fabd2f", type: "#8ec07c", attr: "#83a598" },
    },
    light: {
      bg: "#fbf1c7", ink: "#3c3836", accent: "#076678",
      green: "#79740e", orange: "#af3a03", red: "#9d0006",
      syntax: { comment: "#7c6f64", keyword: "#9d0006", string: "#79740e", number: "#8f3f71", title: "#b57614", type: "#427b58", attr: "#076678" },
    },
  },
];
