import { TONES } from "@/components/realms/hive/cube"
import { DOOR_BLUE, DOOR_LIGHT, SPACE, toLinear } from "@/components/realms/hive/light"
import { fieldWgsl, PAGE } from "@/components/field/stage"

import { holeWgsl } from "./blackhole"
import { DOOR_BOX, MAX_REALMS } from "./world"

const f = (n: number) => n.toFixed(6)
const vec3 = (rgb: readonly number[]) => `vec3f(${rgb.map(f).join(", ")})`
const lin3 = (rgb: readonly number[]) => vec3(rgb.map(toLinear))

/** How many of each thing the passes are told about at once. */
export const PAGE_REALMS = 14
export const TOUCHED = 8
export const CLEAR = 12
export const PANELS = 2
export const BEAMS = 3
export const PULSES = 2
/** Near stars: cells per side of the block round the camera, and a cell's edge in world units. */
export const STAR_BLOCK = 22
export const STAR_CELL = 5.5
/** The realm mesh: fourteen quads, two triangles each. */
export const REALM_VERTICES = 84

export type SceneUniforms = {
  eye: number[]
  fwd: number[]
  right: number[]
  up: number[]
  view: number[]
  clock: number[]
  prevEye: number[]
  prevFwd: number[]
  prevRight: number[]
  prevUp: number[]
  stars: number[]
  haze: number[]
  light: number[]
  holeBox: number[]
  flare: number[]
  touched: number[][]
  page: number[][]
}

export type RealmData = { items: number[][] }

/**
 * The camera and the moment, as every pass of the world reads them. Shared by the space pass, the
 * realms, their glows, the near stars and the sky, each of which declares `scene` with this struct.
 */
const sceneStruct = /* wgsl */ `
struct Scene {
  eye: vec4f,       // xyz eye (world), w focal (CSS px)
  fwd: vec4f,       // xyz forward, w near plane
  right: vec4f,     // xyz right, w render scale (target px per CSS px)
  up: vec4f,        // xyz up, w unused
  view: vec4f,      // width, height (CSS px), principal point x, y (CSS px)
  clock: vec4f,     // seconds, still (1) or moving (0), share of doorways lit, the last frame's seconds
  prevEye: vec4f,   // the last frame's camera, for the near stars' streaks: eye, focal
  prevFwd: vec4f,   //   forward, principal point x
  prevRight: vec4f, //   right, principal point y
  prevUp: vec4f,    //   up, unused
  stars: vec4f,     // the near stars' block: origin cell x, y, z, and how far they are drawn
  haze: vec4f,      // distance the haze into the sky starts, its density, the sky's turn (rad), unused
  light: vec4f,     // the key light: direction toward it, strength
  holeBox: vec4f,   // the black hole's rect on the page, kept clear of realms: left, top, right, bottom
  flare: vec4f,     // a light flaring inside a nebula: where (world), how bright
  touched: array<vec4f, ${TOUCHED * 5}>,    // realms the page has a hand on (see Special)
  page: array<vec4f, ${PAGE_REALMS * 5}>,   // the page's own realms: the chapters' and the team's
}
`

/** WGSL shared by the passes that draw realms: the hash the page shares, the pose, the doorway. */
const realmWgsl = /* wgsl */ `
const REALM_COUNT = ${MAX_REALMS}u;
const PAGE_COUNT = ${PAGE_REALMS}u;
const TOUCH_COUNT = ${TOUCHED};
const X0 = ${f(DOOR_BOX.x0)};
const X1 = ${f(DOOR_BOX.x1)};
const Z0 = ${f(DOOR_BOX.z0)};
const Z1 = ${f(DOOR_BOX.z1)};
const YB = ${f(DOOR_BOX.back)};
const DEPTH = ${f(DOOR_BOX.back + 0.5)};
const DOOR_MID = ${f((DOOR_BOX.z0 + DOOR_BOX.z1) / 2)};
const DOOR_LIGHT = ${vec3(DOOR_LIGHT)};
const DOOR_BLUE = ${vec3(DOOR_BLUE)};

fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// Four numbers in 0..1 for a realm and a purpose: world.ts's seed4, to the bit.
fn seed4(i: u32, salt: u32) -> vec4f {
  let h = pcg(i * 2654435761u + salt);
  return vec4f(f32(h & 255u), f32((h >> 8u) & 255u), f32((h >> 16u) & 255u), f32(h >> 24u)) / 255.0;
}

// The spin about the realm's own axis, then that axis leaned by tilt toward lean (world.ts's turn).
fn turnAxes(yaw: f32, tilt: f32, lean: f32) -> mat3x3f {
  let cy = cos(yaw);
  let sy = sin(yaw);
  let sx = vec3f(cy, sy, 0.0);
  let syv = vec3f(-sy, cy, 0.0);
  let sz = vec3f(0.0, 0.0, 1.0);
  let k = vec3f(cos(lean), sin(lean), 0.0);
  let c = cos(tilt);
  let s = sin(tilt);
  let ax = sx * c + cross(k, sx) * s + k * dot(k, sx) * (1.0 - c);
  let ay = syv * c + cross(k, syv) * s + k * dot(k, syv) * (1.0 - c);
  let az = sz * c + cross(k, sz) * s + k * dot(k, sz) * (1.0 - c);
  return mat3x3f(ax, ay, az);
}

fn bobOf(i: u32, size: f32, t: f32) -> vec3f {
  let h = seed4(i, 101u);
  let amp = (0.08 + 0.3 * h.x) * sqrt(max(size, 0.2));
  let w = 6.2831853 / (10.0 + 14.0 * h.y);
  let phase = 6.2831853 * h.z;
  return vec3f(0.35 * amp * sin(w * t + phase + 1.7), 0.35 * amp * cos(0.8 * w * t + phase), amp * sin(w * t + phase));
}

// An agent at work: each realm keeps its own long rhythm, lit for half a minute to a minute and a
// half, then dark for a long while, coming up and going down over two seconds. How many realms are in
// their lit stretch is the page's to say (clock.z).
fn doorOf(i: u32, t: f32) -> vec2f {
  let h = seed4(i, 202u);
  let busy = 30.0 + 50.0 * h.x;
  let period = busy / max(scene.clock.z * (0.6 + 0.8 * h.z), 1e-3);
  let x = fract(t / period + h.y) * period;
  let lit = smoothstep(0.0, 2.0, x) * (1.0 - smoothstep(busy, busy + 2.0, x)) * (0.75 + 0.25 * h.w);
  let blue = smoothstep(0.7, 0.8, fract(h.w * 7.31));
  return vec2f(lit, blue);
}

// A realm as it is drawn this frame: where, its axes (each its edge long), and its doorway.
struct Pose {
  at: vec3f,
  ax: mat3x3f,
  size: f32,
  glow: f32,     // the doorway's light
  blue: f32,     // how much of it is Realm's blue
  open: f32,     // thrown open: light pouring out
  hover: f32,    // the pointer near it
  ok: bool,
}

// A realm the page sets by hand (the chapters' and the team's, and any the reader is touching): five
// vec4s, its middle and size, its three axes with the doorway's glow, blue and open in their w, and
// which background realm it stands in for (< 0: a realm of the page's own) with how near the pointer is.
fn special(a: vec4f, x: vec4f, y: vec4f, z: vec4f, e: vec4f) -> Pose {
  return Pose(a.xyz, mat3x3f(x.xyz, y.xyz, z.xyz), a.w, x.w, y.w, z.w, e.y, a.w > 0.0);
}

fn poseOf(ii: u32) -> Pose {
  let t = scene.clock.x;
  if (ii >= REALM_COUNT) {
    let k = (ii - REALM_COUNT) * 5u;
    return special(scene.page[k], scene.page[k + 1u], scene.page[k + 2u], scene.page[k + 3u], scene.page[k + 4u]);
  }
  let a = realms.items[ii * 2u];
  let b = realms.items[ii * 2u + 1u];
  if (a.w <= 0.0) {
    return Pose(vec3f(0.0), mat3x3f(vec3f(0.0), vec3f(0.0), vec3f(0.0)), 0.0, 0.0, 0.0, 0.0, 0.0, false);
  }
  for (var j = 0; j < TOUCH_COUNT; j++) {
    let e = scene.touched[j * 5 + 4];
    if (e.x >= 0.0 && u32(e.x + 0.5) == ii) {
      var p = special(scene.touched[j * 5], scene.touched[j * 5 + 1], scene.touched[j * 5 + 2], scene.touched[j * 5 + 3], e);
      // A hand on it lights it; its own rhythm still shows through.
      let own = doorOf(ii, t);
      if (own.x > p.glow) {
        p.glow = own.x;
        p.blue = own.y;
      }
      return p;
    }
  }
  let r = turnAxes(b.x + b.y * t, b.z, b.w);
  let lit = doorOf(ii, t);
  return Pose(a.xyz + bobOf(ii, a.w, t), mat3x3f(r[0] * a.w, r[1] * a.w, r[2] * a.w), a.w, lit.x, lit.y, 0.0, 0.0, true);
}

// Where a point of the world lands on the page, in CSS px, and its depth along the axis.
fn toPage(p: vec3f) -> vec3f {
  let v = p - scene.eye.xyz;
  let z = dot(v, scene.fwd.xyz);
  let s = scene.eye.w / z;
  return vec3f(scene.view.z + dot(v, scene.right.xyz) * s, scene.view.w - dot(v, scene.up.xyz) * s, z);
}

fn toClip(p: vec3f) -> vec4f {
  let v = p - scene.eye.xyz;
  let z = dot(v, scene.fwd.xyz);
  let s = scene.eye.w / z;
  let sx = scene.view.z + dot(v, scene.right.xyz) * s;
  let sy = scene.view.w - dot(v, scene.up.xyz) * s;
  let ndc = vec2f(sx / scene.view.x * 2.0 - 1.0, 1.0 - sy / scene.view.y * 2.0);
  return vec4f(ndc * z, scene.fwd.w, z);
}

fn inHoleBox(p: vec2f, r: f32) -> bool {
  let b = scene.holeBox;
  return b.z > b.x && p.x > b.x - r && p.x < b.z + r && p.y > b.y - r && p.y < b.w + r;
}
`

