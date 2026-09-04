/**
 * The hero shader: the Realm app icon, alive.
 *
 * The same composition as `resources/icon-src/icon.wgsl` — a spectral ring set into a native macOS
 * squircle — drawn at hero size and put in motion: the bright head of the ring sweeps round, the hue
 * drifts, the fine bands flow, and the whole icon tilts toward the pointer with its rim light
 * following. Outside the squircle the ring's colour leaks onto the page, so the icon reads as lit
 * from within rather than pasted on.
 *
 * Kept as a WGSL string rather than a `.wgsl` module so the site needs no bundler loader. vgpu takes
 * a raw string as first-class shader source (`effect(gpu, source)`), and the same string is what
 * `scripts/render-shader.ts` compiles headlessly through `vgpu/node`, so the thing this file renders
 * in the browser is byte-for-byte the thing that gets verified.
 *
 * Uniform layout matches the `Params` struct below; write it with
 * `effect.set({ params: { resolution, pointer, time } })`.
 */
export const realmShader = /* wgsl */ `
struct Params {
  resolution: vec2f,
  pointer: vec2f,
  time: f32,
}

@group(0) @binding(0) var<uniform> params: Params;

const PI: f32 = 3.14159265;

// Apple's icon grid: a 1024 canvas with an 824 squircle. The icon takes ICON_FRAC of the canvas's
// shorter side; the rest is room for the glow it throws.
const ICON: f32 = 824.0;
const ICON_FRAC: f32 = 0.60;

const RING_R: f32 = 0.29;      // ring radius, fraction of ICON
const RING_W: f32 = 0.026;     // ring core sigma, fraction of ICON
const HEAD0: f32 = -2.2;       // where the bright head starts
const TAIL_DIM: f32 = 0.35;
const TWIST: f32 = 1.6;        // hue shift per unit radius
const BG_TOP: vec3f = vec3f(0.11, 0.12, 0.16);
const BG_BOT: vec3f = vec3f(0.03, 0.035, 0.05);
// #0a0b0e — the page. The canvas must dissolve into the section it sits in.
const PAGE: vec3f = vec3f(0.039, 0.043, 0.055);

fn gauss(x: f32, s: f32) -> f32 { return exp(-(x * x) / (2.0 * s * s)); }
fn srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}
fn fromSrgb(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }

// Superellipse (n = 5): the same diagonal extent as Apple's continuous-corner squircle.
fn squircle(p: vec2f, half: f32) -> f32 {
  let n = 5.0;
  let q = abs(p) / half;
  let r = pow(pow(q.x, n) + pow(q.y, n), 1.0 / n);
  return (r - 1.0) * half;
}

// aurora: sky → blue → violet → magenta → coral → gold → sky
fn palette(t: f32) -> vec3f {
  let k0 = vec3f(0.40, 0.80, 1.00);
  let k1 = vec3f(0.25, 0.45, 1.00);
  let k2 = vec3f(0.62, 0.32, 1.00);
  let k3 = vec3f(1.00, 0.30, 0.70);
  let k4 = vec3f(1.00, 0.52, 0.30);
  let k5 = vec3f(0.98, 0.80, 0.45);
  let u = fract(t) * 6.0;
  let i = i32(floor(u));
  let f = smoothstep(0.0, 1.0, fract(u));
  var a = k0; var b = k1;
  if (i == 1) { a = k1; b = k2; }
  if (i == 2) { a = k2; b = k3; }
  if (i == 3) { a = k3; b = k4; }
  if (i == 4) { a = k4; b = k5; }
  if (i == 5) { a = k5; b = k0; }
  return fromSrgb(mix(a, b, f));
}

// The icon is a flat card. Tilt it toward the pointer and find where this pixel's ray meets it, so
// the whole thing turns in perspective instead of just sliding.
fn tilted(p: vec2f, tilt: vec2f) -> vec2f {
  let ax = tilt.y * 0.28;   // around x: pointer above the centre lifts the top edge away
  let ay = -tilt.x * 0.28;  // around y
  let cx = cos(ax); let sx = sin(ax);
  let cy = cos(ay); let sy = sin(ay);
  // Card basis vectors after rotation (Ry * Rx applied to the unit x, y, z axes).
  let ex = vec3f(cy, 0.0, -sy);
  let ey = vec3f(sx * sy, cx, sx * cy);
  let n = vec3f(cx * sy, -sx, cx * cy);
  let cam = vec3f(0.0, 0.0, 2.6);
  let dir = vec3f(p, -2.6);
  let s = -dot(cam, n) / dot(dir, n);
  let hit = cam + dir * s;
  return vec2f(dot(hit, ex), dot(hit, ey));
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = params.time;
  let shortest = min(params.resolution.x, params.resolution.y);
  let unit = 1024.0 / ICON_FRAC / (1024.0 / ICON); // grid units per canvas short side
  let screen = (uv - 0.5) * params.resolution / shortest;
  let pointer = params.pointer;
  let q = tilted(screen * (unit / ICON), pointer);  // icon-normalised: the squircle is [-0.5, 0.5]
  let pp = q * ICON;                                 // Apple-grid pixels
  let px = unit / shortest;                          // grid units per canvas pixel
  let aa = px * 0.75;

  // ---- squircle body and drop shadow --------------------------------
  let d = squircle(pp, ICON * 0.5);
  let mask = 1.0 - smoothstep(-aa, aa, d);
  let ds = squircle(pp - vec2f(0.0, 18.0), ICON * 0.5);
  let shadow = 0.55 * gauss(max(ds, 0.0), 26.0);

  // ---- ring ----------------------------------------------------------
  let head = HEAD0 + t * 0.32;
  let r = length(q);
  let ang = atan2(q.y, q.x);
  let comet = mix(TAIL_DIM, 1.0, pow(0.5 + 0.5 * cos(ang - head), 1.6)) * (0.92 + 0.08 * sin(t * 1.3));
  let w = RING_W * (0.70 + 0.45 * cos(ang - head));
  let ringR = RING_R + 0.005 * sin(t * 0.8);
  let dr = r - ringR;
  let core = gauss(dr, w);
  let inside = smoothstep(0.0, -RING_W * 2.0, dr);
  let halo = gauss(dr, RING_W * 3.5) * 0.30 * (1.0 - 0.7 * inside);
  let bloom = gauss(dr, RING_W * 7.0) * 0.07 * (1.0 - inside);
  let bands = 0.86 + 0.10 * sin(ang * 26.0 + dr * 260.0 - t * 2.2) + 0.04 * sin(ang * 9.0 - dr * 120.0 + t * 0.9);
  let hue = (ang - head) / (2.0 * PI) + dr * TWIST + t * 0.02;
  let col = palette(hue);
  let emission = col * (core * bands * 2.4 + halo + bloom) * comet;
  let hot = gauss(dr, w * 0.45) * comet * comet * 0.75;

  // ---- icon surface --------------------------------------------------
  let vy = clamp(q.y + 0.5, 0.0, 1.0);
  var bg = mix(fromSrgb(BG_TOP), fromSrgb(BG_BOT), vy);
  bg *= 1.0 - 0.35 * smoothstep(0.25, 0.75, r);
  bg *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, ringR - w * 2.0, r));
  bg += col * halo * 0.15 * comet;
  var c = bg + emission + vec3f(hot);

  // ---- glass: rim light that follows the tilt, inner shadow, sheen ---
  let light = normalize(vec2f(-pointer.x * 0.9, -1.0));
  let facing = clamp(0.5 + dot(q, light) * 1.4, 0.0, 1.0);
  let rim = gauss(d + 3.0, 2.2 + px) * facing;
  c += vec3f(1.0) * rim * 0.55;
  let innerShade = gauss(d + 7.0, 9.0) * clamp(-dot(q, light) * 1.5 + 0.2, 0.0, 1.0);
  c *= 1.0 - innerShade * 0.35;
  let sheen = clamp(0.5 + dot(q, light) * 1.1, 0.0, 1.0);
  c += vec3f(0.06, 0.07, 0.09) * sheen * 0.35;

  // ---- the page around it: shadow beneath, ring light leaking out ----
  let leak = exp(-max(d, 0.0) / 95.0) * 0.09 * comet;
  var page = fromSrgb(PAGE) * (1.0 - shadow) + mix(col, vec3f(0.6), 0.25) * leak;

  // ---- encode --------------------------------------------------------
  let icon = srgb(clamp(c, vec3f(0.0), vec3f(1.0)));
  let ground = srgb(clamp(page, vec3f(0.0), vec3f(1.0)));
  var s = mix(ground, icon, mask);
  s += (hash(uv * params.resolution + vec2f(t * 60.0)) - 0.5) / 255.0;
  return vec4f(s, 1.0);
}
`
