import { FACES, MARK_CENTER } from "../mark"

/**
 * The six faces of Realm's mark, assembling — WGSL for the section that answers "what is a realm".
 *
 * The mark is drawn on an equilateral lattice: its horizontal edges sit 8.899 units apart, its slanted
 * ones run at 60° and 120°, and its centre is a lattice node. So this dimension IS that lattice, and
 * the faces are not placed on it so much as returned to it — each flies in from elsewhere and settles
 * into the cells it was always drawn on, while the ones still to come show as empty slots.
 */

/** One step per face, then a seventh where the whole mark is lit. */
export const FACE_STEPS = 7

/**
 * Which face arrives at which step, top of the mark to bottom — `ORDER[step]` is an index into
 * FACES. The page's copy is written in the same order, so step 0's sentence belongs to FACES[1].
 */
export const ORDER = [1, 4, 5, 2, 3, 0] as const

/** How much light each face catches, so the assembled mark reads as a lit solid the way the app
 *  icon does: the top band brightest, the undersides darkest. Indexed like FACES. */
const SHADE = [0.4, 0.95, 0.52, 0.6, 0.78, 0.66]

/** The lattice's cell edge and its line spacing, in mark units. */
const EDGE = 10.2755
const SPACING = EDGE * Math.sin(Math.PI / 3)

const f = (n: number) => n.toFixed(4)
const v2 = ([x, y]: readonly number[]) => `vec2f(${f(x)}, ${f(y)})`

const centroids = FACES.map((poly) => {
  const [sx, sy] = poly.reduce(([ax, ay], [x, y]) => [ax + x, ay + y], [0, 0])
  return [sx / poly.length, sy / poly.length] as const
})
const radii = FACES.map((poly, i) =>
  Math.max(...poly.map(([x, y]) => Math.hypot(x - centroids[i][0], y - centroids[i][1]))),
)
// Each face comes from the direction it sits in, bent a little sideways so they arrive on arcs
// rather than straight lines, and turning as they come.
const flights = centroids.map(([x, y], i) => {
  const dx = x - MARK_CENTER[0]
  const dy = y - MARK_CENTER[1]
  const length = Math.hypot(dx, dy) || 1
  const bend = i % 2 === 0 ? 0.55 : -0.55
  return [dx / length - (dy / length) * bend, dy / length + (dx / length) * bend] as const
})
const spins = FACES.map((_, i) => (i % 2 === 0 ? 1 : -1) * (0.9 + i * 0.17))

const faceSdf = (index: number, vertices: readonly (readonly [number, number])[]) => /* wgsl */ `
fn face${index}(p: vec2f) -> f32 {
  var v = array<vec2f, ${vertices.length}>(${vertices.map(v2).join(", ")});
  var distanceSquared = dot(p - v[0], p - v[0]);
  var sign = 1.0;
  for (var i = 0u; i < ${vertices.length}u; i++) {
    let j = (i + ${vertices.length}u - 1u) % ${vertices.length}u;
    let edge = v[i] - v[j];
    let toPoint = p - v[j];
    let projection = saturate(dot(toPoint, edge) / dot(edge, edge));
    let delta = toPoint - edge * projection;
    distanceSquared = min(distanceSquared, dot(delta, delta));
    let crosses =
      (p.y >= v[j].y && p.y < v[i].y && edge.x * toPoint.y > edge.y * toPoint.x) ||
      (p.y < v[j].y && p.y >= v[i].y && edge.x * toPoint.y <= edge.y * toPoint.x);
    if (crosses) { sign = -sign; }
  }
  return sign * sqrt(distanceSquared);
}`

/**
 * Expects, from the including shader: `field` with `faces` (presence, progress, CSS px per mark
 * unit, unused) and `facesAt` (the mark area's rect), plus PAGE, INK, ACCENT, ACCENT_INK and hash21.
 */