/** Noise the space pass and the sky share. */
const noiseWgsl = /* wgsl */ `
fn hash3(p: vec3i) -> f32 {
  let h = pcg3(bitcast<vec3u>(p));
  return f32(h & 0xffffu) / 65535.0;
}

fn pcg3(v0: vec3u) -> u32 {
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z;
  return v.x ^ v.z;
}

// Value noise in three dimensions with a quintic fade: soft enough for gas.
fn noise3(p: vec3f) -> f32 {
  let i = vec3i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = mix(hash3(i), hash3(i + vec3i(1, 0, 0)), u.x);
  let b = mix(hash3(i + vec3i(0, 1, 0)), hash3(i + vec3i(1, 1, 0)), u.x);
  let c = mix(hash3(i + vec3i(0, 0, 1)), hash3(i + vec3i(1, 0, 1)), u.x);
  let d = mix(hash3(i + vec3i(0, 1, 1)), hash3(i + vec3i(1, 1, 1)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}

const OCTAVE = mat3x3f(vec3f(0.0, 0.8, 0.6), vec3f(-0.8, 0.36, -0.48), vec3f(-0.6, -0.48, 0.64));

fn fbm3(p0: vec3f, octaves: i32) -> f32 {
  var p = p0;
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  for (var i = 0; i < octaves; i++) {
    sum += amp * noise3(p);
    norm += amp;
    p = OCTAVE * p * 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

// The far sky turns slowly about a tilted axis, as a night sky does in a long exposure.
fn skyTurn(rd: vec3f, angle: f32) -> vec3f {
  let k = normalize(vec3f(0.3, 0.2, 0.93));
  let c = cos(angle);
  let s = sin(angle);
  return rd * c + cross(k, rd) * s + k * dot(k, rd) * (1.0 - c);
}
`

/** The palette, linear, as WGSL constants. */
const paletteWgsl = /* wgsl */ `
const SPACE_DEEP = ${vec3(SPACE.deep)};
const SPACE_NAVY = ${vec3(SPACE.navy)};
const NEB_CLOUD = ${vec3(SPACE.cloud)};
const NEB_BLUE = ${vec3(SPACE.blue)};
const NEB_CYAN = ${vec3(SPACE.cyan)};
const NEB_WHITE = ${vec3(SPACE.white)};
const STARLIGHT = ${vec3(SPACE.key)};
// The plane the galaxy's band of light lies in, as its normal.
const BAND = vec3f(0.75, -0.12, 0.65);
// How the sky's light is exposed: radiance in, the 0..1 the scene target holds out.
const EXPOSURE = 1.6;
`

/**
 * The deep sky, at half the page's resolution: a band of the galaxy's light across it, a few far
 * galaxies, and nebulae hanging at real distances, marched as volumes so they have depth, light from
 * the stars inside them, and dust that dims what is behind. They are near enough that the flight
 * moves past them, far enough that they move slowly; and they move on their own, the gas billowing
 * and drifting and the far sky turning, so the sky is never still unless the reader asks for stillness.
 */
