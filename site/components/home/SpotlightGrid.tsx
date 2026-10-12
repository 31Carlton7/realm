"use client"

import { useEffect, useRef, type ReactNode } from "react"

/**
 * A grid whose cards' rims brighten toward the pointer, the light crossing from one card into its
 * neighbours as it moves — Clerk's spotlight, in Realm's blue.
 *
 * One listener on the grid writes each card's own pointer position (`--mx`, `--my`, in that card's
 * pixels) and CSS draws the rest (`.spot` in globals.css). It answers a mouse only: a touch has no
 * position between taps, so on a phone the cards keep their resting rim. The light is the pointer's,
 * not a loop, so reduced motion leaves it alone and only drops its fade.
 */
export function SpotlightGrid({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const grid = ref.current
    if (!grid || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return
    let frame = 0
    let x = 0
    let y = 0
    const paint = () => {
      frame = 0
      for (const card of grid.querySelectorAll<HTMLElement>("[data-spot]")) {
        const r = card.getBoundingClientRect()
        card.style.setProperty("--mx", `${x - r.left}px`)
        card.style.setProperty("--my", `${y - r.top}px`)
      }
    }
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return
      x = event.clientX
      y = event.clientY
      grid.dataset.lit = ""
      if (!frame) frame = requestAnimationFrame(paint)
    }
    const onLeave = () => {
      delete grid.dataset.lit
    }
    grid.addEventListener("pointermove", onMove, { passive: true })
    grid.addEventListener("pointerleave", onLeave)
    return () => {
      cancelAnimationFrame(frame)
      grid.removeEventListener("pointermove", onMove)
      grid.removeEventListener("pointerleave", onLeave)
    }
  }, [])

  return (
    <div ref={ref} className={`spot-grid ${className ?? ""}`}>
      {children}
    </div>
  )
}
