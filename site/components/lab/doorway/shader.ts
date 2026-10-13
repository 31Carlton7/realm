import { ACCENT, labWgsl, PAGE } from "../stage"

/**
 * The Doorway: the product window is an opening in the dark wall of a room, and the realm behind it is
 * lit. Its light comes out through the opening into a faint haze, lands on the floor in front of it,
 * and catches the dust in the air on the way.
 *
 * It is drawn as a small physical scene rather than as a glow. The wall faces the eye squarely, so the
 * wall is the screen scaled — the window on it IS the DOM rect, unskewed — and the eye stands a little
 * above the window, looking down at the floor in front of it. The light sits behind the wall at the
 * height of the window's upper part. Three things are lit by it:
 *
 *   haze   single scattering along each view ray, over exactly the stretch of the ray the light can
 *          reach through the opening. That stretch is found analytically — the ray's points, projected
 *          from the light onto the wall, run along a straight segment that the window clips — and the
 *          haze thins exponentially away from the wall, which integrates exactly. No marching, so there
 *          is no stepping to band or crawl. The light is a disc, averaged over five places on it.
 *   floor  a plane at the window's sill: the light that lands on it, with a penumbra that widens away
 *          from the wall, and the window's reflection, Fresnel-weighted and stretched along the floor.
 *   dust   sparse motes at three depths near the wall, lit only where they are inside the beam.
 */

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const mix = (a: readonly number[], b: readonly number[], t: number) => a.map((x, i) => x + (b[i]! - x) * t)
const vec3 = (rgb: readonly number[]) => `vec3f(${rgb.map((c) => c.toFixed(5)).join(", ")})`

const PAGE_LINEAR = PAGE.map(linear)
const ACCENT_LINEAR = ACCENT.map(linear)
/** Light scattered by fine haze leans blue — Realm's accent at low saturation — and more so where it is
 *  thin, since what reaches the eye there has been scattered more than once. */
const HAZE = mix([1, 1, 1], ACCENT_LINEAR, 0.22)
const HAZE_THIN = mix([1, 1, 1], ACCENT_LINEAR, 0.5)
/** What arrives straight through the opening: near white, a touch cool. */
const CORE = mix([1, 1, 1], ACCENT_LINEAR, 0.06)

