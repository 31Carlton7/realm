import { hexToOklch, oklchToHex, type Oklch } from "./colour";
import type { Mode, SyntaxSeed, ThemeSeed } from "./theme-seed";

/**
 * Reading a VS Code colour theme into one of Realm's thirteen seeds.
 *
 * A VS Code theme is two unrelated things in one file: `colors`, a flat map of some six hundred
 * workbench keys, and `tokenColors`, a TextMate grammar's worth of scope selectors. Realm's palette
 * is thirteen colours that a measured ramp expands into everything else (`deriveVars`). So this is
 * not a copy — it is a READ: find, in whatever the theme chose to state, the thirteen facts Realm
 * needs, and say honestly when one of them was not there.
 *
 * Three rules run through all of it.
 *
 * **Chains, not keys.** Almost nothing is mandatory in a VS Code theme. Monokai states no
 * `editorError.foreground`, no `textLink.foreground` and no git decoration colours at all; Solarized
 * states different ones again. Every role below is a LIST of keys in falling order of how directly
 * each answers the question, ending — for the roles that have one — in a token scope, and then in a
 * derivation from what the theme did state. A theme that states nothing still produces a palette.
 *
 * **Alpha is composited, never carried.** Workbench colours are frequently `#rrggbbaa`, and a seed
 * is opaque: the ramp derives surfaces and inks from it, and an alpha would silently multiply
 * through all of them. So a translucent value is flattened onto the ground it was going to be drawn
 * over, which is what the eye would have seen anyway.
 *
 * **Nothing is invented to clear a floor.** The seeds come out at whatever the theme published;
 * `deriveVars`'s own `lift` is what corrects them against Realm's contrast floors, and its budget is
 * what decides whether the result is honest. Pre-brightening a colour here would route around that
 * and clear the floor silently, at whatever distance from the author's colour it took.
 */

/** The shape this reads. Every field optional, because in real themes every field is. */
export type VsCodeTheme = {
  name?: string;
  type?: string;
  colors?: Record<string, unknown>;
  tokenColors?: unknown;
  semanticTokenColors?: Record<string, unknown>;
};

/** One `tokenColors` entry, after the shapes real themes use are normalised away. */
type TokenRule = { scopes: string[]; foreground: string | null };

const HEX = /^#?([0-9a-f]{3,8})$/i;

/** Below this OKLCH chroma a colour is a grey, whatever its hue says. Measured against the themes
 *  that tripped it: Monokai's `#75715e` sits at 0.018 and Kimbie's `#6e583b` at 0.036, while every
 *  accent worth keeping — Abyss's `#0063a5`, Solarized's `#197271` — clears 0.06. */
const ACCENT_MIN_CHROMA = 0.045;

/**
 * A theme's colour value as opaque hex, composited onto `over` when it carries alpha.
 *
 * Returns null for anything that is not a colour — `false` (VS Code's "unset this"), a missing key,
 * a named colour, a malformed string. Null is the signal the chains below fall through on, so it has
 * to mean "the theme did not answer", never "the theme answered badly and I substituted something".
 */
export function readColour(raw: unknown, over: string | null = null): string | null {
  if (typeof raw !== "string") return null;
  const m = HEX.exec(raw.trim());
  if (!m) return null;
  const h = m[1]!;
  // 3 and 4 digit forms double each nibble; 6 and 8 are already per-channel.
  const full = h.length <= 4 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length !== 6 && full.length !== 8) return null;
  const rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
  const a = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
  if (a >= 0.999 || !over) return toHex(rgb);
  const under = readColour(over);
  if (!under) return toHex(rgb);
  const u = [0, 2, 4].map((i) => parseInt(under.slice(1 + i, 3 + i), 16)) as [number, number, number];
  return toHex(rgb.map((c, i) => Math.round(c * a + u[i]! * (1 - a))) as [number, number, number]);
}

const toHex = (rgb: [number, number, number]): string =>
  `#${rgb.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("")}`;

