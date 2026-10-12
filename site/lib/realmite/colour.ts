/** The slice of packages/contracts/src/colour.ts the Realmite palettes need: OKLCH to sRGB, and WCAG
 *  contrast on top of it. Copied rather than imported because the site sits outside the workspace
 *  (README, "Why it is not in the pnpm workspace"); keep it in step with that file. */

export type Oklch = { l: number; c: number; h: number };

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const fromLinear = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

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

export function css(o: Oklch, alpha?: number): string {
  const n = (x: number, p: number) => Number(x.toFixed(p)).toString();
  const base = `${n(o.l, 3)} ${n(o.c, 4)} ${n(o.h, 2)}`;
  return alpha === undefined ? `oklch(${base})` : `oklch(${base} / ${n(alpha, 3)})`;
}

function luminance(o: Oklch): number {
  const [r, g, b] = toLinearRgb(o);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Oklch, b: Oklch): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