export const facesWgsl = /* wgsl */ `
${FACES.map((vertices, index) => faceSdf(index, vertices)).join("\n")}

fn faceDistance(i: i32, p: vec2f) -> f32 {
  switch i {
    case 0: { return face0(p); }
    case 1: { return face1(p); }
    case 2: { return face2(p); }
    case 3: { return face3(p); }
    case 4: { return face4(p); }
    default: { return face5(p); }
  }
}

var<private> FACE_CENTROID: array<vec2f, 6> = array<vec2f, 6>(${centroids.map(v2).join(", ")});
var<private> FACE_RADIUS: array<f32, 6> = array<f32, 6>(${radii.map(f).join(", ")});
var<private> FACE_STEP: array<f32, 6> = array<f32, 6>(${FACES.map((_, i) => f((ORDER as readonly number[]).indexOf(i))).join(", ")});
var<private> FACE_SHADE: array<f32, 6> = array<f32, 6>(${SHADE.map(f).join(", ")});
var<private> FACE_FLIGHT: array<vec2f, 6> = array<vec2f, 6>(${flights.map(v2).join(", ")});
var<private> FACE_SPIN: array<f32, 6> = array<f32, 6>(${spins.map(f).join(", ")});

const MARK_CENTER = ${v2(MARK_CENTER)};
const LATTICE_SPACING = ${f(SPACING)};

// A pixel, in the mark's own units: the mark sits centred in its area, 48 units tall.
fn toMark(p: vec2f) -> vec2f {
  let c = field.facesAt.xy + field.facesAt.zw * 0.5;
  return (p - c) / max(field.faces.z, 1e-3) + MARK_CENTER;
}

// Where face i is along its arrival: 0 not yet begun, 1 settled. Eased so it arrives fast and lands
// soft. Every input is a uniform, so branching on it keeps control flow uniform.
fn arrival(i: i32) -> f32 {
  let raw = saturate(field.faces.y * ${FACE_STEPS}.0 - FACE_STEP[i]);
  return 1.0 - pow(1.0 - raw, 3.0);
}

// Face i's distance at arrival e: undo its flight — offset, turn and shrink about its centroid — and
// ask the resting polygon. Held in place under reduced motion, where it only fades in.
fn flyingDistance(i: i32, m: vec2f, e: f32) -> f32 {
  let still = field.view.w;
  let away = (1.0 - e) * (1.0 - still);
  let centroid = FACE_CENTROID[i];
  let offset = FACE_FLIGHT[i] * away * away * 34.0;
  let angle = FACE_SPIN[i] * away;
  let scale = mix(1.0, 0.42, away);
  let local = (m - centroid - offset) / scale;
  let cs = vec2f(cos(angle), sin(angle));
  let rest = centroid + vec2f(local.x * cs.x + local.y * cs.y, -local.x * cs.y + local.y * cs.x);
  // Cheap reject: most pixels are nowhere near most faces.
  if (length(rest - centroid) > FACE_RADIUS[i] + 4.0) { return 99.0; }
  return faceDistance(i, rest) * scale;
}

// The lattice the mark is drawn on. Three families of lines, all through the node at the mark's
// centre, fading out from it. \`unit\` is one CSS pixel in mark units.
fn lattice(m: vec2f, unit: f32, t: f32) -> f32 {
  let d = m - MARK_CENTER;
  var lines = 0.0;
  for (var k = 0; k < 3; k++) {
    let a = f32(k) * 1.0471976 + 1.5707963;
    let n = vec2f(cos(a), sin(a));
    let s = dot(d, n) / LATTICE_SPACING;
    let off = abs(fract(s + 0.5) - 0.5) * LATTICE_SPACING;
    lines = max(lines, 1.0 - smoothstep(0.0, unit * 1.2, off));
  }
  let reach = exp(-length(d) / 46.0);
  // A slow wave of brightness moving through the lattice, so the space is alive before anything
  // arrives in it.
  let wave = 0.65 + 0.35 * sin(length(d) * 0.18 - t * 0.9);
  return lines * reach * wave;
}

// Additive light: the lattice, the empty slots, the arriving faces' trails and the lit mark's glow.
fn facesLight(p: vec2f, t: f32) -> vec3f {
  let m = toMark(p);
  let unit = 1.0 / max(field.faces.z, 1e-3);
  let steps = field.faces.y * ${FACE_STEPS}.0;
  let complete = smoothstep(${FACE_STEPS - 1}.0, ${FACE_STEPS - 1}.6, steps);

  var light = ACCENT * lattice(m, unit, t) * 0.24;

  for (var i = 0; i < 6; i++) {
    let e = arrival(i);
    // Not arrived: its slot, a faint outline where it will land, brightest for the one due next.
    if (e < 0.999) {
      let slot = faceDistance(i, m);
      let due = 1.0 - saturate(abs(steps - FACE_STEP[i]) * 0.9);
      light += ACCENT_INK * exp(-abs(slot) / (unit * 1.6)) * (0.18 + due * 0.4) * (1.0 - e);
    }
    // In flight: a trail of where it has been, fading behind it.
    if (e > 0.001 && e < 0.999) {
      for (var g = 1; g <= 3; g++) {
        let ghost = flyingDistance(i, m, max(e - f32(g) * 0.07, 0.0));
        light += ACCENT * exp(-abs(ghost) / (unit * 2.0)) * 0.22 / f32(g);
      }
    }
    // Just landed: a flash along its edges that fades over the step after.
    let landed = steps - FACE_STEP[i] - 1.0;
    if (landed > 0.0 && landed < 1.5) {
      let here = faceDistance(i, m);
      light += ACCENT_INK * exp(-abs(here) / (unit * 2.4)) * exp(-landed * 3.0) * 1.3;
    }
  }

  // All six in: the mark is lit from within and throws light around itself.
  let dm = length(m - MARK_CENTER);
  light += ACCENT * exp(-dm / 20.0) * 0.34 * complete;
  light += ACCENT_INK * exp(-dm / 55.0) * 0.12 * complete;
  return light;
}

// The liquid-glass hero's light: three streams — accent, silver, sky — converging along a diagonal
// into one white one. Same shape as lib/realm-liquid-glass.ts, swinging more gently, because here it
// runs through a finished mark rather than across a whole screen.
fn markStreams(point: vec2f, seconds: f32) -> vec3f {
  let direction = normalize(vec2f(0.7071 + sin(seconds * 0.35) * 1.2, -0.7071));
  let normal = vec2f(0.7071, 0.7071);
  let along = dot(point, direction);
  let across = dot(point, normal);
  let convergence = smoothstep(-0.55, 0.38, along);
  let pulse = 0.76 + 0.24 * sin(seconds * 2.2 - along * 7.5);
  let shimmer = 0.82 + 0.18 * sin(seconds * 4.1 + along * 14.0 + across * 5.0);
  let split = 0.15;
  let width = mix(0.045, 0.075, convergence);
  let accent = exp(-pow(abs(across + split * (1.0 - convergence) - 0.01 * sin(along * 8.0 - seconds * 1.7)) / width, 1.65));
  let silver = exp(-pow(abs(across - 0.01 * sin(along * 9.0 + seconds * 1.3)) / width, 1.65));
  let sky = exp(-pow(abs(across - split * (1.0 - convergence) - 0.01 * sin(along * 7.0 + seconds * 1.9)) / width, 1.65));
  var color = (ACCENT * accent + INK * 0.28 * silver + ACCENT_INK * sky) * pulse * shimmer;
  let merged = exp(-pow(abs(across) / (0.06 + 0.035 * convergence), 1.45)) * convergence;
  color += INK * merged * (1.15 + 0.35 * sin(seconds * 2.7 - along * 9.0));
  return color + ACCENT * 0.5 * exp(-abs(across) * 7.5) * (0.16 + 0.22 * convergence);
}

// The faces themselves, as solid glass: colour and coverage, composited over the light.
fn facesSolid(p: vec2f, t: f32) -> vec4f {
  let m = toMark(p);
  let unit = 1.0 / max(field.faces.z, 1e-3);
  let steps = field.faces.y * ${FACE_STEPS}.0;
  let complete = smoothstep(${FACE_STEPS - 1}.0, ${FACE_STEPS - 1}.6, steps);
  var color = vec3f(0.0);
  var cover = 0.0;
  for (var i = 0; i < 6; i++) {
    let e = arrival(i);
    if (e <= 0.001) { continue; }
    let d = flyingDistance(i, m, e);
    let inside = smoothstep(unit, -unit, d);
    if (inside <= 0.0) { continue; }
    let shade = FACE_SHADE[i];
    // A little depth across the face, lit from the top left like the icon.
    let across = dot(m - FACE_CENTROID[i], vec2f(-0.5, -0.86)) / FACE_RADIUS[i];
    var face = mix(PAGE, INK, shade * (0.86 + across * 0.12));
    face = mix(face, ACCENT_INK, 0.1 * (1.0 - shade));
    // In flight it is still charged from wherever it came from, and cools to silver as it lands.
    face = mix(face, ACCENT_INK, (1.0 - e) * 0.4);
    let landed = steps - FACE_STEP[i] - 1.0;
    face += INK * 0.2 * exp(-max(landed, 0.0) * 3.0) * step(0.0, landed) * step(landed, 1.5);
    // The rim of each face, so adjacent facets read as separate planes.
    let rim = exp(-abs(d) / (unit * 1.4));
    face = mix(face, INK, rim * 0.5);

    // All six in: the mark turns to glass and the light runs THROUGH it. Each facet bends the streams
    // along its own outward direction, a little more the darker it sits, so the facets break the light
    // differently — which is what makes glass read as cut rather than poured.
    let point = (m - MARK_CENTER) / 40.0;
    let bend = normalize(FACE_CENTROID[i] - MARK_CENTER + vec2f(1e-4)) * (0.05 + (1.0 - shade) * 0.07);
    let through = markStreams(point + bend, t);
    var glass = mix(PAGE, INK, 0.07 + shade * 0.1);
    glass += through * (0.6 + shade * 0.45);
    glass = mix(glass, INK, rim * 0.55) + ACCENT_INK * rim * 0.2;
    face = mix(face, glass, complete);
    let alpha = inside * smoothstep(0.0, 0.3, e);
    color = mix(color, face, alpha);
    cover = max(cover, alpha);
  }
  return vec4f(color, cover);
}
`
