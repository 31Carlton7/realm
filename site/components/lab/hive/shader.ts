import { labWgsl } from "../stage"
import { DOORWAY, TONES } from "./cube"

/**
 * The hive: a field of realms seen from above, each one Realm's mark as a solid — the cube with its
 * doorway — standing on the ground in a hexagonal lattice and running off into fog.
 *
 * Nothing is marched. The camera looks down the cube's own diagonal, which is the angle the mark is
 * drawn from, so every cube's outline is the mark's hexagon and the cubes' outlines tile the way the
 * mark's hexagon tiles. A pixel's ray therefore has one cube to ask — the one whose cell it crosses at
 * half height — plus the two in front of it, which reach up into this cell when they rise. Each cube
 * is six planes (the mark's six faces): the ray meets each plane exactly, and the distance from that
 * point to the face's edge, turned into device pixels by the ray's own derivatives, is its coverage.
 * So every edge is anti-aliased like vector art, at every size, while the cubes move.
 *
 * World: x, y on the ground, z up, a cube's edge is 1. Its left wall faces -x, its right wall -y with
 * the doorway in it, its top +z — the mark's a, b and -c.
 */

const f = (n: number) => n.toFixed(5)
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const lin3 = (rgb: readonly number[]) => `vec3f(${rgb.map((c) => f(linear(c))).join(", ")})`

/** How far apart the cubes stand, as a multiple of the spacing at which their outlines would touch. */
export const SPACING = 1.3

export type HiveUniforms = {
  view: [number, number, number, number]
  eye: [number, number, number, number]
  forward: [number, number, number, number]
  right: [number, number, number, number]
  up: [number, number, number, number]
  principal: [number, number, number, number]
  pointer: [number, number, number, number]
  copy: [number, number, number, number]
  portal: [number, number, number, number]
  look: [number, number, number, number]
}

