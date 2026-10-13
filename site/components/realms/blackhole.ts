import type { Rect } from "@/components/field/stage"
import { DOORWAY } from "@/components/realms/hive/cube"

import { basis as basisOf, clamp, dot, lerp, rayThrough, smooth, type Basis, type Vec3, type View } from "./camera"

/**
 * The black hole the flight ends at, under the footer: Realm's mark as the thing the field falls into.
 *
 * Its horizon is a black cube in the mark's pose — seen down its body diagonal, so its outline is the
 * mark's hexagon — with the mark's doorway cut into its dark right wall. It is traced per pixel in the
 * sky pass, inside the rect the page marks `data-field-anchor="hole"` and nowhere else, in the cube's
 * own space, where the cube is 2 across and the doorway is where `DOORWAY` (read off lib/mark.ts) puts
 * it.
 *
 *   the pull      a ray near the cube is stepped through a field that is a point mass far off and the
 *                 cube's own shape close in: the pull runs down the cube's distance field, so light
 *                 grazing a face is bent hard round its edges and light further out gently, and the
 *                 far bend is closed form. A ray that meets the cube is gone: the shadow is the mark.
 *   the rim       light that grazed the cube on its way past leaves as a thin bright line tracing the
 *                 silhouette, and a wider breath of it
 *   the inflow    streams of plasma, starlight and tiny realms spiralling in along the lines matter
 *                 follows, met where a ray crosses their plane: whiter and brighter as they near the
 *                 cube, beamed on the side coming at the camera, and gone where they meet a face. The
 *                 far side is bent over the top of the cube and under it.
 *   the doorway   the one light the cube gives back: its lit back, jamb and floor, a jet of threads of
 *                 its light streaming out into the space in front, and what was taken in coming back
 *                 out along it
 *
 * The hole answers the pointer: the view turns a few degrees about the cube toward it, and every ray
 * is retraced, so the outline, the doorway's depth and the lensing all follow. A click (or Enter on
 * its button) drops a realm in, which rides the streams down, is taken in at a face, and comes back
 * out through the doorway. Arriving, the cube turns into the mark's pose as the footer comes up.
 */

/** The hole's measure, in the cube's half-edges (it is 2 across), and how it moves. */
export const HOLE = {
  /** The hexagon's radius seen down the diagonal: a corner's distance from the middle, 2√(2/3). */
  hexagon: 2 * Math.sqrt(2 / 3),
  /** Where the streams begin to plunge, and the inflow's outer edge. */
  inner: 2.6,
  outer: 7.5,
  /** How tightly the streams wind: radians turned per e-fold of radius as matter falls in. */
  wind: 2.2,
  /** The inflow's inclination from the line of sight, in degrees: arriving, and arrived. */
  inclination: [64, 71] as const,
  /** How far the inflow's plane is turned on the page, its right side down, in degrees: so its near
   *  side passes under the doorway's wall rather than across the doorway. */
  roll: 14,
  /** How far the pointer turns the view about the cube, in degrees: across, and up and down. */
  lean: [8, 6] as const,
  /** How far the cube is turned from the mark's pose before the reader has arrived, in degrees. */
  arrive: 16,
  /** Where stars behind the cube are bent into a ring, in half-edges: the far pull is set from it. */
  ring: 2.55,
  /** Realms dropped in at once. */
  drops: 4,
  /** How long the hole waits, with nothing dropped in, before a realm of the field's own goes in (s). */
  idle: 9,
}

/** The doorway in the cube's space: its sides across the wall (the jamb is at x0), its floor and
 *  lintel, and its lit back, all from the mark's own fractions. */
const DOOR = {
  x0: 1 - 2 * DOORWAY.across[1],
  x1: 1 - 2 * DOORWAY.across[0],
  z0: 1 - 2 * DOORWAY.down[1],
  z1: 1 - 2 * DOORWAY.down[0],
  back: 1 - 2 * DOORWAY.depth,
}

export type HoleUniforms = {
  at: number[]
  box: number[]
  eye: number[]
  ax: number[]
  ay: number[]
  az: number[]
  dn: number[]
  de: number[]
  sr: number[]
  su: number[]
  drops: number[][]
}

const f = (n: number) => n.toFixed(6)

