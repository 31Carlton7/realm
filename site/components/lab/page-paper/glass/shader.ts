import { APOTHEM, geometryWgsl, RADIUS, SHAPE, type Shape } from "./geometry"

/**
 * The light, in two passes.
 *
 * 1. `causticWgsl` sends the lamp's light through the block. A grid laid over the mark is traced from
 *    the lamp: each corner refracts into the top and runs through the glass, reflecting inside it where
 *    the angle is past critical, until it leaves through the base onto the paper under it, or through
 *    the pavilion into the block's own shadow. The grid is then drawn where it landed, each fragment
 *    carrying how much the glass squeezed or spread its patch of light (the ratio of the source area
 *    to the landed area, from the derivatives). Drawn additively, that IS the caustic, folds and all,
 *    and the light is conserved by construction. Once per wavelength, each a hair apart in index, so
 *    the dispersion stays a whisper.
 *
 * 2. `compositeWgsl` draws the paper and the block from straight above. The paper takes the room's
 *    light, the lamp's where the block does not shade it (a soft shadow, marched against the solid),
 *    and the caustic. The block refracts the view down through itself the same way the light went, and
 *    reflects the room by Fresnel's ratio; the room is a bright ceiling over dark walls, which is what
 *    gives glass its drawn edges.
 *
 * Every light value is relative to the paper as the page draws it: 1 is the paper's own colour, so
 * where no shadow and no caustic falls the canvas is exactly the page around it.
 */

/** The caustic map covers this many mark units either side of the mark's centre. */
export const DOMAIN = 44

/** The walls are traced in this many cells around the silhouette and this many up it. */
export const WALL_AROUND = 480
export const WALL_ROWS = 20

const f = (n: number) => n.toFixed(6)

const shared = (shape: Shape) => /* wgsl */ `
${geometryWgsl(shape)}

const IOR = 1.505;
// Absorption per mark unit of glass: clear, with the faint cool cast thick glass has.
const SIGMA = vec3f(0.0135, 0.0085, 0.0047);
const BOX = vec2f(${f(RADIUS)}, ${f(APOTHEM)});

fn absorbed(len: f32) -> f32 {
  let a = exp(-SIGMA * len);
  return (a.r + a.g + a.b) / 3.0;
}

// A ray inside the glass, followed until it leaves: through the base onto the paper under it, or out
// of a wall or the top into the air. A wall or the top past the critical angle reflects it back in.
// Returns where it left (xyz), and in the second vec4 its direction out, the share of it that got out,
// and which way it went (0 through the base, 1 out into the air, plus 2 for each reflection inside).
struct Exit {
  at: vec3f,
  dir: vec3f,
  share: f32,
  route: f32,
  travelled: f32,
}

fn through(start: vec3f, dirIn: vec3f, n: f32) -> Exit {
  var o = start;
  var d = dirIn;
  var share = 1.0;
  var route = 0.0;
  var travelled = 0.0;
  for (var bounce = 0; bounce < 3; bounce++) {
    let e = leave(o, d);
    travelled += distance(o, e);
    let nrm = solidNormal(e);
    if (nrm.z < -0.99 && LIFT < 1e-3) {
      return Exit(e, d, share * 0.955, route, travelled);
    }
    let out = refract(d, -nrm, n);
    if (dot(out, out) < 1e-6) {
      d = reflect(d, nrm);
      o = e;
      route += 2.0;
      continue;
    }
    share *= 1.0 - fresnel(dot(out, nrm), n);
    return Exit(e, out, share, route + 1.0, travelled);
  }
  return Exit(o, d, 0.0, route + 1.0, travelled);
}
`

