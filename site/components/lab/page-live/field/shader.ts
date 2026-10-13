import { labWgsl } from "@/components/lab/stage"

export const MAX_SEGMENTS = 64
export const MAX_POINTS = 24
export const MAX_RIM = 12

/**
 * The hero's light, one pass in the plate's own coordinates (CSS px, origin top-left, y down) offset
 * by the canvas's margin. It draws only what the map publishes (./lights.ts):
 *
 *  - a stretch of line carrying light: a hairline's breath of glow either side of it, brighter toward
 *    the end the light is travelling to — a hovered line along its whole length, a pulse's tail;
 *  - a point: a pulse's head or a landing, a small hot core with a short falloff;
 *  - the window's rim: light where the lines arrive, traced just outside its left edge, running a
 *    little way along it and fading round the corners.
 *
 * Everything else is the page's own colour exactly (compose() maps zero light to PAGE), and every
 * output is dithered, so the canvas never reads as a rectangle or bands in the dark.
 */
export const lightShader = /* wgsl */ `
${labWgsl}

struct Light {
  view: vec4f,
  origin: vec4f,
  win: vec4f,
  info: vec4f,
  seg: array<vec4f, ${MAX_SEGMENTS}>,
  segk: array<vec4f, ${MAX_SEGMENTS}>,
  pt: array<vec4f, ${MAX_POINTS}>,
  rim: array<vec4f, ${MAX_RIM}>,
}
@group(0) @binding(0) var<uniform> light: Light;

// Distance from p to the segment ab, and how far along it the nearest point is (0..1).
fn toSegment(p: vec2f, a: vec2f, b: vec2f) -> vec2f {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
  return vec2f(length(p - (a + ab * t)), t);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // The canvas reaches past the plate by its margins; p is in the plate's own coordinates.
  let p = uv * light.view.xy - light.origin.xy;
  let px = max(fwidth(p.x), 1e-4);
  let t = light.view.z;
  // Signal light: the accent's ink, whitened, so a pulse reads as light rather than as blue paint.
  let signal = mix(ACCENT_INK, INK, 0.38);
  var l = vec3f(0.0);

  let ns = u32(light.info.x);
  for (var i = 0u; i < ${MAX_SEGMENTS}u; i++) {
    if (i >= ns) { break; }
    let s = light.seg[i];
    let k = light.segk[i];
    let w = k.z;
    // Cheap reject: outside the segment's padded box, it adds nothing visible.
    let lo = min(s.xy, s.zw) - vec2f(w * 7.0);
    let hi = max(s.xy, s.zw) + vec2f(w * 7.0);
    if (p.x < lo.x || p.y < lo.y || p.x > hi.x || p.y > hi.y) { continue; }
    let d = toSegment(p, s.xy, s.zw);
    let level = mix(k.x, k.y, d.y);
    l += signal * level * (exp(-d.x / w) * 0.55 + exp(-d.x / (w * 3.2)) * 0.2);
  }

  let np = u32(light.info.y);
  for (var i = 0u; i < ${MAX_POINTS}u; i++) {
    if (i >= np) { break; }
    let q = light.pt[i];
    let d = length(p - q.xy);
    if (d > q.z * 7.0) { continue; }
    let core = exp(-(d * d) / (q.z * q.z * 0.18));
    l += signal * q.w * (core * 1.1 + exp(-d / q.z) * 0.45);
  }

  // The window's rim, outside its edge only: the window covers everything inside it.
  let win = light.win;
  if (win.z > 1.0) {
    let half = win.zw * 0.5;
    let c = win.xy + half;
    let sd = sdRoundRect(p - c, half, 20.0);
    if (sd > -1.0 && sd < 36.0) {
      let o = max(sd, 0.0);
      // The light arrives along one edge — the left on a wide screen, the top on a phone — and fades
      // round the corners from it.
      let top = light.info.w > 0.5;
      let along = select(exp(-max(p.x - win.x - 20.0, 0.0) / 46.0), exp(-max(p.y - win.y - 20.0, 0.0) / 46.0), top);
      let u = select(p.y, p.x, top);
      var level = 0.0;
      let nr = u32(light.info.z);
      for (var i = 0u; i < ${MAX_RIM}u; i++) {
        if (i >= nr) { break; }
        let r = light.rim[i];
        let dy = u - r.x;
        level += r.y * exp(-(dy * dy) / (2.0 * r.z * r.z));
      }
      level *= along;
      let core = clamp(1.0 - o / (px * 1.2), 0.0, 1.0) + exp(-o / 1.4) * 0.3;
      l += (INK * 0.75 + ACCENT_INK * 0.25) * core * level;
      l += ACCENT_INK * exp(-o / 5.0) * level * 0.16;
      l += ACCENT * exp(-o / 22.0) * level * 0.05;
    }
  }

  let color = dither(compose(l), p / px, t);
  return vec4f(color, 1.0);
}
`