export const holeWgsl = /* wgsl */ `
const HOLE_TAU = 6.2831853;
// The cube's edges, rounded so its silhouette has the mark's soft corners.
const HOLE_RC = 0.1;
// The pull: a point mass far off (its strength is a uniform, so its ring of bent stars sits at the same
// share of the hexagon's size at any camera distance), and the cube's own shape close in, reaching
// about this far.
const HOLE_SKIN = 1.6;
const HOLE_SKIN_L = 0.2;
// Rays are stepped inside this sphere; outside it they bend in closed form.
const HOLE_RB = 5.5;
const HOLE_IN = ${f(HOLE.inner)};
const HOLE_OUT = ${f(HOLE.outer)};
const HOLE_WIND = ${f(HOLE.wind)};
// The doorway (lib/mark.ts, by way of DOORWAY): its sides, floor and lintel on the right wall, y = 1,
// and its lit back.
const HOLE_DX0 = ${f(DOOR.x0)};
const HOLE_DX1 = ${f(DOOR.x1)};
const HOLE_DZ0 = ${f(DOOR.z0)};
const HOLE_DZ1 = ${f(DOOR.z1)};
const HOLE_DY = ${f(DOOR.back)};
// Doorway light (the field's), and the plasma's ramp from its cool outer reaches to white.
const HOLE_DOOR = vec3f(0.82, 0.9, 1.0);
const HOLE_DOOR_BLUE = vec3f(0.42, 0.66, 1.0);
const HOLE_DEEP = vec3f(0.07, 0.15, 0.42);
const HOLE_BLUE = vec3f(0.26, 0.52, 1.0);
const HOLE_WHITE = vec3f(0.9, 0.95, 1.0);

// The shader that includes this declares the binding: var<uniform> hole: Hole.
struct Hole {
  at: vec4f,     // the cube's middle on the page and its hexagon's radius (CSS px), shown (0 .. 1)
  box: vec4f,    // the rect it may bend and light: left, top, right, bottom (CSS px)
  eye: vec4f,    // the camera in the cube's space (half-edges), and its distance
  ax: vec4f,     // the cube's axes in the world; ax.w how far the camera has lifted its eyes to the
  ay: vec4f,     //   night it hangs in (the sky pass brightens its stars by it); ay.w the doorway's
  az: vec4f,     //   flare; az.w the hole's clock (s)
  dn: vec4f,     // the inflow's plane, by its normal in the cube's space; w the rim's pulse
  de: vec4f,     // the plane's axis toward the camera; w CSS px per half-edge at the cube
  sr: vec4f,     // the view's right in the cube's space; w its focal length (CSS px)
  su: vec4f,     // the view's up in the cube's space; w the far pull, a point mass's
  drops: array<vec4f, ${HOLE.drops * 3}>,  // per realm dropped in: radius, angle, glow, size; then how far it
                                           // has come (rad), how far out of the doorway it is, its glow there,
                                           // a seed; then where a face took it, and how long ago (s). Once a
                                           // face has taken it, the first's w is how bright it is (the
                                           // field's own are dimmer than the reader's)
}

struct HoleRay {
  dir: vec3f,     // where the ray leaves for, in the world
  light: vec3f,   // what the hole puts in front of it
  through: f32,   // how much of what lies beyond still shows: none inside the shadow
}

fn holeHash(i: vec2f, n: f32) -> f32 {
  return hash21(vec2f(i.x - n * floor(i.x / n), i.y));
}

// Value noise that wraps every n cells along x, so an angle can be fed to it without a seam.
fn holeNoise(p: vec2f, n: f32) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(holeHash(i, n), holeHash(i + vec2f(1.0, 0.0), n), u.x),
    mix(holeHash(i + vec2f(0.0, 1.0), n), holeHash(i + vec2f(1.0, 1.0), n), u.x),
    u.y,
  );
}

// The cube: how far p is from its surface in w (negative inside), and the way out of it in xyz.
fn holeCube(p: vec3f) -> vec4f {
  let q = abs(p) - vec3f(1.0 - HOLE_RC);
  let m = max(q, vec3f(0.0));
  let l = length(m);
  var n = m / max(l, 1e-6);
  if (l < 1e-6) {
    n = select(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), q.y >= q.z), vec3f(1.0, 0.0, 0.0), q.x >= max(q.y, q.z));
  }
  return vec4f(n * sign(p), l + min(max(q.x, max(q.y, q.z)), 0.0) - HOLE_RC);
}

fn holeTint(heat: f32) -> vec3f {
  return mix(mix(HOLE_DEEP, HOLE_BLUE, smoothstep(0.0, 0.55, heat)), HOLE_WHITE, smoothstep(0.5, 1.25, heat));
}

// A point of the inflow's plane from its radius and angle.
fn holeOnDisk(r: f32, phi: f32) -> vec3f {
  return r * (cos(phi) * hole.de.xyz + sin(phi) * cross(hole.dn.xyz, hole.de.xyz));
}

// How far apart two points of the cube's space are on the page, in CSS px, scaled across by k.
fn holeOnPage(off: vec3f, k: f32) -> f32 {
  let x = dot(off, hole.sr.xyz) * hole.de.w;
  let y = dot(off, hole.su.xyz) * hole.de.w * k;
  return x * x + y * y;
}

// Points riding the streams: a grid of streamlines across and of distance along them, each cell
// holding one point or none, carried inward as the stream runs. Measured on the page, so a point is
// round, or a doorway's upright slit, however the plane is tilted.
fn holeMotes(q: vec3f, psi: f32, lr: f32, t: f32, around: f32, along: f32, speed: f32, chance: f32, size: f32, upright: f32, seed: f32) -> f32 {
  let u = psi / HOLE_TAU * around;
  let v = lr * along + t * speed;
  let cell = floor(vec2f(u, v));
  let id = vec2f(cell.x - around * floor(cell.x / around), cell.y);
  let h = hash22(id + seed);
  if (h.x > chance) { return 0.0; }
  // Kept off the cell's edges, so no neighbour has to be asked.
  let at = cell + 0.3 + 0.4 * hash22(id * 1.7 + seed + 3.1);
  let lrc = (at.y - t * speed) / along;
  let c = holeOnDisk(exp(lrc), at.x / around * HOLE_TAU - HOLE_WIND * lrc);
  return exp(-holeOnPage(q - c, upright) / (size * size)) * (0.45 + h.y);
}

// Threads of the streams: n streamlines round, each a thin line of light along the spiral matter
// follows down, with a brightness of its own and clumps running down it with the flow.
fn holeThreads(a: f32, flow: f32, r: f32, n: f32, width: f32, seed: f32) -> f32 {
  let x = a * n;
  let j = floor(x);
  let id = j - n * floor(j / n);
  let h = hash22(vec2f(id + seed, seed * 3.1));
  // Never thinner than about a pixel on the page (the plane is seen at a slant): a thread narrower
  // than that is drawn a pixel wide and as much fainter, so it does not crawl.
  let px = width * HOLE_TAU * r / n * hole.de.w * 0.4;
  let k = max(1.0, 1.2 / px);
  let off = (fract(x) - 0.3 - 0.4 * h.x) / (width * k);
  let run = noise(vec2f(flow * (1.2 + h.y), id * 3.7 + seed));
  return exp(-off * off) * (0.15 + 1.6 * h.y * h.y) * smoothstep(0.25, 0.8, run) / k;
}

// A realm the reader dropped in — the mark's hexagon, small and lit, upright to the page — and the
// streak it leaves along its stream behind it.
fn holeDrops(q: vec3f, r: f32, phi: f32) -> vec3f {
  var light = vec3f(0.0);
  for (var k = 0; k < ${HOLE.drops}; k++) {
    let d = hole.drops[k * 3];
    if (d.z <= 0.0) { continue; }
    let off = q - holeOnDisk(d.x, d.y);
    let o = abs(vec2f(dot(off, hole.sr.xyz), dot(off, hole.su.xyz)) * hole.de.w);
    let size = 3.6 * d.w;
    let hex = max(o.y, dot(o, vec2f(0.866, 0.5))) - size * 0.866;
    let realm = smoothstep(0.8, -0.8, hex) + 0.5 * exp(-max(hex, 0.0) / 2.5);
    // Back along its stream, as far as it has come: the angle back from it, and the radius the
    // stream had there.
    let back = fract((d.y - phi) / HOLE_TAU) * HOLE_TAU;
    let reach = max(min(hole.drops[k * 3 + 1].x, 2.4), 0.05);
    let path = d.x * exp(back / HOLE_WIND);
    let width = 0.014 * path + 0.012;
    let across = (r - path) / width;
    let streak = exp(-back / 0.7) * exp(-across * across) * (1.0 - smoothstep(reach * 0.5, reach, back));
    light += mix(HOLE_WHITE, HOLE_DOOR_BLUE, 0.25) * d.z * (realm * 2.6 + streak * 1.4);
  }
  return light;
}

// What the inflow gives off where a ray crosses its plane at q, travelling along dir: rgb light, a how
// much of what is behind it the streams hide.
fn holeDisk(q: vec3f, dir: vec3f) -> vec4f {
  let n = hole.dn.xyz;
  let e1 = hole.de.xyz;
  let e2 = cross(n, e1);
  let x = dot(q, e1);
  let y = dot(q, e2);
  let r = length(vec2f(x, y));
  if (r > HOLE_OUT) { return vec4f(0.0); }
  let surface = holeCube(q).w;
  if (surface <= 0.0) { return vec4f(0.0); }
  let phi = atan2(y, x);
  let t = hole.az.w;
  let lr = log(r);
  // The streamline through q, constant along the spiral matter follows down, and the distance along
  // it, which runs inward with the flow.
  let psi = phi + HOLE_WIND * lr;
  let flow = lr * 2.4 + t * 0.2;
  let a = psi / HOLE_TAU;
  // Two streams, each a bundle of threads, with a breath of glow between them.
  let arms = pow(0.5 + 0.5 * cos(2.0 * psi - 0.12 * t), 2.0);
  let threads = holeThreads(a, flow, r, 44.0, 0.11, 1.0) + 0.6 * holeThreads(a, flow * 1.3 + 5.0, r, 120.0, 0.12, 9.0);
  // Brightest where the streams begin to plunge, fading outward; inside that only the threads go on,
  // and each goes dark as it meets a face.
  let outer = 1.0 - smoothstep(HOLE_OUT * 0.45, HOLE_OUT, r);
  let fall = pow(HOLE_IN / max(r, HOLE_IN), 1.6) * (1.0 + 1.6 * exp(-(r - HOLE_IN) * (r - HOLE_IN) / 0.9));
  let plunge = smoothstep(1.3, HOLE_IN, r);
  let met = smoothstep(0.0, 0.8, surface);
  let body = threads * (0.2 + 1.3 * arms) + 0.05 * arms * plunge;
  let density = outer * fall * body * met;
  // Beamed: the streams orbit and fall, so the side coming at the camera is brighter and whiter.
  let radial = (x * e1 + y * e2) / max(r, 1e-4);
  let beta = min(0.62 * inverseSqrt(max(r, 1.0)), 0.6);
  let velocity = beta * normalize(cross(n, radial) - radial * 0.35);
  let g = sqrt(1.0 - beta * beta) / (1.0 + dot(velocity, dir));
  let beam = pow(g, 3.5);
  let heat = density * g * (1.3 + 1.2 * (1.0 - plunge));
  var light = holeTint(heat) * density * beam * 2.4;
  var cover = saturate(density * 2.2);
  // Starlight, and the realms themselves as the field shows them from afar: lit doorways, upright.
  if (density > 0.004 || r < HOLE_IN * 1.6) {
    let sparks = holeMotes(q, psi, lr, t, 90.0, 7.0, 0.58, 0.12, 0.85, 1.0, 1.0) * 1.1;
    let realms = holeMotes(q, psi, lr, t, 30.0, 2.6, 0.22, 0.22, 1.05, 0.55, 7.0) * 2.0;
    let carried = (0.25 + arms) * outer * met * smoothstep(1.2, 2.2, r);
    light += (HOLE_WHITE * sparks + HOLE_DOOR * realms) * carried * beam;
    cover = max(cover, saturate(realms * carried));
  }
  light += holeDrops(q, r, phi) * beam * smoothstep(0.0, 0.12, surface);
  return vec4f(light, cover);
}

// The doorway, for a ray that met the cube at p going along dir: its lit back, the jamb on its far
// side and its floor, as the mark draws them, lit from within. Nothing if p is not in it.
fn holeDoorway(p: vec3f, dir: vec3f, perPx: f32) -> vec3f {
  if (p.y < 0.95) { return vec3f(0.0); }
  let half = vec2f(HOLE_DX1 - HOLE_DX0, HOLE_DZ1 - HOLE_DZ0) * 0.5;
  let mid = vec2f(HOLE_DX1 + HOLE_DX0, HOLE_DZ1 + HOLE_DZ0) * 0.5;
  let edge = max(abs(p.x - mid.x) - half.x, abs(p.z - mid.y) - half.y);
  // The wall is seen at a slant, so a pixel covers more of it than of the page.
  let open = smoothstep(perPx * 1.5, -perPx * 1.5, edge);
  // Its light spills a little onto the wall round it.
  let spill = HOLE_DOOR_BLUE * exp(-max(edge, 0.0) / 0.06) * 0.22 * (1.0 + 1.5 * hole.ay.w) * (1.0 - open);
  if (open <= 0.0) { return spill; }
  let tb = (p.y - HOLE_DY) / max(-dir.y, 1e-4);
  let tj = select(1e4, max(p.x - HOLE_DX0, 0.0) / max(-dir.x, 1e-4), dir.x < -1e-4);
  let tf = select(1e4, max(p.z - HOLE_DZ0, 0.0) / max(-dir.z, 1e-4), dir.z < -1e-4);
  let tm = min(tb, min(tj, tf));
  let q = p + dir * tm;
  let deep = saturate((1.0 - q.y) / (1.0 - HOLE_DY));
  var c = vec3f(0.0);
  if (tm == tb) {
    // The lit back, brightest under the lintel.
    c = HOLE_DOOR * mix(1.9, 1.15, saturate((HOLE_DZ1 - q.z) / (HOLE_DZ1 - HOLE_DZ0)));
  } else if (tm == tj) {
    // The jamb, lit across the opening by the back: more the deeper in.
    c = mix(HOLE_DOOR_BLUE, HOLE_DOOR, 0.35) * mix(0.3, 1.0, deep);
  } else {
    c = mix(HOLE_DOOR_BLUE, HOLE_DOOR, 0.6) * mix(0.5, 1.35, deep);
  }
  return c * (1.0 + 2.5 * hole.ay.w) * open + spill;
}

// Where a face took a realm in: a flash, and a ring of light running out across the cube from it.
fn holeTaken(p: vec3f) -> vec3f {
  var light = vec3f(0.0);
  for (var k = 0; k < ${HOLE.drops}; k++) {
    let e = hole.drops[k * 3 + 2];
    if (e.w <= 0.0 || e.w > 1.6) { continue; }
    // Only across the face that took it: a ripple stops at the face's edges, as water does at a shore.
    let face = abs(e.xyz);
    let here = abs(p);
    let axis = select(select(2, 1, face.y >= face.z), 0, face.x >= max(face.y, face.z));
    let mine = select(select(2, 1, here.y >= here.z), 0, here.x >= max(here.y, here.z));
    if (axis != mine || sign(e[axis]) != sign(p[axis])) { continue; }
    let strength = hole.drops[k * 3].w;
    let dist = length(p - e.xyz);
    let radius = 0.05 + 0.95 * pow(e.w, 0.7);
    let off = (dist - radius) / (0.025 + 0.03 * e.w);
    let ring = exp(-off * off) * pow(1.0 - e.w / 1.6, 2.5);
    let flash = exp(-dist * dist / 0.012) * exp(-e.w / 0.15);
    light += (HOLE_DOOR_BLUE * ring * 0.5 + HOLE_WHITE * flash * 3.0) * strength;
  }
  return light;
}

// A spark at c going along way, as seen down the straight ray eye + d·t: a point of light drawn out
// behind it by stretch, as fast things are.
fn holeSpark(eye: vec3f, d: vec3f, c: vec3f, way: vec3f, size: f32, stretch: f32) -> f32 {
  let v = c - eye;
  let off = v - d * dot(v, d);
  let across = way - d * dot(way, d);
  let k = dot(off, across) / max(dot(across, across), 1e-6);
  // Behind it (off along -way) it trails; ahead it is a point.
  let s = select(1.0, stretch, k < 0.0);
  let lateral = off - across * k;
  let behind = k * length(across) / s;
  return select(0.0, exp(-(dot(lateral, lateral) + behind * behind) / (size * size)), dot(v, d) > 0.0);
}

// What comes out of the doorway, along the straight ray from the camera (it is in front of all that
// the cube bends): the doorway's light thrown a little way out into the space before it, the shape of
// the doorway, and what was taken in coming back out through it as sparks, carried off on its light.
fn holeOut(eye: vec3f, d: vec3f, tEnd: f32) -> vec3f {
  let t = hole.az.w;
  var light = vec3f(0.0);
  let reach = 4.5;
  let pad = 0.9;
  let lo = vec3f(HOLE_DX0 - pad, 1.0, HOLE_DZ0 - pad);
  let hi = vec3f(HOLE_DX1 + pad, 1.0 + reach, HOLE_DZ1 + pad);
  let inv = 1.0 / select(d, vec3f(1e-6), abs(d) < vec3f(1e-6));
  let t0 = (lo - eye) * inv;
  let t1 = (hi - eye) * inv;
  let near = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
  let far = min(min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z)), tEnd);
  if (far <= max(near, 0.0)) { return light; }
  // The doorway's light streaming out: threads of it, as the inflow's are, from across the opening
  // and out along the wall's normal, spreading a little, with the light running out along them.
  let mid0 = vec2f(HOLE_DX1 + HOLE_DX0, HOLE_DZ1 + HOLE_DZ0) * 0.5;
  let half0 = vec2f(HOLE_DX1 - HOLE_DX0, HOLE_DZ1 - HOLE_DZ0) * 0.5;
  for (var k = 0; k < 7; k++) {
    let h = hash22(vec2f(f32(k) * 3.7 + 1.0, 2.9));
    let spread = 1.0 - select(0.0, 1.0, k == 0);
    let a = vec3f(mid0.x + (h.x - 0.5) * half0.x * 1.5 * spread, 1.0, mid0.y + (h.y - 0.5) * half0.y * 1.6 * spread);
    let w = normalize(vec3f((h.x - 0.5) * 0.24 * spread, 1.0, (h.y - 0.5) * 0.2 * spread));
    let r0 = eye - a;
    let b = dot(d, w);
    let tr = (b * dot(w, r0) - dot(d, r0)) / max(1.0 - b * b, 1e-4);
    let u = max(b * tr + dot(w, r0), 0.0);
    let miss = r0 + d * tr - w * u;
    // How far the ray misses the thread, in pixels at the thread's own depth.
    let px = length(miss) * hole.de.w * hole.eye.w / max(tr, 1e-3);
    // The first thread is the jet's core: wider and fainter, the light the others are drawn out of.
    let core = select(0.0, 1.0, k == 0);
    let line = mix(exp(-px * px / 0.9), exp(-px * px / 60.0) * 0.16, core);
    let run = noise(vec2f(u * 2.6 - t * 1.1, f32(k) * 5.3));
    let fall = exp(-u / (0.7 + 0.8 * h.y + 0.6 * core)) * (1.0 - exp(-u * 18.0));
    light += mix(HOLE_DOOR, HOLE_DOOR_BLUE, 0.35 + 0.3 * h.y) * line * fall * (0.35 + 1.4 * run * run) * (0.7 + 0.6 * h.x) * 0.9 * (1.0 + hole.ay.w);
  }
  // Sparks: what was taken in, coming back out, a few at a time, always.
  let mid = vec2f(HOLE_DX1 + HOLE_DX0, HOLE_DZ1 + HOLE_DZ0) * 0.5;
  let half = vec2f(HOLE_DX1 - HOLE_DX0, HOLE_DZ1 - HOLE_DZ0) * 0.5;
  for (var k = 0; k < 7; k++) {
    let cycle = t / 3.4 + f32(k) / 7.0 + 0.13;
    let phase = fract(cycle);
    let h = hash22(vec2f(floor(cycle), f32(k) * 1.37 + 0.5));
    let g = hash22(h * 9.1 + 2.3) - 0.5;
    let origin = vec2f(mid.x + (h.x - 0.5) * half.x * 1.6, mid.y + (h.y - 0.5) * half.y * 1.6);
    let out = 0.05 + 3.0 * pow(phase, 1.4);
    let way = normalize(vec3f(g.x * 0.8, 1.0, g.y * 0.8));
    let c = vec3f(origin.x, 1.0, origin.y) + way * out;
    let size = 0.018 + 0.008 * out;
    let glow = smoothstep(0.0, 0.05, phase) * pow(1.0 - phase, 1.6) * (0.5 + h.x);
    light += mix(HOLE_WHITE, HOLE_DOOR_BLUE, 0.3) * holeSpark(eye, d, c, way, size, 1.0 + 7.0 * phase) * glow * 5.5;
  }
  // And the reader's own, brighter, with the doorway flaring as it comes.
  for (var k = 0; k < ${HOLE.drops}; k++) {
    let e = hole.drops[k * 3 + 1];
    if (e.z <= 0.0) { continue; }
    let c = vec3f(mid.x + (e.w - 0.5) * half.x, 1.0 + e.y, mid.y + (fract(e.w * 7.3) - 0.5) * half.y);
    // The realm itself, small and lit, upright to the page, and the light it trails.
    let v = c - eye;
    let off = (v - d * dot(v, d)) * hole.eye.w / max(dot(v, d), 1e-3);
    let o = abs(vec2f(dot(off, hole.sr.xyz), dot(off, hole.su.xyz)) * hole.de.w);
    let hex = max(o.y, dot(o, vec2f(0.866, 0.5))) - 3.4;
    let realm = smoothstep(0.8, -0.8, hex) + 0.5 * exp(-max(hex, 0.0) / 2.5);
    let trail = holeSpark(eye, d, c, vec3f(0.0, 1.0, 0.0), 0.035, 7.0);
    light += mix(HOLE_WHITE, HOLE_DOOR_BLUE, 0.15) * (realm * 2.6 + trail * 1.4) * e.z;
  }
  return light;
}

// Stars of the hole's own, so it has space to bend whatever sky is drawn round it: few, in the world's
// directions, each a point a pixel or so across.
fn holeStars(rd: vec3f) -> f32 {
  let q = rd * 70.0;
  let id = floor(q);
  let seed = hash21(id.xy * 1.31 + id.z * 7.7 + 11.0);
  if (seed < 0.74) { return 0.0; }
  let jitter = vec3f(hash21(id.xy + 1.3 + id.z), hash21(id.yz + 4.1), hash21(id.zx + 8.9));
  let star = normalize(id + 0.2 + 0.6 * jitter);
  let d = length(cross(rd, star)) * hole.sr.w;
  let m = hash21(id.zy + 2.7);
  return mix(0.1, 0.8, m * m * m) * exp(-d * d / 0.75);
}

// The view ray through a point of the page (CSS px), followed round the cube. Outside the hole's rect
// it is returned as it came.
fn holeTrace(css: vec2f, rd: vec3f) -> HoleRay {
  var out = HoleRay(rd, vec3f(0.0), 1.0);
  if (hole.at.w <= 0.0 || css.x < hole.box.x || css.x > hole.box.z || css.y < hole.box.y || css.y > hole.box.w) {
    return out;
  }
  // How far from the hole this pixel is, as a share of the room it has: past it, no bending at all.
  let room = (hole.box.zw - hole.box.xy) * 0.5;
  let reach = length((css - hole.at.xy) / max(room, vec2f(1.0)));
  let bend = 1.0 - smoothstep(0.72, 1.0, reach);
  if (bend <= 0.0) { return out; }

  let d = normalize(vec3f(dot(rd, hole.ax.xyz), dot(rd, hole.ay.xyz), dot(rd, hole.az.xyz)));
  let eye = hole.eye.xyz;
  let far = hole.eye.w;
  let n = hole.dn.xyz;
  let perPx = 1.0 / max(hole.de.w, 1e-3);
  let along = dot(eye, d);
  let closest = eye - d * along;
  let b = max(length(closest), 1e-4);
  let inward = closest / b;

  var light = vec3f(0.0);
  var through = 1.0;
  var dir = d;
  var sMin = 1e4;
  var captured = false;
  var hit = vec3f(0.0);
  var tEnd = 1e6;

  let stepped = b < HOLE_RB;
  let enter = -along - sqrt(max(HOLE_RB * HOLE_RB - b * b, 0.0));
  // The straight run from the camera: up to the sphere the rays are stepped in, or all the way past.
  {
    let tc = -dot(eye, n) / dot(d, n);
    if (tc > 0.0 && (!stepped || tc < enter)) {
      let q = eye + d * tc;
      if (dot(q, q) < HOLE_OUT * HOLE_OUT) {
        let disk = holeDisk(q, d);
        light += disk.rgb;
        through *= 1.0 - disk.a;
      }
    }
  }
  let front = through;

  if (stepped) {
    var p = eye + d * enter;
    var travelled = enter;
    for (var i = 0; i < 64; i++) {
      let c = holeCube(p);
      let s = c.w;
      sMin = min(sMin, s);
      if (s < 0.003) {
        captured = true;
        hit = p;
        tEnd = travelled;
        break;
      }
      let r2 = dot(p, p);
      let pull = -(hole.su.w * inverseSqrt(r2) / r2) * p - (HOLE_SKIN * exp(-s / HOLE_SKIN_L)) * c.xyz;
      let h = min(0.5 * s + 0.006, 0.6);
      dir = normalize(dir + (pull - dir * dot(pull, dir)) * h);
      let pn = p + dir * h;
      let h0 = dot(p, n);
      let h1 = dot(pn, n);
      if (h0 * h1 < 0.0) {
        let disk = holeDisk(mix(p, pn, h0 / (h0 - h1)), dir);
        light += through * disk.rgb;
        through *= 1.0 - disk.a;
      }
      p = pn;
      travelled += h;
      if (dot(p, p) > HOLE_RB * HOLE_RB && dot(p, dir) > 0.0) { break; }
      if (through < 0.004) { break; }
    }
    if (!captured) {
      // Out along a straight line again, through the plane once more if it lies ahead.
      let tc = -dot(p, n) / dot(dir, n);
      if (tc > 0.0) {
        let q = p + dir * tc;
        if (dot(q, q) < HOLE_OUT * HOLE_OUT) {
          let disk = holeDisk(q, dir);
          light += through * disk.rgb;
          through *= 1.0 - disk.a;
        }
      }
      // And the share of the far bend the steps never saw, outside the sphere: all of it at its edge,
      // so the stars do not tear along that circle.
      let alpha = (hole.su.w / b) * (1.0 + sqrt(max(1.0 - b * b / (far * far), 0.0)) - 2.0 * sqrt(max(1.0 - b * b / (HOLE_RB * HOLE_RB), 0.0)));
      let off = p - dir * dot(p, dir);
      dir = normalize(dir * cos(alpha) - off / max(length(off), 1e-5) * sin(alpha));
    }
  } else {
    let alpha = (hole.su.w / b) * (1.0 + sqrt(max(1.0 - b * b / (far * far), 0.0)));
    dir = normalize(d * cos(alpha) - inward * sin(alpha));
  }

  // The rim: light that grazed the cube on its way past, a thin line tracing the silhouette and a
  // breath round it. It gathers where the streams' plane crosses the silhouette, is brighter on the
  // side the streams come at the camera from, and is stirred along its length.
  var rim = 0.0;
  var breath = 0.0;
  if (stepped) {
    let t = hole.az.w;
    let flat = vec2f(dot(inward, hole.sr.xyz), dot(inward, hole.su.xyz));
    let around = atan2(flat.y, flat.x);
    let line = cross(n, eye);
    let node = atan2(dot(line, hole.su.xyz), dot(line, hole.sr.xyz));
    let gather = pow(0.5 + 0.5 * cos(2.0 * (around - node)), 3.0);
    let stir = holeNoise(vec2f(around / HOLE_TAU * 24.0 + t * 0.35, t * 0.25), 24.0);
    let strength = (0.8 + 0.5 * stir) * (1.0 + 1.4 * gather) * (1.0 - 0.3 * flat.x) * (1.0 + 1.5 * hole.dn.w);
    rim = exp(-sMin / (perPx * 2.2)) * smoothstep(0.0, perPx * 1.4, sMin) * 2.6 * strength;
    breath = exp(-sMin / 0.14) * 0.26 * strength;
  }
  if (captured) {
    light += through * (holeDoorway(hit, dir, perPx) + holeTaken(hit));
    through = 0.0;
  } else if (stepped) {
    light += through * (HOLE_WHITE * rim + HOLE_BLUE * breath);
    // The shadow's edge, anti-aliased outward: a ray that only just escaped is still mostly dark.
    through *= smoothstep(0.0, perPx * 1.6, sMin);
  }

  light += front * holeOut(eye, d, tEnd);

  let world = normalize(dir.x * hole.ax.xyz + dir.y * hole.ay.xyz + dir.z * hole.az.xyz);
  light += INK * holeStars(world) * through * (1.0 - smoothstep(0.55, 0.95, reach)) * (0.35 + 0.65 * hole.ax.w);
  out.dir = normalize(mix(rd, world, bend));
  out.light = light * hole.at.w;
  out.through = mix(1.0, through, hole.at.w);
  return out;
}
`

