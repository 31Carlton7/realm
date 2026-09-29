import { clock, effect, frame, frameLoop, init, surface } from "vgpu"

import { fieldShader, PAGE, type FieldUniforms } from "./field"

/**
 * The runtime around `fieldShader`: one device, one surface, one pass per frame.
 *
 * It owns nothing about the page. Every frame it asks `read` what the page looks like right now —
 * where the product image is, how far the hero has scrolled, where the pointer is — so layout stays
 * the DOM's business and the shader only ever draws what it was told.
 */
export type FieldReading = Omit<FieldUniforms, "view"> & { width: number; height: number }

/**
 * Held still under reduced motion: a composed frame rather than time zero, which is the one moment
 * the corridor's phase lines up and every frame sits on top of another.
 */
const STILL_SECONDS = 4

export async function createDimensionField(
  canvas: HTMLCanvasElement,
  options: { read: () => FieldReading; reduceMotion: boolean; signal?: AbortSignal },
) {
  const gpu = await init({ label: "realm-dimension-field" })
  if (options.signal?.aborted) {
    gpu.dispose()
    throw new DOMException("Realm's dimension field was cancelled", "AbortError")
  }

  // Capped at 1.5: the field is soft everywhere but its hairlines, and a full 2x on a 5K display is
  // four times the fragments for a difference nobody can find. Capped again by the device: the canvas
  // is the whole viewport, and a window wide enough (two displays, or a capture harness that sets the
  // viewport to the page's height) asks for a backing store past the largest texture it may have.
  const longest = Math.max(window.screen.width, window.screen.height, window.innerWidth, window.innerHeight, 1)
  const dprMax = Math.max(0.5, Math.min(1.5, gpu.gpu.limits.maxTextureDimension2D / longest))
  const output = surface(gpu, canvas, { dpr: [Math.min(1, dprMax), dprMax], clearColor: [...PAGE, 1] })
  const zero: [number, number, number, number] = [0, 0, 0, 0]
  const shader = effect(gpu, fieldShader, {
    label: "realm-dimension-field",
    set: { field: { view: [1, 1, 0, 0], pointer: zero, portal: zero, hero: zero, ripple: [0, 0, -1, 0], faces: zero, facesAt: zero } },
  })
  const timeline = clock(gpu)
  let reduceMotion = options.reduceMotion

  const paint = (target: { pass: (surface: typeof output, fx: typeof shader) => void }) => {
    const { width, height, ...rest } = options.read()
    const seconds = reduceMotion ? STILL_SECONDS : timeline.time
    shader.set({ field: { ...rest, view: [width, height, seconds, reduceMotion ? 1 : 0] } })
    target.pass(output, shader)
  }

  let loop: { stop(): void } | undefined
  const start = () => {
    if (loop || reduceMotion) return
    loop = frameLoop(gpu, paint)
  }
  const stop = () => {
    loop?.stop()
    loop = undefined
  }

  return {
    start,
    stop,
    /** One frame on request — the whole of the field's life under reduced motion, where it is
     *  redrawn when something it depends on moves (a scroll, a resize) and otherwise holds. */
    paintOnce() {
      frame(gpu, paint)
    },
    setReducedMotion(value: boolean) {
      reduceMotion = value
      if (value) {
        stop()
        frame(gpu, paint)
      } else start()
    },
    dispose() {
      stop()
      gpu.dispose()
    },
  }
}
