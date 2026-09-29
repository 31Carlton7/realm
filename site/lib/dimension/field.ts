/**
 * The field behind the landing page: one fullscreen WGSL pass that every section of the page is a
 * region of. Scrolling moves through it; it does not scroll with it.
 *
 * It is drawn in the DOM's own coordinates — CSS pixels, origin top-left, y down, which is also
 * vgpu's `uv` convention — so an element's `getBoundingClientRect()` goes into a uniform unchanged
 * and the light lines up with the thing it belongs to at every size, zoom and breakpoint. Nothing
 * here knows where the product image IS; it is told, every frame.
 *
 * The headless renderer in the lab imports this same module, so the page and the lab compile
 * exactly the same text.
 */

import { facesWgsl } from "./faces"

/** Realm's tokens as the shader sees them, sRGB-encoded because the surface is not an sRGB view. */
export const PAGE = [23 / 255, 24 / 255, 26 / 255] as const
const ACCENT = [0.238, 0.6036, 1.0] as const
const ACCENT_INK = [0.4933, 0.7529, 1.0] as const
const INK = [0.9489, 0.9535, 0.958] as const

const vec3 = (rgb: readonly number[]) => `vec3f(${rgb.map((c) => c.toFixed(4)).join(", ")})`

/**
 * Everything the field is told, as vec4s so the layout needs no padding rules.
 *
 *   view     width, height (CSS px), seconds, reduced motion (0 | 1)
 *   pointer  x, y (CSS px), presence 0..1 — eased toward 0 when the pointer leaves
 *   portal   the product image's rect: left, top, width, height (CSS px, viewport)
 *   hero     presence 0..1, entering 0..1 (how far the hero has scrolled out)
 *   ripple   x, y (CSS px) of the last click, its age in seconds (negative: none), unused
 *   faces    presence 0..1, progress 0..1 through the pinned section, CSS px per mark unit, unused
 *   facesAt  the rect the assembling mark is centred in (CSS px, viewport)
 *   windows  up to four capture frames on screen, as rects (CSS px, viewport)
 *   counts   how many of `windows` are real, unused, unused, unused
 */
export type FieldUniforms = {
  view: [number, number, number, number]
  pointer: [number, number, number, number]
  portal: [number, number, number, number]
  hero: [number, number, number, number]
  ripple: [number, number, number, number]
  faces: [number, number, number, number]
  facesAt: [number, number, number, number]
  windows: [number, number, number, number][]
  counts: [number, number, number, number]
}

