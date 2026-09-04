// Realm app icon — a glowing spectral ring (a portal into a realm) set into a native
// macOS squircle: Apple's 824/1024 grid, superellipse corners, top rim light, soft drop shadow.
// Rendered headlessly with vgpu; knobs written as double-underscore tokens are filled in by render.mjs.

const CANVAS: f32 = 1024.0;           // logical canvas (Apple's 1024 grid)
const ICON: f32 = 824.0;              // squircle size on that grid
const RES: f32 = __RES__;             // actual render resolution (supersampled)
const PI: f32 = 3.14159265;

// ---- variant knobs -------------------------------------------------------
const RING_R: f32 = __RING_R__;       // ring radius, fraction of ICON
const RING_W: f32 = __RING_W__;       // ring core sigma, fraction of ICON (thickened at tiny sizes)
const HALO_W: f32 = __HALO_W__;       // sigma the halo and bloom are built from (size-independent)
const HEAD: f32 = __HEAD__;           // angle (radians) of the bright, thick "head" of the ring
const TAIL_DIM: f32 = __TAIL_DIM__;   // brightness at the tail, 0..1
const TWIST: f32 = __TWIST__;         // hue shift per unit radius (spiral colour drift)
const GLOW: f32 = __GLOW__;           // overall emission
const PALETTE: i32 = __PALETTE__;     // 0 spectrum, 1 aurora, 2 ember
const BG_TOP: vec3f = __BG_TOP__;
const BG_BOT: vec3f = __BG_BOT__;

fn gauss(x: f32, s: f32) -> f32 { return exp(-(x * x) / (2.0 * s * s)); }
fn srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}
fn fromSrgb(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }

// Superellipse (n = 5) — the same diagonal extent as Apple's continuous-corner squircle.
// Returns a signed distance in canvas pixels (exact on the axes, close elsewhere).
fn squircle(p: vec2f, half: f32) -> f32 {
  let n = 5.0;
  let q = abs(p) / half;
  let r = pow(pow(q.x, n) + pow(q.y, n), 1.0 / n);
  return (r - 1.0) * half;
}

fn spectrum(t: f32) -> vec3f {
  return 0.55 + 0.45 * cos(2.0 * PI * (t + vec3f(0.0, 0.33, 0.67)));
}
fn keyed(t: f32, k0: vec3f, k1: vec3f, k2: vec3f, k3: vec3f, k4: vec3f, k5: vec3f) -> vec3f {
  let u = fract(t) * 6.0;
  let i = i32(floor(u));
  let f = smoothstep(0.0, 1.0, fract(u));
  var a = k0; var b = k1;
  if (i == 1) { a = k1; b = k2; }
  if (i == 2) { a = k2; b = k3; }
  if (i == 3) { a = k3; b = k4; }
  if (i == 4) { a = k4; b = k5; }
  if (i == 5) { a = k5; b = k0; }
  return mix(a, b, f);
}
fn palette(t: f32) -> vec3f {
  if (PALETTE == 0) { return fromSrgb(spectrum(t)); }
  if (PALETTE == 1) {
    // aurora: sky → blue → violet → magenta → coral → gold → sky
    return fromSrgb(keyed(t,
      vec3f(0.40, 0.80, 1.00), vec3f(0.25, 0.45, 1.00), vec3f(0.62, 0.32, 1.00),
      vec3f(1.00, 0.30, 0.70), vec3f(1.00, 0.52, 0.30), vec3f(0.98, 0.80, 0.45)));
  }
  // ember: cyan → azure → indigo → magenta → orange → yellow → cyan
  return fromSrgb(keyed(t,
    vec3f(0.30, 0.95, 1.00), vec3f(0.20, 0.55, 1.00), vec3f(0.45, 0.25, 0.95),
    vec3f(0.95, 0.25, 0.80), vec3f(1.00, 0.45, 0.20), vec3f(1.00, 0.85, 0.35)));
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let pp = (uv - 0.5) * CANVAS;               // canvas pixels, origin centre, y down
  let px = CANVAS / RES;                       // canvas px per render px
  let aa = px * 0.75;

  // ---- squircle body, rim, drop shadow --------------------------------
  let d = squircle(pp, ICON * 0.5);
  let mask = 1.0 - smoothstep(-aa, aa, d);
  let ds = squircle(pp - vec2f(0.0, 10.0), ICON * 0.5);
  let shadow = 0.30 * gauss(max(ds, 0.0), 14.0);

  // ---- ring ----------------------------------------------------------
  let q = pp / ICON;                           // icon-normalised, [-0.5, 0.5]
  let r = length(q);
  let ang = atan2(q.y, q.x);
  let t = (ang - HEAD) / (2.0 * PI);           // 0 at the head; palettes are periodic in t
  let comet = mix(TAIL_DIM, 1.0, pow(0.5 + 0.5 * cos(ang - HEAD), 1.6)); // bright head, dim tail, no seam
  let w = RING_W * (0.70 + 0.45 * cos(ang - HEAD));
  let dr = r - RING_R;
  let core = gauss(dr, w);
  let inside = smoothstep(0.0, -HALO_W * 2.0, dr);      // the void stays dark: glow falls off fast inward
  let halo = gauss(dr, HALO_W * 3.5) * 0.30 * (1.0 - 0.7 * inside);
  let bloom = gauss(dr, HALO_W * 7.0) * 0.07 * (1.0 - inside);
  let bands = 0.86 + 0.10 * sin(ang * 26.0 + dr * 260.0) + 0.04 * sin(ang * 9.0 - dr * 120.0);
  let hue = t + dr * TWIST;
  let col = palette(hue);
  let emission = col * (core * bands * 2.4 + halo + bloom) * comet * GLOW;
  // white-hot core at the head
  let hot = gauss(dr, w * 0.45) * comet * comet * 0.75 * GLOW;

  // ---- background ----------------------------------------------------
  let vy = clamp(q.y + 0.5, 0.0, 1.0);
  var bg = mix(fromSrgb(BG_TOP), fromSrgb(BG_BOT), vy);
  bg *= 1.0 - 0.35 * smoothstep(0.25, 0.75, r);        // vignette
  bg *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, RING_R - w * 2.0, r)); // dark void inside the ring
  bg += col * halo * 0.15 * comet;                       // ring light spills onto the surface

  var c = bg + emission + vec3f(hot);

  // ---- glass: top rim light, bottom inner shadow, faint sheen --------
  let topness = clamp(0.5 - q.y * 1.4, 0.0, 1.0);
  let rim = gauss(d + 3.0, 2.2) * topness;
  c += vec3f(1.0) * rim * 0.55;
  let innerShade = gauss(d + 7.0, 9.0) * clamp(q.y * 1.5 + 0.2, 0.0, 1.0);
  c *= 1.0 - innerShade * 0.35;
  let sheen = smoothstep(0.55, -0.45, q.y);
  c += vec3f(0.06, 0.07, 0.09) * sheen * 0.35;

  // ---- encode --------------------------------------------------------
  var s = srgb(clamp(c, vec3f(0.0), vec3f(1.0)));
  s += (hash(uv * RES) - 0.5) / 255.0;
  let a = mask + shadow * (1.0 - mask);
  return vec4f(s * mask, a);                   // premultiplied
}
