import { FACES, MARK_CENTER, MARK_RADIUS } from "../mark"

/**
 * The six faces of Realm's mark, assembling — WGSL for the section that answers "what is a realm".
 *
 * The mark is drawn on an equilateral lattice: the cube's edges are 20 units long, its horizontal
 * ones sit on lines 17.32 apart, its slanted ones run at 60° and 120°, and its near corner, the
 * centre, is a node. This dimension IS that lattice, drawn at half the cube's edge so the cells are
 * small enough to read as a grid, and the faces are not placed on it so much as returned to it: each
 * flies in from elsewhere and settles where it was always drawn, while the ones still to come show as
 * empty slots. The walls come first, then the doorway's floor, its jamb, and last its lit back.
 */

/**
 * The pinned track's steps: one per face, then one where the whole mark is lit, then one where the
 * view pulls back and it becomes one realm among many.
 */
export const TRACK_STEPS = 8
const LIT_STEP = 6
const MANY_STEP = 7

/**
 * Which face arrives at which step — `ORDER[step]` is an index into FACES, which already lists them
 * walls first and the doorway's lit back last. The page's copy is written in the same order.
 */
export const ORDER = [0, 1, 2, 3, 4, 5] as const

/** How much light each face catches, so the assembled mark reads as a lit solid the way the app
 *  icon does: the top brightest, the dark wall darkest, the doorway's back lit. Indexed like FACES,
 *  and read from the mark's own tones (mark.mjs's MARK_TONES). */
const SHADE_OF = { top: 0.93, left: 0.68, right: 0.4, floor: 0.88, jamb: 0.62, lit: 1 } as const
const SHADE = FACES.map((face) => SHADE_OF[face.name])
/** The lit back, the one face that gives off light of its own once it lands. */
const LIT = FACES.findIndex((face) => face.name === "lit")

/** The lattice's cell edge and its line spacing, in mark units: half the cube's edge. */
const EDGE = MARK_RADIUS / 2
const SPACING = EDGE * Math.sin(Math.PI / 3)

const f = (n: number) => n.toFixed(4)
const v2 = ([x, y]: readonly number[]) => `vec2f(${f(x)}, ${f(y)})`