export const causticWgsl = (shape: Shape = SHAPE) => /* wgsl */ `
struct Caustic {
  // The lamp (mark units, z up) and the irradiance it gives open paper under the mark's centre.
  lamp: vec4f,
  // x: the map's half size in mark units, y: one texel's area, z: the top's grid cells per side,
  // w: the walls' cells around.
  domain: vec4f,
  // The index for the red, green and blue passes.
  ior: vec4f,
}
@group(0) @binding(0) var<uniform> caustic: Caustic;

${shared(shape)}

struct VOut {
  @builtin(position) pos: vec4f,
  // Where on the glass this light came in, in 3D: the fragment stage measures the patch's area there.
  @location(0) src: vec3f,
  @location(1) weight: f32,
  // Which way the light went, and its square. A triangle whose corners went different ways is torn by
  // an edge of the block, and drawing it would smear light across the gap: the two only agree (the
  // square of the mean equals the mean of the squares) when all three corners went the same way.
  @location(2) route: vec2f,
  @location(3) @interpolate(flat) channel: u32,
}

// Light arriving at a point s of the glass's surface with outward normal nrm: where it lands, how much
// of it per unit of surface, and which way it went.
fn traceLight(s: vec3f, nrm: vec3f, n: f32) -> vec4f {
  let toLamp = caustic.lamp.xyz - s;
  let dist2 = dot(toLamp, toLamp);
  let dir = toLamp * inverseSqrt(dist2);
  let cosi = dot(dir, nrm);
  if (cosi <= 0.0) { return vec4f(s.xy, 0.0, -1.0); }
  // The irradiance this patch receives, against open paper under the centre.
  let incoming = (cosi / dist2) / caustic.lamp.w;
  let x = through(s, refract(-dir, nrm, 1.0 / n), n);
  let w = (1.0 - fresnel(cosi, n)) * incoming * x.share * absorbed(x.travelled);
  if (fract(x.route * 0.5) < 0.25) {
    // Through the base: it lands where it left.
    return vec4f(x.at.xy, w, x.route);
  }
  if (x.dir.z > -1e-3) { return vec4f(x.at.xy, 0.0, x.route); }
  return vec4f(x.at.xy + x.dir.xy * (x.at.z / -x.dir.z), w, x.route);
}

fn emit(src: vec3f, landed: vec4f, channel: u32) -> VOut {
  var out: VOut;
  out.src = src;
  out.weight = landed.z;
  out.route = vec2f(landed.w, landed.w * landed.w);
  out.channel = channel;
  let clip = landed.xy / caustic.domain.x;
  out.pos = vec4f(clip.x, -clip.y, 0.0, 1.0);
  return out;
}


// The top: a grid over the mark's box, drawn indexed, so each corner is traced once and shared by the
// six triangles around it. vi is the corner: (n + 1) of them to a row.
@vertex fn vs_top(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let n = u32(caustic.domain.z);
  let g = vec2f(f32(vi % (n + 1u)), f32(vi / (n + 1u)));
  let p = (g / f32(n) * 2.0 - 1.0) * (BOX + vec2f(0.3));
  // A corner off the block is traced from the nearest point just inside it and carries no light, so a
  // cell the silhouette crosses fades its light out across itself instead of being dropped whole, which
  // would leave the edge of the light stepped at the grid's pitch.
  let sd = sdMark(p);
  var q = p;
  var fade = 1.0;
  if (sd > -0.05) {
    q = p - markNormal(p) * (sd + 0.05);
    fade = 0.0;
  }
  let s = vec3f(q, heightAt(q) + LIFT);
  var landed = traceLight(s, normalAt(q), caustic.ior[ii]);
  landed.z *= fade;
  return emit(vec3f(p, s.z), landed, ii);
}

// Where the silhouette crosses the ray from the centre at angle a.
fn rimPoint(a: f32) -> vec2f {
  let dir = vec2f(cos(a), sin(a));
  var r = ${f(RADIUS)};
  for (var i = 0; i < 6; i++) { r -= sdMark(dir * r); }
  return dir * r;
}

// The walls: around the silhouette, and from the paper up to where the top's rounded edge begins.
@vertex fn vs_wall(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let around = u32(caustic.domain.w);
  let g = vec2f(f32(vi % (around + 1u)), f32(vi / (around + 1u)));
  let a = g.x / f32(around) * 6.2831853;
  let edge = rimPoint(a);
  let outward = markNormal(edge);
  let z = g.y / ${f(WALL_ROWS)} * max(relief(edge) - RIM, 0.0);
  let s = vec3f(edge - outward * inset(z), z + LIFT);
  let slope = select(0.0, -TAPER, z < ZP);
  let nrm = normalize(vec3f(outward, slope));
  return emit(s, traceLight(s, nrm, caustic.ior[ii]), ii);
}

@fragment fn fs_main(v: VOut) -> @location(0) vec4f {
  let area = length(cross(dpdx(v.src), dpdy(v.src)));
  if (abs(v.route.y - v.route.x * v.route.x) > 0.01 || v.route.x < 0.0) { discard; }
  let e = min(area / caustic.domain.y, 14.0) * v.weight;
  var c = vec3f(0.0);
  c[v.channel] = e;
  return vec4f(c, 0.0);
}
`

