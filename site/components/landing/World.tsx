"use client"

import { useEffect, useRef } from "react"

import { print } from "./print"
import s from "./landing.module.css"

/**
 * One of the app's own pictures, printed through its dither (print.ts) to fill the box it is given.
 * It is drawn once, and again only when the box changes size. Until it is printed, and without
 * script, the picture itself shows. `x` and `y` say where its subject sits, kept in the box.
 */
export function World({ file, x = 0.5, y = 0.5, className }: { file: string; x?: number; y?: number; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const focus: [number, number] = [x, y]
    const el = canvas.current
    if (!el) return
    let size = ""
    let alive = true
    const draw = () => {
      const box = el.getBoundingClientRect()
      const next = `${Math.round(box.width)}x${Math.round(box.height)}`
      if (next === size || box.width === 0) return
      size = next
      void print(el, `/worlds/${file}`, focus).then(() => {
        if (alive) el.dataset.printed = "1"
      })
    }
    const observer = new ResizeObserver(draw)
    observer.observe(el)
    return () => {
      alive = false
      observer.disconnect()
    }
  }, [file, x, y])
  return (
    <div className={`${s.world} ${className ?? ""}`} style={{ backgroundImage: `url(/worlds/${file})` }} aria-hidden>
      <canvas ref={canvas} className={s.worldPrint} />
    </div>
  )
}