/** The uniforms of a hole that is not on the page: every ray passes it by. */
export const holeOff = (): HoleUniforms => ({
  at: [0, 0, 0, 0],
  box: [0, 0, 0, 0],
  eye: [0, 0, 30, 30],
  ax: [1, 0, 0, 0],
  ay: [0, 1, 0, 0],
  az: [0, 0, 1, 0],
  dn: [0, 0, 1, 0],
  de: [1, 0, 0, 1],
  sr: [1, 0, 0, 1],
  su: [0, 1, 0, 0],
  drops: Array.from({ length: HOLE.drops * 3 }, () => [0, 0, 0, 0]),
})

/** A click (or a key) on the hole: where on the page, to be dropped in on the next frame. */
const clicks: { x: number; y: number }[] = []

/** Called by the page when the reader drops a realm in: `x, y` in viewport CSS px, or nothing when it
 *  came from the keyboard. */
export function dropRealm(x?: number, y?: number) {
  clicks.push({ x: x ?? Number.NaN, y: y ?? Number.NaN })
  if (clicks.length > HOLE.drops) clicks.shift()
}

/** A realm dropped in: where it is on the inflow's plane, and once it has been taken in, how long ago. */
type Drop = { r: number; phi: number; age: number; travelled: number; taken: number; seed: number; entry: Vec3; strength: number }

