/**
 * The backdrop material of @samasante/liquid-glass 0.1.1 (MIT, Sam Asante; LICENSE-samasante-liquid-glass
 * beside this file), cut down to what the prompter uses: its displacement map (`createLensMapGenerator`
 * in the package's dist/index.js) and the single-pass filter graph of `MaterialFilterContents`.
 *
 * Left out on purpose: the sheen, glow and specular channel (a lit rim reads as a slab, design.md), the
 * colour split (three displacement passes for a fringe nobody asked for), the dome and splay terms, the
 * WebGL copy mode, the package's frost (Realm's is a token, tokens.css `--glass-frost`), and its React
 * components and user-agent sniff. Realm's tuning is `OPTICS`; the package's own material defaults are
 * noted beside each value.
 */
import type { FilterPrimitive, GlassLens, LensShape } from "../lens";

const OPTICS = {
  /** Bend as a share of the box's diagonal. The package's material default: at 0.035 the bend over a
   *  picture measured under one level in 255 off the rim. */
  strength: 0.05,
  /** Width of the band that bends, as a share of the half height. Package 0.5. */
  depth: 0.5,
  /** Extra bend right at the rim. Package 0.45. */
  bend: 0.25,
  bendWidth: 0.16,
};

/** The map's resolution. It is drawn in one quadrant and mirrored, so it must be even. */
const MAP_SIZE = 512;

const erf = (x: number) => Math.tanh(Math.sqrt(Math.PI) * x);
const encodeAxis = (signed: number) => ((0.5 + signed) * 255 + 0.5) | 0;
const cornerDistance = (ox: number, oy: number) => (ox > 0 || oy > 0 ? Math.sqrt(ox * ox + oy * oy) : 0);

/** Signed distance from a rounded rect's edge given the point's offset past the corner centre. */
const roundedSdf = (edgeX: number, edgeY: number, radius: number) =>
  cornerDistance(Math.max(edgeX, 0), Math.max(edgeY, 0)) + Math.min(Math.max(edgeX, edgeY), 0) - radius;

/** The displacement map for a box of this shape, as a data URL, `size` px square (even). */
export function drawMap(shape: LensShape, size = MAP_SIZE): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const halfW = shape.width / 2;
  const halfH = shape.height / 2;
  const minHalf = Math.min(halfW, halfH);
  const radius = Math.min(shape.radius, minHalf);
  const depthPx = Math.min(OPTICS.depth * minHalf, minHalf - 1);
  const innerHalfW = Math.max(0, halfW - depthPx);
  const innerHalfH = Math.max(0, halfH - depthPx);
  const innerRadius = Math.max(0, Math.min(shape.radius, innerHalfW, innerHalfH));
  const falloff = depthPx > 0 ? Math.SQRT1_2 / depthPx : 1e6;
  const rimInv = 1 / Math.max(2, OPTICS.bendWidth * minHalf);
  const stepX = (2 * halfW) / size;
  const stepY = (2 * halfH) / size;
  const half = size >> 1;
  const put = (i: number, r: number, g: number) => { data[i] = r; data[i + 1] = g; data[i + 2] = 128; data[i + 3] = 255; };

  for (let row = 0; row < half; row++) {
    const py = halfH - (row + 0.5) * stepY;
    const dirY = Math.min(1, py / halfH);
    for (let col = 0; col < half; col++) {
      const px = halfW - (col + 0.5) * stepX;
      const dirX = Math.min(1, px / halfW);
      const sdf = roundedSdf(px - halfW + radius, py - halfH + radius, radius);
      const quads = [(row * size + col) * 4, (row * size + size - 1 - col) * 4,
        ((size - 1 - row) * size + col) * 4, ((size - 1 - row) * size + size - 1 - col) * 4] as const;
      if (sdf >= 0) { for (const i of quads) put(i, 128, 128); continue; }
      const innerSdf = roundedSdf(px - innerHalfW + innerRadius, py - innerHalfH + innerRadius, innerRadius);
      const edge = 0.5 * (1 + erf(innerSdf * falloff));
      let dx = 0.5 * dirX * edge;
      let dy = 0.5 * dirY * edge;
      const s = Math.max(0, 1 + sdf * rimInv);
      const len = Math.hypot(dirX, dirY);
      if (s > 0 && len > 1e-4) {
        const a = (0.5 * OPTICS.bend * 6.75 * s * s * (1 - s) * edge) / len;
        dx += dirX * a;
        dy += dirY * a;
      }
      put(quads[0], encodeAxis(dx), encodeAxis(dy));
      put(quads[1], encodeAxis(-dx), encodeAxis(dy));
      put(quads[2], encodeAxis(dx), encodeAxis(-dy));
      put(quads[3], encodeAxis(-dx), encodeAxis(-dy));
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

export const samasanteLens: GlassLens = {
  name: "@samasante/liquid-glass 0.1.1",
  primitives(shape): FilterPrimitive[] | null {
    const map = drawMap(shape);
    if (!map) return null;
    const scale = OPTICS.strength * Math.sqrt((shape.width ** 2 + shape.height ** 2) / 2);
    return [
      { tag: "feFlood", props: { floodColor: "rgb(128,128,128)", floodOpacity: 1, result: "mapBg" } },
      { tag: "feImage", props: { href: map, x: 0, y: 0, width: shape.width, height: shape.height, preserveAspectRatio: "none", result: "rawMap" } },
      { tag: "feComposite", props: { in: "rawMap", in2: "mapBg", operator: "over", result: "map" } },
      { tag: "feDisplacementMap", props: { in: "SourceGraphic", in2: "map", scale, xChannelSelector: "R", yChannelSelector: "G" } },
    ];
  },
};