/**
 * `tokenColors` in the three shapes real themes ship it: an array of rules whose `scope` is a string,
 * an array of strings, or a comma-separated string. Anything else is skipped rather than guessed at.
 */
export function tokenRules(raw: unknown): TokenRule[] {
  if (!Array.isArray(raw)) return [];
  const out: TokenRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { scope?: unknown; settings?: unknown };
    const settings = e.settings && typeof e.settings === "object" ? e.settings as { foreground?: unknown } : null;
    const foreground = readColour(settings?.foreground);
    const scope = e.scope;
    const scopes = Array.isArray(scope) ? scope.filter((s): s is string => typeof s === "string")
      : typeof scope === "string" ? scope.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    if (scopes.length > 0) out.push({ scopes, foreground });
  }
  return out;
}

/**
 * The colour a scope resolves to, by TextMate's own rule: the most SPECIFIC selector that is a
 * prefix of the scope wins.
 *
 * Prefix rather than equality because that is how scopes work — a rule on `entity.name` is meant to
 * catch `entity.name.function.js`, and a theme that states the general one and not the specific one
 * has still answered the question. Specificity is the dotted length of the selector, so a rule on
 * `entity.name.function` beats one on `entity`, whichever order the file lists them in.
 *
 * The last matching rule of equal specificity wins, which is VS Code's own precedence: later rules
 * override earlier ones.
 */
export function scopeColour(rules: readonly TokenRule[], scope: string): string | null {
  let best: { depth: number; colour: string } | null = null;
  for (const rule of rules) {
    if (!rule.foreground) continue;
    for (const sel of rule.scopes) {
      if (sel !== scope && !scope.startsWith(`${sel}.`)) continue;
      const depth = sel.split(".").length;
      if (!best || depth >= best.depth) best = { depth, colour: rule.foreground };
    }
  }
  return best?.colour ?? null;
}

/**
 * The workbench keys each Realm role reads, in falling order of how directly each answers.
 *
 * These are ordered by what the key MEANS, not by how common it is. `--accent` is the one hue the
 * app uses for itself — buttons, focus, links, carets — so it asks for a button's fill before a
 * focus border, because a focus border is often a desaturated grey in themes that have a real accent
 * elsewhere. The state colours ask their editor role first (that is literally "what this theme calls
 * an error") and fall back to the terminal's ANSI slot, which every theme sets.
 */
const COLOUR_CHAINS = {
  bg: ["editor.background", "editorPane.background", "tab.activeBackground"],
  /* `editor.foreground` then the workbench `foreground`, and then nothing. A theme may state
     neither — QuietLight states no foreground anywhere — and the chain deliberately stops rather
     than reaching for `editorLineNumber.activeForeground`, which was tried and is a trap: it is an
     ACCENT in most themes, so QuietLight's body ink came out purple. Where a theme says nothing,
     VS Code's own default for that face is the honest answer, because it is what the author was
     looking at while they chose everything else. */
  ink: ["editor.foreground", "foreground"],
  /* Link, badge and progress before `button.background`, and that order is the whole point: Realm's
     accent is links, focus rings, carets and primary buttons at once, and a button's FILL is muted
     chrome in more themes than not (Monokai's is a grey-brown, Abyss's a navy) while the link colour
     is almost always the theme's real identity hue. `focusBorder` is last for the same reason it
     used to be first — it is frequently a desaturated line, not an accent. */
  accent: [
    "textLink.foreground", "editorLink.activeForeground", "activityBarBadge.background",
    "progressBar.background", "button.background", "focusBorder",
  ],
  green: [
    "gitDecoration.addedResourceForeground", "editorGutter.addedBackground",
    "terminal.ansiGreen", "terminal.ansiBrightGreen", "charts.green",
  ],
  orange: [
    "editorWarning.foreground", "list.warningForeground", "gitDecoration.modifiedResourceForeground",
    "editorGutter.modifiedBackground", "terminal.ansiYellow", "terminal.ansiBrightYellow", "charts.yellow",
  ],
  red: [
    "editorError.foreground", "list.errorForeground", "gitDecoration.deletedResourceForeground",
    "editorGutter.deletedBackground", "terminal.ansiRed", "terminal.ansiBrightRed", "charts.red",
  ],
} as const satisfies Record<string, readonly string[]>;

