import { effect, type Frame, type Gpu, type Surface } from "vgpu"

import { ACCENT, labWgsl, PAGE } from "@/components/lab/stage"

/**
 * The studio the window stands in: the app lit as an object, the way a product is photographed.
 *
 * One fullscreen pass behind the page, drawn in the DOM's own coordinates (CSS px, y down), so every
 * rect it is handed is an element's `getBoundingClientRect()` and the light stays on the window as the
 * camera zooms and pans it. It draws only where the page shows through — around and below the lit
 * objects, never on them — and it draws, in that order:
 *
 *   rim       the window's edge catching the key light: a device-pixel line along the edges that face
 *             the light, brightest where the light's reflection sits on the top edge, and a short halo
 *   bounce    the screen's own light on the page right around the frame
 *   wall      the background light on the wall behind, toward the key side
 *   floor     what the window stands on: the key light's pool in front of it, a contact shadow along
 *             the line where it meets the floor, and its reflection, mirrored, blurred more the further
 *             it travels, and gone within a sixth of the window's height
 *
 * The pointer turns the key light a few degrees, so the highlight slides along the edge the way it
 * does on a product turned in the hand. Nothing moves on its own: a studio light holds still.
 *
 * Light with area never reaches words: each text block it is told about zeroes it, with a short ramp
 * outside the block's own edge (a level, not a fade a large shape could reach across).
 */

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const mixRgb = (a: readonly number[], b: readonly number[], t: number) => a.map((x, i) => x + (b[i]! - x) * t)
const vec3 = (rgb: readonly number[]) => `vec3f(${rgb.map((c) => c.toFixed(5)).join(", ")})`

const PAGE_LINEAR = PAGE.map(linear)
const ACCENT_LINEAR = ACCENT.map(linear)
/** The key light: white, a touch cool, as Realm's light is. */
const KEY = mixRgb([1, 1, 1], ACCENT_LINEAR, 0.05)
/** What a screen of Realm's dark surfaces gives off: cooler. */
const SCREEN = mixRgb([1, 1, 1], ACCENT_LINEAR, 0.3)

export const MAX_OBJECTS = 10
export const MAX_WORDS = 3

