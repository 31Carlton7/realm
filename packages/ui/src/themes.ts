import { contrast, css, emitted, hexToOklch, luminance, parseOklch, type Oklch } from "./oklch";
import type { Mode } from "./theme";

/** Custom themes.
 *
 *  Realm already had one colour axis — light / dark / system — and a theme is a SECOND axis, not a
 *  replacement for it. `themePref` still says which mode the user wants; a theme says what the
 *  palette looks like in that mode. The two compose through `paletteFor`, over a SLOT PER FACE: the
 *  light window reads the light slot and the dark window the dark one, so neither axis has to
 *  overrule the other. That is why themes carry `dark`/`light` as nullable seeds rather than a single
 *  palette and a boolean — "Monokai has no light variant" is a fact about the theme, and it is what
 *  keeps Monokai out of the light row rather than something the light row has to cope with.
 *
 *  `realm` is the palette in theme/tokens.css and states NO seeds. Selecting it means writing no
 *  overrides at all, so the default experience is byte-for-byte the static CSS it has always been —
 *  the theme mechanism cannot regress the theme nobody chose. */

/** What a theme has to state. Every property in `THEME_VARS` is derived from these — see
 *  `themeVars` — because a palette is a set of RELATIONSHIPS (a surface ladder, an ink ramp, a
 *  border overlay ramp) and only the anchors of those relationships are a matter of taste.
 *
 *  The border ramp, the shadow stacks and the scrims state nothing here on purpose: tembo's ramps are
 *  ALPHA overlays over whatever ground they land on, so they already follow a repainted surface. That
 *  is the property that makes a thirteen-value seed enough. */
/** Every hue below is the value its upstream PUBLISHES, not a value tuned to clear Realm's floors.
 *  It can be, because `lift` corrects a stated hue along lightness until it clears — and refuses to
 *  move it further than `LIFT_BUDGET`, which is what makes "vendored" mean something. Hand-brightening
 *  a seed to clear the floor routes around that guarantee: it clears silently, at whatever distance
 *  from the published colour it took, and the budget never gets to object. The one seed here that
 *  upstream's own value cannot carry is named where it is written. */
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

export type ThemeName = "realm" | "one" | "monokai" | "dracula" | "nord" | "solarized" | "gruvbox"
  | "catppuccin" | "github" | "rosepine";

/* ── how a seed becomes a palette ──────────────────────────────────────────────
 * Every constant below was MEASURED off the shipped palette in theme/tokens.css, so a derived theme
 * reproduces the shape of a ramp the design already validated instead of inventing a new one. They
 * differ per mode because the shipped ramps do: dark surfaces climb away from the ground and gain a
 * little chroma as they climb, while light surfaces mostly sink below the page and hold the paper's
 * tint. Changing a number here retunes every theme at once, which is the point — there is no
 * per-theme surface ladder to drift. */
type SurfaceStep = "canvas" | "surface" | "inset" | "hover" | "hover-2" | "field" | "stripe-bg";

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
  /** The tooltip chip, which is the one surface that does not sit on the ladder. Dark mode recesses
   *  it below the page and writes the theme's own ink on it; light mode INVERTS it into a dark chip
   *  with light text — a different construction, not different numbers, which is why this is a
   *  function and not two more rows of the table above. Written as rows, whichever mode did not need
   *  a given entry would carry a zero nothing ever reads. */
  tooltip: (p: { bg: Oklch; ink: Oklch; ink2: Oklch }) => Record<"bg" | "fg" | "muted" | "border", Oklch>;
  /** `--accent-ink` (links, accent text on a surface): a step from the accent towards the ink, with
   *  its chroma pulled back so a hyperlink is not louder than the button it sits beside. */
  accentInk: { step: number; chroma: number };
  /** The wash behind a chip. Dark tints are the hue at 15% over whatever surface it lands on; light
   *  tints are the hue at PAPER lightness with its chroma cut to a tenth, because alpha over a
   *  near-white ground washes out to nothing. Both are the mean of the four the shipped palette
   *  states (its own spread is 14–16% dark, L .956–.964 light), rather than four seeds per theme for
   *  a difference no one can see. */
  tint: { alpha: number } | { lightness: number; chroma: number };
  /** Chart ground clamp — see `--chart-surface` below. */
  chartL: { min: number; max: number };
};

