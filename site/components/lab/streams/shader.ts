import { labWgsl } from "@/components/lab/stage"

import { STREAM_COUNT } from "./agents"

/**
 * One full-screen pass, drawn in the DOM's own coordinates (CSS px, origin top-left, y down).
 *
 * Three kinds of light, each belonging to an element the page owns:
 *  - a stream: a cubic from an agent's socket to the window's edge, lit as a fibre — a hairline core
 *    one device pixel wide, a breath of glow — with a pulse travelling it now and then;
 *  - the rim: the product window's frame, traced just outside its edge, brightening where a pulse
 *    lands and carrying that light a short way round before it fades;
 *  - a socket: the ring around an agent's mark, which brightens as a pulse leaves it.
 *
 *   view     width, height (CSS px), seconds, still (0 | 1)
 *   portal   the window's rect; rim: its perimeter (CSS px), corner radius
 *   copy     the rects of the words — the announcement, headline, lede and actions; nothing with
 *            area is drawn inside them, and it has faded to nothing by the time it reaches them
 *   ctrl     per stream, two vec4s: p0, p1 | p2, p3
 *   box      per stream, the rect outside which it cannot reach (min.xy, max.xy); empty when absent
 *   pulse    per stream: head (fraction of its length), head gain, tail (CSS px), resting level
 *   land     per stream: where it lands on the rim (CSS px along it), age of the last arrival (s),
 *            that arrival's strength, hover 0..1
 *   mark     per stream: the socket's centre, radius, and the light on its ring
 */