/** The token scopes each syntax role reads, same falling order and the same reasoning. */
const SCOPE_CHAINS: Record<keyof SyntaxSeed, readonly string[]> = {
  comment: ["comment", "punctuation.definition.comment", "comment.line"],
  keyword: ["keyword", "keyword.control", "storage.type", "storage"],
  string: ["string", "string.quoted", "string.quoted.double"],
  number: ["constant.numeric", "constant.language", "constant"],
  title: ["entity.name.function", "support.function", "entity.name", "meta.function"],
  type: ["entity.name.type", "support.type", "entity.name.class", "support.class", "storage.type"],
  attr: ["entity.other.attribute-name", "variable.other.property", "support.variable", "variable"],
};

/** Where a syntax role may borrow from once its own scopes come up empty, before anything is
 *  derived. A theme that coloured keywords but not types would rather have its keyword colour on a
 *  type than a hue nobody chose. */
const SCOPE_BORROW: Record<keyof SyntaxSeed, readonly (keyof SyntaxSeed)[]> = {
  comment: [], keyword: ["type"], string: ["number"], number: ["string"],
  title: ["keyword"], type: ["keyword"], attr: ["type", "keyword"],
};

/** What was read, and from where — so the import can SAY which of the thirteen the theme actually
 *  stated and which Realm had to work out. A theme missing eight of them is worth knowing about
 *  before it repaints the app. */
/** `borrowed` is its own answer, and only the accent uses it: the theme DID state one, and it was a
 *  grey — so the value came from elsewhere in the same file rather than from nothing. Worth telling
 *  apart from `derived` in the import's own report, because it is the one substitution Realm makes
 *  against something the author actually wrote. */
export type SeedSource = "stated" | "derived" | "borrowed";
export type SeedReport = Record<string, SeedSource>;

/**
 * A VS Code theme as a Realm seed, plus a note of what it had to invent.
 *
 * `mode` is the face being built. It is passed in rather than read off `type` because a theme's own
 * `type` is what it CLAIMS and the ground is what it IS: `readMode` below decides from the
 * background's lightness, and disagreements are common enough in real files to matter (a "dark"
 * theme with a `#fafafa` editor is a light theme).
 */
