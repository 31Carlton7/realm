"use client"

import { useEffect, useRef } from "react"
import { clock, frame, frameLoop, init, surface, type Frame } from "vgpu"

import { PAGE, type Rect, type StageFactory, type StageInput } from "./stage"

/** The moment a reduced-motion frame is composed at: past every concept's opening, before any loop repeats. */
const STILL_SECONDS = 6

declare global {
  interface Window {
    /** Frames painted since load — the lab's screenshot script reads it twice to estimate the frame rate. */
    __labFrames?: number
  }
}

const readAnchors = (): Record<string, Rect> => {
  const anchors: Record<string, Rect> = {}
  for (const node of document.querySelectorAll<HTMLElement>("[data-lab-anchor]")) {
    const name = node.dataset.labAnchor
    if (!name || name in anchors) continue
    const r = node.getBoundingClientRect()
    anchors[name] = [r.left, r.top, r.width, r.height]
  }
  return anchors
}

/**
 * The fixed, viewport-sized canvas a hero concept draws into, and the loop around it.
 *
 * The loop stops when the tab hides and when the concept's `stage` anchor has scrolled out of view,
 * and resumes where it was; under reduced motion it never runs, and the canvas is redrawn once each
 * time the page moves. Without WebGPU, `data-lab-field="off"` lands on <html> and the canvas stays
 * transparent over the concept's CSS fallback.
 */
export function LabCanvas({ create }: { create: StageFactory }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const root = document.documentElement
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    let disposed = false
    let teardown: (() => void) | undefined
    window.__labFrames = 0

    // The pointer eases rather than snaps, so light drifts after it instead of twitching.
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

    const read = (seconds: number, still: boolean): StageInput => {
      const now = performance.now()
      const k = 1 - Math.exp(-(now - pointer.last) / 90)
      pointer.last = now
      pointer.x += (pointer.tx - pointer.x) * k
      pointer.y += (pointer.ty - pointer.y) * k
      pointer.presence += (pointer.target - pointer.presence) * k * 0.6
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        seconds,
        still,
        pointer: [pointer.x, pointer.y, pointer.presence],
        anchors: readAnchors(),
      }
    }

    const stageOnScreen = () => {
      const node = document.querySelector('[data-lab-anchor="stage"]')
      if (!node) return true
      const r = node.getBoundingClientRect()
      return r.bottom > 0 && r.top < window.innerHeight
    }

    root.dataset.labField = "pending"
    void (async () => {
      try {
        const gpu = await init({ label: "realm-hero-lab" })
        if (disposed) {
          gpu.dispose()
          return
        }
        // Capped at 1.5, as the landing field is: soft light at 2x on a 5K display is four times the
        // fragments for a difference nobody finds. Capped again by the largest texture the device takes.
        const longest = Math.max(window.screen.width, window.screen.height, window.innerWidth, window.innerHeight, 1)
        const dprMax = Math.max(0.5, Math.min(1.5, gpu.gpu.limits.maxTextureDimension2D / longest))
        const output = surface(gpu, canvas, { dpr: [Math.min(1, dprMax), dprMax], clearColor: [...PAGE, 1] })
        const stage = await create(gpu, output)
        if (disposed) {
          stage.dispose?.()
          gpu.dispose()
          return
        }
        const timeline = clock(gpu)
        let still = motionQuery.matches

        const paint = (f: Frame) => {
          stage.draw(f, read(still ? STILL_SECONDS : timeline.time, still))
          window.__labFrames = (window.__labFrames ?? 0) + 1
        }

        let loop: { stop(): void } | undefined
        const start = () => {
          if (loop || still || document.visibilityState !== "visible" || !stageOnScreen()) return
          loop = frameLoop(gpu, paint)
        }
        const stop = () => {
          loop?.stop()
          loop = undefined
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
          stage.dispose?.()
          gpu.dispose()
        }
      } catch (error) {
        console.warn("The hero lab's canvas is unavailable here; showing the concept's fallback.", error)
        if (!disposed) root.dataset.labField = "off"
      }
    })()

    return () => {
      disposed = true
      teardown?.()
      delete root.dataset.labField
    }
  }, [create])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 block h-full w-full opacity-0 transition-opacity duration-1000 ease-[var(--ease-out-strong)] [html[data-lab-field=on]_&]:opacity-100"
    />
  )
}
