import type { Rect } from "@/components/field/stage"

import { basis as basisOf, clamp, dot, lerp, rayThrough, smooth, type Basis, type Vec3, type View } from "./camera"

/**
 * The black hole the flight ends at, under the footer: the field of realms drawn into one place.
 *
 * It is a Schwarzschild hole traced per pixel in the sky pass, inside the rect the page marks
 * `data-field-anchor="hole"` and nowhere else. Each view ray is followed in its own orbital plane by
 * the photon orbit equation, u'' + u = 3Mu² (u = 1/r, M = 1), so a ray costs at most 64 steps of an
 * ODE with no square roots in it, and the disk is met exactly where that plane crosses the disk's.
 *
 *   the shadow    every ray whose impact parameter is under 3√3 falls in: an exact, anti-aliased edge
 *   the disk      thin, from the innermost stable orbit out: blue-white plasma, beamed toward the side
 *                 coming at the camera, and further out the realms themselves, lit doorways on rings
 *                 that turn at their orbit's own rate and drift inward, stretching as they go
 *   the lensing   the far side of the disk bent over and under the shadow, the photon ring where rays
 *                 wind round before they leave, and the stars behind it pulled into arcs
 *
 * The hole answers the pointer: the view leans toward it and every ray is retraced, so the lensing
 * follows. A click (or Enter on its button) drops a realm in, which spirals down the disk on its own
 * orbit and streaks it on the way. The scroll is what brings the camera down to the disk's plane as
 * the page ends.
 */

/** The hole's scale and the disk's reach, in units of its mass. */
export const HOLE = {
  /** The critical impact parameter, 3√3: the shadow's edge. */
  shadow: 3 * Math.sqrt(3),
  /** The innermost stable circular orbit, where the plasma's light starts. */
  inner: 6,
  /** How far out realms are still drifting in from. */
  outer: 26,
  /** The view's inclination from the disk's normal: arriving, and arrived (the camera all but in
   *  the disk's plane, so its far side is lensed into the arc over the shadow). */
  inclination: [62, 80.5] as const,
  /** How far the pointer leans the view, in degrees: across (a bank) and up and down. */
  lean: [5, 4] as const,
  /** Realms dropped in at once. */
  drops: 4,
}

export type HoleUniforms = {
  at: number[]
  box: number[]
  eye: number[]
  ax: number[]
  ay: number[]
  az: number[]
  drops: number[][]
}