export const compositeWgsl = (shape: Shape = SHAPE) => /* wgsl */ `
struct Scene {
  // The canvas in CSS px, CSS px per mark unit, device px per CSS px.
  view: vec4f,
  // The mark's centre in the canvas (CSS px), the caustic map's half size, and how far the canvas's
  // edge fades to plain paper (CSS px).
  centre: vec4f,
  // The lamp (mark units, z up) and its angular radius (radians).
  lamp: vec4f,
  // The room's share of the paper's light and the lamp's, the caustic's gain, and the dither's seed.
  light: vec4f,
  // The paper's colour, linear (w: debug view).
  paper: vec4f,
  // The registration mark printed on the paper: its centre (mark units), its circle's radius, and the
  // ink's strength.
  print: vec4f,
}
@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var causticMap: texture_2d<f32>;
@group(0) @binding(2) var causticSampler: sampler;

${shared(shape)}

fn causticAt(p: vec2f) -> vec3f {
  let uv = p / scene.centre.z * 0.5 + 0.5;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return vec3f(0.0); }
  return textureSampleLevel(causticMap, causticSampler, uv, 0.0).rgb;
}

// How much of the lamp a point on the paper sees past the block, its penumbra the lamp's own size.
fn lampSeen(p: vec2f) -> f32 {
  let s = vec3f(p, 0.0);
  let toLamp = scene.lamp.xyz - s;
  let far = length(toLamp);
  let dir = toLamp / far;
  // Nothing on the paper is shaded unless the way to the lamp passes over the block, and the block is
  // under TOP high: a point whose path clears its circle, or has risen past TOP by then, sees the lamp.
  let top = T0 + 2.0 * K + 0.3 + LIFT;
  let flat = normalize(dir.xy + vec2f(1e-6, 0.0));
  let along = dot(-p, flat);
  let miss = length(-p - flat * along);
  if (miss > ${f(RADIUS + 1.5)} || along < -${f(RADIUS + 1.5)}) { return 1.0; }
  let reach = min(far, top / max(dir.z, 0.05));
  let k = 1.0 / tan(scene.lamp.w);
  var seen = 1.0;
  var t = 0.1;
  for (var i = 0; i < 44; i++) {
    let d = solid(s + dir * t);
    seen = min(seen, k * d / t);
    if (seen < 0.002 || t > reach) { break; }
    t += clamp(d, 0.05, 0.8);
  }
  let x = clamp(seen, 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}

// The paper's light at p: the room, the lamp past the block, and what came through it.
// What is printed on the paper: a registration mark, a circle and its crosshair in hairline ink, with
// the crosshair running out to fade before the canvas's edge. Under the block it is seen refracted,
// which is how the eye knows the block is glass.
fn printed(p: vec2f) -> f32 {
  let px = 1.0 / scene.view.z;
  let d = p - scene.print.xy;
  let reach = 1.0 - smoothstep(scene.print.z * 1.25, scene.print.z * 1.75, max(abs(d.x), abs(d.y)));
  let cross = max(1.0 - smoothstep(0.0, px, abs(d.x) - px * 0.35), 1.0 - smoothstep(0.0, px, abs(d.y) - px * 0.35)) * reach;
  let ring = 1.0 - smoothstep(0.0, px, abs(length(d) - scene.print.z) - px * 0.35);
  return 1.0 - scene.print.w * max(cross, ring);
}

fn paperLight(p: vec2f) -> vec3f {
  let sd = sdMark(p) + ZP * TAPER;
  // Where the block stands on the paper the room's light is cut off a little; glass passes most of it.
  let near = exp(-LIFT / 2.0);
  let contact = 1.0 - (0.28 * exp(-max(sd, 0.0) / 0.7) + 0.1 * exp(-max(sd, 0.0) / 3.5)) * near - 0.12 * (1.0 - near) * exp(-max(sdMark(p), 0.0) / 6.0);
  let ambient = scene.light.x * contact;
  let direct = scene.light.y * lampSeen(p);
  return (vec3f(ambient + direct) + scene.light.z * scene.light.y * causticAt(p)) * printed(p);
}

// The paper under the block, seen through it: the room's light that came in through the top, and
// whatever of the lamp's the block bent onto it.
fn underLight(p: vec2f) -> vec3f {
  return (vec3f(scene.light.x * 0.92) + scene.light.z * scene.light.y * causticAt(p)) * printed(p);
}

// The room the block reflects and looks out at, lit the way glass is photographed: a large soft
// source on the lamp's side (which is what gives the lit edges their line), dark flags low on the
// other sides (which give the far edges theirs), a bright ceiling, the paper below, and the lamp.
fn room(r: vec3f, at: vec3f) -> vec3f {
  var c = mix(0.16, 0.98, smoothstep(0.08, 0.85, r.z));
  let toLamp = normalize(scene.lamp.xyz - at);
  let side = normalize(vec3f(toLamp.xy, 0.0) + vec3f(1e-5, 0.0, 0.0));
  let facing = dot(normalize(vec3f(r.xy, 0.0) + vec3f(1e-5, 0.0, 0.0)), side);
  // The softbox: the half of the room toward the lamp, from just above the paper to well up the wall.
  c += 1.35 * smoothstep(0.1, 0.75, facing) * smoothstep(-0.12, 0.08, r.z) * (1.0 - smoothstep(0.55, 0.9, r.z));
  let a = dot(r, toLamp);
  // The lamp's bulb, a point next to its penumbra: a glint where a face catches it, with a little bloom.
  c += 40.0 * smoothstep(cos(scene.lamp.w * 0.32), cos(scene.lamp.w * 0.12), a) + 1.2 * pow(max(a, 0.0), 2400.0);
  if (r.z < -0.12) { c = 0.86; }
  return vec3f(c);
}

fn glassColour(p: vec2f) -> vec3f {
  let h = heightAt(p);
  let nrm = normalAt(p);
  let view = vec3f(0.0, 0.0, -1.0);
  let cosv = max(nrm.z, 0.0);
  let f = fresnel(cosv, IOR);
  let surface = vec3f(p, h + LIFT);
  let reflected = room(reflect(view, nrm), surface);

  let x = through(surface, refract(view, nrm, 1.0 / IOR), IOR);
  let tint = exp(-SIGMA * x.travelled);
  var seen: vec3f;
  if (fract(x.route * 0.5) < 0.25) {
    seen = underLight(x.at.xy) * x.share;
  } else if (x.share <= 0.0) {
    // Still inside after three reflections: the block's own grey interior.
    seen = vec3f(0.32);
  } else if (x.dir.z < -1e-3) {
    let land = x.at.xy + x.dir.xy * (x.at.z / -x.dir.z);
    seen = paperLight(land) * x.share;
  } else {
    seen = room(x.dir, x.at) * x.share;
  }
  var c = mix(seen * tint, reflected, f) * scene.paper.rgb;

  // The doorway's back is etched: it scatters the light that reaches it rather than passing an image.
  let etched = backMask(p);
  if (etched > 0.0) {
    let toLamp = normalize(scene.lamp.xyz - surface);
    let lit = scene.light.x * 0.92 + scene.light.y * (0.5 + 0.55 * max(dot(nrm, toLamp), 0.0));
    let frost = vec3f(lit * 1.05) * scene.paper.rgb * vec3f(0.965, 0.982, 1.0);
    c = mix(c, frost, etched * 0.88);
  }
  return c;
}

// Light above the paper's own level rolls off into the little headroom white leaves, per channel, so
// the paper itself maps to exactly the page's colour and a caustic never clips.
fn shoulder(x: vec3f, knee: vec3f) -> vec3f {
  let room = max(vec3f(1.0) - knee, vec3f(1e-3));
  let over = max(x - knee, vec3f(0.0));
  return select(x, knee + room * (vec3f(1.0) - exp(-over / room)), x > knee);
}

fn encode(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = uv * scene.view.xy;
  let p = (px - scene.centre.xy) / scene.view.z;
  if (scene.paper.w > 1.5) {
    // Debug: the caustic map itself, a quarter of the lamp's open-paper light per step of grey.
    let k = causticAt(p) * 0.25;
    let edge = select(0.0, 0.35, abs(sdMark(p)) < 0.08);
    return vec4f(k + vec3f(edge, 0.0, 0.0), 1.0);
  }
  // One device pixel, in mark units.
  let dot1 = 1.0 / (scene.view.z * scene.view.w);
  let sd = sdMark(p);
  var light: vec3f;
  if (sd > dot1) {
    light = paperLight(p) * scene.paper.rgb;
  } else {
    // The rim band is where the view's way through the glass changes abruptly (out of the base, out of
    // a wall), so it is sampled four times on a rotated grid; the faces inside are smooth enough once.
    var glass: vec3f;
    if (-sd > RIM + 1.2) {
      glass = glassColour(p);
    } else {
      glass = 0.25 * (glassColour(p + vec2f(-0.125, -0.375) * dot1) + glassColour(p + vec2f(0.375, -0.125) * dot1)
        + glassColour(p + vec2f(0.125, 0.375) * dot1) + glassColour(p + vec2f(-0.375, 0.125) * dot1));
    }
    // The silhouette itself, blended by how much of the pixel the glass covers.
    let cover = clamp(0.5 - sd / dot1, 0.0, 1.0);
    if (cover < 1.0) {
      light = mix(paperLight(p) * scene.paper.rgb, glass, cover);
    } else {
      light = glass;
    }
  }
  // Dispersion is held to a whisper of the accent's blue: warm fringes are folded back to neutral.
  let lum = vec3f(0.2126, 0.7152, 0.0722);
  light = mix(vec3f(dot(light, lum)) * scene.paper.rgb / dot(scene.paper.rgb, lum), light, 0.6);
  light.r = min(light.r, max(light.g, light.b * 0.99));

  // At the canvas's own edge everything is plain paper, so it can never show as a rectangle.
  let edge = min(min(px.x, scene.view.x - px.x), min(px.y, scene.view.y - px.y));
  light = mix(scene.paper.rgb, light, smoothstep(0.0, scene.centre.w, edge));

  var c = encode(shoulder(light, scene.paper.rgb));
  let d = px * scene.view.w;
  let n = hash21(d + scene.light.w) + hash21(d.yx + scene.light.w * 1.37) - 1.0;
  c += vec3f(n / 255.0);
  return vec4f(c, 1.0);
}
`

/**
 * The lamp is not a point: seen from the paper under the block it has an angular size, so every
 * caustic is softened by that size times the way its light travelled through the glass — about two
 * texels of the map here. One direction per pass, nine taps on linear filtering.
 */
export const blurWgsl = /* wgsl */ `
struct Blur {
  // The direction to blur in, in texels of the map (x, y), and the map's texel size (z, w).
  step: vec4f,
}
@group(0) @binding(0) var<uniform> blur: Blur;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let d = blur.step.xy * blur.step.zw;
  // A Gaussian of sigma 2 texels in five bilinear taps (offsets and weights merged in pairs).
  var c = textureSampleLevel(source, sourceSampler, uv, 0.0) * 0.2270;
  c += (textureSampleLevel(source, sourceSampler, uv + d * 1.3846, 0.0) + textureSampleLevel(source, sourceSampler, uv - d * 1.3846, 0.0)) * 0.3162;
  c += (textureSampleLevel(source, sourceSampler, uv + d * 3.2308, 0.0) + textureSampleLevel(source, sourceSampler, uv - d * 3.2308, 0.0)) * 0.0703;
  return c;
}
`