const centroids = FACES.map(({ polygon }) => {
  const [sx, sy] = polygon.reduce(([ax, ay], [x, y]) => [ax + x, ay + y], [0, 0])
  return [sx / polygon.length, sy / polygon.length] as const
})
const radii = FACES.map(({ polygon }, i) =>
  Math.max(...polygon.map(([x, y]) => Math.hypot(x - centroids[i][0], y - centroids[i][1]))),
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

const polygonSdf = (name: string, vertices: readonly (readonly [number, number])[]) => /* wgsl */ `
fn ${name}(p: vec2f) -> f32 {
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

// A face is its polygon, less the doorway where one is cut out of it.
const faceSdf = (index: number) => {
  const { polygon, cut } = FACES[index]
  const body = polygonSdf(`facePolygon${index}`, polygon)
  if (!cut) return `${body}\nfn face${index}(p: vec2f) -> f32 { return facePolygon${index}(p); }`
  return `${body}\n${polygonSdf(`faceCut${index}`, cut)}\nfn face${index}(p: vec2f) -> f32 { return max(facePolygon${index}(p), -faceCut${index}(p)); }`
}

/**
 * Expects, from the including shader: `field` with `faces` (presence, progress, CSS px per mark
 * unit, unused) and `facesAt` (the mark area's rect), plus PAGE, INK, ACCENT, ACCENT_INK and hash21.
 */
export const facesWgsl = /* wgsl */ `
${FACES.map((_, index) => faceSdf(index)).join("\n")}

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

// The last step: 0 while the one mark fills its area, 1 once the view has pulled back to many.
fn manyPhase() -> f32 {
  return smoothstep(${MANY_STEP}.0, ${MANY_STEP}.85, field.faces.y * ${TRACK_STEPS}.0);
}

// CSS pixels per mark unit, shrinking as the view pulls back.
fn markScale() -> f32 {
  // Far enough out for three rings of realms — a few dozen — inside the mark's square. The cluster
  // is bounded by that square, so pulling back further adds realms rather than wallpaper.
  let many = manyPhase();
  // Under reduced motion the pull-back is a cut, not a camera move: one mark until halfway, then the
  // hive, with its rings fading in. A continuous zoom tied to scroll is the thing the setting is for.
  let pulled = select(many, step(0.5, many), field.view.w > 0.5);
  return max(field.faces.z * mix(1.0, 0.25, pulled), 1e-3);
}

// A pixel, in the mark's own units: the mark sits centred in its area, 48 units tall.
fn toMark(p: vec2f) -> vec2f {
  let c = field.facesAt.xy + field.facesAt.zw * 0.5;
  return (p - c) / markScale() + MARK_CENTER;
}

// Where face i is along its arrival: 0 not yet begun, 1 settled. Eased so it arrives fast and lands
// soft. Every input is a uniform, so branching on it keeps control flow uniform.
fn arrival(i: i32) -> f32 {
  let raw = saturate(field.faces.y * ${TRACK_STEPS}.0 - FACE_STEP[i]);
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
  let unit = 1.0 / markScale();
  let steps = field.faces.y * ${TRACK_STEPS}.0;
  let complete = smoothstep(${LIT_STEP}.0, ${LIT_STEP}.6, steps);

  let many = manyPhase();
  var light = ACCENT * lattice(m, unit, t) * 0.24 * (1.0 - many);
  if (many > 0.001) {
    let cell = realmCell(m);
    let life = realmActivity(cell, t);
    let glowAt = length(m - cell - MARK_CENTER);
    light += ACCENT * exp(-glowAt / 22.0) * 0.3 * life.x * realmPresence(cell, many);
    // The lit mark's halo hands over rather than vanishing when the branch changes, and home keeps a
    // glow of its own, so the realm you just built is the one you can still find.
    let dm = length(m - MARK_CENTER);
    light += (ACCENT * exp(-dm / 20.0) * 0.34 + ACCENT_INK * exp(-dm / 55.0) * 0.12) * (1.0 - many);
    light += ACCENT_INK * exp(-dm / 16.0) * 0.42 * many;
    return light;
  }

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

  // The doorway's back, once it is in, is lit from inside the cube: light spills close round the
  // opening before the rest of the mark catches it.
  let doorway = max(faceDistance(${LIT}, m), 0.0);
  light += ACCENT_INK * exp(-doorway / 2.4) * 0.3 * arrival(${LIT});

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

// The mark's outline is a flat-topped hexagon 40 wide and 34.64 tall, and hexagons tile: columns
// three quarters of a width apart, every other one dropped half a height. With a little air between.
const CELL = vec2f(${f(MARK_RADIUS * 1.5 * 1.12)}, ${f(MARK_RADIUS * Math.sqrt(3) * 1.12)});

// The centre of the realm a mark-space point falls in, as an offset from the home realm's.
fn realmCell(m: vec2f) -> vec2f {
  let d = m - MARK_CENTER;
  let column = round(d.x / CELL.x);
  var best = vec2f(0.0);
  var bestDistance = 1e9;
  for (var k = -1; k <= 1; k++) {
    let c = column + f32(k);
    let drop = select(0.0, CELL.y * 0.5, abs(c % 2.0) > 0.5);
    let centre = vec2f(c * CELL.x, round((d.y - drop) / CELL.y) * CELL.y + drop);
    let distance = length(d - centre);
    if (distance < bestDistance) { bestDistance = distance; best = centre; }
  }
  return best;
}

// One realm as the finished glass mark, lit as brightly as its agents are busy. The home realm, at
// full activity with no seed, is exactly the lit mark the seventh step ends on, so pulling back
// shows the same object rather than swapping it for a copy.
fn glassMark(local: vec2f, unit: f32, t: f32, activity: f32, seed: f32) -> vec4f {
  var color = vec3f(0.0);
  var cover = 0.0;
  for (var i = 0; i < 6; i++) {
    if (length(local - FACE_CENTROID[i]) > FACE_RADIUS[i] + 3.0) { continue; }
    let d = faceDistance(i, local);
    let inside = smoothstep(unit, -unit, d);
    if (inside <= 0.0) { continue; }
    let shade = FACE_SHADE[i];
    let bend = normalize(FACE_CENTROID[i] - MARK_CENTER + vec2f(1e-4)) * (0.05 + (1.0 - shade) * 0.07);
    let through = markStreams((local - MARK_CENTER) / 40.0 + bend, t + seed * 17.0);
    let rim = exp(-abs(d) / (unit * 1.4));
    var glass = mix(PAGE, INK, 0.07 + shade * 0.1);
    glass += through * (0.6 + shade * 0.45) * activity;
    glass = mix(glass, INK, rim * 0.55) + ACCENT_INK * rim * 0.2;
    // The doorway's back is lit from inside, as brightly as the realm's agents are busy.
    if (i == ${LIT}) { glass = mix(glass, INK, 0.62 * activity) + ACCENT_INK * 0.12 * activity; }
    color = mix(color, glass, inside);
    cover = max(cover, inside);
  }
  return vec4f(color, cover);
}

// Every realm but home has its own seed: how busy it is, and the rate it breathes at, so the field
// reads as many things working rather than one thing repeated.
fn realmActivity(cell: vec2f, t: f32) -> vec2f {
  let home = length(cell) < 1.0;
  let seed = hash21(cell * 0.137 + vec2f(3.1, 7.7));
  // Capped below home's full brightness, so the realm you just built stays the one you can find.
  let busy = 0.2 + seed * 0.62;
  let breath = 0.62 + 0.38 * sin(t * (0.45 + seed * 0.8) + seed * 6.2831);
  return vec2f(select(busy * breath, 1.0, home), select(seed, 0.0, home));
}

// How present a realm is while the view pulls back: the nearer rings first, and only as many rings as
// fit inside the mark's own square — a hexagonal cluster, not wallpaper. The text sits beside that
// square (under it, on a phone), so bounding the cluster by it is what keeps glass out from behind the
// words at every zoom, rather than a fade that a big enough tile can always reach across. Decided per
// realm, so each one comes and goes whole instead of being sliced by a gradient.
fn realmPresence(cell: vec2f, many: f32) -> f32 {
  if (length(cell) < 1.0) { return 1.0; }
  let ring = length(cell) / CELL.y;
  let arrive = smoothstep(ring * 0.16, ring * 0.16 + 0.4, many);
  let fits = min(field.facesAt.z, field.facesAt.w) * 0.5 / (CELL.y * markScale()) - 0.55;
  return arrive * (1.0 - smoothstep(fits - 0.6, fits, ring));
}

// The faces themselves, as solid glass: colour and coverage, composited over the light.
fn facesSolid(p: vec2f, t: f32) -> vec4f {
  let m = toMark(p);
  let unit = 1.0 / markScale();
  let many = manyPhase();
  if (many > 0.001) {
    let cell = realmCell(m);
    let life = realmActivity(cell, t);
    let g = glassMark(m - cell, unit, t, life.x, life.y);
    return vec4f(g.rgb, g.a * realmPresence(cell, many));
  }
  let steps = field.faces.y * ${TRACK_STEPS}.0;
  let complete = smoothstep(${LIT_STEP}.0, ${LIT_STEP}.6, steps);
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
    // The doorway's back stays lit through the glass: the light the mark is named for.
    if (i == ${LIT}) { glass = mix(glass, INK, 0.62) + ACCENT_INK * 0.12; }
    face = mix(face, glass, complete);
    let alpha = inside * smoothstep(0.0, 0.3, e);
    color = mix(color, face, alpha);
    cover = max(cover, alpha);
  }
  return vec4f(color, cover);
}
`
