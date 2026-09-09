// Joinery — three planes meeting around one seam.
//
// The mark is a room reduced to its useful structure: a dark left wall, a porcelain right wall,
// and the blue working plane between them. Each face is a convex polygon described by half-planes;
// this keeps the silhouette exact at every render size and lets the joins tighten at small sizes.

const ROUND: f32 = 0.014;

fn sdPoly4(p: vec2f, v0: vec2f, v1: vec2f, v2: vec2f, v3: vec2f) -> f32 {
  let v = array<vec2f, 4>(v0, v1, v2, v3);
  var d = dot(p - v0, p - v0);
  var s = 1.0;
  var j = 3;
  for (var i = 0; i < 4; i = i + 1) {
    let e = v[j] - v[i];
    let w = p - v[i];
    let b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    let c0 = p.y >= v[i].y;
    let c1 = p.y < v[j].y;
    let c2 = e.x * w.y > e.y * w.x;
    if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) { s = -s; }
    j = i;
  }
  return s * sqrt(d) - ROUND;
}

fn sdPoly6(p: vec2f, v0: vec2f, v1: vec2f, v2: vec2f, v3: vec2f, v4: vec2f, v5: vec2f) -> f32 {
  let v = array<vec2f, 6>(v0, v1, v2, v3, v4, v5);
  var d = dot(p - v0, p - v0);
  var s = 1.0;
  var j = 5;
  for (var i = 0; i < 6; i = i + 1) {
    let e = v[j] - v[i];
    let w = p - v[i];
    let b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    let c0 = p.y >= v[i].y;
    let c1 = p.y < v[j].y;
    let c2 = e.x * w.y > e.y * w.x;
    if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) { s = -s; }
    j = i;
  }
  return s * sqrt(d) - ROUND;
}

fn planeLeft(p: vec2f) -> f32 {
  return sdPoly6(p, vec2f(-0.270, -0.115), vec2f(0.025, -0.285), vec2f(0.025, -0.055), vec2f(-0.040, -0.092), vec2f(-0.040, 0.105), vec2f(-0.270, 0.238));
}

fn planeRight(p: vec2f) -> f32 {
  return sdPoly6(p, vec2f(0.045, -0.075), vec2f(0.290, 0.066), vec2f(0.290, 0.286), vec2f(0.075, 0.162), vec2f(0.075, 0.067), vec2f(0.045, 0.050));
}

fn planeFloor(p: vec2f) -> f32 {
  return sdPoly6(p, vec2f(-0.250, 0.255), vec2f(0.025, 0.096), vec2f(0.090, 0.133), vec2f(0.090, 0.292), vec2f(-0.040, 0.367), vec2f(-0.250, 0.295));
}

fn face(d: f32, aa: f32) -> f32 {
  return 1.0 - smoothstep(-aa, aa, d);
}

fn interior(q: vec2f, pp: vec2f, px: f32) -> vec3f {
  let aa = px * 0.78 / ICON;
  let vy = clamp(q.y + 0.5, 0.0, 1.0);
  var c = mix(fromSrgb(vec3f(0.050, 0.090, 0.170)), fromSrgb(vec3f(0.010, 0.021, 0.052)), vy);
  c *= 1.0 - 0.30 * smoothstep(0.18, 0.68, length(q));

  let dl = planeLeft(q);
  let dr = planeRight(q);
  let df = planeFloor(q);

  // Tight ambient occlusion makes the common seam readable without outlining the whole mark.
  c *= 1.0 - 0.42 * exp(-max(min(dl, min(dr, df)), 0.0) / 0.018);

  let left = face(dl, aa);
  let right = face(dr, aa);
  let floor = face(df, aa);

  let leftLight = clamp(0.72 - q.y * 0.52 - q.x * 0.12, 0.0, 1.0);
  let rightLight = clamp(0.88 - q.y * 0.20 + q.x * 0.08, 0.0, 1.0);
  let floorLight = clamp(0.94 - q.y * 0.38 - q.x * 0.10, 0.0, 1.0);

  let navy = mix(fromSrgb(vec3f(0.025, 0.080, 0.180)), fromSrgb(vec3f(0.105, 0.245, 0.485)), leftLight);
  let porcelain = mix(fromSrgb(vec3f(0.695, 0.675, 0.625)), fromSrgb(vec3f(0.985, 0.970, 0.925)), rightLight);
  let cobalt = mix(fromSrgb(vec3f(0.075, 0.260, 0.900)), fromSrgb(vec3f(0.245, 0.490, 1.000)), floorLight);

  c = mix(c, navy, left);
  c = mix(c, porcelain, right);
  c = mix(c, cobalt, floor);

  // Light catches only the leading edges. At tiny sizes the width clamps above one device pixel.
  let rimW = max(0.0048, 1.0 / (PX_PER_GRID * ICON));
  let leftRim = gauss(dl + rimW * 1.5, rimW) * smoothstep(-0.35, 0.18, -q.y - q.x * 0.35);
  let rightRim = gauss(dr + rimW * 1.5, rimW) * smoothstep(-0.32, 0.20, -q.y + q.x * 0.16);
  let floorRim = gauss(df + rimW * 1.5, rimW) * smoothstep(-0.34, 0.16, -q.y - q.x * 0.20);
  c += fromSrgb(vec3f(0.46, 0.68, 1.0)) * leftRim * left * 0.34;
  c += vec3f(1.0) * rightRim * right * 0.24;
  c += mix(fromSrgb(ACCENT), vec3f(1.0), 0.18) * floorRim * floor * 0.42;

  // The blue floor throws a restrained accent into the joint, the memorable centre of the mark.
  let joint = exp(-length((q - vec2f(0.035, 0.105)) * vec2f(1.0, 1.25)) / 0.080);
  c += fromSrgb(ACCENT_DEEP) * joint * 0.060;
  return c;
}
