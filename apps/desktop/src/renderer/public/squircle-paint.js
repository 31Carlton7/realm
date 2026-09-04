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
 * than as a shape of its own. */
const N = 4;
/* Segments per corner. At the 20px radius the prompter uses this puts a vertex every ~1.3px, which
 * is under the point a retina display can resolve a facet at. */
const STEPS = 24;

const px = (v) => (typeof v?.value === "number" ? v.value : parseFloat(String(v)) || 0);

/** One corner, swept as a superellipse quadrant from `t0` to `t1` about (cx, cy). */
function sweep(ctx, cx, cy, r, t0, t1) {
  for (let i = 0; i <= STEPS; i++) {
    const t = t0 + ((t1 - t0) * i) / STEPS;
    const c = Math.cos(t), s = Math.sin(t);
    ctx.lineTo(cx + r * Math.sign(c) * Math.abs(c) ** (2 / N), cy + r * Math.sign(s) * Math.abs(s) ** (2 / N));
  }
}

function trace(ctx, w, h, rTop, rBot) {
  ctx.beginPath();
  ctx.moveTo(rTop, 0);
  ctx.lineTo(w - rTop, 0);
  sweep(ctx, w - rTop, rTop, rTop, -Math.PI / 2, 0);
  ctx.lineTo(w, h - rBot);
  sweep(ctx, w - rBot, h - rBot, rBot, 0, Math.PI / 2);
  ctx.lineTo(rBot, h);
  sweep(ctx, rBot, h - rBot, rBot, Math.PI / 2, Math.PI);
  ctx.lineTo(0, rTop);
  sweep(ctx, rTop, rTop, rTop, Math.PI, (3 * Math.PI) / 2);
  ctx.closePath();
}

registerPaint(
  "rl-squircle",
  class {
    static get inputProperties() {
      return ["--sq-fill", "--sq-ring", "--sq-ring-w", "--sq-radius-top", "--sq-radius-bottom"];
    }

    paint(ctx, size, props) {
      const { width: w, height: h } = size;
      if (w <= 0 || h <= 0) return;
      /* A radius past half the box turns the superellipse inside out at the midpoint. */
      const cap = Math.min(w, h) / 2;
      const rTop = Math.min(px(props.get("--sq-radius-top")), cap);
      const rBot = Math.min(px(props.get("--sq-radius-bottom")), cap);
      trace(ctx, w, h, rTop, rBot);

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
