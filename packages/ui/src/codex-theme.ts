import { css, hexToOklch, type ThemeSeed } from "@realm/contracts";

/** The Codex desktop app's light palette (OpenAI's ChatGPT.app, bundle com.openai.codex), as its own
 *  theme engine derives it.
 *
 *  Codex does not ship a light palette as a list of colours. It ships four numbers — a surface, an
 *  ink, an accent and a contrast — and a function that turns them into every fill, border and text
 *  tier in the window (`Pba`/`Iba`/`Fba` in its webview bundle). Realm's own ramp would turn the same
 *  four into a DIFFERENT palette, so the vendored values alone would not reproduce Codex; this file is
 *  that function, restated for the tokens Realm has. Every coefficient below is Codex's, and the
 *  values it produces for Codex's own seed were checked against Chromium resolving Codex's
 *  stylesheets with its engine's output applied (see codex-theme.test.ts).
 *
 *  Codex's light default: surface #ffffff, ink #1a1c1f, contrast 45, and the accent of the signed-in
 *  ChatGPT account — blue-400 #3a83f7 for the default account colour, whose text tier is blue-500. */
export const CODEX_LIGHT_SEED: ThemeSeed = {
  bg: "#ffffff", ink: "#1a1c1f", accent: "#3a83f7",
  // Codex's --color-text-success / -warning / -danger.
  green: "#00a240", orange: "#e25507", red: "#e02e2a",
  // Codex's code block (prism): --codeblock-syntax-1..5, and comments at 50% of the ink on the
  // white code card.
  syntax: { comment: "#8d8e8f", keyword: "#0169cc", string: "#008635", number: "#8046d9", title: "#c0660d", type: "#e04c91", attr: "#e04c91" },
};

/** Codex's default contrast, and where it sits on Realm's 0–100 control (whose default is 60). */
const CODEX_CONTRAST = 45;
const REALM_DEFAULT_LEVEL = 60;

/** Realm's contrast level → Codex's: the default lands on Codex's default, and each end on each end. */
export function codexContrast(level: number): number {
  const l = Math.min(100, Math.max(0, level));
  return l <= REALM_DEFAULT_LEVEL
    ? (CODEX_CONTRAST * l) / REALM_DEFAULT_LEVEL
    : CODEX_CONTRAST + ((l - REALM_DEFAULT_LEVEL) * (100 - CODEX_CONTRAST)) / (100 - REALM_DEFAULT_LEVEL);
}

/** Codex's contrast curve (`zba`): linear to its default, twice as steep above it. */
function curve(contrast: number): number {
  const i = contrast / 100 + ((contrast - CODEX_CONTRAST) / 60) * 0.7;
  return contrast <= CODEX_CONTRAST ? i : CODEX_CONTRAST / 100 + (i - CODEX_CONTRAST / 100) * 2;
}

type Rgb = [number, number, number];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

