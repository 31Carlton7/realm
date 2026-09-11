/**
 * The signature superellipse as a `clip-path`, for the one surface that cannot be painted.
 *
 * Every other squircle in Realm is drawn by the paint worklet, which fills a background. A canvas
 * cannot be done that way: its content is opaque, so a fill behind it changes nothing, and
 * `mask-image: paint(rl-squircle)` parses in this Chromium without masking — measured against the
 * real renderer, where the masked box came out square. `corner-shape: squircle` is inert here too
 * (Chromium 138; it lands in 139).
 *
 * What is left is a clip, and a clip needs an explicit path. That is affordable here and nowhere
 * else in the app precisely because this surface already knows its own size in pixels: `fit.ts`
 * computes the letterbox on every resize, so the number this needs is a number that was just
 * derived anyway.
 *
 * The curve is the same one `public/squircle-paint.js` traces, deliberately duplicated rather than
 * shared. The worklet cannot import from the module graph — it is loaded by URL under a
 * `script-src 'self'` CSP — so a shared module would have to be built into two places. Instead the
 * formula is stated twice and `squircle-path.test.ts` pins this copy to the same equation, so a
 * change to one that is not made to the other fails a test rather than showing up as two corners
 * that do not match.
 */

/** The exponent of |x/r|^n + |y/r|^n = 1. 4 is what the signature surfaces use — see the worklet. */
export const SQUIRCLE_N = 4;
/** Vertices per corner, the worklet's number. At these radii no chord leaves the true curve by more
 *  than a fiftieth of a pixel, so the facets stay invisible. */
const STEPS = 24;

/** One superellipse quadrant, swept from `t0` to `t1` about (cx, cy). */
function sweep(out: string[], cx: number, cy: number, r: number, t0: number, t1: number, n: number): void {
  for (let i = 0; i <= STEPS; i++) {
    const t = t0 + ((t1 - t0) * i) / STEPS;
    const c = Math.cos(t), s = Math.sin(t);
    const x = cx + r * Math.sign(c) * Math.abs(c) ** (2 / n);
    const y = cy + r * Math.sign(s) * Math.abs(s) ** (2 / n);
    out.push(`L${round(x)} ${round(y)}`);
  }
}

/** Two decimals. A path string is re-parsed by the compositor on every resize, and the third decimal
 *  is a hundredth of a device pixel — below anything that can be drawn. */
const round = (v: number): number => Math.round(v * 100) / 100;

/**
 * A rounded-rectangle path with superellipse corners, in CSS pixels, for `clip-path: path(...)`.
 *
 * The radius is clamped to half the SHORT side: a corner may never pass it, and a caller that asks
 * for more would otherwise get a self-crossing path — which clips to nothing, i.e. an invisible
 * screen. Returns `""` for a box with no area, so a caller can fall back to no clip at all rather
 * than clip a zero-sized guest into nothing while it is still connecting.
 */
export function squirclePath(width: number, height: number, radius: number, n: number = SQUIRCLE_N): string {
  if (!(width > 0) || !(height > 0)) return "";
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r === 0) return `M0 0L${round(width)} 0L${round(width)} ${round(height)}L0 ${round(height)}Z`;
  const out: string[] = [`M${round(r)} 0`, `L${round(width - r)} 0`];
  sweep(out, width - r, r, r, -Math.PI / 2, 0, n);
  out.push(`L${round(width)} ${round(height - r)}`);
  sweep(out, width - r, height - r, r, 0, Math.PI / 2, n);
  out.push(`L${round(r)} ${round(height)}`);
  sweep(out, r, height - r, r, Math.PI / 2, Math.PI, n);
  out.push(`L0 ${round(r)}`);
  sweep(out, r, r, r, Math.PI, (3 * Math.PI) / 2, n);
  return `${out.join("")}Z`;
}
