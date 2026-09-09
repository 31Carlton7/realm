// Shared frame for every icon candidate: Apple's grid, the squircle body, the glass treatment and
// the premultiplied output. A candidate supplies `interior()` and nothing else, so what differs
// between three contact sheets is the idea and not the lighting.
//
// Knobs filled by render-candidates.mjs: __RES__ (render resolution), __UNIT__ (device pixels per
// grid pixel — a candidate uses it to keep a feature above a minimum width at 16px).

const CANVAS: f32 = 1024.0;
const ICON: f32 = 824.0;
const RES: f32 = __RES__;
const PX_PER_GRID: f32 = __UNIT__;
const PI: f32 = 3.14159265;

const BG_TOP: vec3f = vec3f(0.045, 0.072, 0.135);
const BG_BOT: vec3f = vec3f(0.008, 0.016, 0.040);
/** The app's accent, and the near-white it burns to. */
const ACCENT: vec3f = vec3f(0.475, 0.722, 1.0);
const ACCENT_DEEP: vec3f = vec3f(0.247, 0.533, 0.871);

fn gauss(x: f32, s: f32) -> f32 { return exp(-(x * x) / (2.0 * s * s)); }
fn srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}
fn fromSrgb(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }

/** Superellipse (n = 5): the same diagonal extent as Apple's continuous-corner squircle. */
fn squircle(p: vec2f, half: f32) -> f32 {
  let n = 5.0;
  let q = abs(p) / half;
  let r = pow(pow(q.x, n) + pow(q.y, n), 1.0 / n);
  return (r - 1.0) * half;
}

/** A superellipse at an arbitrary exponent, for the rounded panels a candidate may want. */
fn superRect(p: vec2f, half: vec2f, n: f32) -> f32 {
  let q = abs(p) / half;
  let r = pow(pow(q.x, n) + pow(q.y, n), 1.0 / n);
  return (r - 1.0) * min(half.x, half.y);
}

fn rounded(p: vec2f, half: vec2f, r: f32) -> f32 {
  let d = abs(p) - half + vec2f(r);
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - r;
}

/** Light comes from the top left, as it does in every Apple icon. y is down. */
const LIGHT: vec2f = vec2f(-0.47, -0.88);

/**
 * The outward normal of a superellipse at p, by central difference.
 *
 * A rim light that is equally bright all the way round reads as a stroke; one that fades as the
 * edge turns away from the light reads as an edge. Two extra SDF evaluations per axis is nothing
 * offline, and it is the difference between a shape that looks drawn and one that looks cut.
 */
fn superNormal(p: vec2f, half: vec2f, n: f32, h: f32) -> vec2f {
  let dx = superRect(p + vec2f(h, 0.0), half, n) - superRect(p - vec2f(h, 0.0), half, n);
  let dy = superRect(p + vec2f(0.0, h), half, n) - superRect(p - vec2f(0.0, h), half, n);
  return normalize(vec2f(dx, dy) + vec2f(1e-6, 0.0));
}

/** How much a point on an edge faces the light, 0 to 1. */
fn facingLight(normal: vec2f) -> f32 {
  return clamp(dot(normal, LIGHT), 0.0, 1.0);
}
