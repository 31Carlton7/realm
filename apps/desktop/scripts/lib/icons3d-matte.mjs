/**
 * The pixel work behind `scripts/icons3d.mjs`: lift a render off its white ground, trim it, square
 * it, and scale it down. Plain functions over straight-alpha RGBA (`{ width, height, data }`), so the
 * script can run them on what a canvas decoded and the tests can run them on a picture built in code.
 *
 * Why not "colour to alpha" over the whole picture: that makes every light part of the object as
 * see-through as it is pale, so a cream card would come out half-transparent. The ground is found
 * as REGIONS instead — near-white areas that touch the border, or are big enough to be a hole
 * through the object (the gap under a handle) — and only the band of pixels where the object's edge
 * was blended into the white is unblended. That band, left as it was rendered, is the white fringe
 * an icon cut this way shows on a dark page.
 */

/** Per-channel median of the outermost ring of pixels: the ground the render was drawn on. */
export function groundOf(img) {
  const { width: w, height: h, data } = img;
  const ring = [[], [], []];
  const take = (x, y) => { const i = (y * w + x) * 4; for (let c = 0; c < 3; c++) ring[c].push(data[i + c]); };
  for (let x = 0; x < w; x++) { take(x, 0); take(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { take(0, y); take(w - 1, y); }
  return ring.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
}

const distance = (data, i, ground) =>
  Math.max(Math.abs(data[i] - ground[0]), Math.abs(data[i + 1] - ground[1]), Math.abs(data[i + 2] - ground[2]));

/**
 * How far from the ground a pixel may be and still be ground: the noise the border itself shows,
 * plus a margin, never under 8. A clean #FFFFFF render gets 8, which keeps a cream highlight (about
 * 12 off white) on the object.
 */
export function groundTolerance(img, ground = groundOf(img)) {
  const { width: w, height: h, data } = img;
  const spread = [];
  for (let x = 0; x < w; x++) spread.push(distance(data, x * 4, ground), distance(data, ((h - 1) * w + x) * 4, ground));
  for (let y = 0; y < h; y++) spread.push(distance(data, y * w * 4, ground), distance(data, (y * w + w - 1) * 4, ground));
  spread.sort((a, b) => a - b);
  return Math.max(8, spread[Math.floor(spread.length * 0.99)] + 6);
}

/**
 * Which pixels are ground: 1 for ground, 0 for the object. A near-white region is ground when it
 * touches the border or covers at least `minHole` of the picture; a smaller one enclosed by the
 * object (a specular highlight) stays part of it.
 */
export function groundMask(img, { ground = groundOf(img), tolerance = groundTolerance(img, ground), minHole = 0.0005 } = {}) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const near = new Uint8Array(n);
  for (let p = 0; p < n; p++) near[p] = distance(data, p * 4, ground) <= tolerance ? 1 : 0;
  const mask = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  const holeArea = Math.max(1, Math.round(n * minHole));
  for (let start = 0; start < n; start++) {
    if (!near[start] || seen[start]) continue;
    let head = 0, tail = 0, onBorder = false;
    queue[tail++] = start; seen[start] = 1;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) onBorder = true;
      if (x > 0 && near[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; queue[tail++] = p - 1; }
      if (x < w - 1 && near[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; queue[tail++] = p + 1; }
      if (y > 0 && near[p - w] && !seen[p - w]) { seen[p - w] = 1; queue[tail++] = p - w; }
      if (y < h - 1 && near[p + w] && !seen[p + w]) { seen[p + w] = 1; queue[tail++] = p + w; }
    }
    if (onBorder || tail >= holeArea) for (let k = 0; k < tail; k++) mask[queue[k]] = 1;
  }
  return mask;
}

/** The least alpha that explains `c` as some colour laid over `ground` (the classic colour-to-alpha). */
function leastAlpha(c, ground) {
  let a = 0;
  for (let k = 0; k < 3; k++) {
    const g = ground[k];
    const step = c[k] < g ? (g - c[k]) / g : c[k] > g ? (c[k] - g) / (255 - g || 1) : 0;
    if (step > a) a = step;
  }
  return Math.min(1, a);
}

/**
 * The render with its ground taken out: straight-alpha RGBA of the same size. Ground goes clear
 * (its faint pixels keep the little alpha they explain), the object's inside stays opaque, and the
 * `band` pixels nearest the ground are unblended against the colour of the object just inside them.
 */
export function cutFromGround(img, { band = 2, reach = 6, ...opts } = {}) {
  const { width: w, height: h, data } = img;
  const ground = opts.ground ?? groundOf(img);
  const mask = groundMask(img, { ...opts, ground });
  const n = w * h;
  // Distance (in steps, up to band + reach) from each object pixel to the nearest ground pixel.
  const far = band + reach + 1;
  const depth = new Uint8Array(n).fill(far);
  for (let p = 0; p < n; p++) if (mask[p]) depth[p] = 0;
  for (let step = 1; step < far; step++) {
    for (let p = 0; p < n; p++) {
      if (depth[p] !== far) continue;
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const q = (y + dy) * w + (x + dx);
        if (x + dx >= 0 && x + dx < w && y + dy >= 0 && y + dy < h && depth[q] === step - 1) { depth[p] = step; dy = dx = 2; }
      }
    }
  }
  const out = new Uint8ClampedArray(n * 4);
  const c = [0, 0, 0];
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    c[0] = data[i]; c[1] = data[i + 1]; c[2] = data[i + 2];
    if (mask[p]) {
      const a = leastAlpha(c, ground);
      if (a * 255 < 1) continue;
      for (let k = 0; k < 3; k++) out[i + k] = (c[k] - (1 - a) * ground[k]) / a;
      out[i + 3] = a * 255;
      continue;
    }
    if (depth[p] > band) { out.set(data.subarray(i, i + 3), i); out[i + 3] = 255; continue; }
    const inner = innerColour(data, depth, w, h, p, band, reach);
    let a;
    if (inner) {
      // Project the pixel onto the line from the ground to the object's own colour.
      let num = 0, den = 0;
      for (let k = 0; k < 3; k++) { const d = ground[k] - inner[k]; num += (ground[k] - c[k]) * d; den += d * d; }
      a = den < 100 ? 1 : Math.min(1, Math.max(0, num / den));
    } else a = leastAlpha(c, ground);
    if (a > 0.98) a = 1;
    if (a * 255 < 1) continue;
    for (let k = 0; k < 3; k++) {
      const unblended = (c[k] - (1 - a) * ground[k]) / a;
      // At low coverage the unblended colour is mostly noise; the colour just inside is the truth.
      out[i + k] = inner && a < 0.25 ? inner[k] : unblended;
    }
    out[i + 3] = a * 255;
  }
  return { width: w, height: h, data: out };
}

