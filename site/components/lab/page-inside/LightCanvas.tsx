"use client"

import { useEffect, useRef } from "react"
import { clock, frame, frameLoop, init, surface, type Frame } from "vgpu"

import { PAGE } from "@/components/lab/stage"

import { beforeLight, studioScene, type Rect } from "./scene"
import { createStudio, type StudioInput } from "./studio"

declare global {
  interface Window {
    /** Frames the light has run since load; the lab's screenshot script reads it to estimate the rate. */
    __labFrames?: number
  }
}

const rectOf = (node: Element): Rect => {
  const r = node.getBoundingClientRect()
  return [r.left, r.top, r.width, r.height]
}

const onScreen = (r: Rect, margin = 0) => r[2] > 0 && r[1] + r[3] > -margin && r[1] < window.innerHeight + margin && r[0] + r[2] > -margin && r[0] < window.innerWidth + margin

/**
 * The fixed canvas behind the page that the studio light is drawn on, and the loop around it — the
 * lab's LabCanvas, widened to what this page needs: several lit objects at once, several sections
 * that have light, and a camera that has to move before the light reads anything.
 *
 * Everything the light belongs to says so in the DOM. `data-light-stage` marks a section with light
 * (the loop runs only while one is on screen), `data-light-object` a lit object (`data-light-r` its
 * corner radius at its own layout size, `data-light-face` how bright its face is, `data-light-lit` how
 * much of the key light it is in), and `data-light-words` a text block light with area stays out of
 * (`data-light-pad`, how far). Reduced motion is one frame redrawn when the page moves; a hidden tab
 * stops the loop; no WebGPU puts `data-lab-field="off"` on <html> for the CSS fallback.
 */