export const holeWgsl = /* wgsl */ `
const HOLE_B = ${HOLE.shadow.toFixed(6)};
const HOLE_IN = ${HOLE.inner.toFixed(1)};
const HOLE_OUT = ${HOLE.outer.toFixed(1)};
const HOLE_PI = 3.14159265;
const HOLE_TAU = 6.2831853;
// How fast the plasma turns at the inner edge (rad/s); everything further out at Kepler's rate.
const HOLE_SPIN = 0.32;
// The realms: rings of them in log radius, each ring turning rigidly and the whole stream drifting in.
const HOLE_RINGS = 8.0;
const HOLE_AROUND = 26.0;
const HOLE_FLOW = 0.11;
// Doorway light (the field's), and the plasma's ramp from its cool outer edge to white.
const HOLE_DOOR = vec3f(0.82, 0.9, 1.0);
const HOLE_DOOR_BLUE = vec3f(0.42, 0.66, 1.0);
const HOLE_DEEP = vec3f(0.07, 0.15, 0.42);
const HOLE_BLUE = vec3f(0.26, 0.52, 1.0);
const HOLE_WHITE = vec3f(0.9, 0.95, 1.0);

// The shader that includes this declares the binding: var<uniform> hole: Hole.
struct Hole {
  at: vec4f,     // the shadow's centre on the page and its radius (CSS px), shown (0 .. 1)
  box: vec4f,    // the rect it may bend and light: left, top, right, bottom (CSS px)
  eye: vec4f,    // the camera in the hole's own space (units of M), and its distance
  ax: vec4f,     // the hole's axes in the world: x in the disk toward the camera,
  ay: vec4f,     //   y across the disk,
  az: vec4f,     //   z the disk's normal; az.w the hole's clock (s)
  drops: array<vec4f, ${HOLE.drops}>,  // realms dropped in: radius (M), angle, glow, the spiral's dr/dphi
}

struct HoleRay {
  dir: vec3f,     // where the ray leaves for, in the world
  light: vec3f,   // what the disk and its realms put in front of it
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

fn holeOmega(r: f32) -> f32 {
  return HOLE_SPIN * pow(HOLE_IN / r, 1.5);
}

// The plasma's grain: streaks along the orbit, in rings of log radius that each turn rigidly at their
// own rate. Two sets of rings half a ring apart are blended, so no ring's edge shows and the grain
// never winds up however long the page is open.
fn holePlasma(r: f32, phi: f32, t: f32) -> f32 {
  let s = log(r / HOLE_IN) * 5.0;
  var sum = 0.0;
  for (var k = 0; k < 2; k++) {
    let o = f32(k) * 0.5;
    let ring = floor(s + o);
    let centre = HOLE_IN * exp((ring + 0.5 - o) / 5.0);
    let w = 1.0 - abs(2.0 * fract(s + o) - 1.0);
    let turn = fract((phi - holeOmega(centre) * t) / HOLE_TAU + hash21(vec2f(ring, o)));
    let q = vec2f(turn * 20.0, s * 2.6 + o * 13.0);
    let grain = 0.6 * holeNoise(q, 20.0) + 0.28 * holeNoise(q * vec2f(3.0, 2.2) + 7.1, 60.0) + 0.12 * holeNoise(q * vec2f(9.0, 3.1) + 3.3, 180.0);
    sum += w * grain;
  }
  return sum;
}

// The realms on the disk, as the field draws them from afar: a lit doorway, a short upright slit of
// light. They ride rings that each turn rigidly at the rate of the orbit they are on now and drift
// inward, so a realm follows a spiral down; near the inner edge it stretches along its orbit and runs
// into the plasma. The slit is upright as the camera sees it, which on a disk seen nearly edge-on
// means long along the line of sight. rgb is light, a how much it covers.
fn holeRealms(p: vec2f, r: f32, phi: f32, t: f32, cosI: f32) -> vec4f {
  let span = log(HOLE_OUT / HOLE_IN);
  let s = log(r / HOLE_IN) / span;
  if (s <= 0.16 || s >= 1.0) { return vec4f(0.0); }
  let q = s * HOLE_RINGS + HOLE_FLOW * t;
  let ring = floor(q);
  let here = (ring + 0.5 - HOLE_FLOW * t) / HOLE_RINGS;
  let rr = HOLE_IN * exp(here * span);
  // The turn a ring has made by now, as a function of where it is: closed form for a ring drifting
  // in at a steady rate in log radius while turning at Kepler's.
  let wind = HOLE_SPIN * HOLE_RINGS / (1.5 * span * HOLE_FLOW);
  let spin = fract(wind * pow(HOLE_IN / rr, 1.5) / HOLE_TAU + hash21(vec2f(ring, 3.7))) * HOLE_TAU;
  let a = (phi - spin) / HOLE_TAU * HOLE_AROUND;
  let stretch = 1.0 + 10.0 * pow(saturate(1.0 - here / 0.45), 2.0);
  let size = mix(0.03, 0.05, here);
  var light = vec3f(0.0);
  var cover = 0.0;
  for (var dj = -1; dj <= 1; dj++) {
    let j = floor(a) + f32(dj);
    let id = vec2f(j - HOLE_AROUND * floor(j / HOLE_AROUND), ring);
    let g = hash22(id * 2.11 + 5.3);
    let angle = spin + (j + 0.5) / HOLE_AROUND * HOLE_TAU;
    let centre = rr * vec2f(cos(angle), sin(angle));
    let along = vec2f(-sin(angle), cos(angle));
    var delta = p - centre;
    delta -= along * dot(delta, along) * (1.0 - 1.0 / stretch);
    delta.x *= cosI / 1.9;
    let e = exp(-dot(delta, delta) / (size * size));
    let tint = mix(HOLE_DOOR, HOLE_DOOR_BLUE, step(0.85, g.y));
    light += tint * mix(0.8, 1.3, g.x) * e;
    cover += e * 0.4;
  }
  let fade = smoothstep(1.0, 0.84, s) * smoothstep(0.16, 0.34, s);
  return vec4f(light * fade, saturate(cover) * fade);
}

// A realm the reader dropped in, and the streak it leaves along its orbit behind it.
fn holeDrops(p: vec2f, r: f32, phi: f32, cosI: f32) -> vec3f {
  var light = vec3f(0.0);
  for (var k = 0; k < ${HOLE.drops}; k++) {
    let d = hole.drops[k];
    if (d.z <= 0.0) { continue; }
    let at = d.x * vec2f(cos(d.y), sin(d.y));
    var delta = p - at;
    delta.x *= cosI;
    let point = exp(-dot(delta, delta) / 0.03);
    // Behind it along its spiral: the angle back from it, and the radius its path had there.
    let back = fract((d.y - phi) / HOLE_TAU) * HOLE_TAU;
    let path = d.x + back * d.w;
    let width = 0.03 * path;
    let streak = exp(-back / 0.8) * exp(-pow((r - path) / width, 2.0)) * smoothstep(3.2, 1.6, back);
    light += mix(HOLE_WHITE, HOLE_DOOR_BLUE, 0.35) * d.z * (point * 10.0 + streak * 2.4);
  }
  return light;
}

fn holeTint(heat: f32) -> vec3f {
  return mix(mix(HOLE_DEEP, HOLE_BLUE, smoothstep(0.0, 0.55, heat)), HOLE_WHITE, smoothstep(0.5, 1.25, heat));
}

// What the disk gives off where a ray crosses it, at p (hole space, on the disk) travelling along dir.
// rgb is light, a how much of what is behind it the disk hides.
fn holeDisk(p: vec3f, dir: vec3f) -> vec4f {
  let r = length(p.xy);
  if (r < HOLE_IN - 1.5 || r > HOLE_OUT) { return vec4f(0.0); }
  let phi = atan2(p.y, p.x);
  let t = hole.az.w;
  let cosI = hole.eye.z / hole.eye.w;
  // The plasma orbits at Kepler's speed, so the side coming at the camera is beamed brighter and
  // bluer; the far side of the hole's well takes some of everything (the gravitational shift).
  let beta = min(inverseSqrt(max(r - 2.0, 0.6)), 0.62) * 0.8;
  let velocity = beta * vec3f(-sin(phi), cos(phi), 0.0);
  let gamma = inverseSqrt(1.0 - beta * beta);
  let g = sqrt(max(1.0 - 2.0 / r, 0.02)) / (gamma * (1.0 + dot(velocity, dir)));
  let beam = pow(g, 2.6);
  // Brightest just outside the innermost stable orbit, falling away outward; inside it the gas is
  // plunging and goes dark fast.
  let edge = smoothstep(HOLE_IN - 1.6, HOLE_IN + 0.3, r);
  let profile = edge * pow(HOLE_IN / max(r, HOLE_IN), 2.6) * (1.0 - smoothstep(12.0, 21.0, r));
  let grain = select(0.0, holePlasma(r, phi, t), profile > 1e-3);
  let density = profile * (0.45 + 1.1 * grain * grain);
  let heat = density * g * 1.35;
  var light = holeTint(heat) * density * beam * 2.6;
  var cover = saturate(density * 2.6);
  let realms = holeRealms(p.xy, r, phi, t, cosI);
  light += realms.rgb * beam;
  cover = max(cover, realms.a);
  light += holeDrops(p.xy, r, phi, cosI) * beam;
  return vec4f(light, cover);
}

fn holeHermite(u0: f32, m0: f32, u1: f32, m1: f32, t: f32) -> f32 {
  let t2 = t * t;
  let t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * u0 + (t3 - 2.0 * t2 + t) * m0 + (3.0 * t2 - 2.0 * t3) * u1 + (t3 - t2) * m1;
}

fn holeHermiteSlope(u0: f32, m0: f32, u1: f32, m1: f32, t: f32, h: f32) -> f32 {
  let t2 = t * t;
  return ((6.0 * t2 - 6.0 * t) * u0 + (3.0 * t2 - 4.0 * t + 1.0) * m0 + (6.0 * t - 6.0 * t2) * u1 + (3.0 * t2 - 2.0 * t) * m1) / h;
}

// The view ray through a point of the page (CSS px), followed round the hole. Outside the hole's rect
// it is returned as it came.
fn holeTrace(css: vec2f, rd: vec3f) -> HoleRay {
  var out = HoleRay(rd, vec3f(0.0), 1.0);
  if (hole.at.w <= 0.0 || css.x < hole.box.x || css.x > hole.box.z || css.y < hole.box.y || css.y > hole.box.w) {
    return out;
  }
  // How far from the hole this pixel is, as a share of the room it has: past it, no bending at all.
  let half = (hole.box.zw - hole.box.xy) * 0.5;
  let reach = length((css - hole.at.xy) / max(half, vec2f(1.0)));
  let bend = 1.0 - smoothstep(0.72, 1.0, reach);
  if (bend <= 0.0) { return out; }

  let d = normalize(vec3f(dot(rd, hole.ax.xyz), dot(rd, hole.ay.xyz), dot(rd, hole.az.xyz)));
  let far = hole.eye.w;
  let e1 = hole.eye.xyz / far;
  let ca = dot(d, e1);
  var e2 = d - ca * e1;
  let sa = length(e2);
  e2 = e2 / max(sa, 1e-7);
  // The impact parameter, which the orbit keeps: under 3√3 the ray falls in. One CSS px of it wide,
  // the shadow's edge is anti-aliased exactly.
  let b = far * sa * inverseSqrt(1.0 - 2.0 / far);
  let perPx = HOLE_B / max(hole.at.z, 1.0);
  let outside = smoothstep(HOLE_B - 0.6 * perPx, HOLE_B + 0.6 * perPx, b);

  // A ray that never comes within the disk's reach only bends, by the weak-field series to third order
  // (less the share it would have bent behind the camera), held to the steps' own answer where the two
  // meet so the stars do not tear along that circle: no steps needed.
  if (b > HOLE_OUT + 2.0) {
    let sweep = HOLE_PI - asin(min(b / far, 1.0)) + (2.0 / b) * (1.0 + sqrt(max(1.0 - b * b / (far * far), 0.0))) + 11.781 / (b * b) + 42.667 / (b * b * b) - 0.0032;
    let exit = cos(sweep) * e1 + sin(sweep) * e2;
    let world = normalize(exit.x * hole.ax.xyz + exit.y * hole.ay.xyz + exit.z * hole.az.xyz);
    out.dir = normalize(mix(rd, world, bend));
    return out;
  }

  var u = 1.0 / far;
  var w = sqrt(max(1.0 / (b * b) - u * u * (1.0 - 2.0 * u), 0.0));
  // Where the orbit's plane cuts the disk's: every half turn from the first node ahead.
  var node = atan2(-e1.z, e2.z);
  node = node - floor(node / HOLE_PI) * HOLE_PI;
  if (node < 1e-5) { node += HOLE_PI; }

  var phi = 0.0;
  var light = vec3f(0.0);
  var through = 1.0;
  var leave = -1.0;
  for (var i = 0; i < 64; i++) {
    let h = mix(0.26, 0.1, smoothstep(0.015, 0.2, u));
    let k1u = w;
    let k1w = 3.0 * u * u - u;
    let u2 = u + 0.5 * h * k1u;
    let w2 = w + 0.5 * h * k1w;
    let k2u = w2;
    let k2w = 3.0 * u2 * u2 - u2;
    let u3 = u + 0.5 * h * k2u;
    let w3 = w + 0.5 * h * k2w;
    let k3u = w3;
    let k3w = 3.0 * u3 * u3 - u3;
    let u4 = u + h * k3u;
    let w4 = w + h * k3w;
    let k4u = w4;
    let k4w = 3.0 * u4 * u4 - u4;
    let un = u + h / 6.0 * (k1u + 2.0 * k2u + 2.0 * k3u + k4u);
    let wn = w + h / 6.0 * (k1w + 2.0 * k2w + 2.0 * k3w + k4w);
    if (node <= phi + h) {
      let f = (node - phi) / h;
      let uc = holeHermite(u, w * h, un, wn * h, f);
      if (uc > 1.0 / HOLE_OUT && uc < 0.5) {
        let wc = holeHermiteSlope(u, w * h, un, wn * h, f, h);
        let radial = cos(node) * e1 + sin(node) * e2;
        let across = -sin(node) * e1 + cos(node) * e2;
        let p = radial / uc;
        let dir = normalize(-wc * radial + uc * across);
        let disk = holeDisk(p, dir);
        light += through * disk.rgb;
        through *= 1.0 - disk.a;
      }
      node += HOLE_PI;
    }
    if (un >= 0.5) {
      through = 0.0;
      break;
    }
    if (un <= 0.0) {
      leave = phi + h * u / max(u - un, 1e-7);
      break;
    }
    u = un;
    w = wn;
    phi += h;
    if (through < 0.003) { break; }
  }
  // A ray still winding round when the steps run out leaves from where it is.
  if (leave < 0.0) { leave = phi; }
  let exit = cos(leave) * e1 + sin(leave) * e2;
  let world = normalize(exit.x * hole.ax.xyz + exit.y * hole.ay.xyz + exit.z * hole.az.xyz);
  out.dir = normalize(mix(rd, world, bend));
  out.light = light * hole.at.w;
  out.through = mix(1.0, through * outside, hole.at.w);
  return out;
}
`

