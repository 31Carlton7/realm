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
 *   arc      per stream, the share of its length at t = 1/4, 1/2, 3/4, and the length (CSS px)
 *   pulse    per stream: head (fraction of its length), head gain, tail (CSS px), resting level
 *   land     per stream: where it lands on the rim (CSS px along it), age of the last arrival (s),
 *            which way along the rim the window's middle is (+1 | -1), hover 0..1
 *   mark     per stream: the socket's centre, radius, and the light on its ring
 */
export const streamsShader = /* wgsl */ `
${labWgsl}

const N = ${STREAM_COUNT}u;

struct Streams {
  view: vec4f,
  portal: vec4f,
  rim: vec4f,
  copy: array<vec4f, 4>,
  ctrl: array<vec4f, ${STREAM_COUNT * 2}>,
  box: array<vec4f, ${STREAM_COUNT}>,
  arc: array<vec4f, ${STREAM_COUNT}>,
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

// The nearest point of a stream: x = the distance to it (CSS px), y = how far along it that point
// is (0..1 of its length). Every stream is a single gentle bend, so the point's projection on its
// chord starts Newton in the right basin, and four steps land on the true curve — no sampled
// polyline, so a hairline drawn from it has no facets. The arc length comes from \`arc\`: the share
// of the length at t = 1/4, 1/2 and 3/4, measured on the CPU.
fn nearest(p: vec2f, a: vec2f, b: vec2f, c: vec2f, d: vec2f, arc: vec4f) -> vec2f {
  let chord = d - a;
  var t = clamp(dot(p - a, chord) / max(dot(chord, chord), 1e-4), 0.0, 1.0);
  for (var j = 0; j < 4; j++) {
    let q = bez(a, b, c, d, t) - p;
    let d1 = bezD(a, b, c, d, t);
    // Never let the curvature estimate go non-positive, or the step climbs away from the curve.
    let den = max(dot(d1, d1) + dot(q, bezDD(a, b, c, d, t)), 0.5 * dot(d1, d1) + 1e-4);
    t = clamp(t - clamp(dot(q, d1) / den, -0.25, 0.25), 0.0, 1.0);
  }
  let k = min(t * 4.0, 3.9999);
  let i = floor(k);
  let s0 = select(select(select(arc.z, arc.y, i < 2.5), arc.x, i < 1.5), 0.0, i < 0.5);
  let s1 = select(select(select(1.0, arc.z, i < 2.5), arc.y, i < 1.5), arc.x, i < 0.5);
  return vec2f(length(p - bez(a, b, c, d, t)), mix(s0, s1, k - i));
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

// A pulse landing: a flare where it hits, then light running both ways along the frame — further
// toward the window's middle than away from it, so what lands gathers inward — spreading and fading
// as it goes, and a little of it held at the port for a couple of seconds. du: CSS px along the rim
// from the landing point; age: seconds since; inward: which way along the rim the middle is.
fn landing(du: f32, age: f32, inward: f32) -> f32 {
  if (age < 0.0 || age > 5.0) { return 0.0; }
  let flare = exp(-age / 0.22) * exp(-du * du / 200.0);
  let reach = select(100.0, 250.0, du * inward > 0.0);
  let front = reach * (1.0 - exp(-age / 0.55));
  let width = 7.0 + 24.0 * age;
  let x = abs(du) - front;
  let runner = exp(-x * x / (2.0 * width * width)) * exp(-age / 0.65);
  let wake = (1.0 - smoothstep(front - width, front + width, abs(du))) * exp(-age / 0.45);
  let held = exp(-age / 1.8) * exp(-abs(du) / 150.0);
  return flare * 2.4 + runner * 1.2 + wake * 0.28 + held * 0.22;
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
    let arc = streams.arc[i];
    let n = nearest(p, a, b, c, d, arc);
    let pulse = streams.pulse[i];
    let s = n.y;

    // The pulse: a bright head, a hard front ahead of it, and behind it the fibre lit for a while —
    // the stream shows where work is running in and is nearly gone where none is.
    let lag = (pulse.x - s) * arc.w;
    let tail = select(exp(-lag * lag / 6.0), exp(-lag / pulse.z), lag >= 0.0);
    let head = exp(-lag * lag / 50.0) * step(s, 1.0) * step(pulse.x, 1.02);
    let level = pulse.w * (0.7 + 0.5 * s) + pulse.y * (tail * 0.85 + head * 0.9);

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
      // The frame holds almost no light of its own. What it has pools where the streams come in —
      // a soft glow around each landing, strongest at the two clusters — and fades away from them.
      var resting = 0.03;
      var burst = 0.0;
      for (var i = 0u; i < N; i++) {
        let l = streams.land[i];
        if (streams.box[i].z < streams.box[i].x) { continue; }
        var du = u - l.x;
        du -= perimeter * round(du / perimeter);
        resting += 0.05 * exp(-abs(du) / 150.0);
        burst += landing(du, l.y, l.z);
        burst += l.w * 0.6 * exp(-du * du / (2.0 * 80.0 * 80.0));
      }
      // The frame's light is a line first: crisp at the edge, then a breath of glow off it.
      let core = clamp(1.0 - o / (px * 1.2), 0.0, 1.0) + exp(-o / 1.3) * 0.3;
      light += (INK * 0.82 + ACCENT_INK * 0.18) * core * (resting + burst * 1.2);
      light += ACCENT_INK * exp(-o / 3.2) * (resting * 0.1 + burst * 0.15) * area;
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