export function vscodeToSeed(theme: VsCodeTheme, mode: Mode): { seed: ThemeSeed; report: SeedReport } {
  const colors = (theme.colors ?? {}) as Record<string, unknown>;
  const rules = tokenRules(theme.tokenColors);
  const report: SeedReport = {};

  /* The ground is read first and everything else composites over it — including the ground's own
     fallback, which is why this one cannot use the helper below. */
  const bg = firstColour(colors, COLOUR_CHAINS.bg, null) ?? (mode === "dark" ? "#1e1e1e" : "#ffffff");
  report["bg"] = firstColour(colors, COLOUR_CHAINS.bg, null) ? "stated" : "derived";

  const pick = (role: keyof typeof COLOUR_CHAINS, fallback: () => string): string => {
    const found = firstColour(colors, COLOUR_CHAINS[role], bg);
    report[role] = found ? "stated" : "derived";
    return found ?? fallback();
  };

  // VS Code's own default foreground per face — what the theme's author had on screen while they
  // chose everything else, and so the least surprising thing to put where they said nothing.
  const ink = pick("ink", () => (mode === "dark" ? "#d4d4d4" : "#1f1f1f"));
  /* No accent anywhere is the one genuinely awkward gap, because an accent is a HUE and a theme
     that stated none has not hinted at one. The keyword colour is the best answer available: it is
     the hue the theme uses most prominently, and a palette whose buttons match its keywords reads as
     deliberate where a stock blue reads as a failed import. */
  const accent = accentOf();

  /**
   * The accent, with one guard on top of the chain: a stated accent with no CHROMA is not an accent.
   *
   * Realm spends this colour on focus rings, links, carets and the selected state — every one of
   * which has to be told apart from a border at a glance. A grey passes the chain (Monokai states a
   * grey-brown button and a grey focus border, and states nothing else) and then makes a focus ring
   * indistinguishable from the hairline beside it, which is a working control that looks broken.
   *
   * So a chromaless answer falls through to the theme's own keyword hue: still the author's colour,
   * still from this file, and the one they chose to make the most prominent. It is not a brightening
   * — the value is used as published — it is a different question asked of the same theme.
   */
  function accentOf(): string {
    const stated = firstColour(colors, COLOUR_CHAINS.accent, bg);
    if (stated && hexToOklch(stated).c >= ACCENT_MIN_CHROMA) { report["accent"] = "stated"; return stated; }
    const hue = syntaxOf("keyword") ?? syntaxOf("title") ?? syntaxOf("type");
    if (hue) { report["accent"] = stated ? "borrowed" : "derived"; return hue; }
    report["accent"] = stated ? "stated" : "derived";
    return stated ?? shiftToward(ink, bg, 0.35);
  }
  /* The state colours. "Green means it worked" has to survive a repaint, so where the theme states
     none the fallback looks for the theme's OWN colour nearest that hue before reaching for a
     constant — a palette whose failures are Realm's red rather than its own reads as half-imported.
     `nearestHue` is what does the looking; the constants are the floor under it. */
  const green = pick("green", () => nearest(HUE.green) ?? "#3fb950");
  const orange = pick("orange", () => nearest(HUE.orange) ?? "#d29922");
  const red = pick("red", () => nearest(HUE.red) ?? "#f85149");

  function syntaxOf(role: keyof SyntaxSeed): string | null {
    return scopeChain(rules, SCOPE_CHAINS[role]);
  }

  /** The theme's own colour closest to `hue`, out of everything it stated — its syntax palette and
   *  its accent. Null when nothing it wrote is near enough to be that colour honestly. */
  function nearest(hue: number): string | null {
    /* The SYNTAX palette only. The accent was in this pool and had to come out: it is chrome, and
       chrome is muted in most themes — Kimbie's `#7f5d38` sits nearer the orange target than its own
       `#f79a32` and won on proximity, so "the theme's orange" came out a dull brown. A theme's real
       hues are the ones it writes code in. */
    const pool = (Object.keys(SCOPE_CHAINS) as (keyof SyntaxSeed)[])
      .map((r) => syntaxOf(r)).filter((c): c is string => c !== null);
    return nearestHue(pool, hue);
  }

  const syntax = {} as SyntaxSeed;
  for (const role of Object.keys(SCOPE_CHAINS) as (keyof SyntaxSeed)[]) {
    const own = syntaxOf(role);
    if (own) { syntax[role] = own; report[`syntax.${role}`] = "stated"; continue; }
    const borrowed = SCOPE_BORROW[role].map((r) => syntaxOf(r)).find((c): c is string => c !== null) ?? null;
    /* Last resort, and it is deliberately dull: a comment with nothing to go on sits between the ink
       and the ground (which is what a comment IS), and any other role falls back to the ink itself.
       Both are honest — "this theme did not say" — where a fabricated hue would be a claim. */
    syntax[role] = borrowed ?? (role === "comment" ? shiftToward(ink, bg, 0.55) : ink);
    report[`syntax.${role}`] = "derived";
  }

  return { seed: { bg, ink, accent, green, orange, red, syntax }, report };
}

/** The first key in the chain the theme actually answers with a colour. */
function firstColour(colors: Record<string, unknown>, chain: readonly string[], over: string | null): string | null {
  for (const key of chain) {
    const c = readColour(colors[key], over);
    if (c) return c;
  }
  return null;
}

/** The first scope in the chain that resolves. */
function scopeChain(rules: readonly TokenRule[], chain: readonly string[]): string | null {
  for (const scope of chain) {
    const c = scopeColour(rules, scope);
    if (c) return c;
  }
  return null;
}

