import { TONES } from "@/components/realms/hive/cube"
import { DOOR_BLUE, DOOR_LIGHT, DUSK, OPEN_SKY, POINTER_LIGHT, SPILL_LIGHT, toLinear } from "@/components/realms/hive/light"
import { fieldWgsl, PAGE } from "@/components/field/stage"

import { holeWgsl } from "./blackhole"
import { DOOR, G1, G2 } from "./world"

const f = (n: number) => n.toFixed(6)
const vec3 = (rgb: readonly number[]) => `vec3f(${rgb.map(f).join(", ")})`
const lin3 = (rgb: readonly number[]) => vec3(rgb.map(toLinear))

/** How many of each thing the scene is told about at once. */
export const SCREENS = 2
export const LIT = 10
export const PLAZAS = 6
export const CLEAR = 12
export const PANELS = 2

export type SceneUniforms = {
  eye: number[]
  fwd: number[]
  right: number[]
  up: number[]
  view: number[]
  clock: number[]
  fog: number[]
  planet: number[]
  field: number[]
  fence: number[]
  lamp: number[]
  grid: number[]
  screens: number[][]
  plazas: number[][]
  lit: number[][]
}

/**
 * The world, drawn into an offscreen multisampled target at the page's CSS resolution:
 *
 *   vs_realm / fs_realm  every realm near the camera, one instance per lattice cell: the mark's cube
 *                        with its doorway cut, generated from the vertex index (no buffers)
 *   vs_sky / fs_sky      what lies behind them, at the far plane: the ground between the realms as it
 *                        curves away, the sky, and the black hole at the foot of the page
 *
 * Depth is reversed (1 near, 0 far), so the sky drawn at 0 lands only where no realm did.
 */