export const spaceShader = /* wgsl */ `
${sceneStruct}
@group(0) @binding(0) var<uniform> scene: Scene;

${fieldWgsl}
${paletteWgsl}
${noiseWgsl}

// Each nebula, three vec4s: its middle (world) and radius; the axis it is drawn out along and by how
// much; and its character: how far its light leans to cyan, how much dust it carries, its grain's
// scale, and how fast its gas moves.
const NEBULAE = 5;
var<private> NEB: array<vec4f, 15> = array<vec4f, 15>(
  // The opening's two: high on the right, bright; and on the left, dusty, lit at one edge.
  vec4f(183.0, 394.0, 183.0, 140.0), vec4f(0.35, 0.15, 0.92, 1.7), vec4f(0.9, 0.3, 0.017, 1.0),
  vec4f(-163.0, 350.0, 140.0, 150.0), vec4f(0.8, 0.45, 0.4, 1.9), vec4f(0.4, 1.0, 0.016, 0.8),
  // Ahead and low: the one the chapters look into, its heart under their screens.
  vec4f(60.0, 820.0, -120.0, 260.0), vec4f(0.85, 0.15, 0.5, 2.1), vec4f(0.65, 0.6, 0.0105, 0.9),
  // Below, for the climb.
  vec4f(30.0, 620.0, -200.0, 200.0), vec4f(0.25, 0.85, 0.3, 1.6), vec4f(0.7, 0.6, 0.013, 0.9),
  // Far ahead and high: a long ribbon across the sky, under the opening's words and over every
  // chapter's screen, and low in the finale's sky.
  vec4f(40.0, 950.0, 180.0, 260.0), vec4f(1.0, 0.0, 0.08, 2.8), vec4f(0.5, 0.7, 0.0115, 1.1),
);
// A star inside each, lighting its gas from within: where, relative to the middle, as a share of the
// radius, and how bright.
var<private> CORE: array<vec4f, 5> = array<vec4f, 5>(
  vec4f(0.0, 0.0, 0.0, 1.1),
  vec4f(0.15, -0.1, 0.0, 0.6),
  vec4f(0.0, -0.2, 0.15, 1.0),
  vec4f(0.0, 0.0, 0.1, 0.8),
  vec4f(-0.15, 0.0, 0.0, 0.8),
);

fn sphere(o: vec3f, d: vec3f, c: vec3f, r: f32) -> vec2f {
  let oc = o - c;
  let b = dot(oc, d);
  let q = dot(oc, oc) - r * r;
  let h = b * b - q;
  if (h <= 0.0) { return vec2f(-1.0); }
  let s = sqrt(h);
  return vec2f(max(-b - s, 0.0), -b + s);
}

// Filaments: noise folded at its middle, so its crests are thin bright threads rather than blobs.
fn ridged(p0: vec3f) -> f32 {
  var p = p0;
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  for (var i = 0; i < 3; i++) {
    let n = 1.0 - abs(noise3(p) * 2.0 - 1.0);
    sum += amp * n * n;
    norm += amp;
    p = OCTAVE * p * 2.07;
    amp *= 0.55;
  }
  return sum / norm;
}

// One nebula seen along a ray: the light it adds, and how much of what is behind it still shows.
//
// Its body is marched as a volume in a few steps, so it has depth, the star inside lights the gas
// round it, and its dust darkens what is behind; the fine threads of gas are worked out once per pixel,
// at the point of the ray the body's light came from, so they stay crisp and never break up into the
// grain a coarse march leaves.
fn nebula(k: i32, o: vec3f, d: vec3f, t: f32) -> vec4f {
  let n = NEB[k * 3];
  let axis = NEB[k * 3 + 1];
  let m = NEB[k * 3 + 2];
  let hit = sphere(o, d, n.xyz, n.w);
  if (hit.y <= 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  // A fixed number of steps, so no seam runs across the sky where a count would change.
  let steps = 5;
  let dt = (hit.y - hit.x) / f32(steps);
  let core = n.xyz + CORE[k].xyz * n.w;
  // The flare the page sets off now and then, when it is in this one.
  let flareIn = select(0.0, scene.flare.w, distance(scene.flare.xyz, n.xyz) < 1.0);
  let coreLight = CORE[k].w * (1.0 + 3.0 * flareIn);
  let along = normalize(axis.xyz);
  // The gas drifts and turns slowly about the middle, and billows as it goes.
  let drift = vec3f(0.6, -0.35, 0.25) * t * m.w * 2.2;
  let swirl = t * 0.005 * m.w;
  let cs = cos(swirl);
  let sn = sin(swirl);
  var glow = 0.0;
  var lit = 0.0;
  var depth = 0.0;
  var centre = vec3f(0.0);
  var weight = 0.0;
  for (var i = 0; i < steps; i++) {
    let p = o + d * (hit.x + (f32(i) + 0.5) * dt);
    var rel = (p - n.xyz) / n.w;
    // Drawn out along its axis: a nebula is a cloud with a grain, not a ball.
    rel += along * dot(rel, along) * (1.0 / axis.w - 1.0);
    let r = length(rel);
    if (r >= 1.0) { continue; }
    let turned = vec3f(rel.x * cs - rel.y * sn, rel.x * sn + rel.y * cs, rel.z) * n.w;
    let q = turned * m.z + drift * m.z + vec3f(f32(k) * 17.3);
    let body = fbm3(q * 0.6 + vec3f(0.0, 0.0, t * 0.02), 3);
    // Most of a nebula's light is near its heart: the envelope falls away steeply.
    let edge = pow(smoothstep(1.0, 0.0, r + (body - 0.5) * 0.9), 1.5);
    let g = edge * smoothstep(0.3, 0.75, body);
    let step = dt / n.w;
    let toCore = distance(p, core) / n.w;
    let near = coreLight / (1.0 + toCore * toCore * 40.0);
    let w = g * step * exp(-depth);
    glow += w;
    lit += w * near;
    centre += p * w;
    weight += w;
    depth += g * step * 1.4;
  }
  if (weight <= 1e-5) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  // The threads, where the light came from.
  let p = centre / weight;
  var rel = (p - n.xyz) / n.w;
  rel += along * dot(rel, along) * (1.0 / axis.w - 1.0);
  let turned = vec3f(rel.x * cs - rel.y * sn, rel.x * sn + rel.y * cs, rel.z) * n.w;
  let q = turned * m.z + drift * m.z + vec3f(f32(k) * 17.3);
  let w = vec3f(noise3(q * 0.45 + vec3f(0.0, 0.0, t * 0.03)), noise3(q * 0.45 + vec3f(5.2, 1.3, -t * 0.025)), 0.5) - 0.5;
  // Threads of gas, softened by the billows they run through, so they read as gas rather than as arcs.
  let threads = mix(smoothstep(0.5, 1.0, ridged(q * 1.4 + w * 2.4)), smoothstep(0.4, 0.8, fbm3(q * 2.1 + w, 2)), 0.3);
  let dust = smoothstep(0.48, 0.72, fbm3(q * 1.15 + vec3f(31.0) + w, 3)) * m.y;
  let light = lit / max(glow, 1e-5);
  let heat = glow * (0.3 + 1.9 * threads) * (0.45 + 4.0 * light);
  var e = mix(NEB_CLOUD, NEB_BLUE, smoothstep(0.0, 0.3, heat));
  e = mix(e, mix(NEB_BLUE, NEB_CYAN, m.x), smoothstep(0.25, 0.9, heat));
  e = mix(e, NEB_WHITE, smoothstep(0.9, 2.2, heat));
  var color = e * heat * 1.7 * (1.0 - dust * 0.85);
  // The star's own light, scattered in the gas close round it.
  color += mix(NEB_CYAN, NEB_WHITE, 0.45) * lit * light * 1.6;
  let through = exp(-(glow * (0.6 + 0.8 * threads) + glow * dust * 6.0));
  return vec4f(color, through);
}

// A far galaxy: a disc of stars wound into two arms, seen at a slant, turning very slowly.
fn galaxy(rd: vec3f, g: vec3f, tiltAxis: vec3f, size: f32, turn: f32, bright: f32) -> vec3f {
  let c = dot(rd, g);
  if (c < cos(size * 3.0)) { return vec3f(0.0); }
  let e1 = normalize(cross(g, tiltAxis));
  let e2 = cross(g, e1);
  // The disc is inclined: one of its axes foreshortened.
  var p = vec2f(dot(rd, e1), dot(rd, e2) * 2.6) / tan(size);
  let r = length(p);
  let a = atan2(p.y, p.x);
  let arms = pow(0.5 + 0.5 * cos(2.0 * (a - log(max(r, 0.02)) * 2.4 - turn)), 3.0);
  let disc = exp(-r * 2.6) * (0.25 + 0.75 * arms) * smoothstep(1.6, 0.4, r);
  let core = exp(-r * r * 40.0);
  return (mix(NEB_BLUE, NEB_WHITE, 0.45) * disc * 0.16 + NEB_WHITE * core * 0.5) * bright;
}

// The sky with no nebula in front of it: deep navy, the galaxy's band across it with dust in it, and
// the far galaxies. Directions here are the turning far sky's.
fn farSky(rd: vec3f, t: f32) -> vec3f {
  let across = dot(rd, BAND);
  let band = exp(-across * across / 0.05);
  let grain = fbm3(rd * 3.2 + vec3f(1.3, 4.1, 2.2), 4);
  let dust = smoothstep(0.42, 0.75, fbm3(rd * 7.0 + vec3f(9.1, 2.3, 4.7), 4)) * exp(-across * across / 0.012);
  var c = mix(SPACE_DEEP, SPACE_NAVY, 0.25 + 0.75 * band * (0.45 + 0.55 * grain));
  c += mix(NEB_CLOUD, NEB_WHITE, 0.12) * band * band * grain * grain * 0.09 * (1.0 - dust * 0.85);
  // A wide, faint veil everywhere, so no part of the sky is a flat colour.
  c += NEB_CLOUD * 0.012 * smoothstep(0.35, 0.8, fbm3(rd * 1.6 + vec3f(3.0), 3));
  c += galaxy(rd, normalize(vec3f(0.62, 0.7, 0.36)), vec3f(0.2, 0.1, 1.0), 0.03, t * 0.004, 1.0);
  c += galaxy(rd, normalize(vec3f(-0.55, 0.76, 0.2)), vec3f(0.9, 0.3, 0.2), 0.02, -t * 0.005 + 2.0, 0.8);
  c += galaxy(rd, normalize(vec3f(0.321, 0.933, 0.165)), vec3f(0.3, 0.2, 0.95), 0.034, t * 0.004 + 0.7, 1.1);
  c += galaxy(rd, normalize(vec3f(0.18, 0.93, 0.32)), vec3f(0.4, 0.8, 0.1), 0.012, t * 0.006 + 4.0, 0.9);
  c += galaxy(rd, normalize(vec3f(-0.25, 0.6, -0.76)), vec3f(0.1, 0.9, 0.3), 0.04, t * 0.003 + 1.0, 0.7);
  c += galaxy(rd, normalize(vec3f(0.85, 0.2, -0.48)), vec3f(0.6, 0.1, 0.7), 0.018, -t * 0.004, 0.8);
  return c;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let page = uv * scene.view.xy;
  let f = scene.eye.w;
  let rd = normalize(scene.fwd.xyz + scene.right.xyz * ((page.x - scene.view.z) / f) - scene.up.xyz * ((page.y - scene.view.w) / f));
  let t = scene.clock.x;
  var c = farSky(skyTurn(rd, scene.haze.z), t);
  // The nebulae, the far ones first, each over what is behind it.
  for (var k = 0; k < NEBULAE; k++) {
    let n = nebula(k, scene.eye.xyz, rd, t);
    c = c * n.w + n.rgb;
  }
  return vec4f(vec3f(1.0) - exp(-c * EXPOSURE), 1.0);
}
`

