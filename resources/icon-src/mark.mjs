// Realm's mark: a cube lying on its side — the flat-topped hexagon Realm has worn since its first icon —
// with a lit doorway in its dark wall. A space, and the way into it.
//
// The source of every drawing of the mark: mark.svg and mark-flat.svg beside this file, the renderer's
// realm-mark.svg, the boot mark inline in the renderer's index.html, and the mark on every app icon
// (icons.mjs). render.mjs writes all of them from here.
//
// Every line is on the cube's own lattice — its edges, and fractions along them — which is what keeps
// the facets crisp. The cube is three faces: a light top, a mid left wall and a dark right wall. The
// doorway is cut into the dark wall, and through it you see what an opening in a solid shows: its lit
// back, its floor and one jamb, each in the tone of the face it is parallel to. The lit back is the
// mark's one negative-space facet. Cursor's mark is a cube too, stood on a corner with an arrow cut
// from its top; this one lies on an edge and is cut with a door, so the two read apart at any size.
//
// The flat mark is the silhouette with the doorway knocked out, for sizes where three tones would
// blur into one.

/** The old mark's box, so everything that sizes the mark at 40 × 48 keeps its layout. */
export const MARK_BOX = { width: 40, height: 48 };
/** A flat-topped hexagon of radius 20 — 40 across, 34.6 tall — centred in the box. */
const R = 20;
const CENTRE = [20, 24];
/** The silhouette's corners, softly rounded; the facets inside stay sharp. */
const CORNER = 1.8;
/** The doorway, in the wall's own terms: across it from 0 (the front edge) to 1, down it from 0 (the
 *  top) to 1 (the floor), and how deep it goes into the cube. It stops short of the floor, so the
 *  wall runs unbroken along the hexagon's edge. */
export const DOOR = { across: [0.31, 0.69], down: [0.13, 0.9], depth: 0.13 };

/** The corners: V0 right, then anticlockwise on screen — V1 upper right, V2 upper left, V3 left,
 *  V4 lower left, V5 lower right. */
const V = [0, 1, 2, 3, 4, 5].map((i) => [CENTRE[0] + R * Math.cos((-i * Math.PI) / 3), CENTRE[1] + R * Math.sin((-i * Math.PI) / 3)]);
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];

/**
 * A point of the cube. Its near corner is the centre and its three edges run to V1 (u), V3 (v) and
 * V5 (w, which is down): C + a·u + b·v + c·w. The top is c = 0, the right wall b = 0 and the left wall
 * a = 0, so a point `b` deep into the right wall is drawn at (a - b, c - b) on it — that is the whole
 * of the doorway's perspective.
 */
const U = sub(V[1], CENTRE), VV = sub(V[3], CENTRE), W = sub(V[5], CENTRE);
const P = (a, b, c) => add(add(add(CENTRE, mul(U, a)), mul(VV, b)), mul(W, c));

const fixed = (n) => (Math.abs(n) < 5e-7 ? "0" : n.toFixed(4).replace(/\.?0+$/, ""));
const point = (p) => `${fixed(p[0])} ${fixed(p[1])}`;
/** A closed polygon. */
export const polygon = (pts) => `M${pts.map(point).join("L")}Z`;

/** A convex polygon with every corner rounded to `r`. */
function roundedPolygon(pts, r) {
  return pts.map((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length];
    const ua = sub(a, p), ub = sub(b, p);
    const la = Math.hypot(...ua), lb = Math.hypot(...ub);
    const half = Math.acos((ua[0] * ub[0] + ua[1] * ub[1]) / (la * lb)) / 2;
    const t = r / Math.tan(half);
    return `${i === 0 ? "M" : "L"}${point(add(p, mul(ua, t / la)))}A${r} ${r} 0 0 1 ${point(add(p, mul(ub, t / lb)))}`;
  }).join("") + "Z";
}

const [a0, a1] = DOOR.across, [c0, c1] = DOOR.down, d = DOOR.depth;

/** The mark's parts, in the box's units. Faces and doorway parts are sharp polygons; they are drawn
 *  inside the silhouette, and the doorway's parts inside its front. */