/** The mean colour of the object's settled inside (deeper than the band) nearest to pixel `p`. */
function innerColour(data, depth, w, h, p, band, reach) {
  const x0 = p % w, y0 = (p / w) | 0;
  for (let r = 1; r <= band + reach; r++) {
    let n = 0;
    const sum = [0, 0, 0];
    for (let y = Math.max(0, y0 - r); y <= Math.min(h - 1, y0 + r); y++) {
      for (let x = Math.max(0, x0 - r); x <= Math.min(w - 1, x0 + r); x++) {
        const q = y * w + x;
        if (depth[q] <= band) continue;
        const i = q * 4;
        sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; n++;
      }
    }
    if (n) return sum.map((s) => s / n);
  }
  return null;
}

/** The smallest box holding every pixel at least `floor` opaque (0–255), or null for an empty picture. */
export function opaqueBounds(img, floor = 4) {
  const { width: w, height: h, data } = img;
  let left = w, top = h, right = -1, bottom = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] < floor) continue;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  return right < 0 ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * The object on a clear square, trimmed to its pixels and centred, with `pad` of the square's side
 * left clear on every edge — room for the tilt and the bounce the app gives it, which scale it past
 * its box.
 */
export function squareAround(img, { pad = 0.06, floor = 4 } = {}) {
  const box = opaqueBounds(img, floor);
  if (!box) throw new Error("nothing left after the ground was taken out");
  const side = Math.ceil(Math.max(box.width, box.height) / (1 - 2 * pad));
  const out = new Uint8ClampedArray(side * side * 4);
  const ox = Math.floor((side - box.width) / 2), oy = Math.floor((side - box.height) / 2);
  for (let y = 0; y < box.height; y++) {
    const from = ((box.top + y) * img.width + box.left) * 4;
    out.set(img.data.subarray(from, from + box.width * 4), ((oy + y) * side + ox) * 4);
  }
  return { width: side, height: side, data: out };
}

/** For each output pixel along one axis, the source pixels it covers and by how much. */
function coverage(from, to) {
  const scale = from / to;
  const taps = [];
  for (let o = 0; o < to; o++) {
    const a = o * scale, b = a + scale;
    const row = [];
    for (let i = Math.floor(a); i < Math.min(from, Math.ceil(b)); i++) {
      const wgt = Math.min(b, i + 1) - Math.max(a, i);
      if (wgt > 0) row.push([i, wgt / scale]);
    }
    taps.push(row);
  }
  return taps;
}

/**
 * A square picture scaled down to `size` × `size` by averaging the area each output pixel covers,
 * in premultiplied alpha. Straight alpha averaged as it is would pull the clear ground's colour
 * (black, here) into every edge pixel, which is a dark rim on a light page.
 */
export function shrink(img, size) {
  const { width: w, height: h, data } = img;
  const pre = new Float64Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const a = data[p * 4 + 3] / 255;
    pre[p * 4] = data[p * 4] * a; pre[p * 4 + 1] = data[p * 4 + 1] * a; pre[p * 4 + 2] = data[p * 4 + 2] * a; pre[p * 4 + 3] = a;
  }
  const across = coverage(w, size), down = coverage(h, size);
  const rows = new Float64Array(size * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < size; x++) {
    for (const [sx, wgt] of across[x]) for (let k = 0; k < 4; k++) rows[(y * size + x) * 4 + k] += pre[(y * w + sx) * 4 + k] * wgt;
  }
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const acc = [0, 0, 0, 0];
    for (const [sy, wgt] of down[y]) for (let k = 0; k < 4; k++) acc[k] += rows[(sy * size + x) * 4 + k] * wgt;
    const i = (y * size + x) * 4;
    if (acc[3] <= 0) continue;
    out[i] = Math.round(acc[0] / acc[3]); out[i + 1] = Math.round(acc[1] / acc[3]); out[i + 2] = Math.round(acc[2] / acc[3]);
    out[i + 3] = Math.round(acc[3] * 255);
  }
  return { width: size, height: size, data: out };
}
