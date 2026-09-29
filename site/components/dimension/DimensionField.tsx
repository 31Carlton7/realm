"use client"

import { useEffect, useRef } from "react"

import { createDimensionField, type FieldReading } from "@/lib/dimension/engine"

type Rect = [number, number, number, number]

const rectOf = (selector: string): Rect | null => {
  const node = document.querySelector(selector)
  if (!node) return null
  const r = node.getBoundingClientRect()
  return [r.left, r.top, r.width, r.height]
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** Hermite easing on 0..1 — the shader's smoothstep, so a presence ramps in the way its light does. */
const ease = (value: number) => value * value * (3 - 2 * value)

/** The shader's window array is fixed at four; the unused slots are empty rects it never reads. */
const padded = (rects: Rect[]): Rect[] => [...rects, ...Array<Rect>(4 - rects.length).fill([0, 0, 0, 0])]

/**
 * The field behind the whole landing page, fixed to the viewport.
 *
 * The page's sections are regions of it rather than owners of their own canvases: one device and one
 * frame loop however long the page gets. Sections say where they are with `data-dim-stage`, and the
 * elements the light belongs to with `data-dim` — this reads both every frame.
 *
 * The rules a canvas cannot get from CSS are re-implemented here, because a frame loop answers to
 * none of the stylesheet's own (design.md, Motion): reduced motion is a held frame that redraws only
 * when the page moves, a hidden tab stops the loop outright, and a browser without WebGPU gets the
 * plain page with a CSS glow on the portal — `data-dim-field` on <html> says which.
 */
export function DimensionField() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const root = document.documentElement
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    const controller = new AbortController()
    let disposed = false
    let teardown: (() => void) | undefined

    // The pointer eases rather than snaps, so the lens drifts after it instead of twitching.
    const pointer = { x: 0, y: 0, tx: 0, ty: 0, presence: 0, target: 0, last: performance.now() }
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
    // A click anywhere that is not itself a control sends a shockwave through the field. Controls
    // keep their own feedback; a ring from behind a button would be two answers to one press.
    const ripple = { x: 0, y: 0, at: -Infinity }
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest("a, button, input, textarea, select, summary, [role=button]")) return
      ripple.x = event.clientX
      ripple.y = event.clientY
      ripple.at = performance.now()
    }

    const read = (): FieldReading => {
      const width = window.innerWidth
      const height = window.innerHeight
      const now = performance.now()
      const k = 1 - Math.exp(-(now - pointer.last) / 90)
      pointer.last = now
      pointer.x += (pointer.tx - pointer.x) * k
      pointer.y += (pointer.ty - pointer.y) * k
      pointer.presence += (pointer.target - pointer.presence) * k * 0.6

      const hero = rectOf('[data-dim-stage="hero"]')
      const heroPortal = rectOf('[data-dim="portal"]') ?? [0, 0, 0, 0]
      const closing = rectOf('[data-dim="portal-close"]')
      // One corridor, and it belongs to whichever portal is on screen: the hero's at the top of the
      // page, the closing card's at the bottom. They are never on screen together.
      const closingShown = closing !== null && closing[1] < height && closing[1] + closing[3] > 0
      const portal = closingShown ? closing : heroPortal
      // 0 while the hero fills the view, 1 once it has scrolled entirely past the top. The closing
      // portal is always a little way in, so its frames are already moving when it arrives.
      const entering = closingShown ? 0.25 : hero ? clamp01(-hero[1] / Math.max(hero[3], 1)) : 1
      // The corridor leaves with its portal: whole while the portal is well inside the view, gone
      // once it has passed an edge. The hero's leaves by the top, the closing card's arrives from below.
      const presence = closingShown
        ? clamp01((height - closing[1]) / (height * 0.45))
        : clamp01((heroPortal[1] + heroPortal[3] + height * 0.05) / (height * 0.4))
      // The footer: presence as it arrives from below, and the rise, which completes as the page
      // reaches its end. The mark is sized from the room above the horizon — at full rise its top sits
      // 26.8 mark units above it — so it can never reach up into the words over the scene.
      const footerStage = rectOf('[data-dim-stage="footer"]')
      const footerAt = rectOf('[data-dim="horizon"]') ?? [0, 0, 0, 0]
      const footerPresence = footerStage ? clamp01((height - footerStage[1]) / (height * 0.5)) : 0
      const rise = footerStage ? clamp01((height - footerStage[1]) / Math.max(footerStage[3], 1)) : 0
      const horizon = width < 640 ? 0.5 : 0.44
      const footerUnit = Math.min((footerAt[2] * (width < 640 ? 0.42 : 0.3)) / 40, (footerAt[3] * horizon * 0.9) / 26.8)

      // The capture frames on or near the screen, in page order — rarely more than two at once, and
      // never more than the four the shader holds.
      const windowRects = [...document.querySelectorAll('[data-dim="window"]')]
        .map((node) => node.getBoundingClientRect())
        .filter((r) => r.bottom > -120 && r.top < height + 120)
        .slice(0, 4)
        .map((r): Rect => [r.left, r.top, r.width, r.height])

      // The six faces: progress through the pinned track, and presence that rises as the track's
      // viewport arrives and falls as it leaves, so the corridor and the lattice cross-fade.
      const track = rectOf('[data-dim-stage="faces"]')
      const facesAt = rectOf('[data-dim="faces"]') ?? [0, 0, 0, 0]
      const run = track ? Math.max(track[3] - height, 1) : 1
      const progress = track ? clamp01(-track[1] / run) : 0
      const arriving = track ? clamp01((height - track[1]) / (height * 0.7)) : 0
      const leaving = track ? clamp01((track[1] + track[3]) / (height * 0.7)) : 0
      const facesPresence = Math.min(arriving, leaving)
      // The mark is 48 units tall and fills 62% of the shorter side of its area.
      const unit = (Math.min(facesAt[2], facesAt[3]) * 0.62) / 48

      return {
        width,
        height,
        pointer: [pointer.x, pointer.y, pointer.presence, 0],
        portal,
        // The closing corridor gives way as the realm rises beneath it: one finale at a time.
        hero: [ease(presence) * (1 - ease(footerPresence)), entering, 0, 0],
        ripple: [ripple.x, ripple.y, Number.isFinite(ripple.at) ? (now - ripple.at) / 1000 : -1, 0],
        faces: [ease(facesPresence), progress, unit, 0],
        facesAt,
        windows: padded(windowRects),
        counts: [windowRects.length, 0, 0, 0],
        footer: [ease(footerPresence), rise, footerUnit, horizon],
        footerAt,
      }
    }

    root.dataset.dimField = "pending"
    void (async () => {
      try {
        const field = await createDimensionField(canvas, {
          read,
          reduceMotion: motionQuery.matches,
          signal: controller.signal,
        })
        if (disposed) {
          field.dispose()
          return
        }

        // Under reduced motion nothing loops, so the page's own movement is what redraws it.
        let queued = false
        const repaint = () => {
          if (!motionQuery.matches || queued) return
          queued = true
          requestAnimationFrame(() => {
            queued = false
            field.paintOnce()
          })
        }
        const onVisibility = () => {
          if (document.visibilityState === "visible") field.start()
          else field.stop()
        }
        const onMotionChange = () => field.setReducedMotion(motionQuery.matches)

        window.addEventListener("pointermove", onPointerMove, { passive: true })
        window.addEventListener("pointerdown", onPointerDown, { passive: true })
        document.documentElement.addEventListener("pointerleave", onPointerLeave)
        window.addEventListener("scroll", repaint, { passive: true })
        window.addEventListener("resize", repaint)
        document.addEventListener("visibilitychange", onVisibility)
        motionQuery.addEventListener("change", onMotionChange)

        if (motionQuery.matches) field.paintOnce()
        else field.start()
        root.dataset.dimField = "on"

        teardown = () => {
          window.removeEventListener("pointermove", onPointerMove)
          window.removeEventListener("pointerdown", onPointerDown)
          document.documentElement.removeEventListener("pointerleave", onPointerLeave)
          window.removeEventListener("scroll", repaint)
          window.removeEventListener("resize", repaint)
          document.removeEventListener("visibilitychange", onVisibility)
          motionQuery.removeEventListener("change", onMotionChange)
          field.dispose()
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        console.warn("Realm's dimension field is unavailable here; showing the page without it.", error)
        if (!disposed) root.dataset.dimField = "off"
      }
    })()

    return () => {
      disposed = true
      controller.abort()
      teardown?.()
      delete root.dataset.dimField
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 block h-full w-full opacity-0 transition-opacity duration-1000 ease-[var(--ease-out-strong)] [html[data-dim-field=on]_&]:opacity-100"
    />
  )
}
