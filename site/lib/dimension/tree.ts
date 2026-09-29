/**
 * The interlude between the claims: one agent opening more, drawn as sessions opening sessions.
 *
 * Every beat is something the delegation code does. A session hands work to three others that run
 * at once, each a real session with its own work streaming in it; two of those delegate once more;
 * a third level is refused, because `MAX_DELEGATION_DEPTH` is 2 — drawn here as a beam that meets a
 * boundary and sparks against it. Then every report travels back up the beam it came down, and the
 * session that started it all takes them in.
 *
 * The dimension this happens in is polar: rings and spokes radiating from the first session, a third
 * geometry after the hero's perspective corridor and the mark's isometric lattice.
 *
 * Coordinates are "box units": the tree is laid out in a 1.4 : 1 box one unit wide, fitted into the
 * area the page marks with `data-dim="tree"`. Expects `field.tree` (presence, progress, unused,
 * unused) and `field.treeAt` (the area's rect), plus PAGE, INK, ACCENT, ACCENT_INK and sdRoundRect.
 */

/** Beats in the pinned track: open, fan out, delegate once more and be refused, report back. */
export const TREE_STEPS = 4

const ASPECT = 1.4

type Node = { at: [number, number]; half: [number, number]; parent: number; opens: number; done: number }

/**
 * The tree, root first. `opens` and `done` are in steps (progress × TREE_STEPS): when the node's
 * session opens — as the beam reaching it arrives — and when its report has gone back up.
 */
const NODES: Node[] = [
  { at: [0.11, 0.357], half: [0.078, 0.052], parent: -1, opens: 0.05, done: 3.86 },
  { at: [0.47, 0.12], half: [0.06, 0.04], parent: 0, opens: 1.4, done: 3.74 },
  { at: [0.47, 0.357], half: [0.06, 0.04], parent: 0, opens: 1.5, done: 3.7 },
  { at: [0.47, 0.594], half: [0.06, 0.04], parent: 0, opens: 1.6, done: 3.78 },
  { at: [0.8, 0.05], half: [0.043, 0.029], parent: 1, opens: 2.4, done: 3.3 },
  { at: [0.8, 0.19], half: [0.043, 0.029], parent: 1, opens: 2.47, done: 3.34 },
  { at: [0.8, 0.524], half: [0.043, 0.029], parent: 3, opens: 2.54, done: 3.28 },
  { at: [0.8, 0.664], half: [0.043, 0.029], parent: 3, opens: 2.61, done: 3.36 },
]

/** The refused third level: out of the second grandchild, into a boundary it does not cross. */
const REFUSED_FROM = 5
const BARRIER_X = 0.935

const f = (n: number) => n.toFixed(4)
const v2 = ([x, y]: readonly number[]) => `vec2f(${f(x)}, ${f(y)})`