export const hiveShader = /* wgsl */ `
// view       width, height (CSS px), seconds, still (0 | 1)
// eye        the camera's position, its focal length in CSS px
// forward    the direction it looks, the distance it is focused at
// right, up  the picture's axes in the world; right.w is device px per CSS px
// principal  where the optical axis meets the page (CSS px) — the field moves with the page through it
// pointer    the pointer's place on the field (world x, y), its presence 0..1
// copy       the words' rect; portal the window's rect (CSS px, viewport)
// look       where the fog starts (depth from the focus) and how fast it thickens, blur per unit of
//            depth, and how much depth either side of the focus stays sharp
struct Hive {
  view: vec4f,
  eye: vec4f,
  forward: vec4f,
  right: vec4f,
  up: vec4f,
  principal: vec4f,
  pointer: vec4f,
  copy: vec4f,
  portal: vec4f,
  look: vec4f,
}
@group(0) @binding(0) var<uniform> hive: Hive;

${labWgsl}

// The doorway, read out of the mark (cube.ts): across the right wall from its front edge, down it from
// its top, and how deep it is cut.
const DOOR_A0 = ${f(DOORWAY.across[0])};
const DOOR_A1 = ${f(DOORWAY.across[1])};
const DOOR_C0 = ${f(DOORWAY.down[0])};
const DOOR_C1 = ${f(DOORWAY.down[1])};
const DOOR_DEPTH = ${f(DOORWAY.depth)};

// The cubes stand on the lattice whose cells, seen down the diagonal, are the mark's hexagon: G1 runs
// beside a cube, G2 behind it. At SPACING 1 their outlines would touch; above it there are streets.
const S = ${f(SPACING)};
const G1 = vec2f(S, -S);
const G2 = vec2f(2.0 * S, S);
const ISO_L = S * 1.41421356;

// The mark's tones, linear.
const TOP_FAR = ${lin3(TONES.top[0])};
const TOP_NEAR = ${lin3(TONES.top[1])};
const LEFT_HIGH = ${lin3(TONES.left[0])};
const LEFT_LOW = ${lin3(TONES.left[1])};
const RIGHT_HIGH = ${lin3(TONES.right[0])};
const RIGHT_LOW = ${lin3(TONES.right[1])};
const LIT_HIGH = ${lin3(TONES.lit[0])};
const LIT_LOW = ${lin3(TONES.lit[1])};

// Blue hour: the cubes catch only a cool sky, a long way down from the mark's daylight. They stand on
// the page itself — the open ground is the page's own colour — so the field rises out of the page
// rather than sitting on it as a darker slab.
const DUSK = vec3f(0.062, 0.068, 0.085);
// Door light: white, a little toward the accent; what it throws onto the ground is bluer still.
const DOOR_LIGHT = vec3f(0.82, 0.9, 1.0);
const SPILL_LIGHT = vec3f(0.62, 0.80, 1.0);
const POINTER_LIGHT = vec3f(0.84, 0.9, 1.0);
const MAX_RISE = 0.42;

var<private> RAY_DX: vec3f;
var<private> RAY_DY: vec3f;
// The sky this pixel's field gets, less what the floating window keeps off it.
var<private> SKY: f32;

fn toLinear(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow((c + 0.055) / 1.055, vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}

fn toSrgb(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  let lo = x * 12.92;
  let hi = 1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, x <= vec3f(0.0031308));
}

// ---- the lattice --------------------------------------------------------------------------------

fn hexRound(q: vec2f) -> vec2f {
  let x = q.x;
  let z = q.y;
  let y = -x - z;
  var rx = round(x);
  var ry = round(y);
  var rz = round(z);
  let dx = abs(rx - x);
  let dy = abs(ry - y);
  let dz = abs(rz - z);
  if (dx > dy && dx > dz) {
    rx = -ry - rz;
  } else if (dy > dz) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }
  return vec2f(rx, rz);
}

// The cell a point falls in when the lattice is seen down the diagonal, the cubes' centres taken at
// height h: there the cells are regular hexagons, and rounding to the nearest is exact.
fn cellAt(p: vec3f, h: f32) -> vec2f {
  let q = vec2f((p.x - p.y) * 0.70710678, (p.x + p.y) * 0.40824829 + (p.z - h) * 0.81649658);
  let j = q.y / (ISO_L * 0.8660254);
  let i = q.x / ISO_L - j * 0.5;
  return hexRound(vec2f(i, j));
}

fn cellCentre(cell: vec2f) -> vec2f {
  return cell.x * G1 + cell.y * G2;
}

// ---- what happens in a realm -------------------------------------------------------------------

// How lit a realm's doorway is: each keeps its own long cycle, its agent at work for part of it, and
// its light comes up over a couple of seconds and goes down the same way, so nothing ever blinks.
fn doorGlow(cell: vec2f, t: f32) -> f32 {
  let h1 = hash21(cell * 0.731 + vec2f(11.3, 3.7));
  let h2 = hash21(cell * 1.137 + vec2f(5.1, 17.9));
  let h3 = hash21(cell * 0.593 + vec2f(23.3, 7.1));
  let h4 = hash21(cell * 0.977 + vec2f(2.9, 31.7));
  let period = 26.0 + 44.0 * h1;
  let busy = period * (0.05 + 0.17 * h3);
  let x = fract(t / period + h2) * period;
  let lit = smoothstep(0.0, 1.8, x) * (1.0 - smoothstep(busy, busy + 1.8, x));
  return lit * (0.6 + 0.4 * h4);
}

// The cubes under the pointer rise a little, the nearest most.
fn riseAt(centre: vec2f) -> f32 {
  let d = centre - hive.pointer.xy;
  return MAX_RISE * hive.pointer.z * exp(-dot(d, d) / 5.0);
}

// A lamp held over the model where the pointer is.
fn pointerLight(p: vec3f, n: vec3f) -> f32 {
  let l = vec3f(hive.pointer.xy, 2.6) - p;
  let r2 = dot(l, l);
  return hive.pointer.z * max(dot(n, l), 0.0) * inverseSqrt(r2) / (1.0 + r2 / 7.0);
}

// Light from a doorway's lit back, leaving through the opening toward -y: brightest straight out,
// cut off sideways where the opening's jambs hide the back, falling off with distance.
fn doorSpill(centre: vec2f, lift: f32, glow: f32, p: vec3f, n: vec3f) -> f32 {
  let source = vec3f(
    centre.x - 0.5 + (DOOR_A0 + DOOR_A1) * 0.5,
    centre.y - 0.5 + DOOR_DEPTH,
    lift + 1.0 - (DOOR_C0 + DOOR_C1) * 0.5,
  );
  let l = source - p;
  let r2 = dot(l, l);
  let ln = l * inverseSqrt(r2);
  if (ln.y <= 0.0) { return 0.0; }
  // Sideways, the jambs hide the back; downward, the sill does, so the ground right at the foot of
  // the wall gets less than the ground a step out.
  let across = saturate(1.0 - abs(ln.x) / ln.y * DOOR_DEPTH / (DOOR_A1 - DOOR_A0));
  let out = max(centre.y - 0.5 - p.y, 1e-3);
  let sill = lift + 1.0 - DOOR_C1;
  let seen = saturate((lift + 1.0 - DOOR_C0 - max(sill, p.z + (sill - p.z) * (out + DOOR_DEPTH) / out)) / (DOOR_C1 - DOOR_C0));
  return glow * ln.y * across * seen * max(dot(n, ln), 0.0) / (r2 + 0.05);
}

// ---- seeing it -----------------------------------------------------------------------------------

fn depthOf(p: vec3f) -> f32 {
  return dot(p - hive.eye.xyz, hive.forward.xyz) - hive.forward.w;
}

// Fog that begins softly a little beyond the focus and thickens with depth until the field is the page.
fn fogAt(depth: f32) -> f32 {
  let x = max(depth - hive.look.x, 0.0) * hive.look.y;
  return 1.0 - exp(-x * x);
}

// Coverage is a box filter this many device pixels wide: one in the band the lens is focused on,
// wider in front of it and behind it, which is all a tilt-shift lens does to a model.
fn blurWidth(depth: f32) -> f32 {
  return 1.0 + hive.look.z * max(abs(depth) - hive.look.w, 0.0);
}

fn finish(radiance: vec3f, depth: f32) -> vec3f {
  let shaped = vec3f(1.0) - exp(-radiance);
  return mix(shaped, toLinear(PAGE), fogAt(depth));
}

// A plane the ray meets: where (in the plane's two axes), and how that point moves per device pixel.
struct Plane { uv: vec2f, jx: vec2f, jy: vec2f, p: vec3f }

fn planeX(o: vec3f, d: vec3f, h: f32) -> Plane {
  let t = (h - o.x) / d.x;
  let p = o + d * t;
  let jx = (RAY_DX - d * (RAY_DX.x / d.x)) * t;
  let jy = (RAY_DY - d * (RAY_DY.x / d.x)) * t;
  return Plane(p.yz, jx.yz, jy.yz, p);
}

fn planeY(o: vec3f, d: vec3f, h: f32) -> Plane {
  let t = (h - o.y) / d.y;
  let p = o + d * t;
  let jx = (RAY_DX - d * (RAY_DX.y / d.y)) * t;
  let jy = (RAY_DY - d * (RAY_DY.y / d.y)) * t;
  return Plane(p.xz, jx.xz, jy.xz, p);
}

fn planeZ(o: vec3f, d: vec3f, h: f32) -> Plane {
  let t = (h - o.z) / d.z;
  let p = o + d * t;
  let jx = (RAY_DX - d * (RAY_DX.z / d.z)) * t;
  let jy = (RAY_DY - d * (RAY_DY.z / d.z)) * t;
  return Plane(p.xy, jx.xy, jy.xy, p);
}

// Signed distance from where the ray meets a plane to a rectangle in it, in device pixels: the
// distance in the plane, over how fast it changes across the screen.
fn rectPx(h: Plane, centre: vec2f, half: vec2f) -> f32 {
  let p = h.uv - centre;
  let q = abs(p) - half;
  let s = select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0));
  var d = 0.0;
  var g = vec2f(0.0);
  if (q.x > 0.0 || q.y > 0.0) {
    let m = max(q, vec2f(0.0));
    d = length(m);
    g = s * m / max(d, 1e-6);
  } else if (q.x > q.y) {
    d = q.x;
    g = vec2f(s.x, 0.0);
  } else {
    d = q.y;
    g = vec2f(0.0, s.y);
  }
  let rate = length(vec2f(dot(g, h.jx), dot(g, h.jy)));
  return d / max(rate, 1e-6);
}

fn coverage(px: f32, width: f32) -> f32 {
  return saturate(0.5 - px / width);
}

struct Layer { color: vec3f, alpha: f32 }

// One realm: its six faces, each covering what it covers, the colours mixed by coverage so that where
// two faces meet the edge is the two blended rather than a hairline of whatever is behind.
fn realm(o: vec3f, d: vec3f, cell: vec2f, t: f32) -> Layer {
  let centre = cellCentre(cell);
  let lift = riseAt(centre);
  let x0 = centre.x - 0.5;
  let y0 = centre.y - 0.5;
  let z1 = lift + 1.0;
  let depth = depthOf(vec3f(centre, lift + 0.5));
  let w = blurWidth(depth);

  let top = planeZ(o, d, z1);
  let dTop = rectPx(top, centre, vec2f(0.5));
  let left = planeX(o, d, x0);
  let dLeft = rectPx(left, vec2f(centre.y, lift + 0.5), vec2f(0.5));
  let right = planeY(o, d, y0);
  let dRight = rectPx(right, vec2f(centre.x, lift + 0.5), vec2f(0.5));
  let alpha = coverage(min(min(dTop, dLeft), dRight), w);
  if (alpha <= 0.0) { return Layer(vec3f(0.0), 0.0); }

  let doorAt = vec2f(x0 + (DOOR_A0 + DOOR_A1) * 0.5, z1 - (DOOR_C0 + DOOR_C1) * 0.5);
  let doorHalf = vec2f((DOOR_A1 - DOOR_A0) * 0.5, (DOOR_C1 - DOOR_C0) * 0.5);
  let dDoor = rectPx(right, doorAt, doorHalf);
  let opening = coverage(dDoor, w);
  let glow = doorGlow(cell, t);

  var sum = vec3f(0.0);
  var weight = 0.0;

  // The top, lightest, catching the sky.
  let wTop = coverage(dTop, w);
  if (wTop > 0.0) {
    let k = saturate((top.p.x - x0 + top.p.y - y0) * 0.5);
    let tone = mix(TOP_NEAR, TOP_FAR, k);
    let lamp = pointerLight(top.p, vec3f(0.0, 0.0, 1.0));
    sum += tone * (DUSK * SKY + POINTER_LIGHT * lamp * 0.3) * wTop;
    weight += wTop;
  }

  // The left wall, mid, lit a little by the doorway of the realm beside it, darker toward the ground.
  let wLeft = coverage(dLeft, w);
  if (wLeft > 0.0) {
    let k = saturate(left.p.z - lift);
    let tone = mix(LEFT_LOW, LEFT_HIGH, k);
    let ao = 1.0 - 0.45 * exp(-left.p.z / 0.22);
    let n = vec3f(-1.0, 0.0, 0.0);
    let beside = cell - vec2f(1.0, 0.0);
    let besideCentre = cellCentre(beside);
    let spill = doorSpill(besideCentre, riseAt(besideCentre), doorGlow(beside, t), left.p, n);
    let lamp = pointerLight(left.p, n);
    sum += tone * (DUSK * ao * SKY + SPILL_LIGHT * spill * 0.16 + POINTER_LIGHT * lamp * 0.3) * wLeft;
    weight += wLeft;
  }

  // The right wall, darkest, with the doorway cut out of it.
  let wRight = coverage(max(dRight, -dDoor), w);
  if (wRight > 0.0) {
    let k = saturate(right.p.z - lift);
    let tone = mix(RIGHT_LOW, RIGHT_HIGH, k);
    let ao = 1.0 - 0.45 * exp(-right.p.z / 0.22);
    let lamp = pointerLight(right.p, vec3f(0.0, -1.0, 0.0));
    sum += tone * (DUSK * ao * SKY + POINTER_LIGHT * lamp * 0.3) * wRight;
    weight += wRight;
  }

  // Through the doorway: its back, which is the light when an agent is at work, and the floor and far
  // jamb it lights.
  if (opening > 0.0) {
    let back = planeY(o, d, y0 + DOOR_DEPTH);
    let wBack = coverage(rectPx(back, doorAt, doorHalf), w) * opening;
    let jamb = planeX(o, d, x0 + DOOR_A1);
    let wJamb = coverage(rectPx(jamb, vec2f(y0 + DOOR_DEPTH * 0.5, doorAt.y), vec2f(DOOR_DEPTH * 0.5, doorHalf.y)), w) * opening;
    let sill = planeZ(o, d, z1 - DOOR_C1);
    let wSill = coverage(rectPx(sill, vec2f(doorAt.x, y0 + DOOR_DEPTH * 0.5), vec2f(doorHalf.x, DOOR_DEPTH * 0.5)), w) * opening;
    if (wBack > 0.0) {
      let k = saturate((back.p.z - (z1 - DOOR_C1)) / (DOOR_C1 - DOOR_C0));
      let tone = mix(LIT_LOW, LIT_HIGH, k);
      sum += (tone * DOOR_LIGHT * glow * 2.6 + RIGHT_LOW * DUSK * 0.25) * wBack;
      weight += wBack;
    }
    if (wJamb > 0.0) {
      sum += LEFT_LOW * (DUSK * 0.4 + DOOR_LIGHT * glow * 0.55) * wJamb;
      weight += wJamb;
    }
    if (wSill > 0.0) {
      sum += TOP_NEAR * (DUSK * 0.5 + DOOR_LIGHT * glow * 0.7) * wSill;
      weight += wSill;
    }
  }

  return Layer(finish(sum / max(weight, 1e-4), depth), alpha);
}

const AROUND = array<vec2f, 7>(
  vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(-1.0, 0.0), vec2f(0.0, 1.0),
  vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
);

// The ground between the realms: dark, darker still close in to every cube, and lit where a doorway
// throws its light out onto it.
fn ground(o: vec3f, d: vec3f, t: f32) -> vec3f {
  let p = o + d * (-o.z / d.z);
  let cell = cellAt(p, 0.0);
  var ao = 1.0;
  var spill = 0.0;
  for (var k = 0; k < 7; k++) {
    let c = cell + AROUND[k];
    let centre = cellCentre(c);
    let lift = riseAt(centre);
    let q = abs(p.xy - centre) - vec2f(0.5);
    let edge = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
    ao *= 1.0 - 0.5 * exp(-max(edge, 0.0) / 0.1) * mix(0.35, 1.0, exp(-lift / 0.18));
    let glow = doorGlow(c, t);
    if (glow > 0.001) {
      spill += doorSpill(centre, lift, glow, p, vec3f(0.0, 0.0, 1.0));
    }
  }
  let lamp = pointerLight(p, vec3f(0.0, 0.0, 1.0));
  let light = toLinear(PAGE) * ao * SKY + SPILL_LIGHT * spill * 0.1 + POINTER_LIGHT * lamp * 0.02;
  return finish(light, depthOf(p));
}

// The window floats over the field and keeps the sky off what is under it: a soft shadow straight
// down from it, which on the page is mostly behind the window and shows only beside its lower half.
fn windowShade(p: vec2f) -> f32 {
  let r = hive.portal;
  if (r.z <= 0.0) { return 1.0; }
  let h = r.zw * 0.5;
  let sd = sdRoundRect(p - r.xy - h - vec2f(0.0, 46.0), h + vec2f(10.0, 0.0), 40.0);
  return 1.0 - 0.6 * (1.0 - smoothstep(-30.0, 70.0, sd));
}

// The words keep the page's own colour: the field is held off them by a hard bound around their
// rect, and only fades in beyond it.
fn clearance(p: vec2f) -> f32 {
  let r = hive.copy;
  if (r.z <= 0.0) { return 1.0; }
  let h = r.zw * 0.5;
  let bound = smoothstep(12.0, 150.0, sdRoundRect(p - r.xy - h, h, 16.0));
  let below = smoothstep(r.y + r.w - 40.0, r.y + r.w + 160.0, p.y);
  return bound * below;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * hive.view.xy;
  let dpr = hive.right.w;
  let px = p * dpr;
  let t = hive.view.z;

  // Under the window nothing is ever seen: it is opaque.
  let window = hive.portal;
  let wh = window.zw * 0.5;
  if (window.z > 0.0 && sdRoundRect(p - window.xy - wh, wh, 20.0) < -2.0) {
    return vec4f(dither(PAGE, px, t), 1.0);
  }
  let open = clearance(p);
  if (open <= 0.0) {
    return vec4f(dither(PAGE, px, t), 1.0);
  }

  SKY = windowShade(p);
  let focal = hive.eye.w;
  let o = hive.eye.xyz;
  let rel = (p - hive.principal.xy) / focal;
  let d = hive.forward.xyz + hive.right.xyz * rel.x - hive.up.xyz * rel.y;
  RAY_DX = hive.right.xyz / (focal * dpr);
  RAY_DY = -hive.up.xyz / (focal * dpr);

  // The cell the ray crosses at half height, and the two in front of it, nearest first.
  let home = cellAt(o + d * ((0.5 - o.z) / d.z), 0.5);
  var color = vec3f(0.0);
  var cover = 0.0;
  for (var k = 0; k < 3; k++) {
    var offset = vec2f(0.0, 0.0);
    if (k == 0) { offset = vec2f(0.0, -1.0); }
    if (k == 1) { offset = vec2f(1.0, -1.0); }
    let layer = realm(o, d, home + offset, t);
    color += (1.0 - cover) * layer.alpha * layer.color;
    cover += (1.0 - cover) * layer.alpha;
  }
  if (cover < 0.999) {
    color += (1.0 - cover) * ground(o, d, t);
  }

  let lit = mix(toLinear(PAGE), color, open);
  return vec4f(dither(toSrgb(lit), px, t), 1.0);
}
`