export const studioWgsl = /* wgsl */ `
${labWgsl}

struct Studio {
  view: vec4f,     // viewport width, height (CSS px), seconds, still (0 | 1)
  pointer: vec4f,  // x, y (CSS px), presence 0..1, device px per CSS px
  key: vec4f,      // the point the key light is aimed at (CSS px), its reach (CSS px), its strength
  floor: vec4f,    // the floor line (CSS px), unused, unused, unused
  counts: vec4f,   // lit objects, word blocks, bright regions, unused
  objs: array<vec4f, ${MAX_OBJECTS}>,   // each lit object's rect: left, top, width, height
  looks: array<vec4f, ${MAX_OBJECTS}>,  // its corner radius (CSS px), how lit it is 0..1, its face's light, its shape (0 round, 1 squircle)
  words: array<vec4f, ${MAX_WORDS}>,    // text no light with area may reach
  pads: vec4f,                          // how far outside each text block the light takes to return (CSS px)
  hot: vec4f,                           // a bright region on the main object's face (rect), for its reflection
  hotLight: vec4f,                      // that region's light, unused...
  dark: vec4f,                          // the words' side of the stage: dark left of x, light whole right of y; z > 0 when in use
}
@group(0) @binding(0) var<uniform> studio: Studio;

const PAGE_LIN = ${vec3(PAGE_LINEAR)};
const KEY = ${vec3(KEY)};
const SCREEN = ${vec3(SCREEN)};

fn sdRound(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// The corner \`corner-shape: squircle\` draws, and the app icon's body is close to.
fn sdSquircle(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + vec2f(r);
  let m = max(q, vec2f(0.0));
  let m2 = m * m;
  return sqrt(sqrt(m2.x * m2.x + m2.y * m2.y)) + min(max(q.x, q.y), 0.0) - r;
}

fn sdShape(p: vec2f, half: vec2f, r: f32, shape: f32) -> f32 {
  if (shape > 0.5) { return sdSquircle(p, half, r); }
  return sdRound(p, half, r);
}

fn sdBox(p: vec2f, half: vec2f) -> f32 {
  let q = abs(p) - half;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}

// The outward normal of a rounded rect at the edge nearest p (p outside or on it).
fn edgeNormal(p: vec2f, half: vec2f, r: f32) -> vec2f {
  let q = abs(p) - half + vec2f(r);
  var n = vec2f(0.0, 1.0);
  if (q.x > 0.0 && q.y > 0.0) {
    n = normalize(q);
  } else if (q.x > q.y) {
    n = vec2f(1.0, 0.0);
  }
  return n * sign(p + vec2f(1e-4));
}

fn toSrgb(c: vec3f) -> vec3f {
  let hi = 1.055 * pow(max(c, vec3f(0.0031308)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, c * 12.92, c <= vec3f(0.0031308));
}

// Light adds to the page in linear terms and rolls off with a soft shoulder; a shadow takes from it.
// No light and no shadow is exactly the page, so the canvas never reads as a rectangle.
fn finish(light: vec3f, shade: f32) -> vec3f {
  let base = PAGE_LIN * (1.0 - clamp(shade, 0.0, 0.85));
  let lit = vec3f(1.0) - exp(-light);
  return toSrgb(base + lit * (vec3f(1.0) - base));
}

// How much light with area may reach p: none inside a text block, back in full a pad outside it.
fn wordsBound(p: vec2f) -> f32 {
  var b = 1.0;
  let n = i32(studio.counts.y);
  for (var i = 0; i < ${MAX_WORDS}; i++) {
    if (i >= n) { break; }
    let r = studio.words[i];
    if (r.z < 1.0) { continue; }
    let d = sdBox(p - r.xy - r.zw * 0.5, r.zw * 0.5);
    b *= smoothstep(0.0, studio.pads[i], d);
  }
  return b;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let view = studio.view.xy;
  let p = uv * view;
  let dpr = studio.pointer.w;
  let px = 1.0 / dpr;
  let t = studio.view.z;
  let page = dither(PAGE, p * dpr, t);

  var bound = wordsBound(p);
  // On the stage, everything left of the light's edge is in the dark, the window's own edge included:
  // the same ramp the window is masked with.
  if (studio.dark.z > 0.0) { bound *= smoothstep(studio.dark.x, studio.dark.y, p.x); }
  if (bound <= 0.0) { return vec4f(page, 1.0); }

  // The key light, turned toward the pointer a little: where its highlight sits on an edge.
  let presence = studio.pointer.z * (1.0 - studio.view.w);
  let keyAt = studio.key.xy + (studio.pointer.xy - studio.key.xy) * 0.22 * presence;
  let strength = studio.key.w;
  let floorY = studio.floor.x;

  var light = vec3f(0.0);
  var shade = 0.0;
  let n = i32(studio.counts.x);
  for (var i = 0; i < ${MAX_OBJECTS}; i++) {
    if (i >= n) { break; }
    let rect = studio.objs[i];
    let look = studio.looks[i];
    let lit = look.y;
    if (rect.z < 1.0 || lit <= 0.001) { continue; }
    let half = rect.zw * 0.5;
    let centre = rect.xy + half;
    let q = p - centre;
    let sd = sdShape(q, half, look.x, look.w);
    // The object itself is the DOM's; the canvas is only ever seen around it.
    if (sd < -0.75 * px) { return vec4f(page, 1.0); }
    let bottom = rect.y + rect.w;
    let below = p.y - bottom;
    let reach = max(rect.z, rect.w);
    if (sd > reach * 0.6 && below < 0.0) { continue; }

    // Rim. The light comes from above and toward the key side; the edges that face it catch it, the
    // top edge most, and most of all where the light's own reflection sits on it. A device-pixel line
    // with almost no glow: a lit edge, not a halo.
    if (sd < 60.0) {
      let toKey = normalize(vec2f((keyAt.x - centre.x) / max(half.x, 1.0) * 0.55, -1.0));
      let nrm = edgeNormal(q, half, look.x);
      let facing = dot(nrm, toKey);
      let catchLight = pow(smoothstep(-0.1, 1.0, facing), 1.8);
      let glintX = centre.x + (keyAt.x - centre.x) * 0.6;
      let glint = exp(-pow((p.x - glintX) / (rect.z * 0.18 + 36.0), 2.0)) * smoothstep(0.2, 0.9, -nrm.y);
      let s = max(sd, 0.0);
      let line = exp(-s * dpr * 1.3);
      let edge = catchLight * (0.22 + 0.78 * glint);
      light += KEY * edge * (line * 0.42 + exp(-s / 2.5) * 0.05 + exp(-s / 10.0) * 0.012) * lit * strength;
      // The screen's own light, on the page right around it.
      light += SCREEN * look.z * exp(-s / 26.0) * 0.03 * lit;
    }

    // The floor, under this object: the shadow along the line it stands on, and its reflection —
    // mirrored, blurred more the further it travels, and gone within a few percent of its height.
    if (below > 0.0 && below < rect.w * 0.3) {
      let ends = 1.0 - smoothstep(-4.0 - below * 0.5, 5.0 + below * 0.7, abs(q.x) - half.x);
      shade += (0.5 * exp(-below / 3.0) + 0.22 * exp(-below / 18.0)) * ends * lit;

      let m = vec2f(q.x, rect.w * 0.5 - below);
      let blur = 2.0 + below * 0.22;
      let sdm = sdShape(m, half, look.x, look.w);
      let cover = 1.0 - smoothstep(-blur, blur, sdm);
      let rimm = exp(-abs(sdm) / (blur * 0.7 + 0.5));
      let fade = exp(-below / (rect.w * 0.05 + 10.0));
      var reflected = cover * look.z * 0.05 + rimm * 0.035;
      if (i == 0 && studio.hotLight.x > 0.0) {
        let h = studio.hot;
        let hm = vec2f(p.x, bottom - below) - h.xy - h.zw * 0.5;
        let hc = 1.0 - smoothstep(-blur, blur, sdBox(hm, h.zw * 0.5));
        reflected += hc * studio.hotLight.x * 0.06;
      }
      light += mix(KEY, SCREEN, 0.5) * reflected * fade * lit;
    }
  }

  // The studio around the objects, from the key light: a soft band where the wall curves into the
  // floor behind them, and the pool the light throws on the floor in front of them. Both are a few
  // code values over the page at their brightest; the dither keeps them from banding.
  let reachKey = studio.key.z;
  if (reachKey > 1.0 && strength > 0.0) {
    let dx = (p.x - keyAt.x) / (reachKey * 0.75);
    let across = exp(-dx * dx);
    let dyWall = (p.y - (floorY - reachKey * 0.22)) / (reachKey * 0.5);
    var studioLight = 0.0045 * across * exp(-dyWall * dyWall);
    if (p.y > floorY) {
      let dy = p.y - floorY;
      studioLight += 0.0045 * exp(-dx * dx * 1.6) * exp(-dy / (reachKey * 0.18)) * smoothstep(0.0, 24.0, dy);
    }
    light += KEY * studioLight * strength;
  }

  let color = finish(light * bound, shade * bound);
  return vec4f(dither(color, p * dpr, t), 1.0);
}
`