export function LightCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const root = document.documentElement
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    let disposed = false
    let teardown: (() => void) | undefined
    window.__labFrames = 0

    // The pointer eases rather than snaps, so the highlight drifts after it like a light being turned.
    const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2, tx: 0, ty: 0, presence: 0, target: 0, last: performance.now() }
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return
      pointer.tx = event.clientX
      pointer.ty = event.clientY
      if (pointer.presence === 0) {
        pointer.x = event.clientX
        pointer.y = event.clientY
      }
      pointer.target = 1
    }
    const onPointerLeave = () => {
      pointer.target = 0
    }

    const stageOnScreen = () => [...document.querySelectorAll("[data-light-stage]")].some((node) => onScreen(rectOf(node)))

    const read = (seconds: number, still: boolean, dpr: number): StudioInput => {
      for (const hook of beforeLight) hook()
      const now = performance.now()
      const k = 1 - Math.exp(-(now - pointer.last) / 140)
      pointer.last = now
      pointer.x += (pointer.tx - pointer.x) * k
      pointer.y += (pointer.ty - pointer.y) * k
      pointer.presence += (pointer.target - pointer.presence) * k * 0.5
      if (Math.abs(pointer.target - pointer.presence) < 0.002) pointer.presence = pointer.target

      const objects: StudioInput["objects"] = []
      for (const node of document.querySelectorAll<HTMLElement>("[data-light-object]")) {
        if (node.dataset.lightLit === "0") continue
        const rect = rectOf(node)
        if (!onScreen(rect, 160)) continue
        const layoutWidth = node.offsetWidth || rect[2]
        objects.push({
          rect,
          radius: Number(node.dataset.lightR ?? 12) * (rect[2] / layoutWidth),
          lit: Number(node.dataset.lightLit ?? 1),
          face: Number(node.dataset.lightFace ?? 0.06),
          squircle: node.dataset.lightShape === "squircle",
          rim: node.dataset.lightRim !== "off",
        })
      }
      const words: StudioInput["words"] = []
      for (const node of document.querySelectorAll<HTMLElement>("[data-light-words]")) {
        const rect = rectOf(node)
        if (!onScreen(rect, 200)) continue
        words.push({ rect, pad: Number(node.dataset.lightPad ?? 64) })
      }

      // The camera says where the key light hangs; without one, it hangs above the first lit object and
      // toward its right, and the floor is that object's foot.
      const main = objects[0]?.rect
      const key = studioScene.key ?? (main ? ([main[0] + main[2] * 0.62, main[1] - main[3] * 0.8, Math.max(main[2], main[3]) * 1.4, 1] as const) : ([0, 0, 0, 0] as const))
      const floor = studioScene.floor ?? (main ? main[1] + main[3] : window.innerHeight * 2)

      return {
        width: window.innerWidth,
        height: window.innerHeight,
        seconds,
        still,
        pointer: [pointer.x, pointer.y, still ? 0 : pointer.presence],
        dpr,
        key,
        floor,
        objects,
        words: words.slice(0, 3),
        dark: studioScene.dark,
      }
    }

    root.dataset.labField = "pending"
    void (async () => {
      try {
        const gpu = await init({ label: "realm-inside-studio" })
        if (disposed) {
          gpu.dispose()
          return
        }
        // Capped at 1.5, as the landing field is: soft light at 2x is four times the fragments for a
        // difference nobody finds. Capped again by the largest texture the device takes.
        const longest = Math.max(window.screen.width, window.screen.height, window.innerWidth, window.innerHeight, 1)
        const dprMax = Math.max(0.5, Math.min(1.5, gpu.gpu.limits.maxTextureDimension2D / longest))
        const output = surface(gpu, canvas, { dpr: [Math.min(1, dprMax), dprMax], clearColor: [...PAGE, 1] })
        const studio = createStudio(gpu, output)
        const timeline = clock(gpu)
        let still = motionQuery.matches

        const paint = (f: Frame) => {
          const dpr = canvas.width / Math.max(canvas.clientWidth, 1)
          studio.draw(f, read(still ? 6 : timeline.time, still, dpr))
          window.__labFrames = (window.__labFrames ?? 0) + 1
        }

        let loop: { stop(): void } | undefined
        const start = () => {
          if (loop || still || document.visibilityState !== "visible" || !stageOnScreen()) return
          loop = frameLoop(gpu, paint)
        }
        // A stopped loop leaves its last frame on the canvas, which is fixed to the window: light that
        // belonged to a stage now off screen would hang over whatever scrolled in. The last frame
        // before stopping is drawn with nothing lit, so the canvas holds exactly the page.
        const stop = () => {
          if (!loop) return
          loop.stop()
          loop = undefined
          frame(gpu, (f) => studio.clear(f))
        }

        let queued = false
        const onMoved = () => {
          if (still) {
            if (queued) return
            queued = true
            requestAnimationFrame(() => {
              queued = false
              frame(gpu, paint)
            })
            return
          }
          if (stageOnScreen()) start()
          else stop()
        }
        const onVisibility = () => {
          if (document.visibilityState === "visible") start()
          else stop()
        }
        const onMotionChange = () => {
          still = motionQuery.matches
          if (still) {
            stop()
            frame(gpu, paint)
          } else start()
        }

        window.addEventListener("pointermove", onPointerMove, { passive: true })
        root.addEventListener("pointerleave", onPointerLeave)
        window.addEventListener("scroll", onMoved, { passive: true })
        window.addEventListener("resize", onMoved)
        document.addEventListener("visibilitychange", onVisibility)
        motionQuery.addEventListener("change", onMotionChange)

        if (still) frame(gpu, paint)
        else start()
        root.dataset.labField = "on"

        teardown = () => {
          window.removeEventListener("pointermove", onPointerMove)
          root.removeEventListener("pointerleave", onPointerLeave)
          window.removeEventListener("scroll", onMoved)
          window.removeEventListener("resize", onMoved)
          document.removeEventListener("visibilitychange", onVisibility)
          motionQuery.removeEventListener("change", onMotionChange)
          stop()
          gpu.dispose()
        }
      } catch (error) {
        console.warn("The studio light is unavailable here; the page shows its CSS fallback.", error)
        if (!disposed) root.dataset.labField = "off"
      }
    })()

    return () => {
      disposed = true
      teardown?.()
      delete root.dataset.labField
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 block h-full w-full opacity-0 transition-opacity duration-1000 ease-[var(--ease-out-strong)] [html[data-lab-field=on]_&]:opacity-100"
    />
  )
}
