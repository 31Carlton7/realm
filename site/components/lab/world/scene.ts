import { effect } from "vgpu"

import { anchor, labWgsl, type Rect, type StageFactory } from "@/components/lab/stage"

/**
 * World: the workspace above the lit edge of a planet.
 *
 * A camera in low orbit looks along the night side's limb a moment before sunrise. The planet is a
 * sphere and its air an exponential shell around it; every pixel near the limb integrates single
 * scattering along its view ray (Rayleigh and a little Mie), with the sunlight's way in through the
 * air taken from an analytic Chapman approximation instead of a second march, so a long grazing path
 * dims smoothly and never bands. The sun sits just under the limb, so the planet hides it the way it
 * would: the air above it is the brightest thing in the scene.
 *
 * The camera sits on the planet's axis with its principal point shifted onto the page, which makes the
 * limb an exact circle on screen. Its centre and radius are solved from the product window's rect
 * every frame, so the limb crosses behind the window the same way at every size.
 */

/** The angle between the camera's axis and its view of the limb: a low orbit, so the curve is gentle. */
const ALPHA = (50 * Math.PI) / 180

export const worldShader = /* wgsl */ `
struct World {
  view: vec4f,
  planet: vec4f,
  sun: vec4f,
  portal: vec4f,
  copy: vec4f,
  words: array<vec4f, 3>,
  stage: vec4f,
  look: vec4f,
}
@group(0) @binding(0) var<uniform> world: World;

${labWgsl}

// The product window's corner, the same 20px as its rounded-[20px].
const PORTAL_RADIUS = 20.0;

// The camera's distance from the planet's centre, in planet radii: 1 / sin(ALPHA).
const DIST = ${(1 / Math.sin(ALPHA)).toFixed(6)};

// The air, in planet radii. Scale heights are stretched past Earth's so the shell reads at page
// size; the ratios between them are what make it look like air.
const HR = 0.0011;            // Rayleigh scale height
const HM = 0.0004;            // Mie (haze) scale height, lower and thinner
const TOP = 1.0135;           // the shell's edge, a dozen Rayleigh heights up
// Scattering at the surface per planet radius. The Rayleigh colour is Realm's accent rather than
// lambda^-4, so the air is the page's own blue and not an electric one.
const BETA_R = vec3f(0.30, 0.58, 1.0) * 150.0;
// The haze is one low layer with three ways of scattering: broadly (a pale line along the whole
// limb), forward (the short stretch the sun turns white), and in a narrow aureole right over it.
const HAZE_BROAD = 9.0;
const HAZE_FORWARD = 0.55;
const HAZE_AUREOLE = 0.05;
const LOW_TINT = vec3f(0.78, 0.89, 1.0);
const SUN_TINT = vec3f(0.95, 0.975, 1.0);
// Extinction is grey: a long path through the air dims the light without reddening it, so the
// sunrise stays white-blue (orange means state in Realm).
const EXT_R = 13.0;
const EXT_M = 8.0;
const EXPOSURE = 3.2;

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
  return 0.0795775 * (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosTheta, 1e-7), 1.5);
}

const NIGHT = PAGE * 0.52;

// Optical depth from radius r toward a direction at cos(zenith) = mu, for one exponential layer of
// scale height h, in surface densities times planet radii. Schuler's approximation of the Chapman
// function; below the horizon it is the full tangent path less the part behind, and a path that
// would pass under the surface comes out so deep that its light is gone, which is the planet's shadow.
fn opticalDepth(r: f32, mu: f32, h: f32) -> f32 {
  let c = sqrt(1.5707963 * r / h);
  let here = exp((1.0 - r) / h);
  if (mu >= 0.0) {
    return h * here * c / ((c - 1.0) * mu + 1.0);
  }
  let rmin = r * sqrt(max(1.0 - mu * mu, 0.0));
  let low = exp(min((1.0 - rmin) / h, 60.0));
  let cmin = sqrt(1.5707963 * rmin / h);
  return h * (2.0 * low * cmin - here * c / ((c - 1.0) * (-mu) + 1.0));
}

// Single scattering along one view ray. rgb is the light that reaches the camera, a the
// transmittance of the whole path (how much of a star behind it survives).
fn atmosphere(rd: vec3f, sun: vec3f, ground: bool) -> vec4f {
  let centre = vec3f(0.0, 0.0, DIST);
  let b = rd.z * DIST;              // along the ray to its closest approach to the centre
  let r2 = DIST * DIST - b * b;     // that approach's radius, squared
  let disc = TOP * TOP - r2;
  if (disc <= 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let chord = sqrt(disc);
  // Nearly all the air on a ray lies within a few scale heights of its lowest point.
  let spread = 4.5 * sqrt(sqrt(max(r2, 0.0)) * HR);
  let t0 = max(b - chord, b - spread);
  var t1 = min(b + chord, b + spread);
  if (ground && r2 < 1.0) { t1 = min(t1, b - sqrt(1.0 - r2)); }
  if (t1 <= t0) { return vec4f(0.0, 0.0, 0.0, 1.0); }

  let cosTheta = dot(rd, sun);
  let phaseR = 0.0596831 * (1.0 + cosTheta * cosTheta);
  let haze = LOW_TINT * (HAZE_BROAD * henyeyGreenstein(cosTheta, 0.6))
    + SUN_TINT * (HAZE_FORWARD * henyeyGreenstein(cosTheta, 0.97) + HAZE_AUREOLE * henyeyGreenstein(cosTheta, 0.995));

  let steps = 16;
  let dt = (t1 - t0) / f32(steps);
  var tau = 0.0;
  var rayleigh = 0.0;
  var mie = 0.0;
  for (var i = 0; i < steps; i++) {
    let s = rd * (t0 + (f32(i) + 0.5) * dt) - centre;
    let r = length(s);
    let dR = exp((1.0 - r) / HR);
    let dM = exp((1.0 - r) / HM);
    let local = (dR * EXT_R + dM * EXT_M) * dt;
    let mu = dot(s, sun) / r;
    let toSun = opticalDepth(r, mu, HR) * EXT_R + opticalDepth(r, mu, HM) * EXT_M;
    let through = exp(-(tau + 0.5 * local + toSun));
    rayleigh += dR * through * dt;
    mie += dM * through * dt;
    tau += local;
  }
  let light = BETA_R * (rayleigh * phaseR) + haze * mie;
  return vec4f(light * EXPOSURE, exp(-tau));
}

// 0 inside a rect grown by margin, 1 once soft px clear of it: a hard bound with an anti-aliased edge.
fn clearOf(p: vec2f, r: vec4f, margin: f32, soft: f32) -> f32 {
  if (r.z <= 0.0) { return 1.0; }
  let half = r.zw * 0.5 + vec2f(margin);
  let d = sdRoundRect(p - r.xy - r.zw * 0.5, half, margin);
  return smoothstep(0.0, soft, d);
}

// A few faint stars, still, each a point in device pixels. Anchored to the hero, so they scroll with it.
fn stars(p: vec2f, dpx: f32) -> f32 {
  let q = p - vec2f(0.0, world.stage.y);
  let cell = 92.0;
  let id = floor(q / cell);
  if (hash21(id + 17.31) < 0.70) { return 0.0; }
  let at = (id + 0.15 + 0.7 * hash22(id + 3.7)) * cell;
  let d = length(q - at) * dpx;
  let m = hash21(id + 5.13);
  let brightness = mix(0.035, 0.16, m * m * m);
  return brightness * exp(-d * d / (2.0 * 0.6 * 0.6));
}

fn roundRectNormal(q: vec2f, half: vec2f, r: f32) -> vec2f {
  let d = abs(q) - half + vec2f(r);
  var n = vec2f(0.0, 1.0);
  if (d.x > 0.0 && d.y > 0.0) {
    n = normalize(d);
  } else if (d.x > d.y) {
    n = vec2f(1.0, 0.0);
  }
  return n * select(vec2f(-1.0), vec2f(1.0), q >= vec2f(0.0));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * world.view.xy;
  let t = world.view.z;
  let dpx = world.view.w;
  let device = p * dpx;
  let presence = world.look.x;

  // Behind the window nothing is ever seen: skip it.
  let half = world.portal.zw * 0.5;
  let pc = world.portal.xy + half;
  let edge = sdRoundRect(p - pc, half, PORTAL_RADIUS);
  if (edge < -3.0 || presence <= 0.0) {
    return vec4f(dither(PAGE, device, t), 1.0);
  }

  let centre = world.planet.xy;
  let radius = world.planet.z;
  let focal = world.planet.w;
  let fromCentre = p - centre;
  let above = length(fromCentre) - radius;           // CSS px above the limb; negative on the planet
  let cover = clamp(0.5 - above * dpx, 0.0, 1.0);    // the planet's edge, anti-aliased in device px

  let rd = normalize(vec3f(fromCentre / focal, 1.0));
  let sun = normalize(vec3f((world.sun.xy - centre) / focal, 1.0));

  var light = vec3f(0.0);
  var through = 1.0;
  if (above > -140.0 && above < 160.0) {
    var sky = atmosphere(rd, sun, true);
    if (cover > 0.0 && cover < 1.0) {
      sky = mix(atmosphere(rd, sun, false), sky, cover);
    }
    light += sky.rgb;
    through = sky.a;
  }

  // Glare: the camera's own response to the brightest air, centred a few pixels up into it over the
  // sun. Held off the night side, which stays dark.
  let limbPoint = world.sun.zw;
  let up = normalize(limbPoint - centre);
  let toLimb = length(p - (limbPoint + up * 4.0));
  let tail = 1.0 + toLimb * toLimb / (60.0 * 60.0);
  let glare = world.look.z * (0.6 * exp(-toLimb / 8.0) + 0.25 * exp(-toLimb / 28.0) + 0.15 / (tail * sqrt(tail))) * mix(1.0, 0.3, cover);
  light += mix(INK, ACCENT_INK, 0.35) * glare;

  // Stars: never behind words or the header, hidden by the planet, dimmed through the air.
  var starClear = clearOf(p, world.words[0], 18.0, 12.0) * clearOf(p, world.words[1], 18.0, 12.0) * clearOf(p, world.words[2], 18.0, 12.0);
  starClear *= smoothstep(78.0, 96.0, p.y);
  light += mix(INK, ACCENT_INK, 0.2) * stars(p, dpx) * starClear * through * (1.0 - cover) * exp(-glare * 6.0);

  // The window's top rim catches the sunrise: a hairline on its outer edge, lit where the edge faces
  // the light and fading with distance from it.
  if (edge > -1.0) {
    let out = max(edge, 0.0);
    let n = roundRectNormal(p - pc, half, PORTAL_RADIUS);
    let toward = limbPoint - p;
    let facing = max(dot(n, normalize(toward)), 0.0);
    let fall = 1.0 / (1.0 + dot(toward, toward) / (240.0 * 240.0));
    let rim = (exp(-out * dpx / 1.1) * 0.9 + exp(-out / 6.0) * 0.18) * facing * facing * fall;
    light += mix(INK, ACCENT_INK, 0.3) * rim * world.look.w;
  }

  // Area light never reaches the words: bounded by the copy's rect, not faded toward it.
  light *= clearOf(p, world.copy, 6.0, 28.0);

  let base = mix(PAGE, NIGHT, cover * presence);
  let lit = vec3f(1.0) - exp(-light * presence * 1.15);
  let color = base + lit * (vec3f(1.0) - base);
  return vec4f(dither(color, device, t), 1.0);
}
`

