/** OKLCH ⇄ sRGB, and WCAG contrast on top of it.
 *
 *  The palette in theme/tokens.css is written in OKLCH because that is the space its ladders were
 *  designed in: a surface ladder is a lightness ramp, and only a perceptual space makes "one step
 *  lighter" mean the same thing at the bottom of the ramp as at the top. Deriving a theme from a
 *  handful of seeds means doing that arithmetic here rather than by eye, and CHECKING the result —
 *  which needs the trip back to sRGB, because contrast is defined on sRGB luminance and on nothing
 *  else.
 *
 *  Matrices are Björn Ottosson's (bottosson.github.io/posts/oklab, public domain). Written out
 *  rather than pulled in: the app ships no colour library, this is the whole of what a theme needs,
 *  and a dependency whose only caller is one derivation is a dependency to explain forever. */

export type Oklch = { l: number; c: number; h: number };

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** sRGB transfer function and its inverse, on 0..1 channels. */
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function parseHex(hex: string): [number, number, number] {
  const m = hex.trim().replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = parseHex(hex).map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  // Hue of a neutral is arbitrary noise; report 0 so `hexToOklch("#888").h` is stable rather than
  // whatever the rounding of two near-zero components happened to produce.
  const h = c < 1e-6 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

/** Linear-light sRGB, CLIPPED per channel. An OKLCH triple can name a colour sRGB cannot show; the
 *  browser clips it to the gamut boundary, so a contrast figure computed on the unclipped value
 *  would describe a colour nobody will ever see. */
function toLinearRgb({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const A = c * Math.cos(rad), B = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    clamp01(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clamp01(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clamp01(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

export function oklchToHex(o: Oklch): string {
  const to = (x: number) => Math.round(clamp01(fromLinear(x)) * 255).toString(16).padStart(2, "0");
  const [r, g, b] = toLinearRgb(o);
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** The CSS form. Three decimals on lightness and chroma is what tokens.css already writes, and it is
 *  finer than an 8-bit channel can resolve — rounding here never moves a pixel. */
export function css(o: Oklch, alpha?: number): string {
  const n = (x: number, p: number) => Number(x.toFixed(p)).toString();
  const base = `${n(o.l, 3)} ${n(o.c, 4)} ${n(o.h, 2)}`;
  return alpha === undefined ? `oklch(${base})` : `oklch(${base} / ${n(alpha, 3)})`;
}

/** Back from the CSS form. The derivation's own output is the only thing this parses — a full
 *  colour parser is a different job, and every caller here is reading a value `css` wrote. */
export function parseOklch(value: string): Oklch {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)/.exec(value.trim());
  if (!m) throw new Error(`not an oklch value: ${value}`);
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) };
}

/** The colour as it will actually be WRITTEN. `css` rounds lightness to three decimals, which is
 *  finer than a display can resolve but NOT finer than a contrast floor: a walk that stops the
 *  instant it reaches 3.00:1 can round to 2.9987 on the way out, and ship a ratio the palette is
 *  asserted never to have. Any walk whose stopping condition is a floor measures this instead. */
export const emitted = (o: Oklch): Oklch => parseOklch(css(o));

/** WCAG 2.x relative luminance. */
export function luminance(o: Oklch): number {
  const [r, g, b] = toLinearRgb(o);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1..21. Order-independent. */
export function contrast(a: Oklch, b: Oklch): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
