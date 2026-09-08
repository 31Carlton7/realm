/* Paint worklet: the continuous superellipse corner Realm's floating cards are drawn with.
 *
 * `corner-shape: squircle` is the declarative form of this and lands in Chromium 139; Electron
 * 37.10.3 ships 138, where the property is not even recognised (`CSS.supports('corner-shape',
 * 'squircle')` is false), so the stylesheet keeps that declaration as the path forward and this
 * worklet is what actually draws the shape today.
 *
 * It paints the FILL and the RING, because both have to trace the same curve. A `box-shadow` ring is
 * always drawn on the `border-radius` rounded rect, so leaving the edge to box-shadow puts a hairline
 * across a corner the fill has already bulged past — a superellipse sits further into the corner than
 * the circular arc of the same radius does. The soft lift layers stay on box-shadow: they are blurred
 * far wider than the two curves ever diverge.
 *
 * Lives in `public/` rather than the module graph on purpose. The renderer's CSP is
 * `script-src 'self'`, which rejects a worklet module fetched from a blob: or data: URL — measured,
 * not assumed — so this has to be a real file at the document's own origin.
 */

/* Exponent of the superellipse |x/r|^n + |y/r|^n = 1. n = 2 is the circle a plain border-radius
 * already draws; 4 is the ratio Figma and iOS settled on for a corner that reads as smooth rather
 * than as a shape of its own, and it is the initial value of `--sq-n` (theme/squircle.ts).
 *
 * It is an INPUT rather than a constant because a superellipse is a corner plus the flat run beside
 * it, and a control has no run: at `--sq-ratio-ctl` the corner is the whole short side, so 4 leaves
 * nothing on screen but the squareness. Controls pass a lower exponent (`--sq-n-ctl`); the signature
 * surfaces, whose corner is a third of their height, keep 4. Clamped rather than trusted: below 2
 * the quadrant bulges back OUT past the box, which is not a corner at all, and past 8 the curve is a
 * square with a nick in it that no radius can be read from. */
const N_DEFAULT = 4, N_MIN = 2, N_MAX = 8;
/* Segments per corner. At the 36px radius the prompter uses this puts a vertex every ~2.6px, and no
 * chord leaves the true superellipse by more than ~0.02px — well inside one device pixel at any
 * scale factor, so the facets stay invisible.
 *
 * The deviation is the figure to check when changing either number, not the spacing. Both grow in
 * proportion to the radius at a fixed step count, but a 2.6px facet only reads as a facet if the
 * chord under it visibly misses the curve, and at this radius it misses by a fiftieth of a pixel. */
const STEPS = 24;

const px = (v) => (typeof v?.value === "number" ? v.value : parseFloat(String(v)) || 0);

/** One corner, swept as a superellipse quadrant from `t0` to `t1` about (cx, cy). */
function sweep(ctx, cx, cy, r, t0, t1, n) {
  for (let i = 0; i <= STEPS; i++) {
    const t = t0 + ((t1 - t0) * i) / STEPS;
    const c = Math.cos(t), s = Math.sin(t);
    ctx.lineTo(cx + r * Math.sign(c) * Math.abs(c) ** (2 / n), cy + r * Math.sign(s) * Math.abs(s) ** (2 / n));
  }
}

function trace(ctx, w, h, rTop, rBot, n) {
  ctx.beginPath();
  ctx.moveTo(rTop, 0);
  ctx.lineTo(w - rTop, 0);
  sweep(ctx, w - rTop, rTop, rTop, -Math.PI / 2, 0, n);
  ctx.lineTo(w, h - rBot);
  sweep(ctx, w - rBot, h - rBot, rBot, 0, Math.PI / 2, n);
  ctx.lineTo(rBot, h);
  sweep(ctx, rBot, h - rBot, rBot, Math.PI / 2, Math.PI, n);
  ctx.lineTo(0, rTop);
  sweep(ctx, rTop, rTop, rTop, Math.PI, (3 * Math.PI) / 2, n);
  ctx.closePath();
}

registerPaint(
  "rl-squircle",
  class {
    static get inputProperties() {
      return ["--sq-fill", "--sq-ring", "--sq-ring-w", "--sq-radius-top", "--sq-radius-bottom", "--sq-n"];
    }

    paint(ctx, size, props) {
      const { width: w, height: h } = size;
      if (w <= 0 || h <= 0) return;
      /* Radii that overrun a side are scaled back together, the way `border-radius` itself does it:
       * the two corners on a side may not sum past that side, and the same factor goes on both so
       * their proportion survives. That is a weaker cap than "half the box" for a surface with one
       * square edge — the prompter's under-strip zeroes its top and so may run its bottom corners
       * the full 36px on a 54px strip, which is exactly what its `border-radius` fallback draws.
       * Under the old cap the two disagreed, and the worklet's answer was the smaller one. */
      let rTop = Math.max(0, px(props.get("--sq-radius-top")));
      let rBot = Math.max(0, px(props.get("--sq-radius-bottom")));
      const f = Math.min(1,
        rTop + rBot > 0 ? h / (rTop + rBot) : 1,
        rTop > 0 ? w / (2 * rTop) : 1,
        rBot > 0 ? w / (2 * rBot) : 1);
      rTop *= f;
      rBot *= f;
      const n = Math.min(N_MAX, Math.max(N_MIN, px(props.get("--sq-n")) || N_DEFAULT));
      trace(ctx, w, h, rTop, rBot, n);

      const fill = String(props.get("--sq-fill")).trim();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }

      const ringW = px(props.get("--sq-ring-w"));
      const ring = String(props.get("--sq-ring")).trim();
      if (ringW > 0 && ring) {
        /* Clip first, then stroke at double width: a stroke straddles its path, and the outer half
         * would be cut off by the background painting area anyway. This lands the whole ring just
         * inside the curve, at the width asked for, with no second edge. */
        ctx.save();
        ctx.clip();
        ctx.lineWidth = ringW * 2;
        ctx.strokeStyle = ring;
        ctx.stroke();
        ctx.restore();
      }
    }
  },
);
