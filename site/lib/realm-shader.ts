/**
 * The hero shader: "a realm".
 *
 * A raymarched signed-distance scene — a glowing core wrapped in a shell of orbiting panes, ringed
 * by a precessing band. It is Realm's own shape: one space at the centre, split panes arranged
 * around it, everything local to a single contained world.
 *
 * Kept as a WGSL string rather than a `.wgsl` module so the site needs no bundler loader. vgpu takes
 * a raw string as first-class shader source (`effect(gpu, source)`), and the same string is what
 * `scripts/render-shader.ts` compiles headlessly through `vgpu/node`, so the thing this file renders
 * in the browser is byte-for-byte the thing that gets verified in CI.
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

const PANES: i32 = 9;
const GOLDEN: f32 = 2.39996322973;
const MAX_STEPS: i32 = 76;
const MAX_DIST: f32 = 14.0;
const SURF_EPS: f32 = 0.0012;

// Realm's accent, lifted from the app's design tokens (oklch(0.68 0.173 253.301)) and baked to
// linear-ish RGB here so the shader never pays for a colour-space conversion per pixel.
const ACCENT: vec3f = vec3f(0.243, 0.545, 0.985);
const ACCENT_WARM: vec3f = vec3f(0.596, 0.776, 1.0);
const CORE_HOT: vec3f = vec3f(0.92, 0.96, 1.0);

// ── math helpers ────────────────────────────────────────────────────────────────

fn rot2(p: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * p.x - s * p.y, s * p.x + c * p.y);
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += vec2f(dot(q, q + vec2f(45.32)));
  return fract(q.x * q.y);
}

fn sdSphere(p: vec3f, r: f32) -> f32 {
  return length(p) - r;
}

fn sdRoundBox(p: vec3f, b: vec3f, r: f32) -> f32 {
  let q = abs(p) - b + vec3f(r);
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

fn sdTorus(p: vec3f, major: f32, minor: f32) -> f32 {
  let q = vec2f(length(p.xz) - major, p.y);
  return length(q) - minor;
}

// ── the scene ───────────────────────────────────────────────────────────────────

/**
 * Distance to the realm, plus a material id in .y: 1 = core, 2 = pane, 3 = ring.
 *
 * The panes sit on a Fibonacci shell — golden-angle longitude, evenly stepped latitude — so they
 * wrap the core without ever landing in a visible row. Each is oriented with two cheap 2D
 * rotations rather than a constructed basis: spin the sample point back to the prime meridian, tilt
 * it down to the equator, and what is left is an axis-aligned slab.
 */
fn map(p: vec3f) -> vec2f {
  let t = params.time;

  // Core: a sphere that breathes. Displacement stays well under the march's step size so the
  // distance field remains conservative and the surface never over-steps.
  let breathe = 0.012 * sin(t * 1.1) + 0.008 * sin(p.y * 7.0 + t * 2.3);
  var d = sdSphere(p, 0.40 + breathe);
  var mat = 1.0;

  // Pane shell.
  for (var i = 0; i < PANES; i++) {
    let fi = f32(i);
    let y = 1.0 - (2.0 * fi + 1.0) / f32(PANES);
    let lat = asin(clamp(y, -1.0, 1.0));
    // Two counter-rotating groups keep the shell from reading as one rigid object.
    let dir = select(-1.0, 1.0, (i % 2) == 0);
    let lon = fi * GOLDEN + t * 0.16 * dir;

    var q = p;
    q = vec3f(rot2(q.xz, -lon), q.y).xzy;
    q = vec3f(rot2(q.xy, -lat), q.z);

    // Sizes stay close together on purpose: let one pane get much larger than the rest and it stops
    // reading as a shell around the core and starts reading as a slab in front of it.
    let radius = 1.14 + 0.07 * sin(fi * 1.7);
    let half = vec3f(0.024, 0.29 + 0.055 * sin(fi * 1.3), 0.28 + 0.05 * cos(fi * 0.9));
    let pane = sdRoundBox(q - vec3f(radius, 0.0, 0.0), half, 0.022);

    if (pane < d) {
      d = pane;
      mat = 2.0;
    }
  }

  // Precessing ring. Tilted well off the camera axis so it reads as an ellipse rather than a bar,
  // and kept as a hard union — a smooth-min against a torus this thin swells it into a blob wherever
  // a pane drifts past.
  var r = p;
  r = vec3f(rot2(r.xz, t * 0.09), r.y).xzy;
  r = vec3f(rot2(r.xy, 0.92 + 0.09 * sin(t * 0.23)), r.z);
  let ring = sdTorus(r, 1.58, 0.011);
  if (ring < d) {
    d = ring;
    mat = 3.0;
  }

  return vec2f(d, mat);
}