export const doorwayWgsl = /* wgsl */ `
${labWgsl}

struct Door {
  view: vec4f,     // viewport width, height (CSS px), seconds, still (0 | 1)
  pointer: vec4f,  // x, y (CSS px), presence 0..1, device px per CSS px
  win: vec4f,      // the window: left, top, width, height (CSS px, viewport)
  copy: vec4f,     // the words' block, which no light with area may reach into
  stage: vec4f,    // the hero, whose lower edge the floor fades out before
  light: vec4f,    // the light's place on the screen (CSS px), its depth behind the wall and its radius (in F)
  cam: vec4f,      // the eye's axis on the screen (CSS px), the focal length F (CSS px), the floor's line (CSS px)
  look: vec4f,     // the haze's depth from the wall (in F), its forward scattering g, the light's disc on the wall (CSS px)
}
@group(0) @binding(0) var<uniform> door: Door;

const PAGE_LIN = ${vec3(PAGE_LINEAR)};
const HAZE = ${vec3(HAZE)};
const HAZE_THIN = ${vec3(HAZE_THIN)};
const CORE = ${vec3(CORE)};
// The window's corner — the 20px of \`rounded-[20px]\` on the frame it belongs to, drawn as the squircle
// \`corner-shape\` makes of it.
const FRAME_RADIUS = 20.0;

// The scene, in units of the focal length F: the eye at the origin looking down +z, the wall at z = 1
// (one unit there is F CSS px), y down like the page. Set once per pixel in scene().
var<private> F: f32;
var<private> axis: vec2f;       // where the eye's axis meets the screen, CSS px
var<private> kappa: f32;        // the light's depth: the wall is at 1
var<private> lightPos: vec3f;
var<private> lightOnWall: vec2f; // the light's projection on the wall: where every ray of it appears to start
var<private> srcRadius: f32;
var<private> srcSpread: vec2f;  // the light's disc as the eye sees it on the wall, across and up
var<private> apC: vec2f;        // the opening's centre and half size on the wall
var<private> apH: vec2f;
var<private> floorY: f32;       // the floor's depth below the eye
var<private> hazeDepth: f32;
var<private> hazeG: f32;

fn sdFrame(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + vec2f(r);
  let m = max(q, vec2f(0.0));
  let m2 = m * m;
  return sqrt(sqrt(m2.x * m2.x + m2.y * m2.y)) + min(max(q.x, q.y), 0.0) - r;
}

fn sdBox(p: vec2f, half: vec2f) -> f32 {
  let q = abs(p) - half;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}

fn toSrgb(c: vec3f) -> vec3f {
  let hi = 1.055 * pow(max(c, vec3f(0.0031308)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, c * 12.92, c <= vec3f(0.0031308));
}

// Light adds as light does, in linear terms, and rolls off with a soft shoulder before it is encoded.
// No light at all is exactly the page, so the canvas never reads as a rectangle.
fn composeLinear(light: vec3f) -> vec3f {
  let lit = vec3f(1.0) - exp(-light);
  return toSrgb(PAGE_LIN + lit * (vec3f(1.0) - PAGE_LIN));
}

// Henyey–Greenstein, unnormalised: how much light running one way the haze turns toward the eye.
fn phase(cosT: f32, g: f32) -> f32 {
  let g2 = g * g;
  let k = 1.0 + g2 - 2.0 * g * cosT;
  return (1.0 - g2) / (k * sqrt(k));
}

// The part of the segment a -> b (u from 0 to 1) inside the box c +- h, as [u0, u1]; empty when u0 >= u1.
fn clipSegment(a: vec2f, b: vec2f, c: vec2f, h: vec2f) -> vec2f {
  let dir = b - a;
  let inv = 1.0 / select(dir, vec2f(1e-6), abs(dir) < vec2f(1e-6));
  let t0 = (c - h - a) * inv;
  let t1 = (c + h - a) * inv;
  let lo = min(t0, t1);
  let hi = max(t0, t1);
  return vec2f(max(max(lo.x, lo.y), 0.0), min(min(hi.x, hi.y), 1.0));
}

// A view ray's points, projected from the light onto the wall, run along the segment from the pixel's
// own wall point (u = 0, at the wall) to the light's projection (u = 1, at the eye). This is the depth
// of the point at u.
fn depthAt(u: f32) -> f32 {
  return kappa * (1.0 - u) / (kappa - u);
}

// What the haze turns toward the eye from depth s on the view ray d, per unit of haze: how strongly it
// scatters forward at that angle to the light, and the light's inverse-square falloff.
fn scatterAt(d: vec3f, s: f32) -> f32 {
  let fromLight = d * s - lightPos;
  let r2 = dot(fromLight, fromLight);
  let cosT = -dot(fromLight, d) * inverseSqrt(r2 * dot(d, d));
  let k = kappa - 1.0;
  return phase(cosT, hazeG) * k * k / r2;
}

// The haze along the view ray between depths s0 and s1. Its density falls off exponentially away from
// the wall, which integrates exactly; the phase and the falloff change slowly over a stretch that
// short, so they are taken once, at the stretch's haze-weighted centre. No marching, so no steps.
fn hazeBetween(d: vec3f, s0: f32, s1: f32) -> f32 {
  let span = max(s1 - s0, 0.0);
  let fall = exp(-span / hazeDepth);
  let amount = hazeDepth * exp((s1 - 1.0) / hazeDepth) * (1.0 - fall);
  let centre = s1 - hazeDepth + span * fall / max(1.0 - fall, 1e-5);
  return amount * scatterAt(d, clamp(centre, s0, s1)) * length(d);
}

// The light is a disc, not a point: its rays through the opening are averaged over five places on it,
// which softens where the beam's upper faces cut the haze.
fn volume(w: vec2f, d: vec3f, sEnd: f32) -> f32 {
  var sum = 0.0;
  for (var i = 0; i < 5; i++) {
    let a = f32(i) * 2.3999632;
    let rr = sqrt((f32(i) + 0.5) / 5.0);
    let source = lightOnWall + vec2f(cos(a), sin(a)) * rr * srcSpread;
    let span = clipSegment(w, source, apC, apH);
    if (span.y > span.x) {
      let near = depthAt(span.y);
      let far = min(depthAt(span.x), sEnd);
      if (far > near) { sum += hazeBetween(d, near, far); }
    }
  }
  return sum / 5.0;
}

// How much of the light's disc a point in the room sees through the opening. The penumbra widens with
// the point's distance from the wall, so the light is crisp where it leaves and soft where it lands.
fn throughWindow(x: vec3f) -> f32 {
  let q = lightPos.xy + (x.xy - lightPos.xy) * (kappa - 1.0) / (kappa - x.z);
  let pen = srcRadius * (1.0 - x.z) / (kappa - x.z) + 0.6 / F;
  let sd = sdRoundRect((q - apC) * F, apH * F, FRAME_RADIUS) / F;
  return clamp(0.5 - sd / (2.0 * pen), 0.0, 1.0);
}

// The light at a point in the room as the eye sees it scattered: through the opening, inverse square,
// and turned toward the eye by a phase with forward lobe g.
fn beamAt(x: vec3f, g: f32) -> f32 {
  let fromLight = x - lightPos;
  let r2 = dot(fromLight, fromLight);
  let cosT = -dot(fromLight, x) * inverseSqrt(r2 * dot(x, x));
  let k = kappa - 1.0;
  return throughWindow(x) * phase(cosT, g) * k * k / r2;
}

// Two octaves of value noise, normalised to 0..1 like fbm: enough for the broad, low-contrast layers.
fn fbm2(p: vec2f) -> f32 {
  return (noise(p) * 0.5 + noise(p * 2.03 + vec2f(1.7, 9.2)) * 0.25) / 0.75;
}

// Light through haze is never even: a faint variation by direction from the light, constant along every
// ray of it, which is what reads as shafts. Sampled on a circle, so it has no seam; slow, as haze drifts.
fn streak(w: vec2f, t: f32) -> f32 {
  let v = w - lightOnWall;
  let dir = normalize(v + vec2f(1e-5, 0.0));
  let broad = fbm2(dir * 2.7 + vec2f(t * 0.016, -t * 0.011));
  let mid = noise(dir * 13.0 + vec2f(-t * 0.03, t * 0.022));
  let fine = noise(dir * 37.0 + vec2f(t * 0.05, t * 0.031));
  // Every ray meets at the light's projection, which sits just inside the window's top edge: fade the
  // variation out around it, or the rim over the top edge would fan like a sunrise from one point. The
  // window's corners and the floor are far enough away to keep all of it.
  let away = smoothstep(0.08, 0.3, length(v));
  return max(1.0 + away * ((broad - 0.5) + 0.5 * (mid - 0.5) + 0.36 * (fine - 0.5)), 0.0);
}

// The haze is not even either: a faint, slow unevenness, fixed to the room so it scrolls with it.
fn hazeDensity(q: vec2f, t: f32) -> f32 {
  let n = fbm2(q / 230.0 + vec2f(t * 0.011, -t * 0.006));
  return 0.72 + 0.56 * n;
}

// Dust: sparse motes at three depths near the wall, drifting, each lit by the beam where it is. They are
// seen only where the air itself is seen to glow, so they read as dust in the light rather than as points
// in the dark. Nearer motes are a little bigger and softer; the pointer's air pushes the nearest aside.
fn dust(p: vec2f, t: f32, dpr: f32) -> f32 {
  var sum = 0.0;
  for (var layer = 0; layer < 3; layer++) {
    let fl = f32(layer);
    let s = 0.965 - fl * 0.055;
    let cell = 46.0 / s;
    let drift = vec2f(sin(t * 0.045 + fl * 2.1) * 12.0, t * (2.2 + fl * 0.9)) / s;
    let g = (p - axis + drift) / cell;
    let base = floor(g);
    let o = select(vec2f(-1.0), vec2f(0.0), g - base > vec2f(0.5));
    for (var j = 0; j < 4; j++) {
      let id = base + o + vec2f(f32(j & 1), f32(j >> 1));
      let h = hash22(id + fl * 19.31);
      if (h.x > 0.2) { continue; }
      let jit = hash22(id * 1.37 + 5.17);
      let wob = vec2f(sin(t * (0.13 + jit.x * 0.17) + h.y * 40.0), cos(t * (0.11 + jit.y * 0.13) + h.y * 23.0)) * 0.09;
      var m = (id + 0.25 + 0.5 * jit + wob) * cell - drift + axis;
      let away = m - door.pointer.xy;
      let dist = length(away) + 1e-3;
      m += away / dist * 34.0 * door.pointer.z * exp(-dist * dist / 15000.0);
      let r = length(p - m) * dpr;
      let sigma = max((0.28 + h.y * 0.3 + fl * 0.12) * dpr, 0.55);
      if (r > sigma * 4.0) { continue; }
      let x = vec3f((m - axis) / F, 1.0) * s;
      let profile = exp(-r * r / (2.0 * sigma * sigma)) * min(1.0, 0.6 / (sigma * sigma));
      let haze = exp((s - 1.0) / (hazeDepth * 1.3));
      let glint = fract(h.y * 7.3);
      sum += beamAt(x, 0.45) * haze * profile * (0.25 + 0.75 * glint * glint);
    }
  }
  return sum;
}

fn scene(p: vec2f, t: f32, sdWin: f32, dpr: f32) -> vec3f {
  F = door.cam.z;
  axis = door.cam.xy;
  kappa = door.light.z;
  srcRadius = door.light.w;
  hazeDepth = door.look.x;
  hazeG = door.look.y;
  srcSpread = door.look.zw / F;
  lightOnWall = (door.light.xy - axis) / F;
  lightPos = vec3f(lightOnWall * kappa, kappa);
  apC = (door.win.xy + door.win.zw * 0.5 - axis) / F;
  apH = door.win.zw * 0.5 / F;
  floorY = (door.cam.w - axis.y) / F;

  let w = (p - axis) / F;
  let d = vec3f(w, 1.0);
  let onFloor = w.y > floorY;
  let sEnd = select(1.0, floorY / max(w.y, 1e-5), onFloor);
  let shafts = streak(w, t);

  let haze = volume(w, d, sEnd) * shafts * hazeDensity(p - axis, t) * 0.36;
  var light = mix(HAZE_THIN, HAZE, smoothstep(0.0, 0.2, haze)) * haze;

  if (onFloor) {
    // Polished concrete: a faint, broad unevenness, in the floor's own coordinates so it foreshortens.
    let x = d * sEnd;
    let grain = fbm(vec2f(x.x, x.z) * vec2f(7.0, 11.0) + 3.7);
    let albedo = 0.86 + 0.28 * grain;

    // The light that lands on it.
    let toLight = lightPos - x;
    let r2 = dot(toLight, toLight);
    let cosI = max(-toLight.y, 0.0) * inverseSqrt(r2);
    let k = kappa - 1.0;
    light += CORE * throughWindow(x) * cosI * k * k / r2 * mix(1.0, shafts, 0.55) * albedo * 0.1;

    // The window's reflection: the pixel's wall point mirrored in the floor, blurred more the further the
    // reflected ray runs and far more along the floor than across it, as a polished floor stretches it.
    // The window's face is dim — it is the product — and its frame is lit, so the reflection is mostly
    // the frame's: two long edges falling away under the window's sides, and its foot along the sill.
    let mirrored = (vec2f(w.x, 2.0 * floorY - w.y) - apC) * F;
    let travel = 1.0 - sEnd;
    let blur = vec2f(1.5 + travel * 0.035 * F, 3.0 + travel * 0.32 * F);
    let edge = abs(mirrored) - apH * F;
    let across = 1.0 - smoothstep(-blur.x, blur.x, edge.x);
    let along = 1.0 - smoothstep(-blur.y, blur.y, edge.y);
    let rim = exp(-abs(edge.x) / blur.x) * along + exp(-abs(edge.y) / (blur.y * 0.6)) * across;
    let cosV = w.y * inverseSqrt(dot(d, d));
    let fresnel = 0.04 + 0.96 * pow(1.0 - cosV, 5.0);
    light += CORE * (across * along * 0.035 + rim * 0.3) * fresnel * exp(-travel * 2.2) * mix(1.0, albedo, 0.5);
  }

  // The eye's own glare round a lit opening: tight, and quick to fall away.
  let sd = max(sdWin, 0.0);
  light += CORE * (0.14 * exp(-sd / 3.0) + 0.045 * exp(-sd / 16.0) + 0.012 * exp(-sd / 70.0)) * mix(1.0, shafts, 0.6);

  if (haze > 0.004) {
    light += CORE * dust(p, t, dpr) * 0.5 * smoothstep(0.004, 0.05, haze);
  }
  return light;
}

// Light with area stays below the words: nothing at all down to a margin under their block, across the
// whole width, then a short rise — a level, not a box, so no shape is ever cut round them.
fn belowCopy(p: vec2f) -> f32 {
  let r = door.copy;
  if (r.z < 1.0) { return 1.0; }
  return smoothstep(r.y + r.w + 12.0, r.y + r.w + 64.0, p.y);
}

// And it ends with the hero: the floor fades to dark before the stage's lower edge.
fn withinStage(p: vec2f) -> f32 {
  let bottom = door.stage.y + door.stage.w;
  return 1.0 - smoothstep(bottom - 280.0, bottom, p.y);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * door.view.xy;
  let t = door.view.z;
  let dpr = door.pointer.w;
  var light = vec3f(0.0);
  let bound = belowCopy(p) * withinStage(p);
  if (door.win.z > 1.0 && bound > 0.0) {
    let half = door.win.zw * 0.5;
    let sdWin = sdFrame(p - door.win.xy - half, half, FRAME_RADIUS);
    // Inside the window the product covers the canvas; nothing there is ever seen.
    if (sdWin > -2.0) {
      light = scene(p, t, sdWin, dpr) * bound;
    }
  }
  return vec4f(dither(composeLinear(light), p * dpr, t), 1.0);
}
`
