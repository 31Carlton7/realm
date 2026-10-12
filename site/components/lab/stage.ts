import type { Frame, Gpu, Surface } from "vgpu"

/**
 * The contract every hero concept in the lab draws through.
 *
 * `LabCanvas` owns the device, the canvas, the frame loop and every rule a frame loop has to
 * re-implement because the stylesheet cannot reach it (design.md, Motion): reduced motion is one held
 * frame redrawn only when the page moves, a hidden tab or a hero scrolled out of view stops the loop,
 * and a browser without WebGPU gets `data-lab-field="off"` on <html> and the concept's CSS fallback.
 *
 * A concept supplies a factory that builds its pipeline once and draws it every frame from what the
 * page looks like right now. Layout stays the DOM's: anything the light belongs to is marked
 * `data-lab-anchor="<name>"`, and its viewport rect arrives in `anchors` every frame.
 */

/** left, top, width, height — CSS px, viewport, origin top-left, y down (vgpu's `uv` times the view). */
export type Rect = readonly [number, number, number, number]

export type StageInput = {
  /** The viewport in CSS px. Every rect and the pointer share this space. */
  width: number
  height: number
  /** Seconds since the stage started, held at a composed moment under reduced motion. */
  seconds: number
  /** Reduced motion: this is a still frame, redrawn only when the page scrolls or resizes. */
  still: boolean
  /** x, y in CSS px, and presence 0..1 easing in as a mouse arrives and out as it leaves. */
  pointer: readonly [number, number, number]
  /** Every element marked `data-lab-anchor`, by its name, as its viewport rect. */
  anchors: Readonly<Record<string, Rect>>
}

export type Stage = {
  draw(frame: Frame, input: StageInput): void
  dispose?(): void
}

/** Called once per mount. Keep it at module scope so its identity is stable across renders. */
export type StageFactory = (gpu: Gpu, output: Surface) => Stage | Promise<Stage>

const EMPTY: Rect = [0, 0, 0, 0]

/** An anchor's rect, or an empty one, so a shader can always be handed four numbers. */
export const anchor = (input: StageInput, name: string): Rect => input.anchors[name] ?? EMPTY

/** Realm's ground and lights as the shaders see them: sRGB-encoded, because the surface is not an sRGB view. */
export const PAGE = [23 / 255, 24 / 255, 26 / 255] as const
export const ACCENT = [0.238, 0.6036, 1.0] as const
export const ACCENT_INK = [0.4933, 0.7529, 1.0] as const
export const INK = [0.9489, 0.9535, 0.958] as const

const vec3 = (rgb: readonly number[]) => `vec3f(${rgb.map((c) => c.toFixed(4)).join(", ")})`

/**
 * WGSL every concept may paste in front of its own: the palette, hashing and noise, a rounded-rect
 * distance, and the two finishing steps that keep a dark gradient from banding on an 8-bit surface.
 */
export const labWgsl = /* wgsl */ `
const PAGE = ${vec3(PAGE)};
const ACCENT = ${vec3(ACCENT)};
const ACCENT_INK = ${vec3(ACCENT_INK)};
const INK = ${vec3(INK)};
const TAU = 6.2831853;

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

fn hash22(p: vec2f) -> vec2f {
  let n = hash21(p);
  return vec2f(n, hash21(p + n * 37.0));
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
    mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x),
    u.y,
  );
}

fn fbm(p: vec2f) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < 4; i++) {
    sum += amp * noise(q);
    q = q * 2.03 + vec2f(1.7, 9.2);
    amp *= 0.5;
  }
  return sum;
}

fn sdRoundRect(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// Light is added to the page and then compressed, so where there is none the result is exactly the
// page's colour and the canvas never reads as a rectangle against the DOM around it.
fn compose(light: vec3f) -> vec3f {
  let lit = vec3f(1.0) - exp(-light * 1.15);
  return PAGE + lit * (vec3f(1.0) - PAGE);
}

// Half a code value of triangular noise per channel: the difference between a smooth dark gradient
// and visible contour bands on an 8-bit display. Pass the pixel position in device px.
fn dither(color: vec3f, px: vec2f, t: f32) -> vec3f {
  let a = hash21(px + fract(t) * 61.0);
  let b = hash21(px.yx + fract(t * 1.37) * 47.0);
  return color + vec3f((a + b - 1.0) / 255.0);
}
`