fn normalAt(p: vec3f) -> vec3f {
  // Tetrahedron sampling: four map() calls instead of six.
  let e = vec2f(1.0, -1.0) * 0.0008;
  return normalize(
    e.xyy * map(p + e.xyy).x +
    e.yyx * map(p + e.yyx).x +
    e.yxy * map(p + e.yxy).x +
    e.xxx * map(p + e.xxx).x
  );
}

/** Ambient occlusion sampled along the normal. Cheap, and it is what gives the shell its depth. */
fn ambientOcclusion(p: vec3f, n: vec3f) -> f32 {
  var occ = 0.0;
  var scale = 1.0;
  for (var i = 0; i < 5; i++) {
    let h = 0.012 + 0.09 * f32(i);
    occ += (h - map(p + n * h).x) * scale;
    scale *= 0.72;
  }
  return clamp(1.0 - 2.2 * occ, 0.0, 1.0);
}

/** Soft shadow toward the core, so panes cast onto the panes behind them. */
fn coreShadow(p: vec3f, ld: vec3f, maxT: f32) -> f32 {
  var shade = 1.0;
  var t = 0.05;
  for (var i = 0; i < 14; i++) {
    if (t > maxT) { break; }
    let h = map(p + ld * t).x;
    if (h < 0.0008) { return 0.0; }
    shade = min(shade, 14.0 * h / t);
    t += clamp(h, 0.02, 0.24);
  }
  return clamp(shade, 0.0, 1.0);
}

/** Animated banding on the core — surface detail without touching the distance field. */
fn corePattern(n: vec3f, t: f32) -> f32 {
  let bands = 0.5 + 0.5 * sin(n.y * 9.0 - t * 1.4 + sin(n.x * 5.0 + t * 0.7) * 1.6);
  let cells = 0.5 + 0.5 * sin(atan2(n.z, n.x) * 7.0 + t * 0.5);
  return mix(bands, cells, 0.35);
}

// ── tonemap ─────────────────────────────────────────────────────────────────────