export const sceneShader = /* wgsl */ `
struct Scene {
  eye: vec4f,      // xyz eye (world), w focal (CSS px)
  fwd: vec4f,      // xyz forward, w near plane
  right: vec4f,    // xyz right, w render scale (target px per CSS px)
  up: vec4f,       // xyz up, w unused
  view: vec4f,     // width, height (CSS px), principal point x, y (CSS px)
  clock: vec4f,    // seconds, night (0 dusk .. 1 night), still, share of doorways lit by agents at work
  fog: vec4f,      // distance the haze starts, its density, unused, unused
  planet: vec4f,   // nadir x, y, radius, unused
  field: vec4f,    // realms dissolved into the ground (0 .. 1), lit doorways seen as lights (0 .. 1), unused, unused
  fence: vec4f,    // a confined realm's boundary on the ground: centre x, y, half its side, how drawn (0 .. 1)
  lamp: vec4f,     // the pointer's lamp on the ground: x, y, height, presence
  grid: vec4f,     // the instances' origin cell i, j, cells per side, how far out a realm is drawn
  screens: array<vec4f, ${SCREENS * 2}>,  // per screen: foot xyz + width; height, facing yaw, light, unused
  plazas: array<vec4f, ${PLAZAS * 2}>,    // per plaza: centre x, y, radius cleared, radius kept quiet; the avenue's far end x, y
  lit: array<vec4f, ${LIT}>,              // realms lit by the page: centre x, y, glow (<0: unused), blue
}
@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<uniform> hole: Hole;

${fieldWgsl}
${holeWgsl}

const PAGE_LINEAR = ${lin3(PAGE)};

// The doorway (world.ts, read from the mark): across the dark wall, down from the top, and its depth.
const X0 = ${f(-0.5 + DOOR.across[0])};
const X1 = ${f(-0.5 + DOOR.across[1])};
const Z0 = ${f(1 - DOOR.down[1])};
const Z1 = ${f(1 - DOOR.down[0])};
const DEPTH = ${f(DOOR.depth)};
const YB = ${f(-0.5 + DOOR.depth)};
const DOOR_MID = ${f(1 - (DOOR.down[0] + DOOR.down[1]) / 2)};

const G1 = vec2f(${f(G1[0])}, ${f(G1[1])});
const G2 = vec2f(${f(G2[0])}, ${f(G2[1])});
// The share of the ground a realm's footprint covers.
const FOOTPRINT = ${f(1 / (G1[0] * G2[1] - G1[1] * G2[0]))};

// The mark's tones, linear.
const TOP_FAR = ${lin3(TONES.top[0])};
const TOP_NEAR = ${lin3(TONES.top[1])};
const LEFT_HIGH = ${lin3(TONES.left[0])};
const LEFT_LOW = ${lin3(TONES.left[1])};
const RIGHT_HIGH = ${lin3(TONES.right[0])};
const RIGHT_LOW = ${lin3(TONES.right[1])};
const LIT_HIGH = ${lin3(TONES.lit[0])};
const LIT_LOW = ${lin3(TONES.lit[1])};

// The light (the Hive's light.ts): blue hour, and the doorways' white and Realm's blue.
const DUSK = ${vec3(DUSK)};
const NIGHT_SKY = ${vec3(DUSK.map((c) => c * 0.5))};
const OPEN_SKY = ${f(OPEN_SKY)};
const DOOR_LIGHT = ${vec3(DOOR_LIGHT)};
const DOOR_BLUE = ${vec3(DOOR_BLUE)};
const SPILL_LIGHT = ${vec3(SPILL_LIGHT)};
const POINTER_LIGHT = ${vec3(POINTER_LIGHT)};
// What a screen gives off: the cool white of a lit window seen across a dark room.
const SCREEN_LIGHT = vec3f(0.78, 0.86, 1.0);
// The last of the day along the horizon at dusk: the page's own grey, a breath lighter and cooler.
const DUSK_GLOW = vec3f(0.0028, 0.0036, 0.0058);
// And the light it still throws: low, from the west, cool. It is why a realm's left wall reads lighter
// than its dark one at dusk, as the mark draws them; it is gone by night.
const DUSK_KEY = vec3f(0.030, 0.034, 0.044);
const KEY_DIR = vec3f(-0.894, -0.358, 0.268);

fn sky() -> vec3f {
  return mix(DUSK, NIGHT_SKY, scene.clock.y);
}

fn key(n: vec3f) -> vec3f {
  return DUSK_KEY * (1.0 - scene.clock.y) * max(dot(n, KEY_DIR), 0.0);
}

// ---- the lattice --------------------------------------------------------------------------------

fn cellCentre(cell: vec2f) -> vec2f {
  return cell.x * G1 + cell.y * G2;
}

fn latticeOf(p: vec2f) -> vec2f {
  return vec2f(p.x - 2.0 * p.y, p.x + p.y) / (3.0 * G1.x);
}

fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn seedOf(cell: vec2f) -> vec4f {
  let c = vec2i(round(cell));
  let h = pcg((bitcast<u32>(c.x) * 1597334677u) ^ (bitcast<u32>(c.y) * 3812015801u));
  return vec4f(f32(h & 255u), f32((h >> 8u) & 255u), f32((h >> 16u) & 255u), f32(h >> 24u)) / 255.0;
}

// What the page says about a cell: cleared into a plaza, kept quiet near one, or one of the realms the
// page itself lights (a chapter's, a team's) and how. Every realm the page lights stands in a plaza, so
// a cell outside them all needs no more looking at.
struct Kept { gone: bool, listed: bool, quiet: bool, glow: f32, blue: f32 }

// A plaza is a clearing round a realm the page shows, drawn out into an avenue toward where the camera
// stands to look at it, so nothing stands between the camera and the screen.
fn kept(centre: vec2f) -> Kept {
  var inside = false;
  var quiet = false;
  for (var k = 0; k < ${PLAZAS}; k++) {
    let q = scene.plazas[k * 2];
    if (q.z <= 0.0) { continue; }
    let a = scene.plazas[k * 2 + 1].xy;
    let ab = a - q.xy;
    let t = saturate(dot(centre - q.xy, ab) / max(dot(ab, ab), 1e-4));
    let d = distance(centre, q.xy + ab * t);
    if (d < q.z) { inside = true; }
    if (d < q.w) { quiet = true; }
  }
  if (!inside) { return Kept(false, false, quiet, 0.0, 0.0); }
  for (var k = 0; k < ${LIT}; k++) {
    let l = scene.lit[k];
    if (l.z >= 0.0 && distance(l.xy, centre) < 0.2) { return Kept(false, true, true, l.z, l.w); }
  }
  return Kept(true, false, true, 0.0, 0.0);
}

// An agent at work: each realm keeps its own long rhythm, lit for half a minute to a minute and a
// half, then dark for a long while, coming up and going down over two seconds. How many realms are
// in their lit stretch is the page's to say (clock.w): a few at dusk, more as the night goes on. Near
// a realm the page is showing, the field keeps quiet, so the light there is that realm's.
fn door(cell: vec2f, page: Kept) -> vec2f {
  if (page.listed) { return vec2f(page.glow, page.blue); }
  if (page.quiet) { return vec2f(0.0); }
  let h = seedOf(cell);
  let busy = 30.0 + 50.0 * h.x;
  let period = busy / max(scene.clock.w * (0.6 + 0.8 * h.z), 1e-3);
  let x = fract(scene.clock.x / period + h.y) * period;
  let lit = smoothstep(0.0, 2.0, x) * (1.0 - smoothstep(busy, busy + 2.0, x)) * (0.75 + 0.25 * h.w);
  let blue = smoothstep(0.7, 0.8, fract(h.w * 7.31));
  return vec2f(lit, blue);
}

// ---- the planet ---------------------------------------------------------------------------------

// The ground curves away round a planet whose top is always under the camera: a point of the flat
// world is laid on the sphere at the same distance from the nadir, raised along its own vertical.
fn bend(q: vec3f) -> vec3f {
  let R = scene.planet.z;
  let d = q.xy - scene.planet.xy;
  let rho = length(d);
  if (rho < 1e-4) { return q; }
  let theta = rho / R;
  let s = sin(theta * 0.5);
  let dir = d / rho;
  return vec3f(scene.planet.xy + dir * (R + q.z) * sin(theta), q.z * cos(theta) - 2.0 * R * s * s);
}

// Where a point of the world lands on the page, in CSS px, and its depth.
fn toPage(p: vec3f) -> vec3f {
  let v = p - scene.eye.xyz;
  let z = dot(v, scene.fwd.xyz);
  let s = scene.eye.w / z;
  return vec3f(scene.view.z + dot(v, scene.right.xyz) * s, scene.view.w - dot(v, scene.up.xyz) * s, z);
}

// ---- light --------------------------------------------------------------------------------------

// Light from a doorway's lit back, leaving through the opening toward -y (the Hive's doorSpill).
fn doorSpill(centre: vec2f, glow: f32, p: vec3f, n: vec3f) -> f32 {
  let source = vec3f(centre.x, centre.y - 0.5 + DEPTH, DOOR_MID);
  let l = source - p;
  let r2 = dot(l, l);
  let ln = l * inverseSqrt(r2);
  if (ln.y <= 0.0) { return 0.0; }
  let across = saturate(1.0 - abs(ln.x) / ln.y * DEPTH / (X1 - X0));
  let out = max(centre.y - 0.5 - p.y, 1e-3);
  let seen = saturate((Z1 - max(Z0, p.z + (Z0 - p.z) * (out + DEPTH) / out)) / (Z1 - Z0));
  return glow * ln.y * across * seen * max(dot(n, ln), 0.0) / (r2 + 0.05);
}

// A screen standing on the ground, giving off light from its face toward the camera that composed it.
// The light leaves the whole face, so a point is lit from the face's middle height above the nearest
// point across it (which lifts the ground at its foot, rather than grazing it), falling off like a lit
// panel rather than a bulb.
fn screenLight(p: vec3f, n: vec3f) -> vec3f {
  var e = vec3f(0.0);
  for (var k = 0; k < ${SCREENS}; k++) {
    let a = scene.screens[k * 2];
    let b = scene.screens[k * 2 + 1];
    if (b.z <= 0.001) { continue; }
    let facing = vec3f(-cos(b.y), -sin(b.y), 0.0);
    let across = vec3f(sin(b.y), -cos(b.y), 0.0);
    let rel = p - a.xyz;
    if (dot(rel, facing) <= 0.02) { continue; }
    let u = clamp(dot(rel, across), -a.w * 0.5, a.w * 0.5);
    let source = a.xyz + across * u + vec3f(0.0, 0.0, b.x * 0.5);
    let l = source - p;
    let r2 = dot(l, l);
    let ln = l * inverseSqrt(max(r2, 1e-6));
    let emit = max(dot(facing, -ln), 0.0);
    let area = a.w * b.x;
    e += SCREEN_LIGHT * b.z * area * max(dot(n, ln), 0.0) * emit / (r2 * 3.0 + area * 0.6 + 0.5);
  }
  return e * 0.16;
}

// A lamp held over the field where the pointer is.
fn lamp(p: vec3f, n: vec3f) -> f32 {
  let l = vec3f(scene.lamp.xy, scene.lamp.z) - p;
  let r2 = dot(l, l);
  return scene.lamp.w * max(dot(n, l), 0.0) * inverseSqrt(r2) / (1.0 + r2 * r2 / pow(scene.lamp.z, 4.0) * 0.55);
}

// Haze from where it starts, thickening with distance into the page's own colour.
fn fogAt(d: f32) -> f32 {
  return 1.0 - exp(-max(d - scene.fog.x, 0.0) * scene.fog.y);
}

fn horizonGlow(rd: vec3f) -> vec3f {
  return DUSK_GLOW * exp(-abs(rd.z) * 9.0) * (1.0 - scene.clock.y);
}

fn finish(radiance: vec3f, d: f32, rd: vec3f) -> vec3f {
  let shaped = vec3f(1.0) - exp(-radiance);
  return mix(shaped, PAGE_LINEAR + horizonGlow(rd), fogAt(d));
}

// ---- the realms ---------------------------------------------------------------------------------

var<private> Q_O: array<vec3f, 13> = array<vec3f, 13>(
  vec3f(-0.5, -0.5, 1.0), vec3f(-0.5, -0.5, 0.0),
  vec3f(-0.5, -0.5, 0.0), vec3f(X1, -0.5, 0.0), vec3f(X0, -0.5, 0.0), vec3f(X0, -0.5, Z1),
  vec3f(-0.5, 0.5, 0.0), vec3f(0.5, -0.5, 0.0),
  vec3f(X0, YB, Z0), vec3f(X0, -0.5, Z0), vec3f(X0, -0.5, Z1), vec3f(X0, -0.5, Z0), vec3f(X1, -0.5, Z0),
);
var<private> Q_U: array<vec3f, 13> = array<vec3f, 13>(
  vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0),
  vec3f(X0 + 0.5, 0.0, 0.0), vec3f(0.5 - X1, 0.0, 0.0), vec3f(X1 - X0, 0.0, 0.0), vec3f(X1 - X0, 0.0, 0.0),
  vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0),
  vec3f(X1 - X0, 0.0, 0.0), vec3f(X1 - X0, 0.0, 0.0), vec3f(0.0, DEPTH, 0.0), vec3f(0.0, DEPTH, 0.0), vec3f(0.0, 0.0, Z1 - Z0),
);
var<private> Q_V: array<vec3f, 13> = array<vec3f, 13>(
  vec3f(0.0, 1.0, 0.0), vec3f(0.0, 1.0, 0.0),
  vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, Z0), vec3f(0.0, 0.0, 1.0 - Z1),
  vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0),
  vec3f(0.0, 0.0, Z1 - Z0), vec3f(0.0, DEPTH, 0.0), vec3f(X1 - X0, 0.0, 0.0), vec3f(0.0, 0.0, Z1 - Z0), vec3f(0.0, DEPTH, 0.0),
);
// 0 top, 1 left wall, 2 dark wall, 3 back, 4 right, 5 the doorway's lit back, 6 its floor,
// 7 its lintel, 8 and 9 its jambs.
var<private> Q_F: array<u32, 13> = array<u32, 13>(0u, 1u, 2u, 2u, 2u, 2u, 3u, 4u, 5u, 6u, 7u, 8u, 9u);
var<private> CORNERS: array<vec2f, 6> = array<vec2f, 6>(
  vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
);

struct RealmOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) local: vec3f,
  @location(2) @interpolate(flat) info: vec4f,
  @location(3) @interpolate(flat) cell: vec4f,
  @location(4) bent: vec3f,
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

@vertex fn vs_realm(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RealmOut {
  var out: RealmOut;
  let n = u32(scene.grid.z);
  let cell = vec2f(scene.grid.x + f32(ii % n) - f32(n / 2u), scene.grid.y + f32(ii / n) - f32(n / 2u));
  let centre = cellCentre(cell);
  let toward = centre - scene.eye.xy;
  let page = kept(centre);
  // Too far to see, behind the camera, or cleared for a plaza: nothing.
  if (dot(toward, toward) > scene.grid.w * scene.grid.w || dot(vec3f(toward, -scene.eye.z), scene.fwd.xyz) < -3.0 || page.gone) {
    out.clip = vec4f(2.0, 2.0, 2.0, 1.0);
    return out;
  }
  let q = vi / 6u;
  let c = CORNERS[vi % 6u];
  let local = Q_O[q] + Q_U[q] * c.x + Q_V[q] * c.y;
  let world = vec3f(centre + local.xy, local.z);
  let bent = bend(world);
  let lit = door(cell, page);
  out.clip = toClip(bent);
  out.world = world;
  out.local = local;
  out.info = vec4f(f32(Q_F[q]), lit.x, lit.y, 0.0);
  out.cell = vec4f(centre, cell);
  out.bent = bent;
  return out;
}

var<private> AROUND: array<vec2f, 6> = array<vec2f, 6>(
  vec2f(1.0, 0.0), vec2f(-1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
);

// The field seen from too far up to make out a realm: the ground with its realms' tops averaged in.
fn fieldAverage() -> vec3f {
  let tops = (TOP_NEAR + TOP_FAR) * 0.5 * sky() * OPEN_SKY;
  return mix(PAGE_LINEAR * 0.82, vec3f(1.0) - exp(-tops), FOOTPRINT);
}

@fragment fn fs_realm(in: RealmOut) -> @location(0) vec4f {
  let face = u32(in.info.x + 0.5);
  let glow = in.info.y;
  let tint = mix(DOOR_LIGHT, DOOR_BLUE, in.info.z);
  let l = in.local;
  let p = in.world;
  let skyLight = sky();
  let ao = 1.0 - 0.45 * exp(-p.z / 0.22);

  var n = vec3f(0.0, 0.0, 1.0);
  var tone = TOP_NEAR;
  var ambient = skyLight;
  var emit = vec3f(0.0);
  switch (face) {
    case 0u: {
      tone = mix(TOP_NEAR, TOP_FAR, saturate((l.x + l.y + 1.0) * 0.5));
      ambient = skyLight * OPEN_SKY;
    }
    case 1u: {
      n = vec3f(-1.0, 0.0, 0.0);
      tone = mix(LEFT_LOW, LEFT_HIGH, saturate(l.z));
      ambient = skyLight * ao;
    }
    case 2u: {
      n = vec3f(0.0, -1.0, 0.0);
      tone = mix(RIGHT_LOW, RIGHT_HIGH, saturate(l.z));
      ambient = skyLight * ao;
    }
    case 3u: {
      n = vec3f(0.0, 1.0, 0.0);
      tone = mix(LEFT_LOW, LEFT_HIGH, saturate(l.z)) * 0.8;
      ambient = skyLight * ao;
    }
    case 4u: {
      n = vec3f(1.0, 0.0, 0.0);
      tone = mix(RIGHT_LOW, RIGHT_HIGH, saturate(l.z)) * 1.15;
      ambient = skyLight * ao;
    }
    case 5u: {
      // The doorway's back: the light itself when an agent is at work, brightest under the lintel.
      n = vec3f(0.0, -1.0, 0.0);
      let k = saturate((l.z - Z0) / (Z1 - Z0));
      tone = mix(LIT_LOW, LIT_HIGH, k);
      ambient = skyLight * 0.12;
      emit = tone * tint * glow * mix(1.25, 1.75, k);
    }
    case 6u: {
      tone = TOP_NEAR;
      ambient = skyLight * 0.5;
      emit = tone * tint * glow * 0.6;
    }
    case 7u: {
      n = vec3f(0.0, 0.0, -1.0);
      tone = RIGHT_LOW;
      ambient = skyLight * 0.25;
      emit = tone * tint * glow * 0.4;
    }
    default: {
      n = select(vec3f(-1.0, 0.0, 0.0), vec3f(1.0, 0.0, 0.0), face == 8u);
      tone = LEFT_LOW;
      ambient = skyLight * 0.4;
      emit = tone * tint * glow * 0.5;
    }
  }

  // The doorways of the realms around this one, falling on whichever of its faces they reach.
  var spill = vec3f(0.0);
  if (face < 5u) {
    ambient += key(n) * select(ao, 1.0, face == 0u);
    for (var k = 0; k < 6; k++) {
      let c = in.cell.zw + AROUND[k];
      let centre = cellCentre(c);
      let page = kept(centre);
      let lit = door(c, page);
      if (lit.x > 0.001 && !page.gone) {
        spill += mix(SPILL_LIGHT, DOOR_BLUE, lit.y) * doorSpill(centre, lit.x, p, n);
      }
    }
  }
  let radiance = tone * (ambient + spill * 0.16 + POINTER_LIGHT * lamp(p, n) * 0.62) + tone * screenLight(p, n) * 2.5 + emit;
  let d = distance(in.bent, scene.eye.xyz);
  let rd = (in.bent - scene.eye.xyz) / d;
  var color = finish(radiance, d, rd);
  // Climbing away, the realms go into the field's average before they are too small to draw.
  color = mix(color, fieldAverage(), scene.field.x);
  return vec4f(color, 1.0);
}

// ---- behind the realms --------------------------------------------------------------------------

@vertex fn vs_sky(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[vi], 0.0, 1.0);
}

// A confined space's boundary, drawn on the ground round its realm as a hairline of the accent's light:
// a rounded square a little over a device pixel wide wherever it is seen from, and a faint wash
// inside it, because what it bounds is the realm's own ground.
fn boundary(p: vec3f, spot: f32) -> vec3f {
  let f = scene.fence;
  if (f.w <= 0.001) { return vec3f(0.0); }
  let q = abs(p.xy - f.xy) - vec2f(f.z) + vec2f(0.6);
  let sd = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - 0.6;
  let w = max(spot * 1.2, 0.01);
  let line = 1.0 - smoothstep(0.0, w, abs(sd));
  let inside = (1.0 - smoothstep(-0.3, 0.0, sd)) * 0.006;
  return toLinear3(ACCENT_INK) * (line * 0.22 + inside) * f.w;
}

fn toLinear3(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

// The ground between the realms: the page's own colour, darker close in to every realm's foot, and
// lit where a doorway or a screen throws its light out onto it. \`detail\` is how much of that a pixel
// can still resolve (1 close in, 0 from high up), \`here\` is the pixel on the page and \`spot\` how
// much ground it covers, in edges, so a lit doorway seen from far enough up is drawn as the point of
// light it has become.
fn ground(p: vec3f, detail: f32, here: vec2f, spot: f32) -> vec3f {
  let base = round(latticeOf(p.xy));
  // A doorway is a point of light while its cell is several pixels across; smaller, it would only salt
  // the ground, so the lights thin out and fade as the cells shrink toward the limb.
  let sparse = mix(1.0, 0.22, smoothstep(0.15, 0.6, spot)) * (1.0 - smoothstep(0.7, 1.6, spot));
  var ao = 1.0;
  var spill = vec3f(0.0);
  var points = vec3f(0.0);
  for (var di = -1; di <= 1; di++) {
    for (var dj = -1; dj <= 1; dj++) {
      let c = base + vec2f(f32(di), f32(dj));
      let centre = cellCentre(c);
      let page = kept(centre);
      if (page.gone) { continue; }
      let lit = door(c, page);
      if (detail > 0.0) {
        let q = abs(p.xy - centre) - vec2f(0.5);
        let edge = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
        ao *= 1.0 - 0.5 * exp(-max(edge, 0.0) / 0.12);
        if (lit.x > 0.001) {
          spill += mix(SPILL_LIGHT, DOOR_BLUE, lit.y) * doorSpill(centre, lit.x, p, vec3f(0.0, 0.0, 1.0));
        }
      }
      // Seen from far up, only some doorways still read as lights, and fewer the higher it goes, so
      // the night side is lit sparsely rather than salted.
      if (scene.field.y > 0.0 && lit.x > 0.001 && seedOf(c).y < sparse) {
        let at = toPage(bend(vec3f(centre.x, centre.y - 0.6, DOOR_MID)));
        if (at.z > 0.0) {
          let d = length(at.xy - here) * scene.right.w;
          points += mix(DOOR_LIGHT, DOOR_BLUE, lit.y) * lit.x * exp(-d * d / 0.7);
        }
      }
    }
  }
  let up = vec3f(0.0, 0.0, 1.0);
  let near = PAGE_LINEAR * ao + spill * 0.13 + screenLight(p, up) + POINTER_LIGHT * lamp(p, up) * 0.07 + boundary(p, spot);
  let far = fieldAverage();
  return mix(far, near, detail) + points * 0.4 * scene.field.y;
}

// Stars, few and faint, fixed to directions of the sky so they wheel with the camera: one chance of a
// star per cell of a grid of directions, each a point a device pixel or so across.
fn stars(rd: vec3f) -> f32 {
  let q = rd * 90.0;
  let id = floor(q);
  let seed = hash21(id.xy + id.z * 17.17);
  if (seed < 0.86) { return 0.0; }
  let jitter = vec3f(hash21(id.xy + 3.1 + id.z), hash21(id.yz + 7.3), hash21(id.zx + 1.7));
  let star = normalize(id + 0.2 + 0.6 * jitter);
  let d = length(cross(rd, star)) * scene.eye.w * scene.right.w;
  let m = hash21(id.zy + 5.13);
  return mix(0.08, 0.45, m * m * m) * exp(-d * d / 0.7);
}

@fragment fn fs_sky(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let page = frag.xy / scene.right.w;
  let f = scene.eye.w;
  let ray = normalize(scene.fwd.xyz + scene.right.xyz * ((page.x - scene.view.z) / f) - scene.up.xyz * ((page.y - scene.view.w) / f));
  let o = scene.eye.xyz;
  let R = scene.planet.z;
  let h = max(o.z, 1e-3);

  // How far above the horizon this ray passes, as an angle, and how fast that changes across the
  // screen: the ground's edge is anti-aliased from it like a vector edge. The rate
  // is taken from the straight ray, before the hole's loop, where a derivative is still defined.
  let dip = atan(sqrt(h * (2.0 * R + h)) / R);
  let rate = fwidth(asin(clamp(ray.z, -1.0, 1.0)));

  // The black hole at the foot of the page: in its rect the ray is bent round it, and its disk is
  // put in front. A bent ray reads the world where its new direction would meet the page.
  let bent = holeTrace(page, ray);
  let rd = bent.dir;
  let ahead = dot(rd, scene.fwd.xyz);
  let css = select(page, scene.view.zw + vec2f(dot(rd, scene.right.xyz), -dot(rd, scene.up.xyz)) * f / max(ahead, 1e-4), ahead > 0.05);
  let above = asin(clamp(rd.z, -1.0, 1.0)) + dip;
  let cover = saturate(0.5 - above / max(rate, 1e-6));

  var base = PAGE_LINEAR + horizonGlow(rd);
  var light = vec3f(0.0);

  if (cover > 0.0) {
    // The ground, as a sphere whose top is under the camera. c is the camera's height times (2R + h),
    // written that way so it keeps its precision a few edges above a planet thousands round.
    let b = (h + R) * rd.z;
    let c = h * (2.0 * R + h);
    let disc = max(b * b - c, 0.0);
    let t = c / max(-b + sqrt(disc), 1e-4);
    let hit = o + rd * t;
    let fromCentre = hit - vec3f(scene.planet.xy, -R);
    let across = length(fromCentre.xy);
    let theta = atan2(across, fromCentre.z);
    let onGround = vec3f(scene.planet.xy + select(vec2f(0.0), fromCentre.xy / across, across > 1e-5) * R * theta, 0.0);
    // A pixel's footprint on the ground, in edges: past a few tenths of an edge the field is an average.
    let spot = t / (f * scene.right.w * max(-rd.z, 0.03));
    let detail = 1.0 - smoothstep(0.08, 0.45, spot);
    let lit = ground(onGround, detail, css, spot);
    base = mix(base, finish(lit, t, rd), cover);
  }

  // Stars by night, never on the ground; brighter over the hole, once the camera has lifted its eyes.
  let starry = scene.clock.y * smoothstep(0.0, 0.08, rd.z + dip);
  light += INK * stars(rd) * starry * (0.06 + 0.08 * hole.ax.w) * (1.0 - cover);

  let lit = vec3f(1.0) - exp(-light * 1.15);
  let behind = (base + lit * (vec3f(1.0) - base)) * bent.through;
  let front = vec3f(1.0) - exp(-bent.light * 1.15);
  return vec4f(behind + front * (vec3f(1.0) - behind), 1.0);
}
`