export type StudioInput = {
  width: number
  height: number
  seconds: number
  still: boolean
  pointer: readonly [number, number, number]
  dpr: number
  key: readonly [number, number, number, number]
  floor: number
  objects: { rect: readonly [number, number, number, number]; radius: number; lit: number; face: number; squircle?: boolean }[]
  words: { rect: readonly [number, number, number, number]; pad: number }[]
  hot: { rect: readonly [number, number, number, number]; light: number } | null
  dark: readonly [number, number] | null
}

type Vec4 = [number, number, number, number]
const ZERO: Vec4 = [0, 0, 0, 0]

export function createStudio(gpu: Gpu, output: Surface) {
  const fx = effect(gpu, studioWgsl, {
    label: "realm-inside-studio",
    set: {
      studio: {
        view: [1, 1, 0, 0],
        pointer: ZERO,
        key: ZERO,
        floor: ZERO,
        counts: ZERO,
        objs: Array.from({ length: MAX_OBJECTS }, () => ZERO),
        looks: Array.from({ length: MAX_OBJECTS }, () => ZERO),
        words: Array.from({ length: MAX_WORDS }, () => ZERO),
        pads: ZERO,
        hot: ZERO,
        hotLight: ZERO,
        dark: ZERO,
      },
    },
  })

  let last = ""
  return {
    /** The page and nothing on it, for a canvas about to stop drawing. */
    clear(frame: Frame) {
      fx.set({ studio: { counts: ZERO, key: ZERO, dark: ZERO } })
      frame.pass(output, fx)
      last = ""
    },
    /** Draws the frame, or nothing at all when nothing it depends on has changed since the last one. */
    draw(frame: Frame, input: StudioInput): boolean {
      const objects = input.objects.slice(0, MAX_OBJECTS)
      const words = input.words.slice(0, MAX_WORDS)
      const uniforms = {
        view: [input.width, input.height, input.still ? 6 : input.seconds % 1000, input.still ? 1 : 0] as Vec4,
        pointer: [input.pointer[0], input.pointer[1], input.pointer[2], input.dpr] as Vec4,
        key: [...input.key] as Vec4,
        floor: [input.floor, 0, 0, 0] as Vec4,
        counts: [objects.length, words.length, input.hot ? 1 : 0, 0] as Vec4,
        objs: Array.from({ length: MAX_OBJECTS }, (_, i) => (objects[i] ? ([...objects[i]!.rect] as Vec4) : ZERO)),
        looks: Array.from({ length: MAX_OBJECTS }, (_, i) => {
          const o = objects[i]
          return o ? ([o.radius, o.lit, o.face, o.squircle ? 1 : 0] as Vec4) : ZERO
        }),
        words: Array.from({ length: MAX_WORDS }, (_, i) => (words[i] ? ([...words[i]!.rect] as Vec4) : ZERO)),
        pads: Array.from({ length: 4 }, (_, i) => words[i]?.pad ?? 1) as Vec4,
        hot: input.hot ? ([...input.hot.rect] as Vec4) : ZERO,
        hotLight: [input.hot?.light ?? 0, 0, 0, 0] as Vec4,
        dark: (input.dark ? [input.dark[0], input.dark[1], 1, 0] : ZERO) as Vec4,
      }
      // The light holds still unless something it reads has moved; the time only feeds the grain.
      const key = JSON.stringify({ ...uniforms, view: uniforms.view.slice(0, 2).concat(uniforms.view[3]!) })
      if (key === last) return false
      last = key
      fx.set({ studio: uniforms })
      frame.pass(output, fx)
      return true
    },
  }
}