export const MARK = {
  silhouette: roundedPolygon([V[3], V[2], V[1], V[0], V[5], V[4]], CORNER),
  top: [CENTRE, V[3], V[2], V[1]],
  right: [CENTRE, V[1], V[0], V[5]],
  left: [CENTRE, V[5], V[4], V[3]],
  /** The doorway as cut in the wall's face. */
  front: [P(a0, 0, c0), P(a1, 0, c0), P(a1, 0, c1), P(a0, 0, c1)],
  /** Its back, `depth` in: lit. Seen only through the front, which the drawing clips it to. */
  lit: [P(a0, d, c0), P(a1, d, c0), P(a1, d, c1), P(a0, d, c1)],
  /** The jamb on the far side faces the way the left wall does, and the floor faces up, so each
   *  takes that face's tone. */
  jamb: [P(a1, 0, c0), P(a1, d, c0), P(a1, d, c1), P(a1, 0, c1)],
  floor: [P(a0, 0, c1), P(a1, 0, c1), P(a1, d, c1), P(a0, d, c1)],
};

const mid = (p, q) => mul(add(p, q), 0.5);
/** Each face's gradient runs the way one soft light from above falls on a matte cube: the top from its
 *  far corner to its near one, each wall from its top edge down to its floor. */
const VECTORS = {
  top: [V[2], CENTRE], left: [mid(V[3], CENTRE), mid(V[4], V[5])], right: [mid(CENTRE, V[1]), mid(V[5], V[0])],
  lit: [P(a0, d, c0), P(a0, d, c1)], jamb: [P(a1, 0, c0), P(a1, 0, c1)], floor: [P(a0, d, c1), P(a1, 0, c1)],
};

/** The mark's own tones, for every drawing of it that is not an app icon. */
export const MARK_TONES = {
  top: ["#f4f5f7", "#e3e5e8"],
  left: ["#b4b8be", "#9ea2a9"],
  right: ["#6c7078", "#575b63"],
  lit: ["#ffffff", "#f1f2f4"],
};

/** What each part is drawn in: a face its own tones, a doorway part the tones of the face it is
 *  parallel to, at their darker end because it is in the opening's shade. */
function partTones(tones) {
  return {
    top: tones.top, left: tones.left, right: tones.right, lit: tones.lit,
    jamb: [tones.left[1], tones.left[1]], floor: [tones.top[1], tones.top[1]],
  };
}

const stops = (colors) => colors.map((c, i) => `<stop offset="${colors.length === 1 ? 0 : i / (colors.length - 1)}" stop-color="${c}"/>`).join("");

/**
 * The shaded mark as SVG elements in the box's units, one per line: `defs` to put in the document's
 * <defs>, and `body` to draw, indented as it nests. Ids carry `prefix`, so the mark can sit in a
 * document beside another copy of itself.
 */
export function markLayer(tones, prefix) {
  const t = partTones(tones);
  const id = (k) => `${prefix}${k}`;
  const defs = [
    ...Object.entries(VECTORS).map(([k, [p, q]]) =>
      `<linearGradient id="${id(k)}" x1="${fixed(p[0])}" y1="${fixed(p[1])}" x2="${fixed(q[0])}" y2="${fixed(q[1])}" gradientUnits="userSpaceOnUse">${stops(t[k])}</linearGradient>`),
    `<clipPath id="${id("silhouette")}"><path d="${MARK.silhouette}"/></clipPath>`,
    `<clipPath id="${id("front")}"><path d="${polygon(MARK.front)}"/></clipPath>`,
  ];
  const fill = (k) => `<path fill="url(#${id(k)})" d="${polygon(MARK[k])}"/>`;
  const body = [
    `<g clip-path="url(#${id("silhouette")})">`,
    ...["top", "left", "right"].map((k) => `  ${fill(k)}`),
    `  <g clip-path="url(#${id("front")})">`,
    ...["lit", "jamb", "floor"].map((k) => `    ${fill(k)}`),
    "  </g>",
    "</g>",
  ];
  return { defs, body };
}

/** The shaded mark as a document of its own. */
export function markSvg(tones = MARK_TONES, prefix = "realm-") {
  const { defs, body } = markLayer(tones, prefix);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MARK_BOX.width}" height="${MARK_BOX.height}" viewBox="0 0 ${MARK_BOX.width} ${MARK_BOX.height}" fill="none">`,
    "  <defs>", ...defs.map((l) => `    ${l}`), "  </defs>",
    ...body.map((l) => `  ${l}`),
    "</svg>",
    "",
  ].join("\n");
}

/** The flat mark: one ink, the doorway knocked out. `currentColor` takes the colour of the text it
 *  sits beside. */
export function flatMarkSvg(ink = "currentColor") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${MARK_BOX.width}" height="${MARK_BOX.height}" viewBox="0 0 ${MARK_BOX.width} ${MARK_BOX.height}" fill="none">
<path fill="${ink}" fill-rule="evenodd" d="${MARK.silhouette}${polygon(MARK.front)}"/>
</svg>
`;
}