type Vec4 = [number, number, number, number]

const rectOf = (r: Rect): Vec4 => [r[0], r[1], r[2], r[3]]
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Where the planet sits, solved from the window: its limb's apex a little above the window's top
 * edge, centred on the window, with a radius that keeps the curve gentle at every width.
 */
function placePlanet(portal: Rect, copy: Rect, width: number) {
  const [left, top, w] = portal
  const radius = Math.max(w * 1.9, width * 1.55)
  const copyBottom = copy[1] + copy[3]
  const lift = clamp((top - copyBottom) * 0.48, 34, 96)
  const cx = left + w / 2
  const cy = top - lift + radius
  const focal = radius / Math.tan(ALPHA)
  return { cx, cy, radius, focal }
}

export const createWorld: StageFactory = (gpu, output) => {
  const zero: Vec4 = [0, 0, 0, 0]
  const fx = effect(gpu, worldShader, {
    label: "realm-hero-world",
    set: {
      world: {
        view: [1, 1, 0, 1],
        planet: [0, 1e4, 1, 1],
        sun: zero,
        portal: zero,
        copy: zero,
        words: [zero, zero, zero],
        stage: zero,
        look: zero,
      },
    },
  })

  // The sun's place along the limb, eased toward the pointer with a time constant of about a second.
  let sunX = Number.NaN
  let lastSeconds = 0

  return {
    draw(frame, input) {
      const portal = anchor(input, "portal")
      const copy = anchor(input, "copy")
      const stage = anchor(input, "stage")
      const { width, height } = input
      const dpx = output.size[0] / Math.max(width, 1)

      const { cx, cy, radius, focal } = placePlanet(portal, copy, width)

      const restX = portal[0] + portal[2] * 0.68
      const [px, , presenceOfPointer] = input.pointer
      const reach = clamp(px, portal[0] + portal[2] * 0.12, portal[0] + portal[2] * 0.88)
      const targetX = input.still ? restX : restX + (reach - restX) * 0.32 * presenceOfPointer
      const dt = Math.max(0, input.seconds - lastSeconds)
      lastSeconds = input.seconds
      if (!Number.isFinite(sunX) || input.still) sunX = targetX
      else sunX += (targetX - sunX) * (1 - Math.exp(-dt / 1.1))

      // The sun a few pixels under the limb, on the radius through sunX.
      const sin = clamp((sunX - cx) / radius, -0.95, 0.95)
      const cos = Math.sqrt(1 - sin * sin)
      const depth = 13
      const sun: Vec4 = [cx + sin * (radius - depth), cy - cos * (radius - depth), cx + sin * radius, cy - cos * radius]

      // The scene leaves with the hero: whole while its bottom is well inside the view, gone (exactly
      // the page) once it has passed the top, so the frame held after the loop stops is the page.
      const stageBottom = stage[1] + stage[3]
      const presence = stage[3] > 0 ? clamp(stageBottom / (height * 0.45), 0, 1) : 1
      const eased = presence * presence * (3 - 2 * presence)

      fx.set({
        world: {
          view: [width, height, input.seconds, dpx],
          planet: [cx, cy, radius, focal],
          sun,
          portal: rectOf(portal),
          copy: rectOf(copy),
          words: [rectOf(anchor(input, "words-a")), rectOf(anchor(input, "words-h")), rectOf(anchor(input, "words-l"))],
          stage: rectOf(stage),
          look: [eased, input.still ? 1 : 0, 0.32, 1.0],
        },
      })
      frame.pass(output, fx)
    },
  }
}