const rgb = (hex: string): Rgb => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hex = (c: Rgb): string => `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
/** Codex's `YJ`: a per-channel step from `a` towards `b`, rounded to the byte. */
const mix = (a: Rgb, b: Rgb, t: number): Rgb => {
  const k = Math.min(1, Math.max(0, t));
  return a.map((x, i) => Math.round(x + (b[i]! - x) * k)) as Rgb;
};
/** An `rgba(ink, alpha)` fill as it lands on `ground`. Codex writes these as alphas (`qJ`, three
 *  decimals); Realm's ramp tokens are opaque, so they are composited on the ground they sit on. */
const over = (ground: Rgb, ink: Rgb, alpha: number): Rgb => mix(ground, ink, Number(alpha.toFixed(3)));
const rgba = (c: Rgb, alpha: number): string => `rgba(${c.join(", ")}, ${Number(Math.min(1, Math.max(0, alpha)).toFixed(3))})`;

const lin = (x: number): number => { const v = x / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: Rgb): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/** Codex's `Gba`: the label on an accent fill — white on the deep blues, black on anything brighter
 *  than a luminance of .179. On its own #3a83f7 that is black. */
function onAccent(a: Rgb): Rgb {
  const [r, g, b] = a;
  if (b > r && b > g) {
    const t = b - Math.min(r, g), h = ((r - g) / t + 4) * 60;
    if ((t / b >= 0.8 && h >= 205 && h <= 212) || (t / b >= 0.6 && h >= 218 && h <= 233 && lum(a) <= 0.21)) return WHITE;
  }
  return lum(a) > 0.179 ? BLACK : WHITE;
}

/** The ChatGPT account colours Codex's accent comes from (`Sba`). An accent that is one of these
 *  palettes' 400 step takes its text tier from the 500 step and its soft fill from the 50 step, as
 *  Codex does (`gba`); any other accent is its own text colour and a tint of the surface. */
const ACCOUNT_ACCENTS: Record<string, { text: string; soft: string }> = {
  "#3a83f7": { text: "#2c67c5", soft: "#e8f3fe" }, // blue
  "#53b559": { text: "#48a04c", soft: "#def3e5" }, // green
  "#f6c543": { text: "#b8802b", soft: "#fdf6dc" }, // yellow (its text tier is 600)
  "#f077af": { text: "#cf6194", soft: "#fdedf4" }, // pink
  "#ee7c37": { text: "#d25e28", soft: "#fbe8db" }, // orange
  "#a67df2": { text: "#7849d1", soft: "#ede5fc" }, // purple (accent is its 300)
};

/** Codex's soft status fills (`--app-color-background-status-*`, on white). A seed that moves a
 *  state colour gets the same 15% wash of the surface instead. */
const STATUS_TINTS: Record<string, string> = { "#00a240": "#edf8f1", "#e25507": "#ffe7d9", "#e02e2a": "#ffd9d9" };

/** The tokens Codex's palette sets beyond `THEME_VARS`: the border, fill and scrim ramps, which in
 *  Realm are fixed alpha overlays and in Codex are alphas of the theme's own ink. */
export const CODEX_EXTRA_VARS = [
  "--line", "--line-strong", "--line-soft", "--divider", "--divider-hover", "--mark", "--mark-strong",
  "--rl-hover", "--rl-active", "--scrim", "--scrim-soft", "--shadow-overlay", "--chrome-tint",
] as const;

/** Codex's derivation, on a Realm seed, for Realm's tokens. `level` is Realm's contrast control. */
export function deriveCodex(seed: ThemeSeed, level: number): Record<string, string> {
  const k = codexContrast(level), c = curve(k);
  const S = rgb(seed.bg), I = rgb(seed.ink), A = rgb(seed.accent);
  const out = (x: Rgb): string => css(hexToOklch(hex(x)));

  /* The grounds. Codex's sidebar and title bar show the window ground (`surface-under`, the surface
     4% of the way to the ink); its main area is the surface itself; the composer, cards and menus are
     the surface lifted towards white (`elevated-primary-opaque`). On a white surface that lift has
     nowhere to go, so in Codex's default the composer is told from the page by its shadow alone —
     kept exactly, rather than darkening Codex's main area to give Realm's ladder a step. */
  const page = mix(S, I, 0.04 + (k - CODEX_CONTRAST) * 0.0012);
  const canvas = S;
  const surface = mix(S, WHITE, 0.16 + c * 0.12);
  const field = mix(S, WHITE, 0.09 + c * 0.04);

  const account = ACCOUNT_ACCENTS[seed.accent.toLowerCase()];
  const accentInk = account ? rgb(account.text) : A;
  const accentTint = account ? rgb(account.soft) : mix(S, A, 0.11 + c * 0.04);
  const tint = (h: string): string => out(STATUS_TINTS[h.toLowerCase()] ? rgb(STATUS_TINTS[h.toLowerCase()]!) : mix(S, rgb(h), 0.15));

  const ink2 = over(canvas, I, 0.65 + c * 0.1);
  const ink3 = over(canvas, I, 0.45 + c * 0.1);
  const red = out(rgb(seed.red));

  return {
    "--page": out(page),
    "--canvas": out(canvas),
    "--surface": out(surface),
    // A sunken well: Codex's light border fill (its inline-code and secondary-button ground).
    "--inset": out(over(canvas, I, 0.04 + c * 0.02)),
    // Row hover and the stronger hover: Codex's secondary- and tertiary-button hovers.
    "--hover": out(over(canvas, I, 0.04 + c * 0.03)),
    "--hover-2": out(over(canvas, I, 0.08 + c * 0.04)),
    // Inputs: Codex's opaque control ground.
    "--field": out(field),
    // Codex's `--color-surface-canvas`: 98% of the surface, 2% black.
    "--stripe-bg": out(S.map((x) => Math.round(x * 0.98)) as Rgb),

    "--ink": out(I),
    "--ink-2": out(ink2),
    "--ink-3": out(ink3),

    "--accent": out(A),
    "--accent-ink": out(accentInk),
    "--accent-tint": out(accentTint),
    "--rl-accent-contrast": out(onAccent(A)),

    "--green": out(rgb(seed.green)),
    "--green-tint": tint(seed.green),
    "--orange": out(rgb(seed.orange)),
    "--orange-tint": tint(seed.orange),
    "--red": red,
    "--red-tint": tint(seed.red),

    // Codex's tooltip: the ink as a chip, white text, its quiet tier at 80%, a 5% white rim.
    "--tooltip-bg": out(I),
    "--tooltip-fg": out(WHITE),
    "--tooltip-muted": out(mix(I, WHITE, 0.8)),
    "--tooltip-border": out(mix(I, WHITE, 0.05)),

    "--chart-surface": out(surface),

    // Code is body text in Codex: the full ink, not a dimmed tier.
    "--syn-fg": out(I),
    "--syn-comment": out(rgb(seed.syntax.comment)),
    "--syn-keyword": out(rgb(seed.syntax.keyword)),
    "--syn-string": out(rgb(seed.syntax.string)),
    "--syn-number": out(rgb(seed.syntax.number)),
    "--syn-title": out(rgb(seed.syntax.title)),
    "--syn-type": out(rgb(seed.syntax.type)),
    "--syn-attr": out(rgb(seed.syntax.attr)),
    "--syn-meta": out(rgb(seed.syntax.comment)),
    "--syn-deleted": red,

    // The ramps Realm holds as fixed overlays, as alphas of this ink.
    "--line": rgba(I, 0.06 + c * 0.04),
    "--line-strong": rgba(I, 0.09 + c * 0.06),
    "--line-soft": rgba(I, 0.04 + c * 0.02),
    "--divider": rgba(I, 0.09 + c * 0.06),
    "--divider-hover": rgba(I, 0.2),
    "--mark": rgba(I, 0.1), // --switch-track-color
    "--mark-strong": rgba(I, 0.3), // --scrollbar-color
    "--rl-hover": rgba(I, 0.04 + c * 0.02),
    "--rl-active": rgba(I, 0.04 + c * 0.03),
    "--scrim": rgba(BLACK, 0.08 + c * 0.04),
    "--scrim-soft": rgba(BLACK, 0.08 + c * 0.04),
    // --shadow-dropdown-overlay: a half-pixel ring in the border colour over the xl lift.
    "--shadow-overlay": `0 0 0 0.5px ${rgba(I, 0.06 + c * 0.04)}, 0 8px 16px -4px #0000001f`,
    // Codex's title bar and icon rail ARE the window ground (surface-under), with nothing laid over
    // them; Realm darkens its chrome row by a 6% overlay, which Codex does not have.
    "--chrome-tint": "transparent",
  };
}
