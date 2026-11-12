"use client"

import { useEffect } from "react"

/**
 * Where the pointer is over a button, for the light its face and rim draw there (globals.css, `.btn`):
 * one listener for the whole page, writing `--gx` and `--gy` into the button under the pointer, at most
 * once a frame. A mouse only, and nothing under reduced motion, where the light stays in the middle.
 */
export function PointerLight() {
  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)")
    let target: HTMLElement | null = null
    let x = 0
    let y = 0
    let frame = 0

    const write = () => {
      frame = 0
      if (!target) return
      const r = target.getBoundingClientRect()
      target.style.setProperty("--gx", `${(x - r.left).toFixed(1)}px`)
      target.style.setProperty("--gy", `${(y - r.top).toFixed(1)}px`)
    }
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || still.matches) return
      const button = event.target instanceof Element ? event.target.closest<HTMLElement>(".btn") : null
      if (!button) return
      x = event.clientX
      y = event.clientY
      // Arriving on a button, the light starts where the pointer came in, not where it last left.
      if (button !== target) {
        target = button
        write()
        return
      }
      if (!frame) frame = requestAnimationFrame(write)
    }

    document.addEventListener("pointerover", onMove, { passive: true })
    document.addEventListener("pointermove", onMove, { passive: true })
    return () => {
      document.removeEventListener("pointerover", onMove)
      document.removeEventListener("pointermove", onMove)
      cancelAnimationFrame(frame)
    }
  }, [])
  return null
}
