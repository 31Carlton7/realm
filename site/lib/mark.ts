/**
 * Realm's mark as geometry: the cube lying on its side with a lit doorway in its dark wall, in the
 * mark's own 40 × 48 box. Worked out here the way resources/icon-src/mark.mjs works it out — the same
 * hexagon, the same cube coordinates, the same doorway fractions — rather than copied as numbers, so
 * a change to the doorway there is a change of three constants here.
 *
 * The mark has six faces: the cube's top, its left wall and its dark right wall, and, seen through
 * the doorway cut in that wall, the opening's floor, its far jamb and its lit back. The walls are
 * clipped to the silhouette's rounded corners and the doorway's parts to the opening, as the SVG
 * clips them, so every polygon below is exactly what the drawing shows of that face.
 *
 * One copy, because design.md asks that anything drawing the mark derive it from the approved vector
 * rather than from geometry invented around it — and two copies is how one of them stops being it.
 */

type Point = readonly [number, number]
type Polygon = readonly Point[]

/** The middle of the box, which is the middle of the mark and the cube's near corner. */
export const MARK_CENTER: Point = [20, 24]
/** The hexagon's radius: 40 across, 34.64 tall. */
export const MARK_RADIUS = 20
/** The silhouette's corner radius; the facets inside it stay sharp. */
const CORNER = 1.8
/** The doorway, in the wall's own terms (mark.mjs's DOOR): across it from the front edge, down it
 *  from the top, and how deep it goes into the cube. */
const DOORWAY = { across: [0.31, 0.69], down: [0.13, 0.9], depth: 0.13 } as const

const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]]
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]]
const mul = (a: Point, k: number): Point => [a[0] * k, a[1] * k]
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0]

/** The corners: V0 right, then anticlockwise on screen — upper right, upper left, left, lower left,
 *  lower right. */
const V: Point[] = [0, 1, 2, 3, 4, 5].map((i) => [
  MARK_CENTER[0] + MARK_RADIUS * Math.cos((-i * Math.PI) / 3),
  MARK_CENTER[1] + MARK_RADIUS * Math.sin((-i * Math.PI) / 3),
])

/** A point of the cube: its near corner is the centre, and its edges run to V1, V3 and V5 (down).
 *  The right wall is b = 0, so a point `b` deep into it is drawn at (a - b, c - b) on it. */
const U = sub(V[1], MARK_CENTER)
const VV = sub(V[3], MARK_CENTER)
const W = sub(V[5], MARK_CENTER)
const P = (a: number, b: number, c: number): Point =>
  add(add(add(MARK_CENTER, mul(U, a)), mul(VV, b)), mul(W, c))

/** The silhouette with each corner rounded to CORNER, its arcs sampled finely enough that the
 *  polygon cannot be told from the curve at any size the page draws it. */
function roundedSilhouette(): Polygon {
  const corners = [V[3], V[2], V[1], V[0], V[5], V[4]]
  const out: Point[] = []
  corners.forEach((p, i) => {
    const a = corners[(i + corners.length - 1) % corners.length]
    const b = corners[(i + 1) % corners.length]
    const ua = sub(a, p)
    const ub = sub(b, p)
    const la = Math.hypot(...ua)
    const lb = Math.hypot(...ub)
    const half = Math.acos((ua[0] * ub[0] + ua[1] * ub[1]) / (la * lb)) / 2
    const t = CORNER / Math.tan(half)
    const from = add(p, mul(ua, t / la))
    const to = add(p, mul(ub, t / lb))
    // The arc's centre sits on the corner's bisector, CORNER from both edges.
    const bisector = mul(add(mul(ua, 1 / la), mul(ub, 1 / lb)), 1 / Math.hypot(...add(mul(ua, 1 / la), mul(ub, 1 / lb))))
    const centre = add(p, mul(bisector, CORNER / Math.sin(half)))
    const start = Math.atan2(from[1] - centre[1], from[0] - centre[0])
    let end = Math.atan2(to[1] - centre[1], to[0] - centre[0])
    if (end < start) end += Math.PI * 2
    const steps = 6
    for (let s = 0; s <= steps; s++) {
      const angle = start + ((end - start) * s) / steps
      out.push([centre[0] + Math.cos(angle) * CORNER, centre[1] + Math.sin(angle) * CORNER])
    }
  })
  return out
}

/** Sutherland–Hodgman: what of `subject` lies inside the convex polygon `clip`. */
function clipTo(subject: Polygon, clip: Polygon): Polygon {
  const area = clip.reduce((sum, p, i) => sum + cross(p, clip[(i + 1) % clip.length]), 0)
  const inside = (p: Point, a: Point, b: Point) => Math.sign(area) * cross(sub(b, a), sub(p, a)) >= -1e-9
  const meet = (p: Point, q: Point, a: Point, b: Point): Point => {
    const r = sub(q, p)
    const s = sub(b, a)
    return add(p, mul(r, cross(sub(a, p), s) / cross(r, s)))
  }
  let out: Point[] = [...subject]
  clip.forEach((a, i) => {
    const b = clip[(i + 1) % clip.length]
    const input = out
    out = []
    input.forEach((p, j) => {
      const q = input[(j + 1) % input.length]
      if (inside(q, a, b)) {
        if (!inside(p, a, b)) out.push(meet(p, q, a, b))
        out.push(q)
      } else if (inside(p, a, b)) out.push(meet(p, q, a, b))
    })
  })
  // Points the clip left on top of one another would give an edge of zero length.
  return out
    .filter((p, i) => Math.hypot(...sub(p, out[(i + 1) % out.length])) > 1e-4)
    .map(([x, y]) => [Number(x.toFixed(3)), Number(y.toFixed(3))] as const)
}

const [a0, a1] = DOORWAY.across
const [c0, c1] = DOORWAY.down
const d = DOORWAY.depth
const silhouette = roundedSilhouette()

/** The doorway as it is cut in the right wall's face. */
export const DOOR: Polygon = [P(a0, 0, c0), P(a1, 0, c0), P(a1, 0, c1), P(a0, 0, c1)]

export type Face = {
  name: "top" | "left" | "right" | "floor" | "jamb" | "lit"
  /** What the drawing shows of the face. */
  polygon: Polygon
  /** A hole in it: the right wall has the doorway cut out of it. */
  cut?: Polygon
}

/**
 * The six faces, walls first and the doorway's parts after, which is also the order the landing
 * page assembles them in. The union of all six is the silhouette.
 */
export const FACES: readonly Face[] = [
  { name: "top", polygon: clipTo([MARK_CENTER, V[3], V[2], V[1]], silhouette) },
  { name: "left", polygon: clipTo([MARK_CENTER, V[5], V[4], V[3]], silhouette) },
  { name: "right", polygon: clipTo([MARK_CENTER, V[1], V[0], V[5]], silhouette), cut: DOOR },
  { name: "floor", polygon: clipTo([P(a0, 0, c1), P(a1, 0, c1), P(a1, d, c1), P(a0, d, c1)], DOOR) },
  { name: "jamb", polygon: clipTo([P(a1, 0, c0), P(a1, d, c0), P(a1, d, c1), P(a1, 0, c1)], DOOR) },
  { name: "lit", polygon: clipTo([P(a0, d, c0), P(a1, d, c0), P(a1, d, c1), P(a0, d, c1)], DOOR) },
]

/** The three walls alone: the flat mark is these with the doorway knocked out. */
export const WALLS: readonly Polygon[] = FACES.slice(0, 3).map((face) => face.polygon)
