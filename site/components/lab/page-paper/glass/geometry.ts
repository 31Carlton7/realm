import { DOOR, FACES, MARK_CENTER, MARK_RADIUS } from "@/lib/mark"

/**
 * The glass mark's solid, worked out from the approved vector (lib/mark.ts) rather than drawn around
 * it, as design.md asks of any glass presentation of the mark.
 *
 * The mark is a cube seen along its diagonal: its centre is the near corner, and its three walls run
 * back from there. Read as a relief, that drawing already says how far every point of the face is
 * from the eye, so the glass is that depth turned into height: a hexagonal block, thickest at the
 * near corner and sloping down each wall to the three far corners, with the doorway cut into its dark
 * wall. Everything below is in the mark's own units (its 40 × 48 box), centred on the mark, with x to
 * the right, y down the page and z up out of the paper.
 */

const [cx, cy] = MARK_CENTER

/** Where a point sits on the right wall, as (a, c): a along the wall's top edge, c down its front edge. */
const wallCoords = ([x, y]: readonly [number, number]) => {
  const u = (x - cx) / (MARK_RADIUS / 2)
  const v = (y - cy) / ((MARK_RADIUS * Math.sqrt(3)) / 2)
  return [(u - v) / 2, (u + v) / 2] as const
}

const door = DOOR.map(wallCoords)
/** The doorway in the wall's own terms: across it (a) and down it (c). */
export const DOOR_A = [Math.min(...door.map((p) => p[0])), Math.max(...door.map((p) => p[0]))] as const
export const DOOR_C = [Math.min(...door.map((p) => p[1])), Math.max(...door.map((p) => p[1]))] as const

/**
 * How deep the doorway goes into the cube. The lit back is the opening moved that far back, which on
 * the wall reads as a shift of the same amount in both a and c; its far edge gives the depth away.
 */
const lit = FACES.find((face) => face.name === "lit")!.polygon.map(wallCoords)
export const DOOR_DEPTH = DOOR_A[1] - Math.max(...lit.map((p) => p[0]))

/** The hexagon's radius and its apothem, in mark units. */
export const RADIUS = MARK_RADIUS
export const APOTHEM = (MARK_RADIUS * Math.sqrt(3)) / 2

const f = (n: number) => n.toFixed(6)

/** The block's proportions, in mark units (see the WGSL below for what each one is). */
export type Shape = { t0: number; k: number; pocket: number; rim: number; zp: number; taper: number; lift: number }
export const SHAPE: Shape = { t0: 5.5, k: 4.2, pocket: 1.7, rim: 2.1, zp: 3.0, taper: 0.78, lift: 0 }

/**
 * The solid, as WGSL both passes paste in: the silhouette's distance, the cube's depth and the
 * doorway's, the height they make, and the surface normal.
 */