export const treeWgsl = /* wgsl */ `
var<private> NODE_AT: array<vec2f, 8> = array<vec2f, 8>(${NODES.map((n) => v2(n.at)).join(", ")});
var<private> NODE_HALF: array<vec2f, 8> = array<vec2f, 8>(${NODES.map((n) => v2(n.half)).join(", ")});
var<private> NODE_PARENT: array<i32, 8> = array<i32, 8>(${NODES.map((n) => n.parent).join(", ")});
var<private> NODE_OPENS: array<f32, 8> = array<f32, 8>(${NODES.map((n) => f(n.opens)).join(", ")});
var<private> NODE_DONE: array<f32, 8> = array<f32, 8>(${NODES.map((n) => f(n.done)).join(", ")});
const TREE_ASPECT = ${f(ASPECT)};
const BARRIER_X = ${f(BARRIER_X)};

// The box the tree is laid out in, fitted into its area: origin, width, height in CSS px.
fn treeBox() -> vec4f {
  let r = field.treeAt;
  let w = min(r.z, r.w * TREE_ASPECT);
  let h = w / TREE_ASPECT;
  return vec4f(r.x + (r.z - w) * 0.5, r.y + (r.w - h) * 0.5, w, h);
}

fn toTree(p: vec2f) -> vec2f {
  let b = treeBox();
  return (p - b.xy) / max(b.z, 1.0);
}

fn beamPoint(a: vec2f, b: vec2f, c: vec2f, t: f32) -> vec2f {
  return mix(mix(a, b, t), mix(b, c, t), t);
}

// Distance from p to a quadratic Bezier, and the curve's parameter at the closest point — Inigo
// Quilez's closed form, kept whole so a beam can be drawn up to a point along its own length.
fn beamDistance(p: vec2f, A: vec2f, B: vec2f, C: vec2f) -> vec2f {
  let a = B - A;
  let b = A - 2.0 * B + C;
  let c = a * 2.0;
  let d = A - p;
  let kk = 1.0 / dot(b, b);
  let kx = kk * dot(a, b);
  let ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0;
  let kz = kk * dot(d, a);
  let q0 = ky - kx * kx;
  let q3 = q0 * q0 * q0;
  let q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
  let h = q * q + 4.0 * q3;
  if (h >= 0.0) {
    let hs = sqrt(h);
    let x = (vec2f(hs, -hs) - q) * 0.5;
    let uv = sign(x) * pow(abs(x), vec2f(1.0 / 3.0));
    let t = saturate(uv.x + uv.y - kx);
    let e = d + (c + b * t) * t;
    return vec2f(length(e), t);
  }
  let z = sqrt(-q0);
  let v = acos(clamp(q / (q0 * z * 2.0), -1.0, 1.0)) / 3.0;
  let m = cos(v);
  let n = sin(v) * 1.7320508;
  let t1 = saturate((m + m) * z - kx);
  let t2 = saturate((-n - m) * z - kx);
  let e1 = d + (c + b * t1) * t1;
  let e2 = d + (c + b * t2) * t2;
  if (dot(e1, e1) < dot(e2, e2)) { return vec2f(length(e1), t1); }
  return vec2f(length(e2), t2);
}

// The beam into node i: out of its parent's right edge, level at first, then bending to the child's
// left edge. The control point is lifted a hair so a level beam is never a degenerate curve.
fn beamEnds(i: i32) -> array<vec2f, 3> {
  let parent = NODE_PARENT[i];
  let a = NODE_AT[parent] + vec2f(NODE_HALF[parent].x, 0.0);
  let c = NODE_AT[i] - vec2f(NODE_HALF[i].x, 0.0);
  return array<vec2f, 3>(a, vec2f(mix(a.x, c.x, 0.55), a.y + 0.0017), c);
}

// How much of beam i is drawn: it grows over the half-step before its child opens. Under reduced
// motion it is simply there once its child is, with no growing tip.
fn beamDrawn(i: i32, s: f32) -> f32 {
  if (field.view.w > 0.5) { return step(NODE_OPENS[i] - 0.2, s); }
  return smoothstep(NODE_OPENS[i] - 0.45, NODE_OPENS[i], s);
}

// A report's journey back up beam i, 0 at the child to 1 at the parent; outside (0, 1) there is none.
fn beamReport(i: i32, s: f32) -> f32 {
  return (s - (NODE_DONE[i] - 0.3)) / 0.3;
}

fn treeLight(p: vec2f, t: f32) -> vec3f {
  let u = toTree(p);
  let unit = 1.0 / max(treeBox().z, 1.0);
  let s = field.tree.y * ${TREE_STEPS}.0;
  let still = field.view.w > 0.5;
  var light = vec3f(0.0);

  // The polar dimension: rings and spokes out of the first session, turning slowly.
  let fromRoot = u - NODE_AT[0];
  let radius = length(fromRoot);
  let ringPhase = radius / 0.052 - t * 0.12;
  let ring = 1.0 - smoothstep(0.0, unit * 1.3 / 0.052, abs(fract(ringPhase) - 0.5));
  let spokePhase = (atan2(fromRoot.y, fromRoot.x + 1e-6) / 6.2831853 + t * 0.004) * 36.0;
  let spoke = 1.0 - smoothstep(0.0, 36.0 * unit * 1.1 / (6.2831853 * max(radius, 1e-3)), abs(fract(spokePhase) - 0.5));
  let reach = exp(-radius / 0.36) * smoothstep(0.02, 0.09, radius);
  light += ACCENT * (ring * 0.2 + spoke * 0.08) * reach * smoothstep(0.0, 0.4, s);

  // The beams, the tips growing along them, and the reports travelling back.
  for (var i = 1; i < 8; i++) {
    let drawn = beamDrawn(i, s);
    if (drawn <= 0.0) { continue; }
    let ends = beamEnds(i);
    let bz = beamDistance(u, ends[0], ends[1], ends[2]);
    let shown = 1.0 - smoothstep(drawn - 0.02, drawn, bz.y);
    let finished = smoothstep(NODE_DONE[i], NODE_DONE[i] + 0.3, s);
    let strength = mix(1.0, 0.45, finished);
    light += (ACCENT * exp(-bz.x / (unit * 10.0)) * 0.3 + ACCENT_INK * exp(-bz.x / (unit * 1.2)) * 0.7) * shown * strength;
    if (drawn < 1.0 && !still) {
      let tip = beamPoint(ends[0], ends[1], ends[2], drawn);
      light += INK * exp(-length(u - tip) / (unit * 4.5)) * 1.3;
    }
    // While the child runs, work keeps flowing out to it: dots travelling the beam, so running in
    // parallel is something you watch rather than read.
    let running = smoothstep(NODE_OPENS[i], NODE_OPENS[i] + 0.2, s) * (1.0 - smoothstep(NODE_DONE[i] - 0.35, NODE_DONE[i] - 0.3, s));
    if (running > 0.0 && !still) {
      for (var k = 0; k < 4; k++) {
        let along = fract(t * 0.42 + f32(k) * 0.25 + f32(i) * 0.13);
        let dot = beamPoint(ends[0], ends[1], ends[2], along);
        light += ACCENT_INK * exp(-length(u - dot) / (unit * 2.4)) * 0.8 * running * sin(along * 3.14159);
      }
    }
    let report = beamReport(i, s);
    if (report > 0.0 && report < 1.0 && !still) {
      let at = beamPoint(ends[0], ends[1], ends[2], 1.0 - report);
      light += INK * exp(-length(u - at) / (unit * 3.8)) * 1.5 + ACCENT_INK * exp(-length(u - at) / (unit * 14.0)) * 0.4;
    }
  }

  // The refused third level: a beam out of a grandchild that stops dead at the depth boundary, and
  // the spark where it hits. The boundary is only visible where it is being leaned on.
  let origin = NODE_AT[${REFUSED_FROM}] + vec2f(NODE_HALF[${REFUSED_FROM}].x, 0.0);
  let hit = vec2f(BARRIER_X, origin.y - 0.03);
  let reach3 = select(smoothstep(2.62, 2.9, s), step(2.8, s), still);
  if (reach3 > 0.0) {
    let rz = beamDistance(u, origin, vec2f(mix(origin.x, hit.x, 0.5), origin.y + 0.0017), hit);
    let shown3 = 1.0 - smoothstep(reach3 - 0.02, reach3, rz.y);
    light += ACCENT_INK * exp(-rz.x / (unit * 1.2)) * 0.6 * shown3 * (1.0 - smoothstep(3.2, 3.6, s));
  }
  let spark = select(exp(-max(s - 2.9, 0.0) * 4.0) * step(2.9, s), step(2.9, s) * 0.5, still);
  // The depth boundary is there once there is a second level to be the edge of: a faint dashed line,
  // brightest near where the refused beam is heading, flaring where it lands.
  let dashes = step(0.5, fract(u.y / 0.018));
  let near = exp(-abs(u.y - hit.y) / 0.22);
  let wall = exp(-abs(u.x - BARRIER_X) / (unit * 1.2));
  light += ACCENT_INK * wall * dashes * near * 0.35 * smoothstep(2.4, 2.8, s) * (1.0 - smoothstep(3.3, 3.7, s));
  light += ACCENT_INK * wall * exp(-abs(u.y - hit.y) / 0.09) * 1.4 * spark;
  // The hit itself: a flash, and a ring running out from it that the boundary does not let through.
  let fromHit = length(u - hit);
  let ringR = max(s - 2.9, 0.0) * 0.22;
  let shock = exp(-pow((fromHit - ringR) / (unit * 5.0), 2.0)) * step(u.x, BARRIER_X + unit * 2.0);
  light += INK * exp(-fromHit / (unit * 9.0)) * 2.2 * spark + ACCENT_INK * shock * 0.9 * spark * select(1.0, 0.0, still);

  // Each open session glows; the first one flares when the last report reaches it.
  for (var i = 0; i < 8; i++) {
    let open = smoothstep(NODE_OPENS[i], NODE_OPENS[i] + 0.25, s);
    if (open <= 0.0) { continue; }
    let d = max(sdRoundRect(u - NODE_AT[i], NODE_HALF[i] * mix(0.3, 1.0, open), 0.012), 0.0);
    let flare = exp(-max(s - NODE_OPENS[i], 0.0) * 5.0) * step(NODE_OPENS[i], s);
    light += ACCENT * exp(-d / (unit * 16.0)) * (0.22 + flare * 0.6) * open;
  }
  let arrived = step(NODE_DONE[0], s) * exp(-max(s - NODE_DONE[0], 0.0) * 3.0);
  let rootEdge = max(sdRoundRect(u - NODE_AT[0], NODE_HALF[0], 0.012), 0.0);
  light += (INK * exp(-rootEdge / (unit * 3.0)) * 1.2 + ACCENT * exp(-rootEdge / (unit * 40.0)) * 0.5) * arrived;
  return light;
}

// The sessions as solid panes: dark glass with lines of work streaming up them while they run, and
// a quieter rim once their report has gone.
fn treeSolid(p: vec2f, t: f32) -> vec4f {
  let u = toTree(p);
  let unit = 1.0 / max(treeBox().z, 1.0);
  let s = field.tree.y * ${TREE_STEPS}.0;
  var color = vec3f(0.0);
  var cover = 0.0;
  for (var i = 0; i < 8; i++) {
    let open = smoothstep(NODE_OPENS[i], NODE_OPENS[i] + 0.25, s);
    if (open <= 0.0) { continue; }
    let half = NODE_HALF[i] * mix(0.3, 1.0, open);
    let local = u - NODE_AT[i];
    let d = sdRoundRect(local, half, 0.012);
    let inside = smoothstep(unit, -unit, d);
    if (inside <= 0.0) { continue; }
    let done = smoothstep(NODE_DONE[i], NODE_DONE[i] + 0.3, s);
    var pane = mix(PAGE, INK, 0.07);
    // Work streaming in the session: rows of varying length rising up the pane, like a transcript.
    let cell = (local + half) / max(half * 2.0, vec2f(1e-4));
    let row = floor(cell.y * 7.0 + t * 1.3 * (1.0 - done));
    let lineAt = fract(cell.y * 7.0 + t * 1.3 * (1.0 - done));
    let span = 0.25 + hash21(vec2f(row, f32(i) * 3.7)) * 0.6;
    let text = step(0.12, cell.x) * step(cell.x, 0.12 + span * 0.8) * step(0.35, lineAt) * step(lineAt, 0.62);
    pane += ACCENT_INK * text * mix(0.28, 0.1, done);
    let rim = exp(-abs(d) / (unit * 1.3));
    pane = mix(pane, mix(ACCENT_INK, INK, 0.4), rim * mix(0.75, 0.4, done));
    color = mix(color, pane, inside);
    cover = max(cover, inside * open);
  }
  return vec4f(color, cover);
}
`