export const streamsShader = /* wgsl */ `
${labWgsl}

const N = ${STREAM_COUNT}u;
const SEGMENTS = 20;

struct Streams {
  view: vec4f,
  portal: vec4f,
  rim: vec4f,
  copy: array<vec4f, 4>,
  ctrl: array<vec4f, ${STREAM_COUNT * 2}>,
  box: array<vec4f, ${STREAM_COUNT}>,
  pulse: array<vec4f, ${STREAM_COUNT}>,
  land: array<vec4f, ${STREAM_COUNT}>,
  mark: array<vec4f, ${STREAM_COUNT}>,
}
@group(0) @binding(0) var<uniform> streams: Streams;

fn bez(a: vec2f, b: vec2f, c: vec2f, d: vec2f, t: f32) -> vec2f {
  let s = 1.0 - t;
  return s * s * s * a + 3.0 * s * s * t * b + 3.0 * s * t * t * c + t * t * t * d;
}

fn bezD(a: vec2f, b: vec2f, c: vec2f, d: vec2f, t: f32) -> vec2f {
  let s = 1.0 - t;
  return 3.0 * s * s * (b - a) + 6.0 * s * t * (c - b) + 3.0 * t * t * (d - c);
}

fn bezDD(a: vec2f, b: vec2f, c: vec2f, d: vec2f, t: f32) -> vec2f {
  return 6.0 * (1.0 - t) * (c - 2.0 * b + a) + 6.0 * t * (d - 2.0 * c + b);
}

// The nearest point of a cubic: x = distance to it, y = arc length up to it, z = the whole length
// (CSS px). Sampled as a polyline to find the right stretch, then refined on the true curve, so a
// hairline drawn from it has no facets where the samples turn a corner.
fn nearest(p: vec2f, a: vec2f, b: vec2f, c: vec2f, d: vec2f) -> vec3f {
  var prev = a;
  var run = 0.0;
  var best = 1e20;
  var bestT = 0.0;
  var bestRun = 0.0;
  for (var k = 1; k <= SEGMENTS; k++) {
    let tk = f32(k) / f32(SEGMENTS);
    let cur = bez(a, b, c, d, tk);
    let e = cur - prev;
    let ee = max(dot(e, e), 1e-6);
    let h = clamp(dot(p - prev, e) / ee, 0.0, 1.0);
    let q = p - prev - e * h;
    let dd = dot(q, q);
    let el = sqrt(ee);
    if (dd < best) {
      best = dd;
      bestT = (f32(k - 1) + h) / f32(SEGMENTS);
      bestRun = run + el * h;
    }
    run += el;
    prev = cur;
  }
  var t = bestT;
  for (var j = 0; j < 2; j++) {
    let q = bez(a, b, c, d, t) - p;
    let d1 = bezD(a, b, c, d, t);
    // Never let the curvature estimate go non-positive, or the step climbs away from the curve.
    let den = max(dot(d1, d1) + dot(q, bezDD(a, b, c, d, t)), 0.5 * dot(d1, d1) + 1e-4);
    let step = dot(q, d1) / den;
    t = clamp(t - clamp(step, -0.5 / f32(SEGMENTS), 0.5 / f32(SEGMENTS)), 0.0, 1.0);
  }
  let along = bestRun + (t - bestT) * length(bezD(a, b, c, d, t));
  return vec3f(length(p - bez(a, b, c, d, t)), along, run);
}

// The window's frame. Its corners are CSS \`corner-shape: squircle\` — a superellipse |x|^4 + |y|^4 —
// not circular arcs, so the corner distance is the superellipse's, to first order: exact on the curve
// itself, which is where the hairline sits.
fn sdFrame(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + vec2f(r);
  if (q.x > 0.0 && q.y > 0.0) {
    let q2 = q * q;
    let f = sqrt(sqrt(q2.x * q2.x + q2.y * q2.y));
    let g = length(q2 * q) / max(f * f * f, 1e-6);
    return (f - r) / max(g, 0.5);
  }
  return max(q.x, q.y) - r;
}

// Where a point beside the frame is along it: CSS px from the top edge's left end, clockwise. The
// corners are walked as quarter circles; the streams land on straight edges, where this is exact.
fn rimU(p: vec2f, c: vec2f, half: vec2f, r: f32) -> f32 {
  let l = p - c;
  let q = abs(l) - half + vec2f(r);
  let ex = 2.0 * (half.x - r);
  let ey = 2.0 * (half.y - r);
  let lc = 1.5707963 * r;
  if (q.x > 0.0 && q.y > 0.0) {
    let phi = atan2(q.y, q.x);
    if (l.x > 0.0 && l.y < 0.0) { return ex + (1.5707963 - phi) * r; }
    if (l.x > 0.0) { return ex + lc + ey + phi * r; }
    if (l.y > 0.0) { return 2.0 * ex + 2.0 * lc + ey + (1.5707963 - phi) * r; }
    return 2.0 * ex + 3.0 * lc + 2.0 * ey + phi * r;
  }
  if (q.x > q.y) {
    if (l.x > 0.0) { return ex + lc + l.y + half.y - r; }
    return 2.0 * ex + 3.0 * lc + ey + half.y - r - l.y;
  }
  if (l.y < 0.0) { return l.x + half.x - r; }
  return ex + 2.0 * lc + ey + half.x - r - l.x;
}

// A pulse landing: a flare where it hits, then light running both ways along the frame, spreading
// and fading as it goes. du: CSS px along the rim from the landing point; age: seconds since.
fn landing(du: f32, age: f32) -> f32 {
  if (age < 0.0 || age > 3.0) { return 0.0; }
  let flare = exp(-age / 0.22) * exp(-du * du / 200.0);
  let front = 210.0 * (1.0 - exp(-age / 0.5));
  let width = 7.0 + 26.0 * age;
  let x = abs(du) - front;
  let runner = exp(-x * x / (2.0 * width * width)) * exp(-age / 0.62);
  let wake = (1.0 - smoothstep(front - width, front + width, abs(du))) * exp(-age / 0.4);
  return flare * 2.4 + runner * 1.25 + wake * 0.3;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * streams.view.xy;
  // CSS px per device pixel: a hairline is one of these wide at every density.
  let px = max(fwidth(p.x), 1e-4);
  let t = streams.view.z;

  // Nothing with area reaches the words: it is zero inside each block of them and rises to full only
  // 24px clear of it — a hard bound with a soft edge, so no seam is drawn where it holds.
  var area = 1.0;
  for (var k = 0; k < 4; k++) {
    let r = streams.copy[k];
    if (r.z <= 0.0) { continue; }
    let outside = max(max(r.xy - p, p - r.xy - r.zw), vec2f(0.0));
    area *= smoothstep(0.0, 24.0, length(outside));
  }

  let fibre = INK * 0.72 + ACCENT_INK * 0.28;
  var light = vec3f(0.0);

  for (var i = 0u; i < N; i++) {
    let bx = streams.box[i];
    if (p.x < bx.x || p.y < bx.y || p.x > bx.z || p.y > bx.w) { continue; }
    let a = streams.ctrl[2u * i].xy;
    let b = streams.ctrl[2u * i].zw;
    let c = streams.ctrl[2u * i + 1u].xy;
    let d = streams.ctrl[2u * i + 1u].zw;
    let n = nearest(p, a, b, c, d);
    let pulse = streams.pulse[i];
    let s = n.y / max(n.z, 1.0);

    // The pulse: a bright head with a tail behind it along the fibre, and a hard front ahead.
    let lag = (pulse.x - s) * n.z;
    let tail = select(exp(-lag * lag / 6.0), exp(-lag / pulse.z), lag >= 0.0);
    let head = exp(-lag * lag / 50.0);
    let hover = streams.land[i].w;
    let level = pulse.w * (0.78 + 0.32 * s) + pulse.y * (tail * 0.9 + head * 0.9);

    let core = clamp(1.0 - n.x / (px * 1.1), 0.0, 1.0);
    let glow = exp(-n.x / 2.0);
    let halo = exp(-n.x / 11.0);
    // The pulse's own light is whiter than the fibre's: the head is hot, the line it runs is cool.
    let heat = pulse.y * head;
    light += mix(fibre, INK, heat) * core * level;
    light += ACCENT_INK * glow * level * 0.13 * area;
    light += ACCENT * halo * level * 0.035 * area;
  }

  // The rim, outside the frame only: the window covers everything inside its edge.
  let pr = streams.portal;
  if (pr.z > 1.0) {
    let half = pr.zw * 0.5;
    let centre = pr.xy + half;
    let r = streams.rim.y;
    let sd = sdFrame(p - centre, half, r);
    let o = max(sd, 0.0);
    if (o < 120.0) {
      let u = rimU(p, centre, half, r);
      let perimeter = streams.rim.x;
      // Resting light, stronger along the top where the streams arrive; events on top of it.
      let topness = 1.0 - smoothstep(0.0, 320.0, p.y - pr.y);
      let resting = 0.12 + 0.24 * topness;
      var burst = 0.0;
      for (var i = 0u; i < N; i++) {
        let l = streams.land[i];
        if (streams.box[i].z < streams.box[i].x) { continue; }
        var du = u - l.x;
        du -= perimeter * round(du / perimeter);
        burst += landing(du, l.y) * l.z;
        burst += l.w * 0.6 * exp(-du * du / (2.0 * 80.0 * 80.0));
      }
      // The frame's light is a line first: crisp at the edge, then a breath of glow off it.
      let core = clamp(1.0 - o / (px * 1.2), 0.0, 1.0) + exp(-o / 1.3) * 0.3;
      light += (INK * 0.82 + ACCENT_INK * 0.18) * core * (resting + burst * 1.2);
      light += ACCENT_INK * exp(-o / 4.0) * (resting * 0.1 + burst * 0.17) * area;
      light += ACCENT * exp(-o / 28.0) * (resting * 0.022 + burst * 0.04) * area;
    }
  }

  // Sockets: the ring around a mark brightens as a pulse leaves it, and while it is hovered.
  for (var i = 0u; i < N; i++) {
    let m = streams.mark[i];
    if (m.w < 0.002) { continue; }
    let o = max(length(p - m.xy) - m.z, 0.0);
    if (o > 40.0) { continue; }
    let core = clamp(1.0 - o / (px * 1.2), 0.0, 1.0);
    light += fibre * (core * 0.7 + exp(-o / 3.0) * 0.2) * m.w;
    light += ACCENT * exp(-o / 12.0) * m.w * 0.05 * area;
  }

  let color = dither(compose(light), p / px, t);
  return vec4f(color, 1.0);
}
`