export type CompositeUniforms = {
  view: number[]
  look: number[]
  clear: number[][]
  panels: number[][]
}

/**
 * The scene, laid on the canvas at its full resolution: smoothly upsampled, held off the words by a
 * hard bound round each block of text, with each screen's own light drawn crisply at its rect, and
 * dithered so the dark haze never bands.
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
  clear: array<vec4f, ${CLEAR}>,
  panels: array<vec4f, ${PANELS * 2}>,   // per panel: rect x, y, w, h; fill, corner radius, picture, light
}
@group(0) @binding(0) var<uniform> comp: Comp;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var sceneSampler: sampler;

${fieldWgsl}

fn toSrgb(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  let lo = x * 12.92;
  let hi = 1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, x <= vec3f(0.0031308));
}

fn toLinear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

// 0 at the words, 1 clear of them: zero inside each block grown by 14 px, easing out over 100.
fn clearance(p: vec2f) -> f32 {
  var k = 1.0;
  let n = i32(comp.look.y);
  for (var i = 0; i < ${CLEAR}; i++) {
    if (i >= n) { break; }
    let r = comp.clear[i];
    if (r.z <= 0.0) { continue; }
    let h = r.zw * 0.5;
    let d = sdRoundRect(p - r.xy - h, h + vec2f(14.0), 18.0);
    k *= smoothstep(0.0, 100.0, d);
  }
  return k;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * comp.view.xy;
  let dpr = comp.view.z;
  let px = p * dpr;
  let t = comp.view.w;
  let page = toLinear(PAGE);
  let field = textureSampleLevel(sceneTex, sceneSampler, uv, 0.0).rgb;
  let clear = clearance(p);
  var color = mix(page, field, clear);

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
  // A whisper of grain that moves, so the darkest haze never sits still in bands.
  srgb *= 1.0 + (hash21(px + fract(t * 7.3) * 113.0) - 0.5) * 0.035 * (1.0 - comp.look.x * 0.5);
  return vec4f(dither(srgb, px, t), 1.0);
}
`