const DEG = Math.PI / 180

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const mix3 = (a: Vec3, b: Vec3, ka: number, kb: number): Vec3 => [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb]

/** The mark's view of the cube, in the cube's space: toward the camera down the body diagonal, and
 *  the page's right and up, which put the cube's near corner in the middle, its edges up-right, left
 *  and down-right, and the doorway's wall (y = 1) on the right. */
const TOWARD: Vec3 = norm([1, 1, 1])
const RIGHT: Vec3 = norm([-1, 2, -1])
const UP: Vec3 = norm([-1, 0, 1])

/** A realm put in where it is easiest to follow: on the far side, from where its stream carries it over
 *  the cube's top, round past the side coming at the camera and across the front, to be taken in by
 *  the wall under the cube's near corner. */
const fromFarSide = (seed: number, strength: number): Drop => ({
  r: 6 + seed * 0.6,
  phi: (155 + (seed - 0.5) * 16) * DEG,
  age: 0,
  travelled: 0,
  taken: -1,
  seed,
  entry: [0, 0, 0],
  strength,
})

/** How far the cube's surface is from its middle along a direction: where a realm on the plane meets it. */
const surfaceAlong = (u: Vec3) => 1 / Math.max(Math.abs(u[0]), Math.abs(u[1]), Math.abs(u[2]), 1e-3)