/** A click (or a key) on the hole: where on the page, to be dropped in on the next frame. */
const clicks: { x: number; y: number }[] = []

/** Called by the page when the reader drops a realm in; `x, y` in viewport CSS px, or the middle of
 *  the hole's rect when it came from the keyboard. */
export function dropRealm(x?: number, y?: number) {
  clicks.push({ x: x ?? Number.NaN, y: y ?? Number.NaN })
  if (clicks.length > HOLE.drops) clicks.shift()
}

type Drop = { r: number; phi: number; age: number }

const DEG = Math.PI / 180

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const mix3 = (a: Vec3, b: Vec3, ka: number, kb: number): Vec3 => [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb]

/** The shadow's radius on the page for a viewport: a tenth of its height, held to its width on a phone. */
export const shadowRadius = (width: number, height: number) => clamp(Math.min(width * 0.064, height * 0.1), 32, 96)

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

  frame(input: HoleFrame): { uniforms: HoleUniforms; live: boolean } {
    const { view, rect, width, height, seconds, still } = input
    const b = input.b ?? basisOf(view)
    const off: HoleUniforms = {
      at: [0, 0, 0, 0],
      box: [0, 0, 0, 0],
      eye: [0, 0, 1, 100],
      ax: [1, 0, 0, 0],
      ay: [0, 1, 0, 0],
      az: [0, 0, 1, 0],
      drops: Array.from({ length: HOLE.drops }, () => [0, 0, 0, 0]),
    }
    if (!rect || rect[2] <= 0 || rect[1] > height || rect[1] + rect[3] < 0) {
      clicks.length = 0
      return { uniforms: off, live: false }
    }

    const radius = shadowRadius(width, height)
    const cx = rect[0] + rect[2] / 2
    const cy = rect[1] + rect[3] * 0.56
    // Arriving: how far the reader has come down to it, by how much of its rect is on screen.
    const arrived = still ? 1 : smooth(clamp((height - rect[1]) / Math.max(rect[3], 1), 0, 1))

    // The lean: the view tips toward the pointer, easing after it over half a second.
    const [px, py, presence] = input.pointer
    const k = still ? 1 : 1 - Math.exp(-Math.max(input.dt, 0) / 0.5)
    const tx = still ? 0 : clamp((px - cx) / Math.max(rect[2] * 0.5, 1), -1, 1) * presence
    const ty = still ? 0 : clamp((py - cy) / Math.max(rect[3] * 0.6, 1), -1, 1) * presence
    this.lean[0] += (tx - this.lean[0]) * k
    this.lean[1] += (ty - this.lean[1]) * k

    const inclination = (lerp(HOLE.inclination[0], HOLE.inclination[1], arrived) + this.lean[1] * HOLE.lean[1]) * DEG
    const bank = -this.lean[0] * HOLE.lean[0] * DEG

    // The hole's own axes, from the camera's: x in the disk toward the observer, z its normal.
    const centre = rayThrough(view, b, cx, cy)
    const toward: Vec3 = [-centre[0], -centre[1], -centre[2]]
    const upish = norm(mix3(b.up, centre, 1, -dot(b.up, centre)))
    const right = cross(centre, upish)
    const up = norm(mix3(upish, right, Math.cos(bank), Math.sin(bank)))
    const z = norm(mix3(toward, up, Math.cos(inclination), Math.sin(inclination)))
    const x = norm(mix3(toward, z, 1, -dot(toward, z)))
    const y = cross(z, x)
    const distance = (HOLE.shadow * view.focal) / radius
    const eye: Vec3 = [dot(toward, x) * distance, dot(toward, y) * distance, dot(toward, z) * distance]

    // Realms the reader dropped in since the last frame: onto the disk where the click's ray meets it,
    // or at its outer edge on that side.
    while (clicks.length > 0) {
      const click = clicks.shift()!
      if (still) continue
      const sx = Number.isNaN(click.x) ? cx + (Math.random() - 0.5) * rect[2] * 0.5 : click.x
      const sy = Number.isNaN(click.y) ? cy : click.y
      const ray = rayThrough(view, b, sx, sy)
      const d: Vec3 = [dot(ray, x), dot(ray, y), dot(ray, z)]
      const t = d[2] < -1e-4 ? -eye[2] / d[2] : -1
      // Missing the disk (above it on the page): in at its outer edge on the far side, under the click.
      let r = HOLE.outer
      let phi = Math.PI - Math.asin(clamp((d[1] * distance) / HOLE.outer, -1, 1))
      if (t > 0) {
        const hit: Vec3 = [eye[0] + d[0] * t, eye[1] + d[1] * t, 0]
        r = clamp(Math.hypot(hit[0], hit[1]), HOLE.inner + 3, HOLE.outer)
        phi = Math.atan2(hit[1], hit[0])
      }
      this.drops.push({ r, phi, age: 0 })
      if (this.drops.length > HOLE.drops) this.drops.shift()
    }

    // A dropped realm falls slowly at first and then plunges, turning faster the deeper it goes, and
    // dims into the well before it reaches the horizon.
    const dt = Math.min(Math.max(input.dt, 0), 0.1)
    const drops: number[][] = []
    this.drops = this.drops.filter((drop) => drop.r > 2.02)
    for (const drop of this.drops) {
      const fall = 1.4 + 70 * drop.r ** -1.5
      const turn = 2.6 * (HOLE.inner / drop.r) ** 1.5
      drop.r -= fall * dt
      drop.phi += turn * dt
      drop.age += dt
      const r = Math.max(drop.r, 2.02)
      const glow = smooth(drop.age / 0.25) * (1 - 2 / r) ** 1.5
      drops.push([r, drop.phi, glow, fall / turn])
    }
    while (drops.length < HOLE.drops) drops.push([0, 0, 0, 0])

    return {
      uniforms: {
        at: [cx, cy, radius, 1],
        box: [rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]],
        eye: [...eye, distance],
        ax: [...x, 0],
        ay: [...y, 0],
        az: [...z, seconds],
        drops,
      },
      live: !still,
    }
  }
}