/**
 * The colour in `pool` closest to `hue`, or null when none is close enough to claim it.
 *
 * Two guards, and both are about not fabricating a state colour. A colour with no chroma is a grey
 * and has no hue to be near anything; a colour more than `HUE_REACH` away is a different colour, and
 * calling a blue "the theme's red" because it was the least-blue thing available would be worse than
 * using Realm's own red and saying so. Among what survives, the most chromatic wins — a state colour
 * is meant to carry at a glance.
 */
export function nearestHue(pool: readonly string[], hue: number): string | null {
  let best: { d: number; c: number; hex: string } | null = null;
  for (const hex of pool) {
    const o = hexToOklch(hex);
    if (o.c < STATE_MIN_CHROMA) continue;
    // Circular distance: the `+540 … %360 −180` fold maps equal hues to 0 and opposite ones to ±180.
    const d = Math.abs(((o.h - hue + 540) % 360) - 180);
    if (d > HUE_REACH) continue;
    /* NEARNESS first, chroma only to break a tie. Ranking by chroma alone was tried and is wrong in
       a way that shows: Kimbie's `#f06431` is more saturated than its `#f79a32`, so the orange slot
       took the red-orange and then the red slot took it too — one colour doing two jobs, and neither
       of them the colour the theme would have chosen. */
    if (!best || d < best.d || (d === best.d && o.c > best.c)) best = { d, c: o.c, hex };
  }
  return best?.hex ?? null;
}

/**
 * Where each state colour lives on the OKLCH wheel, measured off the reds, oranges and greens these
 * themes actually publish rather than picked off a colour picker.
 *
 *   red     GitHub 27.0 · Solarized 27.1 · Red's own keyword 27.6
 *   orange  Kimbie 63.5 · GitHub 79.9 · Solarized 85.7
 *   green   Solarized 118.6 · Kimbie 120.4 · Monokai 127.3 · GitHub 145.6
 *
 * Red is remarkably tight; green spans nearly thirty degrees, which is what `HUE_REACH` has to cover.
 */
const HUE = { red: 27, orange: 78, green: 130 } as const;

/** How far from the wanted hue a colour may sit and still be called it, in degrees. Wide enough that
 *  an orange-red counts as the red of a theme that states none, narrow enough that a yellow never
 *  does — and wide enough to hold the green span above. */
const HUE_REACH = 40;
/**
 * A state colour needs real chroma to read as a state at all — HIGHER than the accent's guard, not
 * lower, and that is the correction this constant carries. "Green means it worked" has to land at a
 * glance on a status dot a few pixels across, where an accent gets a whole button.
 *
 * Calibrated against what these themes publish: the greens, oranges and reds worth borrowing sit at
 * 0.109–0.206, while the muted chrome that kept winning on proximity alone — Kimbie's `#7f5d38`, its
 * `#98676a`, a `#8ab1b0` teal — sits at 0.042–0.07.
 */
const STATE_MIN_CHROMA = 0.09;

/** `a` moved `t` of the way towards `b` in OKLCH lightness, keeping its own hue. What a derived
 *  comment colour is: the ink, most of the way down to the ground. */
function shiftToward(a: string, b: string, t: number): string {
  const from = hexToOklch(a), to = hexToOklch(b);
  const out: Oklch = { l: from.l + (to.l - from.l) * t, c: from.c * (1 - t * 0.5), h: from.h };
  return oklchToHex(out);
}

/**
 * Which face this theme IS, from its ground rather than its label.
 *
 * `type` is a claim and the background is the fact. Real themes disagree often enough to matter —
 * and the consequence of believing the label is a "dark" palette whose ground is white, derived with
 * the dark ramp, which climbs its surfaces the wrong way and produces a theme nobody can read.
 */
export function readMode(theme: VsCodeTheme): Mode {
  const bg = firstColour((theme.colors ?? {}) as Record<string, unknown>, COLOUR_CHAINS.bg, null);
  if (bg) return hexToOklch(bg).l < 0.5 ? "dark" : "light";
  const type = typeof theme.type === "string" ? theme.type.toLowerCase() : "";
  return type === "light" || type === "hc-light" ? "light" : "dark";
}