/**
 * The world, drawn into an offscreen multisampled target at the page's CSS resolution:
 *
 *   vs_realm / fs_realm  every realm in the sky, one instance each, the mark's cube with its doorway
 *                        cut, generated from the vertex index; the population is a uniform, the
 *                        moment's turn and bob are worked out here, as world.ts works them out
 *   vs_sky / fs_sky      the deep sky behind them (the space pass, sampled), the far stars, and the
 *                        black hole at the foot of the page
 *   vs_glow / fs_glow    the light round a lit doorway, and a realm too far to draw as a point of light
 *   vs_star / fs_star    the near stars, fixed in the world, so the flight moves through them
 *
 * Depth is reversed (1 near, 0 far). The alpha channel carries the inverse of the distance to what a
 * pixel shows (0 for the sky), which the composite uses to hide its light behind the realms.
 */
export const sceneShader = /* wgsl */ `
${sceneStruct}
struct Realms { items: array<vec4f, ${MAX_REALMS * 2}> }
@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<uniform> hole: Hole;
@group(0) @binding(2) var<uniform> realms: Realms;
@group(0) @binding(3) var spaceTex: texture_2d<f32>;
@group(0) @binding(4) var spaceSampler: sampler;

${fieldWgsl}
${holeWgsl}
${paletteWgsl}
${realmWgsl}
${noiseWgsl}

// The mark's tones, linear.
const TOP_FAR = ${lin3(TONES.top[0])};
const TOP_NEAR = ${lin3(TONES.top[1])};
const LEFT_HIGH = ${lin3(TONES.left[0])};
const LEFT_LOW = ${lin3(TONES.left[1])};
const RIGHT_HIGH = ${lin3(TONES.right[0])};
const RIGHT_LOW = ${lin3(TONES.right[1])};
const LIT_HIGH = ${lin3(TONES.lit[0])};
const LIT_LOW = ${lin3(TONES.lit[1])};

// The deep sky behind a point of the page, from the space pass: four taps of it, a texel apart, since
// its nebulae were marched with a jitter that would otherwise show as grain.
fn backdrop(css: vec2f) -> vec3f {
  let uv = css / scene.view.xy;
  let texel = 1.0 / vec2f(textureDimensions(spaceTex));
  let a = textureSampleLevel(spaceTex, spaceSampler, saturate(uv + texel * vec2f(-0.75, -0.75)), 0.0).rgb;
  let b = textureSampleLevel(spaceTex, spaceSampler, saturate(uv + texel * vec2f(0.75, -0.75)), 0.0).rgb;
  let c = textureSampleLevel(spaceTex, spaceSampler, saturate(uv + texel * vec2f(-0.75, 0.75)), 0.0).rgb;
  let d = textureSampleLevel(spaceTex, spaceSampler, saturate(uv + texel * vec2f(0.75, 0.75)), 0.0).rgb;
  return (a + b + c + d) * 0.25;
}

// Haze: in space there is no air, but a far realm still goes the colour of the sky behind it, because
// the light between is what the eye has to read it by. Light, then the sky's share.
fn hazeAt(d: f32) -> f32 {
  return 1.0 - exp(-max(d - scene.haze.x, 0.0) * scene.haze.y);
}

// ---- the realms ---------------------------------------------------------------------------------

var<private> Q_O: array<vec3f, 14> = array<vec3f, 14>(
  vec3f(-0.5, -0.5, 1.0), vec3f(-0.5, -0.5, 0.0),
  vec3f(-0.5, -0.5, 0.0), vec3f(X1, -0.5, 0.0), vec3f(X0, -0.5, 0.0), vec3f(X0, -0.5, Z1 + 0.5),
  vec3f(-0.5, 0.5, 0.0), vec3f(0.5, -0.5, 0.0),
  vec3f(X0, YB, Z0 + 0.5), vec3f(X0, -0.5, Z0 + 0.5), vec3f(X0, -0.5, Z1 + 0.5), vec3f(X0, -0.5, Z0 + 0.5), vec3f(X1, -0.5, Z0 + 0.5),
  vec3f(-0.5, -0.5, 0.0),
);
var<private> Q_U: array<vec3f, 14> = array<vec3f, 14>(
  vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0),
  vec3f(X0 + 0.5, 0.0, 0.0), vec3f(0.5 - X1, 0.0, 0.0), vec3f(X1 - X0, 0.0, 0.0), vec3f(X1 - X0, 0.0, 0.0),
  vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0),
  vec3f(X1 - X0, 0.0, 0.0), vec3f(X1 - X0, 0.0, 0.0), vec3f(0.0, DEPTH, 0.0), vec3f(0.0, DEPTH, 0.0), vec3f(0.0, 0.0, Z1 - Z0),
  vec3f(0.0, 1.0, 0.0),
);
var<private> Q_V: array<vec3f, 14> = array<vec3f, 14>(
  vec3f(0.0, 1.0, 0.0), vec3f(0.0, 1.0, 0.0),
  vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, Z0 + 0.5), vec3f(0.0, 0.0, 0.5 - Z1),
  vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0),
  vec3f(0.0, 0.0, Z1 - Z0), vec3f(0.0, DEPTH, 0.0), vec3f(X1 - X0, 0.0, 0.0), vec3f(0.0, 0.0, Z1 - Z0), vec3f(0.0, DEPTH, 0.0),
  vec3f(1.0, 0.0, 0.0),
);
// 0 top, 1 left wall, 2 dark wall, 3 back, 4 right, 5 the doorway's lit back, 6 its floor,
// 7 its lintel, 8 and 9 its jambs, 10 the bottom.
var<private> Q_F: array<u32, 14> = array<u32, 14>(0u, 1u, 2u, 2u, 2u, 2u, 3u, 4u, 5u, 6u, 7u, 8u, 9u, 10u);
var<private> Q_N: array<vec3f, 11> = array<vec3f, 11>(
  vec3f(0.0, 0.0, 1.0), vec3f(-1.0, 0.0, 0.0), vec3f(0.0, -1.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0),
  vec3f(0.0, -1.0, 0.0), vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0), vec3f(1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0),
  vec3f(0.0, 0.0, -1.0),
);
var<private> CORNERS: array<vec2f, 6> = array<vec2f, 6>(
  vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
);

struct RealmOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) local: vec3f,
  @location(2) @interpolate(flat) info: vec4f,    // face, glow, blue, open
  @location(3) @interpolate(flat) normal: vec4f,  // the face's normal in the world, hover
  @location(4) @interpolate(flat) size: f32,
}

const NOTHING = vec4f(2.0, 2.0, 2.0, 1.0);

@vertex fn vs_realm(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RealmOut {
  var out: RealmOut;
  let pose = poseOf(ii);
  if (!pose.ok) {
    out.clip = NOTHING;
    return out;
  }
  // Too far, behind the camera, too small to draw as a solid (it is a point of light then, vs_glow),
  // or over the black hole, whose sky is bent and whose realms are its own.
  let c = toPage(pose.at);
  let px = scene.eye.w * pose.size / max(c.z, 1e-3);
  if (c.z < -pose.size * 1.5 || px < 2.2 || inHoleBox(c.xy, px)) {
    out.clip = NOTHING;
    return out;
  }
  let q = vi / 6u;
  let k = CORNERS[vi % 6u];
  let local = Q_O[q] + Q_U[q] * k.x + Q_V[q] * k.y - vec3f(0.0, 0.0, 0.5);
  let world = pose.at + pose.ax * local;
  let face = Q_F[q];
  out.clip = toClip(world);
  out.world = world;
  out.local = local;
  out.info = vec4f(f32(face), pose.glow, pose.blue, pose.open);
  out.normal = vec4f(normalize(pose.ax * Q_N[face]), pose.hover);
  out.size = pose.size;
  return out;
}

// How far a point of a face is from that face's edges, in local units: the cube's own edges, and on
// the dark wall the doorway's.
fn edgeOf(face: u32, l: vec3f) -> f32 {
  var a = vec2f(0.0);
  switch (face) {
    case 0u, 10u: { a = l.xy; }
    case 1u, 4u: { a = l.yz; }
    default: { a = l.xz; }
  }
  var e = 0.5 - max(abs(a.x), abs(a.y));
  if (face == 2u) {
    let door = vec2f((X0 + X1) * 0.5, DOOR_MID);
    let half = vec2f((X1 - X0) * 0.5, (Z1 - Z0) * 0.5);
    let q = abs(l.xz - door) - half;
    e = min(e, abs(length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0)));
  }
  return e;
}

@fragment fn fs_realm(in: RealmOut) -> @location(0) vec4f {
  let face = u32(in.info.x + 0.5);
  let glow = in.info.y;
  let open = in.info.w;
  let tint = mix(DOOR_LIGHT, DOOR_BLUE, in.info.z);
  let l = in.local;
  let n = in.normal.xyz;
  let hover = in.normal.w;
  let toEye = scene.eye.xyz - in.world;
  let d = length(toEye);
  let v = toEye / d;
  let key = scene.light.xyz;

  var tone = TOP_NEAR;
  var emit = vec3f(0.0);
  var inside = 1.0;
  let k = saturate((l.z + 0.5 - Z0) / (Z1 - Z0));
  switch (face) {
    case 0u: { tone = mix(TOP_NEAR, TOP_FAR, saturate((l.x + l.y + 1.0) * 0.5)); }
    case 1u: { tone = mix(LEFT_LOW, LEFT_HIGH, saturate(l.z + 0.5)); }
    case 2u: { tone = mix(RIGHT_LOW, RIGHT_HIGH, saturate(l.z + 0.5)); }
    case 3u: { tone = mix(LEFT_LOW, LEFT_HIGH, saturate(l.z + 0.5)) * 0.8; }
    case 4u: { tone = mix(RIGHT_LOW, RIGHT_HIGH, saturate(l.z + 0.5)) * 1.1; }
    case 5u: {
      // The doorway's back: the light itself when an agent is at work, brightest under the lintel.
      tone = mix(LIT_LOW, LIT_HIGH, k);
      inside = 0.12;
      emit = tone * tint * glow * mix(1.25, 1.75, k) * (1.0 + 1.6 * open);
    }
    case 6u: { tone = TOP_NEAR; inside = 0.4; emit = tone * tint * glow * 0.6 * (1.0 + open); }
    case 7u: { tone = RIGHT_LOW; inside = 0.25; emit = tone * tint * glow * 0.4 * (1.0 + open); }
    case 10u: { tone = mix(RIGHT_LOW, LEFT_LOW, 0.5) * 0.8; }
    default: { tone = LEFT_LOW; inside = 0.4; emit = tone * tint * glow * 0.5 * (1.0 + open); }
  }

  // Lit by a far cluster of stars, and from the other side by the sky's own blue; the edge turned away
  // from the eye catches a little of the nebulae behind it.
  let lambert = max(dot(n, key), 0.0);
  let fill = 0.5 + 0.5 * dot(n, -key);
  var light = STARLIGHT * scene.light.w * lambert * inside;
  light += NEB_BLUE * 0.05 * fill * inside + SPACE_NAVY * 0.6;
  let rim = pow(1.0 - abs(dot(n, v)), 3.0);
  let sheen = pow(max(dot(n, normalize(key + v)), 0.0), 28.0) * scene.light.w;
  var radiance = tone * light + (NEB_CYAN * rim * 0.09 + STARLIGHT * sheen * 0.22) * inside + emit;
  // The pointer's light: the realm it is near is lit a step brighter, its edges in Realm's blue.
  radiance += tone * NEB_BLUE * hover * 0.09 * inside;
  // The cube's edges, a hairline of light where they catch it, so a realm holds its shape in the dark.
  let e = edgeOf(face, l);
  let px = fwidth(e);
  let line = (1.0 - smoothstep(0.0, px * 1.4, e)) * select(1.0, 0.0, face >= 5u && face != 10u);
  radiance += (STARLIGHT * 0.05 * (0.4 + lambert) + NEB_BLUE * hover * 0.12) * line;

  var color = vec3f(1.0) - exp(-radiance);
  // Far off, a realm dims toward the dark and takes a little of the sky's colour: it recedes, and it
  // still stands in front of the nebula behind it rather than showing it through.
  let sky = backdrop(in.clip.xy / scene.right.w);
  // A giant hazes as a realm a few times nearer would: big enough to hold its shape that far off.
  color = mix(color, SPACE_DEEP * EXPOSURE + sky * 0.3, hazeAt(d / (1.0 + max(in.size - 1.0, 0.0) * 0.22)));
  return vec4f(color, 1.0 / d);
}

// ---- the glow round a lit doorway, and a far realm as a point --------------------------------------

struct GlowOut {
  @builtin(position) clip: vec4f,
  @location(0) offset: vec2f,
  @location(1) @interpolate(flat) color: vec4f,
}

@vertex fn vs_glow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GlowOut {
  var out: GlowOut;
  let pose = poseOf(ii);
  if (!pose.ok) {
    out.clip = NOTHING;
    return out;
  }
  let c = toPage(pose.at);
  if (c.z < 0.5) {
    out.clip = NOTHING;
    return out;
  }
  let px = scene.eye.w * pose.size / c.z;
  let d = distance(pose.at, scene.eye.xyz);
  let haze = hazeAt(d);
  var centre = c.xy;
  var radius = 0.0;
  var color = vec3f(0.0);
  var depth = c.z;
  let tint = mix(DOOR_LIGHT, DOOR_BLUE, pose.blue);
  if (px < 2.6) {
    // Too far to draw as a solid: a point of the mark's grey in the starlight, and its doorway's light.
    let fade = smoothstep(2.6, 2.2, px);
    radius = max(px * 0.75, 0.9);
    color = (STARLIGHT * 0.16 * scene.light.w + tint * pose.glow * 0.9) * (1.0 - haze) * min(px / 1.2, 1.0) * fade;
  } else if (pose.glow > 0.01 || pose.open > 0.01) {
    // A lit doorway's glow, only from in front of it.
    let doorAt = pose.at + pose.ax * vec3f((X0 + X1) * 0.5, -0.56, DOOR_MID);
    let facingEye = dot(normalize(-pose.ax[1]), normalize(scene.eye.xyz - doorAt));
    if (facingEye <= 0.0) {
      out.clip = NOTHING;
      return out;
    }
    let dp = toPage(doorAt);
    centre = dp.xy;
    depth = dp.z;
    radius = max(px * (0.42 + 1.2 * pose.open), 4.0);
    color = tint * (pose.glow + 2.0 * pose.open) * (0.1 + 0.25 * facingEye) * (1.0 - haze * 0.8);
  } else {
    out.clip = NOTHING;
    return out;
  }
  if (inHoleBox(centre, radius)) {
    out.clip = NOTHING;
    return out;
  }
  let k = CORNERS[vi % 6u] * 2.0 - 1.0;
  let p = centre + k * radius * 2.2;
  let ndc = vec2f(p.x / scene.view.x * 2.0 - 1.0, 1.0 - p.y / scene.view.y * 2.0);
  out.clip = vec4f(ndc * depth, scene.fwd.w, depth);
  out.offset = k * 2.2;
  out.color = vec4f(color, radius);
  return out;
}

@fragment fn fs_glow(in: GlowOut) -> @location(0) vec4f {
  let r2 = dot(in.offset, in.offset);
  let core = exp(-r2 * 2.2);
  let halo = exp(-r2 * 0.6) * 0.35;
  return vec4f(in.color.rgb * (core + halo), 0.0);
}

// ---- the near stars ------------------------------------------------------------------------------

struct StarOut {
  @builtin(position) clip: vec4f,
  @location(0) along: vec2f,       // where across the streak: along it (0 tail .. 1 head), and across (px)
  @location(1) @interpolate(flat) color: vec4f,   // light, and the streak's length in px
  @location(2) @interpolate(flat) width: f32,
}

fn prevPage(p: vec3f) -> vec3f {
  let v = p - scene.prevEye.xyz;
  let z = dot(v, scene.prevFwd.xyz);
  let s = scene.prevEye.w / max(z, 1e-3);
  return vec3f(scene.prevFwd.w + dot(v, scene.prevRight.xyz) * s, scene.prevRight.w - dot(v, scene.prevUp.xyz) * s, z);
}

@vertex fn vs_star(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> StarOut {
  var out: StarOut;
  let n = ${STAR_BLOCK}u;
  let cell = vec3i(scene.stars.xyz) + vec3i(i32(ii % n), i32((ii / n) % n), i32(ii / (n * n)));
  let h = hash3(cell * vec3i(1, 7, 13) + vec3i(11, 5, 3));
  if (h > 0.62) {
    out.clip = NOTHING;
    return out;
  }
  let j = vec3f(hash3(cell + vec3i(17, 0, 0)), hash3(cell + vec3i(0, 29, 0)), hash3(cell + vec3i(0, 0, 41)));
  // The dust the stars are drifts, slowly, the way the flight would see a current.
  let drift = vec3f(0.07, -0.11, 0.03);
  let p = (vec3f(cell) + 0.1 + 0.8 * j) * ${f(STAR_CELL)} + drift * scene.clock.x;
  let was = (vec3f(cell) + 0.1 + 0.8 * j) * ${f(STAR_CELL)} + drift * scene.clock.w;
  let d = distance(p, scene.eye.xyz);
  let fade = (1.0 - smoothstep(scene.stars.w * 0.6, scene.stars.w, d)) * smoothstep(1.2, 3.5, d);
  let c = toPage(p);
  if (c.z < 0.6 || fade <= 0.0) {
    out.clip = NOTHING;
    return out;
  }
  let o = prevPage(was);
  var tail = select(c.xy, o.xy, o.z > 0.6);
  // A streak no longer than a few dozen px: past that it is a blur, not a star.
  var delta = c.xy - tail;
  let len = length(delta);
  if (len > 28.0) { tail = c.xy - delta / len * 28.0; }
  delta = c.xy - tail;
  let streak = length(delta);
  let bright = mix(0.12, 1.0, pow(j.x, 4.0)) * fade / (1.0 + d * 0.025);
  let width = 0.8 + 1.1 * j.y * j.y;
  let dir = select(vec2f(1.0, 0.0), delta / max(streak, 1e-4), streak > 0.01);
  let side = vec2f(-dir.y, dir.x);
  let k = CORNERS[vi % 6u];
  let pad = width * 2.5;
  let at = mix(tail - dir * pad, c.xy + dir * pad, k.x) + side * (k.y * 2.0 - 1.0) * pad;
  let ndc = vec2f(at.x / scene.view.x * 2.0 - 1.0, 1.0 - at.y / scene.view.y * 2.0);
  out.clip = vec4f(ndc * c.z, scene.fwd.w, c.z);
  out.along = vec2f(mix(-pad, streak + pad, k.x), (k.y * 2.0 - 1.0) * pad);
  // Some stars are whiter, some bluer; none are warm.
  let tint = mix(vec3f(0.75, 0.86, 1.0), vec3f(1.0), j.z);
  out.color = vec4f(tint * bright * 1.6, streak);
  out.width = width;
  return out;
}

@fragment fn fs_star(in: StarOut) -> @location(0) vec4f {
  let x = clamp(in.along.x, 0.0, in.color.w);
  let d = length(vec2f(in.along.x - x, in.along.y));
  let core = exp(-d * d / (in.width * in.width * 0.55));
  // A streak spreads the same light along its length.
  let spread = 1.0 / (1.0 + in.color.w / (in.width * 1.5));
  return vec4f(in.color.rgb * core * spread, 0.0);
}

// ---- behind the realms --------------------------------------------------------------------------

@vertex fn vs_sky(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[vi], 0.0, 1.0);
}

// Far stars, fixed to directions of the turning sky: a chance of one per cell of a grid of directions,
// each a point a device pixel or so across. Denser in the galaxy's band.
fn starLayer(rd: vec3f, grid: f32, chance: f32, bright: f32, salt: f32) -> f32 {
  let q = rd * grid;
  let id = floor(q);
  let seed = hash21(id.xy + id.z * 17.17 + salt);
  let across = dot(rd, BAND);
  let band = exp(-across * across / 0.03);
  // Never so many that the grid they are drawn from shows through.
  if (seed > min(chance * (0.55 + 1.2 * band), 0.36)) { return 0.0; }
  let jitter = vec3f(hash21(id.xy + 3.1 + id.z + salt), hash21(id.yz + 7.3 + salt), hash21(id.zx + 1.7 + salt));
  let star = normalize(id + 0.08 + 0.84 * jitter);
  let d = length(cross(rd, star)) * scene.eye.w * scene.right.w;
  let m = hash21(id.zy + 5.13 + salt);
  // A few of them shimmer a little.
  let shimmer = 1.0 + 0.25 * sin(scene.clock.x * (1.3 + 2.0 * m) + m * 40.0) * step(0.8, m) * (1.0 - scene.clock.y);
  return mix(0.06, 1.0, m * m * m) * bright * shimmer * exp(-d * d / 0.55);
}

fn stars(rd: vec3f) -> vec3f {
  let dim = starLayer(rd, 260.0, 0.22, 0.12, 0.0);
  let mid = starLayer(rd, 120.0, 0.22, 0.32, 11.0);
  let bright = starLayer(rd, 46.0, 0.16, 0.85, 23.0);
  return vec3f(0.78, 0.87, 1.0) * dim + vec3f(0.86, 0.92, 1.0) * mid + vec3f(0.95, 0.97, 1.0) * bright;
}

@fragment fn fs_sky(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let page = frag.xy / scene.right.w;
  let f = scene.eye.w;
  let ray = normalize(scene.fwd.xyz + scene.right.xyz * ((page.x - scene.view.z) / f) - scene.up.xyz * ((page.y - scene.view.w) / f));

  // The black hole at the foot of the page: in its rect the ray is bent round it, and its disk is
  // put in front. A bent ray reads the sky where its new direction would meet the page.
  let bent = holeTrace(page, ray);
  let rd = bent.dir;
  let ahead = dot(rd, scene.fwd.xyz);
  let css = select(page, scene.view.zw + vec2f(dot(rd, scene.right.xyz), -dot(rd, scene.up.xyz)) * f / max(ahead, 1e-4), ahead > 0.05);
  let base = select(SPACE_DEEP * EXPOSURE, backdrop(clamp(css, vec2f(0.0), scene.view.xy)), ahead > 0.05);

  // The far stars, on the turning sky; brighter over the hole, once the camera has lifted its eyes.
  let far = skyTurn(rd, scene.haze.z);
  let light = vec3f(1.0) - exp(-stars(far) * (1.0 + 0.6 * hole.ax.w));

  let behind = (base + light * (vec3f(1.0) - base)) * bent.through;
  let front = vec3f(1.0) - exp(-bent.light * 1.15);
  return vec4f(behind + front * (vec3f(1.0) - behind), 0.0);
}
`

