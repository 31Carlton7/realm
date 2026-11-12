"use client"

import { useEffect, useRef } from "react"
import { clock, frame, init, surface, type Frame } from "vgpu"

import { PAGE, type Rect, type StageFactory, type StageInput } from "./stage"

/** The moment a reduced-motion frame is composed at: past every concept's opening, before any loop repeats. */
const STILL_SECONDS = 6

/**
 * The pace of a field nobody is moving. Left alone, a sky's own motion is slow (it turns a seventh of a
 * degree a second; a hand-off takes two seconds to cross it), and drawing it at 120 frames a second on a
 * ProMotion display shows nothing that 60 do not, at twice the GPU, the main thread, and the
 * compositor's re-blur of every glass pane over it. So the field is drawn at most every
 * `IDLE_FRAME_MS`, less half a 120 Hz frame of slack so a jittery timestamp never drops it to 40,
 * unless the reader is moving the view.
 */
const IDLE_FRAME_MS = 1000 / 60 - 4

/**
 * How long after the reader last scrolled, pointed, or resized the field stays at the display's own
 * rate. Those move the camera and the DOM it lines up with, and both have to step together on every
 * frame the display shows.
 */
const SETTLE_MS = 600

/** The opening's warp or dive is the one fast move nobody asks for; it is over within this. */
const ARRIVAL_MS = 3000

declare global {
  interface Window {
    /** Frames painted since load — the screenshot script reads it twice to estimate the frame rate. */
    __fieldFrames?: number
  }
}

const readAnchors = (): Record<string, Rect> => {
  const anchors: Record<string, Rect> = {}
  for (const node of document.querySelectorAll<HTMLElement>("[data-field-anchor]")) {
    const name = node.dataset.fieldAnchor
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
 * time the page moves. Without WebGPU, `data-field="off"` lands on <html> and the canvas stays
 * transparent over the concept's CSS fallback.
 */
export function FieldCanvas({ create }: { create: StageFactory }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const root = document.documentElement
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    let disposed = false
    let teardown: (() => void) | undefined
    window.__fieldFrames = 0

    // The pointer eases rather than snaps, so light drifts after it instead of twitching.
    const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2, tx: 0, ty: 0, presence: 0, target: 0, last: performance.now() }
    let lastInput = performance.now() + ARRIVAL_MS - SETTLE_MS
    const onInput = () => {
      lastInput = Math.max(lastInput, performance.now())
    }
    const onPointerMove = (event: PointerEvent) => {
      onInput()
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
        // The canvas is fixed to the view, which a classic scroll bar narrows, and `innerWidth`
        // counts the bar: a field drawn to it squeezed the page into a canvas 15px narrower, so the
        // dark it lays under a screen landed up to a bar's width left of the picture, a band down its
        // left edge (Realm's own browser pane draws the bar; so does a Mac with a mouse plugged in).
        width: document.documentElement.clientWidth || window.innerWidth,
        height: window.innerHeight,
        seconds,
        still,
        pointer: [pointer.x, pointer.y, pointer.presence],
        anchors: readAnchors(),
      }
    }

    const stageOnScreen = () => {
      const node = document.querySelector('[data-field-anchor="stage"]')
      if (!node) return true
      const r = node.getBoundingClientRect()
      return r.bottom > 0 && r.top < window.innerHeight
    }

    root.dataset.field = "pending"
    void (async () => {
      try {
        const gpu = await init({ label: "realm-field" })
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
          window.__fieldFrames = (window.__fieldFrames ?? 0) + 1
        }

        // The loop: every display frame while the reader is moving the view, at most every
        // IDLE_FRAME_MS otherwise. A skipped tick touches nothing (no clock step, no resize, no
        // submit), so the canvas keeps the frame it has, and the clock, which is wall time, carries
        // the next one to the same moment the display's own rate would have.
        let loop = 0
        let lastDrawn = -Infinity
        // The next tick is asked for after the frame, as frameLoop did, so a frame that throws (a lost
        // device) ends the loop instead of throwing again on every display frame.
        const tick = (now: number) => {
          if (now - lastInput <= SETTLE_MS || now - lastDrawn >= IDLE_FRAME_MS) {
            lastDrawn = now
            frame(gpu, paint)
          }
          loop = requestAnimationFrame(tick)
        }
        const start = () => {
          if (loop || still || document.visibilityState !== "visible" || !stageOnScreen()) return
          loop = requestAnimationFrame(tick)
        }
        const stop = () => {
          cancelAnimationFrame(loop)
          loop = 0
        }

        let queued = false
        const onMoved = () => {
          onInput()
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
        // A press can throw a doorway open, which bursts faster than the sky's own motion.
        window.addEventListener("pointerdown", onInput, { passive: true })
        document.addEventListener("visibilitychange", onVisibility)
        motionQuery.addEventListener("change", onMotionChange)

        if (still) frame(gpu, paint)
        else start()
        root.dataset.field = "on"

        teardown = () => {
          window.removeEventListener("pointermove", onPointerMove)
          root.removeEventListener("pointerleave", onPointerLeave)
          window.removeEventListener("scroll", onMoved)
          window.removeEventListener("resize", onMoved)
          window.removeEventListener("pointerdown", onInput)
          document.removeEventListener("visibilitychange", onVisibility)
          motionQuery.removeEventListener("change", onMotionChange)
          stop()
          stage.dispose?.()
          gpu.dispose()
        }
      } catch (error) {
        console.warn("The page's live field is unavailable here; showing its fallback.", error)
        if (!disposed) root.dataset.field = "off"
      }
    })()

    return () => {
      disposed = true
      teardown?.()
      delete root.dataset.field
    }
  }, [create])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 block h-full w-full opacity-0 transition-opacity duration-1000 ease-[var(--ease-out-strong)] [html[data-field=on]_&]:opacity-100"
    />
  )
}