export const fieldShader = /* wgsl */ `
struct Field {
  view: vec4f,
  pointer: vec4f,
  portal: vec4f,
  hero: vec4f,
  ripple: vec4f,
  faces: vec4f,
  facesAt: vec4f,
  windows: array<vec4f, 4>,
  counts: vec4f,
}
@group(0) @binding(0) var<uniform> field: Field;

const PAGE = ${vec3(PAGE)};
const ACCENT = ${vec3(ACCENT)};
const ACCENT_INK = ${vec3(ACCENT_INK)};
const INK = ${vec3(INK)};
const TAU = 6.2831853;
// The portal's corner radius — the same 20px as the \`rounded-[20px]\` on the element it belongs to.
// Change one and the rim stops tracing the image's corners.
const PORTAL_RADIUS = 20.0;

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
    mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x),
    u.y,
  );
}

fn fbm(p: vec2f) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < 4; i++) {
    sum += amp * noise(q);
    q = q * 2.03 + vec2f(1.7, 9.2);
    amp *= 0.5;
  }
  return sum;
}

fn sdRoundRect(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// A rounded-rectangle "radius" that scales exactly: 1 on the portal's edge, 2 on a copy twice its
// size, about the same centre. A superellipse, because a true rounded rect does not scale that way —
// and the corridor is nothing but scaled copies of the portal.
fn portalRadius(v: vec2f) -> f32 {
  let a = abs(v) + vec2f(1e-5);
  return pow(pow(a.x, 10.0) + pow(a.y, 10.0), 0.1);
}

// The hero: the product image is the nearest of an endless run of frames receding behind it, and
// they flow inward — toward it — so the page reads as being drawn into the realm, not away from it.
fn heroLight(p: vec2f, t: f32) -> vec3f {
  let half = max(field.portal.zw * 0.5, vec2f(1.0));
  let c = field.portal.xy + half;
  let entering = field.hero.y;

  // The pointer bends the corridor around itself, a lens rather than a cursor trail. Proportional to
  // the offset rather than to its direction, so it is smooth through the pointer instead of pinching
  // to a ring there — and it moves the corridor only: the rim belongs to a DOM element that does not
  // bend, and light that drifted off its edge would stop being that element's light.
  let toM = p - field.pointer.xy;
  let lensRadius = 220.0;
  let near = field.pointer.z * exp(-dot(toM, toM) / (2.0 * lensRadius * lensRadius));
  var q = p - toM * 0.38 * near;

  // A click is a shockwave: a ring that runs outward from it, shoving the corridor aside and lighting
  // it as it passes, gone in under two seconds. Corridor only, like the lens.
  let rv = p - field.ripple.xy;
  let rd = max(length(rv), 1.0);
  let age = field.ripple.z;
  let ring = step(0.0, age) * exp(-pow((rd - age * 900.0) / 80.0, 2.0)) * exp(-age * 1.7);
  q += rv / rd * ring * 56.0;

  // Frames twist as they recede, so the corridor bends into a slow vortex. The twist is zero at the
  // portal itself, which keeps the nearest frame square to the image it surrounds.
  let flat = max(portalRadius((q - c) / half), 1e-4);
  let twist = log2(flat) * 0.34 + sin(t * 0.21) * 0.035 * log2(flat);
  let cs = vec2f(cos(twist), sin(twist));
  let w = q - c;
  let v = vec2f(w.x * cs.x + w.y * cs.y, -w.x * cs.y + w.y * cs.x) / half;
  let d = max(portalRadius(v), 1e-4);
  let z = log2(d);                                  // 0 on the portal, 1 one doubling out
  let theta = atan2(v.y, v.x + 1e-6);
  // Signed distance to the image's own edge, in CSS pixels: the mask and the rim share it.
  let edge = sdRoundRect(p - c, half, PORTAL_RADIUS);
  let outside = smoothstep(-1.0, 0.5, edge);

  // Frames: evenly spaced in log space, which is what perspective does to evenly spaced planes.
  let speed = 0.11 * (1.0 + entering * 5.0);
  let spacing = 0.2;
  let phase = z / spacing + t * speed * 5.0;
  let fw = max(fwidth(phase), 1e-4);
  let onFrame = 1.0 - smoothstep(0.0, fw * 1.25, abs(fract(phase + 0.5) - 0.5));
  let lit = 1.0 + near * 1.8 + ring * 3.0;
  let frames = onFrame * exp(-z * 1.35) * (0.5 + 0.5 * entering) * lit;

  // Rails: the corridor's walls, drawn along constant angle. Width comes from the distance to the
  // centre rather than fwidth, which would light the seam where atan2 wraps.
  let rails = 32.0;
  let railPhase = theta / TAU * rails;
  let railWidth = rails / (TAU * max(length(w), 1.0));
  let onRail = 1.0 - smoothstep(0.0, railWidth * 1.1, abs(fract(railPhase + 0.5) - 0.5));
  let rail = onRail * exp(-z * 2.4) * 0.22 * lit;

  // The edge of the portal, in true CSS pixels so the hairline stays a hairline.
  let sd = max(edge, 0.0);
  let rimAngle = atan2((p - c).y / half.y, (p - c).x / half.x + 1e-6);
  let dir = vec2f(cos(rimAngle), sin(rimAngle));
  let hair = exp(-sd / 1.4);
  let glow = exp(-sd / 26.0);
  let haze = exp(-sd / 150.0);
  // Energy runs round the perimeter. Sampled on a circle so it has no seam.
  let energy = smoothstep(0.42, 0.9, fbm(dir * 2.2 + vec2f(t * 0.22, -t * 0.17)));

  // Light escaping the portal: streaks that vary with angle only, so they read as rays.
  let ray = pow(fbm(dir * 5.5 + vec2f(t * 0.035, 0.0)), 3.2) * 2.6;
  let rays = ray * exp(-sd / 420.0);

  // Motes carried inward along the corridor.
  let cell = vec2f(theta / TAU * 84.0, z * 12.0 + t * speed * 16.0);
  let id = floor(cell);
  let h = hash21(id);
  let jitter = vec2f(hash21(id + 7.13), hash21(id + 3.31)) - 0.5;
  let md = length(fract(cell) - 0.5 - jitter * 0.55);
  let mote = step(0.965, h) * exp(-md * md * 240.0) * exp(-z * 1.4);

  var light = vec3f(0.0);
  light += ACCENT * frames * 0.9 + INK * frames * 0.12;
  light += ACCENT_INK * rail;
  light += ACCENT * (glow * 0.5 + haze * 0.11) * (1.0 + entering * 0.8);
  light += INK * hair * (0.28 + energy * 0.95);
  light += ACCENT_INK * glow * energy * 0.55;
  light += ACCENT_INK * rays * 0.16;
  light += INK * mote * 0.45;
  // The wave itself, not only the lines it crosses — otherwise it reads as a wobble.
  light += ACCENT_INK * ring * 0.2 * (1.0 - smoothstep(0.0, 900.0, rd));
  return light * outside;
}

// The product captures further down the page are windows into the same realm the hero looks into,
// so they wear the portal's edge — the hairline, the glow and the energy running round it — without
// its corridor, which would crowd the evidence it frames.
fn windowLight(p: vec2f, t: f32) -> vec3f {
  var light = vec3f(0.0);
  let count = i32(field.counts.x);
  for (var i = 0; i < 4; i++) {
    if (i >= count) { break; }
    let r = field.windows[i];
    let half = max(r.zw * 0.5, vec2f(1.0));
    let c = r.xy + half;
    let edge = sdRoundRect(p - c, half, PORTAL_RADIUS);
    let sd = max(edge, 0.0);
    let dir = normalize((p - c) / half + vec2f(1e-4));
    let energy = smoothstep(0.45, 0.9, fbm(dir * 2.0 + vec2f(t * 0.18 + f32(i) * 3.1, -t * 0.13)));
    let rim = ACCENT * (exp(-sd / 22.0) * 0.3 + exp(-sd / 120.0) * 0.06)
      + INK * exp(-sd / 1.3) * (0.16 + energy * 0.55) + ACCENT_INK * exp(-sd / 22.0) * energy * 0.35;
    light += rim * smoothstep(-1.0, 0.5, edge);
  }
  return light;
}

${facesWgsl}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * field.view.xy;
  let t = field.view.z;
  // Each dimension costs only while it is on screen. The conditions are uniforms, so control flow
  // stays uniform and the hero's derivatives stay legal.
  var light = vec3f(0.0);
  if (field.hero.x > 0.001) { light += heroLight(p, t) * field.hero.x; }
  if (field.faces.x > 0.001) { light += facesLight(p, t) * field.faces.x; }
  if (field.counts.x > 0.5) { light += windowLight(p, t); }
  // Light is added to the page and then compressed, so where there is none the result is exactly
  // --color-page and the canvas never reads as a rectangle.
  let lit = vec3f(1.0) - exp(-light * 1.15);
  var color = PAGE + lit * (vec3f(1.0) - PAGE);
  if (field.faces.x > 0.001) {
    let solid = facesSolid(p, t);
    color = mix(color, solid.rgb, solid.a * field.faces.x);
  }
  return vec4f(color, 1.0);
}
`
