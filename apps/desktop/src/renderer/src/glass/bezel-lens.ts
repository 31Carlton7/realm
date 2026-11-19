/**
 * The lens a glass surface wears, drawn for its own size: a displacement map of a convex bezel round a
 * rounded rect. Inside the bezel the backdrop is sampled from further in, most at the rim and none at
 * the bezel's inner edge, which is how a thick pane of glass with a rounded edge bends what is behind
 * it (macOS 26's controls, measured beside ours in the PR). Past the bezel the glass is flat and bends
 * nothing, so a panel of rows reads its rows where they are.
 *
 * One map serves one size. A map stretched from another box's shape thickens the rim on a long box and
 * thins it on a short one, which is why the shared lens of #498 bent nearly nothing on a picker: its
 * band was a share of a 620 × 480 box, laid over boxes of every other shape.
 */

export type BezelShape = {
  /** The box, in CSS px. */
  width: number;
  height: number;
  /** Its corner, in CSS px. */
  radius: number;
  /** The corner's superellipse exponent: 2 is a circle, a control's chosen segment is `--sq-n-ctl`. A
   *  bend traced on a circle under a squircle's edge lifts off the rim at every corner. */
  n?: number;
  /** How far in from the rim the glass curves, in CSS px. */
  bezel: number;
};

/** The bend at a point `s` of the way across the bezel (0 at the rim, 1 at its inner edge): steep at
 *  the rim and flat where the bezel meets the face, the slope of a convex edge. */
export const bendAt = (s: number) => (s >= 1 ? 0 : (1 - s) ** 2);

/**
 * The map as RGBA, `cols` × `rows`, laid over the box: red is the x offset and green the y, 128 for
 * none. The offset points inward along the rim's normal, so the corners bend toward their centre.
 */
export function bezelField(shape: BezelShape, cols: number, rows: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(cols * rows * 4);
  const halfW = shape.width / 2;
  const halfH = shape.height / 2;
  const radius = Math.max(0, Math.min(shape.radius, halfW, halfH));
  const bezel = Math.max(1, Math.min(shape.bezel, halfW, halfH));
  const n = shape.n ?? 2;
  const stepX = shape.width / cols;
  const stepY = shape.height / rows;
  for (let row = 0; row < rows; row++) {
    const y = (row + 0.5) * stepY - halfH;
    for (let col = 0; col < cols; col++) {
      const x = (col + 0.5) * stepX - halfW;
      // Distance in from the rounded rect's edge, and the edge's outward normal there. In a corner the
      // superellipse's own norm stands in for the distance, which is exact on both axes and a circle's
      // at n = 2, and the normal is its gradient.
      const qx = Math.abs(x) - (halfW - radius);
      const qy = Math.abs(y) - (halfH - radius);
      let inside: number, nx: number, ny: number;
      if (qx > 0 && qy > 0) {
        inside = radius - (qx ** n + qy ** n) ** (1 / n);
        const gx = qx ** (n - 1), gy = qy ** (n - 1), len = Math.hypot(gx, gy);
        nx = gx / len; ny = gy / len;
      } else if (qx > qy) {
        inside = radius - qx; nx = 1; ny = 0;
      } else {
        inside = radius - qy; nx = 0; ny = 1;
      }
      const m = inside < 0 ? 0 : bendAt(inside / bezel);
      const i = (row * cols + col) * 4;
      data[i] = Math.round(128 - 127 * m * nx * Math.sign(x));
      data[i + 1] = Math.round(128 - 127 * m * ny * Math.sign(y));
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  return data;
}

/** The map drawn at half the box's CSS size (the bend is smooth, and feImage scales it back up), as a
 *  data URL, or null where no canvas can be had. */
export function bezelMap(shape: BezelShape): string | null {
  const cols = Math.max(2, Math.ceil(shape.width / 2));
  const rows = Math.max(2, Math.ceil(shape.height / 2));
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const image = ctx.createImageData(cols, rows);
  image.data.set(bezelField(shape, cols, rows));
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}