/** The hexagon's radius on the page for a viewport: about a ninth of its height, held to its width on a
 *  phone. HoleStage's button and the drawing without WebGPU size themselves by the same rule. */
export const shadowRadius = (width: number, height: number) => clamp(Math.min(width * (width < 640 ? 0.11 : 0.07), height * 0.11), 34, 104)

export type HoleFrame = {
  view: View
  b?: Basis
  rect: Rect | undefined
  width: number
  height: number
  seconds: number
  dt: number
  still: boolean
  /** x, y in CSS px and presence 0..1, as the field reads the mouse. */
  pointer: readonly [number, number, number]
}

/**
 * The hole's state across frames: the lean easing after the pointer, and the realms dropped in.
 * `frame` returns the uniforms for this one, and whether anything in it is moving.
 */
export class BlackHole {
  private lean = [0, 0]
  private drops: Drop[] = []
  private pulse = 0
  /** When the hole last had a realm going in or coming out (s), for the field's own. */
  private busy = Number.NEGATIVE_INFINITY

  frame(input: HoleFrame): { uniforms: HoleUniforms; live: boolean } {
    const { view, rect, width, height, seconds, still } = input
    const b = input.b ?? basisOf(view)
    if (!rect || rect[2] <= 0 || rect[1] > height || rect[1] + rect[3] < 0) {
      clicks.length = 0
      return { uniforms: holeOff(), live: false }
    }

    const radius = shadowRadius(width, height)
    const cx = rect[0] + rect[2] / 2
    const cy = rect[1] + rect[3] * 0.56
    // Arriving: how far the reader has come down to it, by how much of its rect is on screen.
    const arrived = still ? 1 : smooth(clamp((height - rect[1]) / Math.max(rect[3], 1), 0, 1))

    // The lean: the view turns toward the pointer, easing after it over half a second.
    const [px, py, presence] = input.pointer
    const dt = Math.min(Math.max(input.dt, 0), 0.1)
    const k = still ? 1 : 1 - Math.exp(-dt / 0.5)
    const tx = still ? 0 : clamp((px - cx) / Math.max(rect[2] * 0.5, 1), -1, 1) * presence
    const ty = still ? 0 : clamp((py - cy) / Math.max(rect[3] * 0.6, 1), -1, 1) * presence
    this.lean[0] += (tx - this.lean[0]) * k
    this.lean[1] += (ty - this.lean[1]) * k

    // The view at the hole: toward the camera, and the page's right and up there.
    const centre = rayThrough(view, b, cx, cy)
    const toward: Vec3 = [-centre[0], -centre[1], -centre[2]]
    const up = norm(mix3(b.up, centre, 1, -dot(b.up, centre)))
    const right = cross(centre, up)

    // The camera's place about the cube: the mark's view, turned toward the pointer (and, until the
    // reader has arrived, a little off the mark's pose), across and then up and down.
    const yaw = (this.lean[0] * HOLE.lean[0] + (1 - arrived) * HOLE.arrive) * DEG
    const pitch = this.lean[1] * HOLE.lean[1] * DEG
    let n = mix3(TOWARD, RIGHT, Math.cos(yaw), Math.sin(yaw))
    const r = mix3(RIGHT, TOWARD, Math.cos(yaw), -Math.sin(yaw))
    const u = mix3(UP, n, Math.cos(pitch), Math.sin(pitch))
    n = mix3(n, UP, Math.cos(pitch), -Math.sin(pitch))
    // The cube's axes in the world: a world direction's cube coordinates are its parts along toward,
    // right and up, weighed by n, r and u.
    const axis = (i: 0 | 1 | 2): Vec3 => mix3(mix3(toward, right, n[i], r[i]), up, 1, u[i])
    const ax = axis(0)
    const ay = axis(1)
    const az = axis(2)
    const distance = (HOLE.hexagon * view.focal) / radius
    const eye: Vec3 = [n[0] * distance, n[1] * distance, n[2] * distance]

    // The inflow's plane, fixed to the cube: its normal tipped from the page's up toward the camera.
    const inclination = lerp(HOLE.inclination[0], HOLE.inclination[1], arrived) * DEG
    const rolled = mix3(UP, RIGHT, Math.cos(HOLE.roll * DEG), Math.sin(HOLE.roll * DEG))
    const dn = mix3(rolled, TOWARD, Math.sin(inclination), Math.cos(inclination))
    const de = mix3(TOWARD, rolled, Math.sin(inclination), -Math.cos(inclination))
    const e2 = cross(dn, de)
    const onPlane = (rr: number, phi: number): Vec3 => mix3(de, e2, rr * Math.cos(phi), rr * Math.sin(phi))

    // Realms the reader dropped in since the last frame: onto the plane where the click's ray meets it,
    // or at its outer edge on that side. A key carries no point, so its realm goes in from the far side.
    while (clicks.length > 0) {
      const click = clicks.shift()!
      if (still) continue
      const seed = Math.random()
      if (Number.isNaN(click.x)) {
        this.drops.push(fromFarSide(seed, 1))
      } else {
        const ray = rayThrough(view, b, click.x, click.y)
        const d: Vec3 = [dot(ray, ax), dot(ray, ay), dot(ray, az)]
        const across = dot(d, dn)
        const t = Math.abs(across) > 1e-4 ? -dot(eye, dn) / across : -1
        let rr = HOLE.outer * 0.85
        let phi = Math.atan2(dot(d, e2), dot(d, de))
        if (t > 0) {
          const hit = mix3(eye, d, 1, t)
          rr = clamp(Math.hypot(dot(hit, de), dot(hit, e2)), HOLE.inner + 0.6, HOLE.outer * 0.85)
          phi = Math.atan2(dot(hit, e2), dot(hit, de))
        }
        this.drops.push({ r: rr, phi, age: 0, travelled: 0, taken: -1, seed, entry: [0, 0, 0], strength: 1 })
      }
      if (this.drops.length > HOLE.drops) this.drops.shift()
    }

    // While nothing is being dropped in, every so often a realm of the field's own goes in the same
    // way, dimmer, so the hole is seen taking things in and giving them back without being asked.
    if (still || this.drops.length > 0) this.busy = seconds
    else if (seconds - this.busy > HOLE.idle) {
      this.drops.push(fromFarSide(Math.random(), 0.6))
      this.busy = seconds
    }

    // A dropped realm rides its stream down, faster the deeper it goes, until a face takes it; a
    // moment later it comes back out through the doorway and away.
    const drops: number[][] = []
    let flare = 0
    this.pulse *= Math.exp(-dt / 0.35)
    this.drops = this.drops.filter((drop) => drop.taken < 3)
    for (const drop of this.drops) {
      drop.age += dt
      if (drop.taken < 0) {
        const fall = 0.9 + 3 / (drop.r * drop.r)
        const turn = (HOLE.wind * fall) / drop.r
        drop.r -= fall * dt
        drop.phi += turn * dt
        drop.travelled += turn * dt
        const meets = surfaceAlong(onPlane(1, drop.phi))
        if (drop.r <= meets + 0.03) {
          drop.taken = 0
          drop.entry = onPlane(meets, drop.phi)
          this.pulse = 1
        }
        const glow = smooth(drop.age / 0.25) * smooth((drop.r - meets) / 0.6) * drop.strength
        drops.push([Math.max(drop.r, meets), drop.phi, glow, 0.55 + 0.45 * smooth((drop.r - meets) / 1.2)], [drop.travelled, 0, 0, 0], [0, 0, 0, 0])
      } else {
        drop.taken += dt
        const out = drop.taken - 0.9
        const glow = out > 0 ? smooth(out / 0.12) * Math.exp(-out / 0.9) * drop.strength : 0
        flare = Math.max(flare, out > 0 ? Math.exp(-out / 0.5) * smooth(out / 0.08) * drop.strength : 0)
        const along = out > 0 ? 0.1 + 0.9 * out + 0.55 * out * out : 0
        drops.push([0, 0, 0, drop.strength], [drop.travelled, along, glow, drop.seed], [...drop.entry, Math.max(drop.taken, 1e-3)])
      }
    }
    while (drops.length < HOLE.drops * 3) drops.push([0, 0, 0, 0])

    return {
      uniforms: {
        at: [cx, cy, radius, 1],
        box: [rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]],
        eye: [...eye, distance],
        ax: [...ax, 0],
        ay: [...ay, flare],
        az: [...az, seconds],
        dn: [...dn, this.pulse],
        de: [...de, radius / HOLE.hexagon],
        sr: [...r, view.focal],
        su: [...u, (HOLE.ring * HOLE.ring) / (2 * distance)],
        drops,
      },
      live: !still,
    }
  }
}