const DARK: Ramp = {
  surfaces: { canvas: 0.022, surface: 0.051, inset: 0.034, hover: 0.08, "hover-2": 0.109, field: 0.084, "stripe-bg": 0.017 },
  chroma: { surface: 0.002, hover: 0.002, "hover-2": 0.003, field: 0.002 },
  ink2: 0.7,
  ink3: 0.427,
  tooltip: ({ bg, ink, ink2 }) => ({ bg: step(bg, -0.027), fg: ink, muted: ink2, border: step(bg, 0.099, 0.002) }),
  accentInk: { step: 0.38, chroma: 0.65 },
  tint: { alpha: 0.15 },
  chartL: { min: 0, max: 0.245 },
};

const LIGHT: Ramp = {
  surfaces: { canvas: -0.024, surface: 0.015, inset: -0.006, hover: -0.015, "hover-2": -0.052, field: -0.024, "stripe-bg": -0.015 },
  chroma: { canvas: 0.001, inset: 0.001, hover: 0.001, "hover-2": 0.002 },
  ink2: 0.62,
  ink3: 0.333,
  // The inversion: the chip is built off the INK, and the light text on it is the page.
  tooltip: ({ bg, ink }) => ({
    bg: step(ink, 0.025, 0.002), fg: step(bg, -0.009),
    muted: { l: 0.731, c: ink.c, h: ink.h }, border: step(ink, 0.109, 0.001),
  }),
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

/** The grounds each ink tier actually lands on, read off styles.css rather than taken as the whole
 *  ladder: `--ink-2` never appears on `--hover-2` or `--field` (both are written with `--ink` in
 *  every rule that uses them), and `--ink-3` never leaves the resting surfaces. Widening these to the
 *  full cross-product would fail palettes over pairings the stylesheet never produces; narrowing them
 *  past what it does produce is how an unreadable pairing ships. */
export const INK_GROUNDS = {
  ink: ["--page", "--canvas", "--surface", "--inset", "--hover", "--hover-2", "--field"],
  ink2: ["--page", "--canvas", "--surface", "--inset", "--hover"],
  ink3: ["--page", "--canvas", "--surface", "--inset"],
} as const;

/** The ink ramp's SPREAD, as a user control. 0–100 with 60 the shipped ramp, which is the range and
 *  the default the control shows.
 *
 *  What it moves is the only thing in this palette that is a matter of preference rather than of
 *  correctness: how far `--ink-2` and `--ink-3` fall below `--ink` against the ground. Those are the
 *  exponents in `Ramp`, and this is a multiplier on them — a higher exponent puts the secondary and
 *  hint tiers closer to primary text, a lower one lets them recede. It cannot touch `--ink` itself
 *  (that is a seed, and the palette's identity) and it cannot touch a hue (a slider that desaturated
 *  Monokai's pink towards the ground would be a repaint, not a preference).
 *
 *  It CANNOT make anything illegible, and not by arithmetic that has to be got right here: `inkStep`
 *  floors every tier at `CONTRAST_FLOOR` before it walks, so the bottom of this range is where the
 *  floors start binding rather than where the ramp keeps sinking. The top is bounded too — at 1.28
 *  the shipped exponents still leave the three tiers a clear step apart on every palette, and a ramp
 *  collapsed to one flat tier is a hierarchy destroyed rather than a contrast raised. */
export const CONTRAST_RANGE = { min: 0, max: 100, default: 60 } as const;
const CONTRAST_SPAN = { lo: 0.72, hi: 1.28 } as const;

export const clampContrast = (x: number): number =>
  Math.round(clamp(x, CONTRAST_RANGE.min, CONTRAST_RANGE.max));

/** 0 → `lo`, the default → 1, 100 → `hi`. Two linear halves rather than one, because the default is
 *  not the midpoint: the shipped ramp has to land exactly on 1 or moving the slider to 60 and back
 *  would not return the palette it started from. */
const contrastScale = (level: number): number => {
  const c = clampContrast(level), d = CONTRAST_RANGE.default;
  return c <= d
    ? CONTRAST_SPAN.lo + ((1 - CONTRAST_SPAN.lo) * c) / d
    : 1 + ((CONTRAST_SPAN.hi - 1) * (c - d)) / (CONTRAST_RANGE.max - d);
};

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
  const g = emitted(ground);
  let best = o;
  for (let d = 0; d <= budget + 1e-9; d += 0.002) {
    best = { ...o, l: clamp(o.l + dir * d, 0, 1) };
    if (contrast(emitted(best), g) >= floor) return best;
  }
  return best;
}