fn aces(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = params.time;
  let aspect = params.resolution.x / max(params.resolution.y, 1.0);
  // uv arrives 0..1 with y down; centre it and flip so +y is up.
  var screen = (uv - vec2f(0.5)) * 2.0;
  screen.x *= aspect;
  screen.y = -screen.y;

  // Camera. The pointer nudges the orbit rather than the target, so the realm turns to face you.
  let park = vec2f(0.22 + params.pointer.x * 0.55, 0.10 + params.pointer.y * 0.34);
  let drift = vec2f(sin(t * 0.11) * 0.06, sin(t * 0.077) * 0.035);
  let yaw = park.x + drift.x;
  let pitch = clamp(park.y + drift.y, -0.85, 0.85);

  var ro = vec3f(0.0, 0.0, 4.75);
  ro = vec3f(rot2(ro.zy, pitch), ro.x).zyx;
  ro = vec3f(rot2(ro.xz, yaw), ro.y).xzy;

  let forward = normalize(-ro);
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), forward));
  let up = cross(forward, right);
  let rd = normalize(right * screen.x + up * screen.y + forward * 1.85);

  // March, accumulating the core's volumetric halo as we go. Because the loop stops at the first
  // hit, the panes occlude the glow for free — that is where the shell's silhouette comes from.
  var dist = 0.0;
  var mat = 0.0;
  var glow = 0.0;
  var hit = false;
  for (var i = 0; i < MAX_STEPS; i++) {
    let p = ro + rd * dist;
    let s = map(p);
    let step = max(s.x, SURF_EPS * 0.5);

    let toCore = length(p);
    glow += exp(-2.6 * toCore) * step * 0.55;

    if (s.x < SURF_EPS * max(1.0, dist * 0.6)) {
      mat = s.y;
      hit = true;
      break;
    }
    dist += step;
    if (dist > MAX_DIST) { break; }
  }

  // Background: the page's own ground, lifted very slightly toward the accent in the centre so the
  // canvas dissolves into the section around it instead of sitting on it as a rectangle.
  let vignette = smoothstep(1.5, 0.05, length(screen));
  var color = vec3f(0.0355, 0.0375, 0.0435) + ACCENT * 0.012 * vignette;

  if (hit) {
    let p = ro + rd * dist;
    let n = normalAt(p);
    let view = -rd;
    let fresnel = pow(1.0 - clamp(dot(n, view), 0.0, 1.0), 4.0);

    // The core is the scene's only real light source.
    let toCoreVec = -p;
    let coreDist = length(toCoreVec);
    let ld = toCoreVec / max(coreDist, 0.0001);
    let key = normalize(vec3f(0.55, 0.78, 0.42));

    if (mat < 1.5) {
      // Core: emissive, but deliberately kept off the top of the range. Raising the pattern to a
      // power tightens the bands into filaments, so the sphere reads as structured plasma rather
      // than the flat white disc a linear ramp gives you.
      let pattern = corePattern(n, t);
      let filament = pow(pattern, 2.4);
      let rim = pow(1.0 - clamp(dot(n, view), 0.0, 1.0), 2.0);
      var emissive = mix(ACCENT * 0.55, CORE_HOT, filament * 0.85);
      emissive *= 0.62 + 1.05 * filament;
      // Limb brightening toward the accent, not toward white — the edge should glow, not clip.
      emissive = mix(emissive, ACCENT * 1.35, rim * 0.8);
      color = emissive;
    } else {
      // Panes and ring: near-black glass that only exists because the core lights it.
      let falloff = 1.0 / (1.0 + 1.25 * coreDist * coreDist);
      let lambert = clamp(dot(n, ld), 0.0, 1.0);
      let shadow = coreShadow(p, ld, coreDist - 0.5);
      let occ = ambientOcclusion(p, n);

      var lit = vec3f(0.024, 0.028, 0.036);
      // Ambient bounce from the halo. Without it every pane whose face turns away from the core
      // collapses to pure black and punches a hole in the shell.
      lit += ACCENT * 0.075;
      lit += ACCENT * lambert * falloff * shadow * 2.6;
      lit += ACCENT_WARM * fresnel * 0.62;
      // Broad sheen across the whole outward face — a low fresnel exponent, so it is a wash rather
      // than an edge. This is what makes a pane turned away from the core read as glass, not a hole.
      lit += ACCENT_WARM * pow(1.0 - clamp(dot(n, view), 0.0, 1.0), 1.6) * 0.11;

      // The ring is self-lit: at this radius it is a couple of pixels wide, and a surface that thin
      // never gathers enough diffuse to survive the tonemap.
      if (mat > 2.5) {
        lit += ACCENT * 0.85 + ACCENT_WARM * 0.45;
      }

      // Specular from the key light gives the slabs a glass edge the core alone cannot.
      let h = normalize(ld + view);
      lit += ACCENT_WARM * pow(clamp(dot(n, h), 0.0, 1.0), 48.0) * falloff * shadow * 1.5;
      lit += vec3f(0.9, 0.94, 1.0) * pow(clamp(dot(n, normalize(key + view)), 0.0, 1.0), 90.0) * 0.30;

      // Thin bright lip where a pane's edge faces the core — reads as a lit screen bezel.
      let edge = smoothstep(0.55, 1.0, fresnel) * lambert * falloff;
      lit += ACCENT_WARM * edge * 1.1;

      color = lit * mix(0.55, 1.0, occ);
    }
  }

  color += ACCENT * glow * 1.15;
  color += ACCENT_WARM * pow(glow, 2.2) * 0.42;

  color = aces(color * 1.06);
  // Slight lift in the shadows keeps the panes from crushing to pure black on OLED.
  color = pow(color, vec3f(0.9));

  // Ordered-ish dither: without it the halo bands badly on an 8-bit surface.
  let grain = (hash21(uv * params.resolution + vec2f(t * 60.0)) - 0.5) / 255.0;
  return vec4f(color + vec3f(grain), 1.0);
}
`