export type CompositeUniforms = {
  view: number[]
  look: number[]
  cam: number[][]
  clear: number[][]
  panels: number[][]
  beams: number[][]
  pulses: number[][]
  fence: number[][]
}

/**
 * The scene, laid on the canvas at its full resolution: smoothly upsampled, held off the words by a
 * hard bound round each block of text, with the light that belongs to the page's realms — the beam
 * from a chapter's doorway to its screen, a doorway thrown open, a hand-off between two realms, the
 * boundary round a confined one — traced in the world's own space against what the scene shows, each
 * screen's own light drawn crisply at its rect, and dithered so the dark never bands.
 *
 * A screen's panel is opaque from the moment the doorway starts to open: first the doorway's light
 * filling the rect as it grows from the doorway's shape to the screen's, then, as the capture fades
 * in over it, the page's own colour under the picture. So the world never shows through a picture
 * that is still arriving, and once it has arrived the panel is only its breath of light outside.
 */
export const compositeShader = /* wgsl */ `
struct Comp {
  view: vec4f,     // width, height (CSS px), device px per CSS px, seconds
  look: vec4f,     // still, number of clear rects, unused, unused
  cam: array<vec4f, 4>,   // eye xyz + focal; forward + principal x; right + principal y; up + unused
  clear: array<vec4f, ${CLEAR * 2}>,     // per block of words: rect x, y, w, h; its pane's corner radius (< 0: no pane), field left inside, unused, unused
  panels: array<vec4f, ${PANELS * 2}>,   // per panel: rect x, y, w, h; fill, corner radius, picture, light
  beams: array<vec4f, ${BEAMS * 7}>,     // per beam (see beam())
  pulses: array<vec4f, ${PULSES * 5}>,   // per hand-off: five points along its trail, head first: page x, y, depth, light
  fence: array<vec4f, 10>,               // a confined realm's boundary: its eight corners on the page (x, y, depth), how drawn, its rect
}
@group(0) @binding(0) var<uniform> comp: Comp;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var sceneSampler: sampler;

${fieldWgsl}
${paletteWgsl}

fn toSrgb(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  let lo = x * 12.92;
  let hi = 1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, x <= vec3f(0.0031308));
}

fn toLinear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

// How much of the field shows at p, given the words over it. Words on a pane (FieldPanel) dim it
// inside the pane's own rounded rect, by the share the pane leaves, with an anti-aliased edge and
// nothing past it, so the pane is the only shape there is. Words on no pane (the opening's, the
// footer's) keep a clearance the sky shows through dimly: a third of it inside the block grown by
// 14 px, easing back over 160, so no edge of it is ever seen.
fn clearance(p: vec2f, dpr: f32) -> f32 {
  var k = 1.0;
  let n = i32(comp.look.y);
  for (var i = 0; i < ${CLEAR}; i++) {
    if (i >= n) { break; }
    let r = comp.clear[i * 2];
    let pane = comp.clear[i * 2 + 1];
    if (r.z <= 0.0) { continue; }
    let h = r.zw * 0.5;
    if (pane.x < 0.0) {
      let d = sdRoundRect(p - r.xy - h, h + vec2f(14.0), 60.0);
      k *= mix(0.32, 1.0, smoothstep(0.0, 160.0, d));
    } else {
      let d = sdRoundRect(p - r.xy - h, h, pane.x);
      k *= mix(1.0, pane.y, saturate(0.5 - d * dpr));
    }
  }
  return k;
}

// The ray from the eye through a point of the page.
fn rayAt(p: vec2f) -> vec3f {
  let f = comp.cam[0].w;
  return normalize(comp.cam[1].xyz + comp.cam[2].xyz * ((p.x - comp.cam[1].w) / f) - comp.cam[3].xyz * ((p.y - comp.cam[2].w) / f));
}

// A beam of light leaving a doorway: a frustum from the doorway's rect to a far rect (a chapter's
// screen, or the doorway's own light thrown out ahead of it), marched where the ray passes through it
// and stopped at whatever the scene shows nearer. Six vec4s:
//   origin xyz, length; axis xyz, light; across xyz, half width at the door; up xyz, half height at the door;
//   half width and height at the far end, kind (0 to a screen, 1 a doorway thrown open), its moment; its
//   rect on the page; and the rect of the screen it lands on, where the picture hides it (left, top, right, bottom).
fn beam(k: i32, p: vec2f, rd: vec3f, far: f32, t: f32) -> vec3f {
  let o = comp.beams[k * 7];
  let a = comp.beams[k * 7 + 1];
  let u = comp.beams[k * 7 + 2];
  let v = comp.beams[k * 7 + 3];
  let e = comp.beams[k * 7 + 4];
  let box = comp.beams[k * 7 + 5];
  let hid = comp.beams[k * 7 + 6];
  if (a.w <= 0.0 || p.x < box.x || p.y < box.y || p.x > box.z || p.y > box.w) { return vec3f(0.0); }
  if (p.x > hid.x && p.y > hid.y && p.x < hid.z && p.y < hid.w) { return vec3f(0.0); }
  let rel = comp.cam[0].xyz - o.xyz;
  // The ray in the beam's own frame: across, up, along.
  let ro = vec3f(dot(rel, u.xyz), dot(rel, v.xyz), dot(rel, a.xyz));
  let rv = vec3f(dot(rd, u.xyz), dot(rd, v.xyz), dot(rd, a.xyz));
  let L = o.w;
  let ku = (e.x - u.w) / L;
  let kv = (e.y - v.w) / L;
  var t0 = 0.0;
  var t1 = far;
  // Six half-spaces, each alpha + beta t <= 0.
  var alpha = array<f32, 6>(ro.x - u.w - ku * ro.z, -ro.x - u.w - ku * ro.z, ro.y - v.w - kv * ro.z, -ro.y - v.w - kv * ro.z, -ro.z, ro.z - L);
  var beta = array<f32, 6>(rv.x - ku * rv.z, -rv.x - ku * rv.z, rv.y - kv * rv.z, -rv.y - kv * rv.z, -rv.z, rv.z);
  for (var i = 0; i < 6; i++) {
    if (abs(beta[i]) < 1e-6) {
      if (alpha[i] > 0.0) { return vec3f(0.0); }
    } else if (beta[i] > 0.0) {
      t1 = min(t1, -alpha[i] / beta[i]);
    } else {
      t0 = max(t0, -alpha[i] / beta[i]);
    }
  }
  if (t1 <= t0) { return vec3f(0.0); }
  // March it: brightest at the doorway, spreading thinner as it widens, softer at its walls, with
  // motes of light running out along it.
  var sum = 0.0;
  let steps = 6;
  let dt = (t1 - t0) / f32(steps);
  let seed = hash21(p * 1.37 + fract(t));
  for (var i = 0; i < steps; i++) {
    let s = t0 + (f32(i) + seed) * dt;
    let q = ro + rv * s;
    let along = saturate(q.z / L);
    let hu = u.w + ku * q.z;
    let hv = v.w + kv * q.z;
    let cu = abs(q.x) / max(hu, 1e-3);
    let cv = abs(q.y) / max(hv, 1e-3);
    // Soft across, with its four edges a little brighter, as a projector's beam shows them in dust.
    let walls = (1.0 - pow(cu, 6.0)) * (1.0 - pow(cv, 6.0)) + 1.4 * pow(max(cu, cv), 14.0) * step(max(cu, cv), 1.0);
    let spread = (u.w * v.w) / max(hu * hv, 1e-4);
    let motes = 0.8 + 0.45 * smoothstep(0.5, 1.0, noise(vec2f(q.z * 1.1 - t * 1.2 * (1.0 + e.z), atan2(q.y / hv, q.x / hu) * 1.6 + e.w * 13.0)));
    let near = select(1.0 - smoothstep(0.75, 1.0, along), 1.0 - along, e.z > 0.5);
    sum += max(walls, 0.0) * pow(spread, 0.75) * motes * near * dt;
  }
  return mix(DOOR_LIGHT_C, vec3f(0.62, 0.8, 1.0), 0.35) * sum * a.w;
}

const DOOR_LIGHT_C = vec3f(0.82, 0.9, 1.0);

fn segment(p: vec2f, a: vec2f, b: vec2f) -> vec2f {
  let ab = b - a;
  let h = saturate(dot(p - a, ab) / max(dot(ab, ab), 1e-6));
  return vec2f(length(p - a - ab * h), h);
}

// A hand-off between two realms: a point of light running from one doorway to the other along a
// shallow arc, its trail fading behind it, hidden behind any realm in front of it.
fn pulse(k: i32, p: vec2f, depthHere: f32) -> vec3f {
  var light = vec3f(0.0);
  let head = comp.pulses[k * 5];
  if (head.w <= 0.0) { return light; }
  for (var i = 0; i < 4; i++) {
    let a = comp.pulses[k * 5 + i];
    let b = comp.pulses[k * 5 + i + 1];
    if (a.z <= 0.0 || b.z <= 0.0) { continue; }
    let s = segment(p, a.xy, b.xy);
    let z = mix(a.z, b.z, s.y);
    if (1.0 / z < depthHere) { continue; }
    let w = mix(a.w, b.w, s.y);
    light += vec3f(0.75, 0.88, 1.0) * w * exp(-s.x * s.x / 1.4) * 0.5;
  }
  let dh = distance(p, head.xy);
  if (1.0 / head.z >= depthHere) {
    light += vec3f(0.85, 0.93, 1.0) * head.w * (exp(-dh * dh / 3.0) * 1.2 + exp(-dh / 9.0) * 0.18);
  }
  return light;
}

// The boundary round a confined realm: the twelve edges of a box of light, a hairline wide.
var<private> EDGES: array<vec2u, 12> = array<vec2u, 12>(
  vec2u(0u, 1u), vec2u(1u, 2u), vec2u(2u, 3u), vec2u(3u, 0u),
  vec2u(4u, 5u), vec2u(5u, 6u), vec2u(6u, 7u), vec2u(7u, 4u),
  vec2u(0u, 4u), vec2u(1u, 5u), vec2u(2u, 6u), vec2u(3u, 7u),
);

fn fence(p: vec2f, depthHere: f32, dpr: f32) -> vec3f {
  let amount = comp.fence[8].x;
  let box = comp.fence[9];
  if (amount <= 0.0 || p.x < box.x || p.y < box.y || p.x > box.z || p.y > box.w) { return vec3f(0.0); }
  var light = 0.0;
  for (var i = 0; i < 12; i++) {
    let a = comp.fence[EDGES[i].x];
    let b = comp.fence[EDGES[i].y];
    if (a.z <= 0.0 || b.z <= 0.0) { continue; }
    let s = segment(p, a.xy, b.xy);
    let z = mix(a.z, b.z, s.y);
    let hidden = select(1.0, 0.3, 1.0 / z < depthHere);
    let w = 0.7 / dpr;
    light += (1.0 - smoothstep(w * 0.5, w * 1.6, s.x)) * 0.55 * hidden + exp(-s.x / 5.0) * 0.03 * hidden;
  }
  return toLinear(ACCENT_INK) * light * amount;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * comp.view.xy;
  let dpr = comp.view.z;
  let px = p * dpr;
  let t = comp.view.w;
  let page = toLinear(PAGE);
  let scene = textureSampleLevel(sceneTex, sceneSampler, uv, 0.0);
  // The glows are added into the scene and can carry it past white; held there, so the light laid over
  // it below brightens and never turns a channel back down.
  let field = min(scene.rgb, vec3f(1.0));
  let clear = clearance(p, dpr);
  var color = mix(SPACE_DEEP, field, clear);

  // The page's own light in the world, under the same bound as the field it is part of.
  let rd = rayAt(p);
  let depthHere = scene.a;
  let far = select(1e5, 1.0 / max(depthHere, 1e-5), depthHere > 1e-4);
  var light = vec3f(0.0);
  for (var k = 0; k < ${BEAMS}; k++) {
    light += beam(k, p, rd, far, t);
  }
  for (var k = 0; k < ${PULSES}; k++) {
    light += pulse(k, p, depthHere);
  }
  light += fence(p, depthHere, dpr);
  color += light * clear * (vec3f(1.0) - color);

  for (var k = 0; k < ${PANELS}; k++) {
    let r = comp.panels[k * 2];
    let s = comp.panels[k * 2 + 1];
    if (r.z <= 0.0 || (s.x <= 0.0 && s.z <= 0.0)) { continue; }
    let h = r.zw * 0.5;
    let d = sdRoundRect(p - r.xy - h, h, s.y);
    let inside = saturate(0.5 - d * dpr);
    // The doorway's light opening out into the screen: the rect goes dark as it grows, with the light
    // gathered at its edges like a frame being drawn open, and the picture fades in over the dark.
    let depth = clamp(d, -400.0, 0.0);
    let rim = exp(depth / 5.0) * 0.7 + exp(depth / 22.0) * 0.07 + 0.02;
    let panel = page + vec3f(0.74, 0.84, 1.0) * s.w * rim;
    color = mix(color, panel, inside * s.x);
    let out = max(d, 0.0);
    let halo = (exp(-out / 9.0) * 0.05 + exp(-out / 60.0) * 0.022) * max(s.z, s.w) * clear;
    color += vec3f(0.62, 0.76, 1.0) * halo * (1.0 - inside);
  }

  var srgb = toSrgb(color);
  // A whisper of grain that moves, so the darkest sky never sits still in bands.
  srgb *= 1.0 + (hash21(px + fract(t * 7.3) * 113.0) - 0.5) * 0.035 * (1.0 - comp.look.x * 0.5);
  return vec4f(dither(srgb, px, t), 1.0);
}
`