/** The lightness at which `o` sits `exp` of the way down the ink's contrast ladder against `ground`,
 *  never dimmer than `floor`. Solved by walking L rather than inverting the transfer function: the
 *  walk is exact to a step no display can resolve, and it stays correct where the naive inverse does
 *  not — at the gamut boundary, where raising L stops raising luminance. */
function inkStep(ink: Oklch, ground: Oklch, exp: number, floor: number): Oklch {
  const g = emitted(ground);
  const target = Math.max(floor, contrast(ink, g) ** exp);
  const dir = luminance(ink) >= luminance(g) ? -1 : 1;
  let best = ink;
  for (let d = 0; d <= 1; d += 0.002) {
    const next = { ...ink, l: clamp(ink.l + dir * d, 0, 1) };
    if (contrast(emitted(next), g) < target) break;
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
export function themeVars(name: ThemeName, mode: Mode,
  { override = {}, contrast = CONTRAST_RANGE.default }: { override?: ThemeOverride; contrast?: number } = {},
): Record<string, string> {
  const seed = seedFor(name, mode, override);
  return seed ? deriveVars(seed, mode, contrast) : {};
}

/** The derivation itself, on a bare seed. Exported so the guardrail can feed it the seeds tokens.css
 *  was built from and check that what comes out IS tokens.css — the ramp constants above are only
 *  "measured off the shipped palette" for as long as something re-measures them. */
export function deriveVars(seed: ThemeSeed, mode: Mode, contrastLevel: number = CONTRAST_RANGE.default): Record<string, string> {
  const r = mode === "dark" ? DARK : LIGHT;
  const spread = contrastScale(contrastLevel);
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
   *  fails slot 6: #008300 clears 3:1 on Realm's own #232427 (L 0.26) by 0.14, so the clamp sits a
   *  little under it at L 0.245 to leave the margin a theme's chroma can eat. That is a property of
   *  the series, not of the themes. */
  const chart = { ...surface, l: clamp(surface.l, r.chartL.min, r.chartL.max) };

  const ink2 = inkStep(ink, worst(["canvas", "surface", "inset", "hover"]), r.ink2 * spread, CONTRAST_FLOOR.ink2);
  const ink3 = inkStep(ink, worst(["canvas", "surface", "inset"]), r.ink3 * spread, CONTRAST_FLOOR.ink3);
  const tip = r.tooltip({ bg, ink, ink2 });

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

    /* A recessed chip in dark and an inverted one in light — the shipped palette's own asymmetry,
     * kept, and constructed by the ramp rather than branched on here. */
    "--tooltip-bg": css(tip.bg),
    "--tooltip-fg": css(tip.fg),
    "--tooltip-muted": css(tip.muted),
    "--tooltip-border": css(tip.border),

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

export type ContrastMiss = { role: string; ratio: number; floor: number };

/** Which of a seed's colours the derivation could not get to their floor, and how far short they
 *  fell. Two different failures land here, and the difference is why the UI reports rather than
 *  silently repaints:
 *
 *  - The ground and the ink are the two seeds NOTHING corrects. A palette's identity is its paper
 *    and its text, and a mechanism that moved them would hand back a theme the user did not pick.
 *    So a `#2b2b2b` ink on a `#282828` page is derived exactly as asked and named here instead.
 *  - Everything else is corrected along lightness, inside `LIFT_BUDGET`, exactly as a vendored
 *    palette is. A hue that still misses after its budget is one the ramp genuinely cannot carry,
 *    and saying which one is more use than a number that quietly stopped being the chosen colour.
 *
 *  Measured on the DERIVED palette, so it reports what will be on screen rather than what the seed
 *  asked for — the same predicate the theme suite holds the shipped palettes to. */
export function contrastMisses(seed: ThemeSeed, mode: Mode, contrastLevel: number = CONTRAST_RANGE.default): ContrastMiss[] {
  const v = deriveVars(seed, mode, contrastLevel);
  const at = (token: string): Oklch => parseOklch(v[token]!);
  const out: ContrastMiss[] = [];
  const check = (role: string, token: string, grounds: readonly string[], floor: number): void => {
    const ratio = Math.min(...grounds.map((g) => contrast(at(token), at(g))));
    if (ratio < floor) out.push({ role, ratio, floor });
  };
  check("Foreground", "--ink", INK_GROUNDS.ink, CONTRAST_FLOOR.ink);
  check("Secondary text", "--ink-2", INK_GROUNDS.ink2, CONTRAST_FLOOR.ink2);
  check("Hint text", "--ink-3", INK_GROUNDS.ink3, CONTRAST_FLOOR.ink3);
  for (const [role, token] of [["Accent", "--accent"], ["Success", "--green"], ["Warning", "--orange"], ["Error", "--red"]] as const) {
    check(role, token, ["--surface"], CONTRAST_FLOOR.chrome);
  }
  check("Link text", "--accent-ink", ["--surface"], CONTRAST_FLOOR.accentInk);
  check("Button label", "--rl-accent-contrast", ["--accent"], CONTRAST_FLOOR.onAccent);
  for (const token of THEME_VARS.filter((t) => t.startsWith("--syn-"))) {
    check(`Code (${token.slice(6)})`, token, ["--surface"], CONTRAST_FLOOR.syntax);
  }
  return out;
}

/** What a user has moved off a palette's own seeds. A PARTIAL SEED rather than a fixed trio of
 *  fields, because the same shape is what a copied theme has to carry: the picker edits three of the
 *  thirteen (ground, ink, accent — the three that decide what a palette feels like), and an imported
 *  theme states as many of them as it likes, through one type and one merge.
 *
 *  Overrides are keyed by PALETTE as well as by face. Moving One Dark's accent is a statement about
 *  One Dark; carrying it onto Gruvbox when the palette changes would repaint a theme the user never
 *  edited, and losing it on the way back would make the picker destructive. */
export type ThemeOverride = Partial<Omit<ThemeSeed, "syntax">> & { syntax?: Partial<SyntaxSeed> };
export type ThemeOverrides = Record<string, ThemeOverride>;

export const overrideKey = (name: ThemeName, mode: Mode): string => `${name}:${mode}`;

/** The seed roles an override may state, as the names they carry in the JSON — which are the seed's
 *  own field names, so a copied theme and a stored override are the same document. */
export const SEED_ROLES = ["bg", "ink", "accent", "green", "orange", "red"] as const;
export const SYNTAX_ROLES = ["comment", "keyword", "string", "number", "title", "type", "attr"] as const;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const isHexColour = (x: unknown): x is string => typeof x === "string" && HEX.test(x);

/** Overrides arrive from a user-editable settings row and from the clipboard, and `hexToOklch`
 *  THROWS on anything that is not a colour — so an unvalidated `"blue"` in `ui.themeOverrides` is a
 *  renderer that white-screens at boot with no control left on screen to undo it with. Field by
 *  field, dropping what does not parse, exactly as the terminal-panel map is read. */
export function parseThemeOverride(raw: unknown): ThemeOverride {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: ThemeOverride = {};
  for (const role of SEED_ROLES) if (isHexColour(src[role])) out[role] = src[role];
  const syn = src["syntax"];
  if (syn && typeof syn === "object" && !Array.isArray(syn)) {
    const s = syn as Record<string, unknown>;
    const kept: Partial<SyntaxSeed> = {};
    for (const role of SYNTAX_ROLES) if (isHexColour(s[role])) kept[role] = s[role];
    if (Object.keys(kept).length) out.syntax = kept;
  }
  return out;
}

export function parseThemeOverrides(raw: unknown): ThemeOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ThemeOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const [name, mode] = key.split(":");
    // A key naming a palette or a face this build does not have would be an override nothing can
    // ever reach, kept forever in a row the user cannot see.
    if (!isThemeName(name) || (mode !== "dark" && mode !== "light")) continue;
    const parsed = parseThemeOverride(value);
    if (isOverridden(parsed)) out[key] = parsed;
  }
  return out;
}

export const isOverridden = (o: ThemeOverride | undefined): boolean =>
  !!o && (Object.keys(o).length > (o.syntax ? 1 : 0) || Object.keys(o.syntax ?? {}).length > 0);

/** The seed a face actually derives from: the palette's own, with the user's edits merged in.
 *
 *  Null means "write nothing", which is only ever Realm untouched — the default has to stay
 *  byte-for-byte the static CSS in tokens.css, so the theme mechanism cannot repaint the app for
 *  someone who never chose a theme. The moment Realm IS edited it needs a ground to move, and
 *  `REALM_SEED` is that ground, read back out of the stylesheet the default is. */
export function seedFor(name: ThemeName, mode: Mode, override: ThemeOverride = {}): ThemeSeed | null {
  const def = THEMES.find((t) => t.name === name);
  const stated = (mode === "dark" ? def?.dark : def?.light) ?? null;
  const base = stated ?? (name === "realm" ? REALM_SEED[mode] : null);
  if (!base || (!stated && !isOverridden(override))) return null;
  return { ...base, ...override, syntax: { ...base.syntax, ...override.syntax } };
}

/** Which modes a theme actually has a palette for. `realm` has both and states neither — it IS
 *  tokens.css, whose two blocks the mode attribute already flips. */
export function themeModes(name: ThemeName): Mode[] {
  if (name === "realm") return ["dark", "light"];
  const def = THEMES.find((t) => t.name === name);
  return [...(def?.dark ? (["dark"] as const) : []), ...(def?.light ? (["light"] as const) : [])];
}

/** Which mode a theme would be worn in if it were the only thing chosen — a one-faced theme answers
 *  with the face it has. Nothing about the WINDOW hangs off this any more (see `paletteFor`): it is
 *  what a picker card and a ⌘K hint use to preview and to label, so `themeSwatches("monokai",
 *  "light")` draws Monokai's dark face rather than fabricating a light one. */
export function resolveMode(name: ThemeName, mode: Mode): Mode {
  const modes = themeModes(name);
  return modes.includes(mode) ? mode : (modes[0] ?? mode);
}

/** Which palette each face wears. Two slots rather than one name because the palette that suits a
 *  lit room is rarely the one that suits a dark one, and a single selection forces one of the two to
 *  be a compromise — the mode preference already says WHEN to switch, and this says what to switch
 *  TO. The pickers offer each face only the palettes that have it, which is what keeps the two axes
 *  independent: choosing Monokai for the dark slot cannot pin the window dark at noon. */
export type ThemeSelection = Record<Mode, ThemeName>;

export const DEFAULT_SELECTION: ThemeSelection = { dark: "realm", light: "realm" };

/** The palette a face actually wears. A selection naming a palette with no such face — a hand-edited
 *  setting, or a palette that loses a face in some later version — falls back to `realm`, whose face
 *  is the static CSS and therefore always exists. Falling back rather than pinning the mode is the
 *  point of splitting the selection: the window shows the light the user asked for, in the closest
 *  palette that has one. */
export function paletteFor(selection: ThemeSelection, mode: Mode): ThemeName {
  const name = selection[mode];
  return themeModes(name).includes(mode) ? name : "realm";
}

/** Realm's own thirteen, read out of theme/tokens.css and written here as hex — the same seeds the
 *  stylesheet's own ramp guardrail recovers from that file, so styles.test.ts pins this copy against
 *  it rather than letting two sets of Realm's colours drift apart.
 *
 *  It exists for the two jobs that need Realm's palette as VALUES rather than as a stylesheet. The
 *  picker cannot read them off the document — by the time it renders under any other theme the live
 *  `var(--page)` is THAT theme's page, so a preview built from computed styles would draw every card
 *  in the colours of whichever palette is already on. And an override needs a ground to derive from:
 *  a user who moves Realm's accent has asked for a palette, and there has to be a seed under it.
 *
 *  Realm's `ThemeDef` still states no seeds, which is what keeps the untouched default byte-for-byte
 *  the static CSS: an unoverridden `realm` writes nothing, and this is never consulted. */
export const REALM_SEED: Record<Mode, ThemeSeed> = {
  dark: {
    bg: "#17181a", ink: "#f2f3f4", accent: "#3d9aff",
    green: "#3cbb72", orange: "#f68f3c", red: "#ee5c61",
    syntax: { comment: "#6c6f75", keyword: "#3d9aff", string: "#3cbb72", number: "#f68f3c", title: "#f2f3f4", type: "#f2f3f4", attr: "#a5a8ad" },
  },
  light: {
    bg: "#fafafb", ink: "#1f2124", accent: "#0285ff",
    green: "#199a4d", orange: "#ef720d", red: "#e3474c",
    syntax: { comment: "#9a9da3", keyword: "#0285ff", string: "#199a4d", number: "#ef720d", title: "#1f2124", type: "#1f2124", attr: "#62656b" },
  },
};

/** The colours a picker shows for a theme: the window, the card that floats on it, the accent, the
 *  one syntax hue that says most about a code palette — and a hairline in the theme's own hint ink.
 *
 *  The hairline is there because the card is painted in the theme it names, so a swatch can land on
 *  a ground it matches: every light palette's `--surface` is within a step of its `--page`, and that
 *  dot disappeared into the card entirely. A ring drawn from the theme's own ink is visible on any
 *  ground the theme can produce, which a fixed black or white one is not. */
export function themeSwatches(name: ThemeName, mode: Mode): [string, string, string, string, string] {
  const v = themeVars(name, resolveMode(name, mode));
  const s = v["--page"] ? v : deriveVars(REALM_SEED[mode], mode);
  return [s["--page"]!, s["--surface"]!, s["--accent"]!, s["--syn-string"]!, s["--ink-3"]!];
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
     * syntax foreground (#abb2bf): --ink is chrome, and the dimmer tiers derive off it. */
    name: "one",
    label: "One",
    credit: "Atom One Dark / One Light — MIT © GitHub, Inc.",
    blurb: "Atom's One, in both of its faces.",
    dark: {
      bg: "#282c34", ink: "#d7dae0", accent: "#61afef",
      green: "#98c379", orange: "#d19a66", red: "#e06c75",
      syntax: { comment: "#5c6370", keyword: "#c678dd", string: "#98c379", number: "#d19a66", title: "#61afef", type: "#e5c07b", attr: "#56b6c2" },
    },
    light: {
      bg: "#fafafa", ink: "#383a42", accent: "#4078f2",
      green: "#50a14f", orange: "#986801", red: "#e45649",
      syntax: { comment: "#a0a1a7", keyword: "#a626a4", string: "#50a14f", number: "#986801", title: "#4078f2", type: "#c18401", attr: "#0184bc" },
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
      syntax: { comment: "#88846f", keyword: "#f92672", string: "#e6db74", number: "#ae81ff", title: "#a6e22e", type: "#66d9ef", attr: "#a6e22e" },
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
      syntax: { comment: "#6272a4", keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9", title: "#50fa7b", type: "#8be9fd", attr: "#50fa7b" },
    },
    light: null,
  },
  {
    /* Nord — arcticicestudio/nord, MIT © Sven Greb. Dark only: Nord is specified as one palette
     * (Polar Night grounds, Snow Storm ink), and the "Nord Light" builds in the wild are community
     * inversions rather than upstream.
     * The one seed in this file that is not the value its spec publishes: comments are #616e88, the
     * brightened tone Nord's own editor ports adopted, because nord3 (#4c566a) measures 1.39:1 on
     * the surface derived from nord0 and needs 0.160 of lightness to clear the syntax floor — past
     * LIFT_BUDGET, which is the mechanism refusing to pretend and saying so. #616e88 needs 0.074 and
     * is corrected in the ordinary way. */
    name: "nord",
    label: "Nord",
    credit: "Nord — MIT © Sven Greb",
    blurb: "Arctic blue-greys. Dark only.",
    dark: {
      bg: "#2e3440", ink: "#eceff4", accent: "#88c0d0",
      green: "#a3be8c", orange: "#d08770", red: "#bf616a",
      syntax: { comment: "#616e88", keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead", title: "#88c0d0", type: "#8fbcbb", attr: "#d8dee9" },
    },
    light: null,
  },
  {
    /* Solarized — altercation/solarized, MIT © Ethan Schoonover. Both faces, which is the whole point
     * of Solarized: one set of accent hues over two symmetric grounds.
     * One deviation, and it is the one `lift` cannot make: `ink` is base2/base02 rather than
     * base0/base00. Solarized's text tones are an editor foreground, and as UI chrome base0 measures
     * 3.16:1 and base00 3.54:1 against the grounds this palette derives — under the 4.5:1 that
     * primary text is held to. `--ink` is deliberately the one seed nothing corrects, so a palette
     * whose foreground will not carry chrome has to say which tone it borrowed instead. */
    name: "solarized",
    label: "Solarized",
    credit: "Solarized — MIT © Ethan Schoonover",
    blurb: "Ethan Schoonover's symmetric pair.",
    dark: {
      bg: "#002b36", ink: "#eee8d5", accent: "#268bd2",
      green: "#859900", orange: "#cb4b16", red: "#dc322f",
      syntax: { comment: "#586e75", keyword: "#859900", string: "#2aa198", number: "#d33682", title: "#268bd2", type: "#b58900", attr: "#6c71c4" },
    },
    light: {
      bg: "#fdf6e3", ink: "#073642", accent: "#268bd2",
      green: "#859900", orange: "#cb4b16", red: "#dc322f",
      syntax: { comment: "#93a1a1", keyword: "#859900", string: "#2aa198", number: "#d33682", title: "#268bd2", type: "#b58900", attr: "#6c71c4" },
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
      syntax: { comment: "#928374", keyword: "#fb4934", string: "#b8bb26", number: "#d3869b", title: "#fabd2f", type: "#8ec07c", attr: "#83a598" },
    },
    light: {
      bg: "#fbf1c7", ink: "#3c3836", accent: "#076678",
      green: "#79740e", orange: "#af3a03", red: "#9d0006",
      syntax: { comment: "#7c6f64", keyword: "#9d0006", string: "#79740e", number: "#8f3f71", title: "#b57614", type: "#427b58", attr: "#076678" },
    },
  },
  {
    /* Catppuccin — catppuccin/palette (palette.json), MIT © Catppuccin. Mocha and Latte, both faces.
     * Comments are `overlay2`, which is the one syntax role Catppuccin states globally — its VS Code
     * port sets the rest PER LANGUAGE, so there is no published keyword-or-string colour to vendor.
     * The seven hues below are Catppuccin's; the assignment of hue to role is Realm's, and it follows
     * the convention its ports converge on: mauve for keywords, green for strings, blue for the name
     * being defined, yellow for types, peach for numbers, teal for attributes. */
    name: "catppuccin",
    label: "Catppuccin",
    credit: "Catppuccin — MIT © Catppuccin",
    blurb: "Mocha at night, Latte by day.",
    dark: {
      bg: "#1e1e2e", ink: "#cdd6f4", accent: "#cba6f7",
      green: "#a6e3a1", orange: "#fab387", red: "#f38ba8",
      syntax: { comment: "#9399b2", keyword: "#cba6f7", string: "#a6e3a1", number: "#fab387", title: "#89b4fa", type: "#f9e2af", attr: "#94e2d5" },
    },
    light: {
      bg: "#eff1f5", ink: "#4c4f69", accent: "#8839ef",
      green: "#40a02b", orange: "#fe640b", red: "#d20f39",
      syntax: { comment: "#7c7f93", keyword: "#8839ef", string: "#40a02b", number: "#fe640b", title: "#1e66f5", type: "#df8e1d", attr: "#179299" },
    },
  },
  {
    /* GitHub — primer/github-vscode-theme, MIT © Primer. Values read off the SHIPPED theme JSON
     * rather than off @primer/primitives: colors.js overrides three of them at build time, so the
     * primitives' own `fg.default` and `accent.fg` are not what the editor draws.
     * One deviation, and it is the ladder's rather than a matter of taste: GitHub Light's editor
     * ground is #ffffff, and a light surface step CLIMBS from the page — off pure white there is
     * nowhere to climb to, so every card would land back on the page and the ladder would collapse.
     * The seed is `canvas.subtle` (#f6f8fa), which is GitHub's own chrome ground: what it paints its
     * sidebar, panel and tab strip with, and the right analogue of Realm's `--page`. */
    name: "github",
    label: "GitHub",
    credit: "GitHub — MIT © Primer",
    blurb: "GitHub's own two, as the editor draws them.",
    dark: {
      bg: "#0d1117", ink: "#e6edf3", accent: "#2f81f7",
      green: "#3fb950", orange: "#d29922", red: "#f85149",
      syntax: { comment: "#8b949e", keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff", title: "#d2a8ff", type: "#7ee787", attr: "#ffa657" },
    },
    light: {
      bg: "#f6f8fa", ink: "#1f2328", accent: "#0969da",
      green: "#1a7f37", orange: "#9a6700", red: "#cf222e",
      syntax: { comment: "#6e7781", keyword: "#cf222e", string: "#0a3069", number: "#0550ae", title: "#8250df", type: "#116329", attr: "#953800" },
    },
  },
  {
    /* Rosé Pine — rose-pine/rose-pine-palette, MIT © Rosé Pine. Main and Dawn.
     * Dawn's text is #575279, from the palette's TypeScript source and its shipped VS Code theme.
     * The palette.json in that repo says #464261; it was added in a commit titled "temp: add json,
     * toml, yaml", disagrees with every built artifact, and is not what anything renders.
     * Rosé Pine publishes no green. "It worked" takes foam, the nearest tone it has, because a
     * semantic colour has to survive a repaint and inventing a green would be inventing a hue. */
    name: "rosepine",
    label: "Rosé Pine",
    credit: "Rosé Pine — MIT © Rosé Pine",
    blurb: "Muted natural tones, night and dawn.",
    dark: {
      bg: "#191724", ink: "#e0def4", accent: "#c4a7e7",
      green: "#9ccfd8", orange: "#f6c177", red: "#eb6f92",
      syntax: { comment: "#6e6a86", keyword: "#31748f", string: "#f6c177", number: "#c4a7e7", title: "#ebbcba", type: "#9ccfd8", attr: "#908caa" },
    },
    light: {
      bg: "#faf4ed", ink: "#575279", accent: "#907aa9",
      green: "#56949f", orange: "#ea9d34", red: "#b4637a",
      syntax: { comment: "#9893a5", keyword: "#286983", string: "#ea9d34", number: "#907aa9", title: "#d7827e", type: "#56949f", attr: "#797593" },
    },
  },
];