export const geometryWgsl = (shape: Shape = SHAPE) => /* wgsl */ `
const APOTHEM = ${f(APOTHEM)};
// The silhouette's corners are rounded to this, as the mark's are.
const CORNER = 1.8;
const DOOR_A = vec2f(${f(DOOR_A[0])}, ${f(DOOR_A[1])});
const DOOR_C = vec2f(${f(DOOR_C[0])}, ${f(DOOR_C[1])});
const DOOR_D = ${f(DOOR_DEPTH)};

// The block: its thickness at the three far corners, and the height it gains for each unit of the
// cube's depth nearer the eye (so the near corner stands 2K above them).
const T0 = ${f(shape.t0)};
const K = ${f(shape.k)};
// The doorway is cut this many times deeper than the drawing's own depth, so it reads in glass.
const POCKET = ${f(shape.pocket)};
// The cube's three edges are rounded over about this many mark units, the doorway's inner edges over
// less, and the top edge of the block over RIM.
const RIDGE = 0.085;
const NOTCH = 0.025;
const RIM = ${f(shape.rim)};
// Under its girdle the block is cut in toward its base, as a paperweight's pavilion is: below ZP the
// walls slope in by TAPER for each unit down. It is what lets light out of the block into its own
// shadow; a vertical wall reflects everything back in.
const ZP = ${f(shape.zp)};
const TAPER = ${f(shape.taper)};
// How far the block's base stands off the paper (0: resting on it).
const LIFT = ${f(shape.lift)};

fn sdMark(p: vec2f) -> f32 {
  let k = vec3f(-0.866025404, 0.5, 0.577350269);
  var q = abs(p);
  q -= 2.0 * min(dot(k.xy, q), 0.0) * k.xy;
  let r = APOTHEM - CORNER;
  q -= vec2f(clamp(q.x, -k.z * r, k.z * r), r);
  return length(q) * sign(q.y) - CORNER;
}

// The outward normal of the silhouette at a point near its edge.
fn markNormal(p: vec2f) -> vec2f {
  let e = 0.02;
  let g = vec2f(sdMark(p + vec2f(e, 0.0)) - sdMark(p - vec2f(e, 0.0)), sdMark(p + vec2f(0.0, e)) - sdMark(p - vec2f(0.0, e)));
  return normalize(g + vec2f(1e-6, 0.0));
}

fn smax(a: f32, b: f32, r: f32) -> f32 {
  let h = max(r - abs(a - b), 0.0) / r;
  return max(a, b) + h * h * r * 0.25;
}

fn smin(a: f32, b: f32, r: f32) -> f32 {
  return -smax(-a, -b, r);
}

// Where p sits on the right wall, as (a, c).
fn wallCoords(p: vec2f) -> vec2f {
  let u = p.x / 10.0;
  let v = p.y / APOTHEM;
  return vec2f(u - v, u + v) * 0.5;
}

// The cube's depth seen along its diagonal: 0 at the near corner, 1 at V1, V3 and V5, 2 at V0, V2 and
// V4. The block is convex there, so its surface is the deepest of the three walls' planes, and a
// smooth maximum rounds the three edges where they meet.
fn cubeDepth(p: vec2f) -> f32 {
  let aTop = -p.y / APOTHEM;
  let top = aTop + (10.0 * aTop - p.x) / 20.0;
  let cLeft = p.y / APOTHEM;
  let left = cLeft + (10.0 * cLeft - p.x) / 20.0;
  let right = p.x / 10.0;
  return smax(smax(top, left, RIDGE), right, RIDGE);
}

// How much deeper the doorway is than the wall around it. The floor and the far jamb ramp down from
// the sill and the jamb's edge to the lit back; at the lintel and the near edge it drops straight in.
fn pocketDepth(p: vec2f) -> f32 {
  let w = wallCoords(p);
  let ramp = smin(DOOR_D, smin(DOOR_C.y - w.y, DOOR_A.y - w.x, NOTCH), NOTCH);
  let open = smoothstep(-0.006, 0.006, w.y - DOOR_C.x) * smoothstep(-0.006, 0.006, w.x - DOOR_A.x);
  return 3.0 * POCKET * max(ramp, 0.0) * open;
}

// The face's own relief, carried past the silhouette so a blur or a march near the edge has a surface.
fn relief(p: vec2f) -> f32 {
  return T0 + K * (2.0 - cubeDepth(p) - pocketDepth(p));
}

// The block's height: the relief, rolled over at its top edge, and nothing outside it.
fn heightAt(p: vec2f) -> f32 {
  let sd = sdMark(p);
  if (sd > 0.0) { return 0.0; }
  var h = relief(p);
  let inside = -sd;
  if (inside < RIM) {
    let t = RIM - inside;
    h -= RIM - sqrt(max(RIM * RIM - t * t, 0.0));
  }
  return h;
}

fn normalAt(p: vec2f) -> vec3f {
  let e = 0.18;
  let hx = heightAt(p + vec2f(e, 0.0)) - heightAt(p - vec2f(e, 0.0));
  let hy = heightAt(p + vec2f(0.0, e)) - heightAt(p - vec2f(0.0, e));
  return normalize(vec3f(-hx, -hy, 2.0 * e));
}

// Whether p is on the doorway's lit back, which is etched rather than polished.
fn backMask(p: vec2f) -> f32 {
  let w = wallCoords(p);
  let inA = smoothstep(DOOR_A.x - 0.004, DOOR_A.x + 0.004, w.x) * (1.0 - smoothstep(DOOR_A.y - DOOR_D - 0.004, DOOR_A.y - DOOR_D + 0.004, w.x));
  let inC = smoothstep(DOOR_C.x - 0.004, DOOR_C.x + 0.004, w.y) * (1.0 - smoothstep(DOOR_C.y - DOOR_D - 0.004, DOOR_C.y - DOOR_D + 0.004, w.y));
  return inA * inC;
}

// How far in from its silhouette the block's wall stands at height z: none above the girdle.
fn inset(z: f32) -> f32 {
  return max(ZP - z, 0.0) * TAPER;
}

// The solid, negative inside: walls (sloping in below the girdle), the faceted top, and the base.
// Each part is scaled to stay under the true distance, so a march along it never steps through.
fn solidSide(q: vec3f) -> f32 { return (sdMark(q.xy) + inset(q.z - LIFT)) * 0.78; }
fn solidTop(q: vec3f) -> f32 { return (q.z - LIFT - heightAt(q.xy)) * 0.55; }
fn solid(q: vec3f) -> f32 {
  return max(max(solidSide(q), solidTop(q)), LIFT - q.z);
}

// The outward normal of whichever surface q is on.
fn solidNormal(q: vec3f) -> vec3f {
  let side = solidSide(q);
  let top = solidTop(q);
  let base = LIFT - q.z;
  if (base >= side && base >= top) { return vec3f(0.0, 0.0, -1.0); }
  if (top >= side) { return normalAt(q.xy); }
  let slope = select(0.0, -TAPER, q.z - LIFT < ZP);
  return normalize(vec3f(markNormal(q.xy), slope));
}

// From a point inside the glass along dir, to where the ray leaves it.
fn leave(origin: vec3f, dir: vec3f) -> vec3f {
  var t = 0.04;
  var inside = 0.0;
  for (var i = 0; i < 40; i++) {
    let d = solid(origin + dir * t);
    if (d > -0.003) { break; }
    inside = t;
    t += max(-d, 0.035);
  }
  // Close in on the surface between the last point inside and the first one out.
  var a = inside;
  var b = t;
  for (var i = 0; i < 5; i++) {
    let m = (a + b) * 0.5;
    if (solid(origin + dir * m) > 0.0) { b = m; } else { a = m; }
  }
  return origin + dir * ((a + b) * 0.5);
}

fn fresnel(cosi: f32, n: f32) -> f32 {
  let r0 = (n - 1.0) / (n + 1.0);
  let f0 = r0 * r0;
  let m = 1.0 - clamp(cosi, 0.0, 1.0);
  return f0 + (1.0 - f0) * m * m * m * m * m;
}
`
