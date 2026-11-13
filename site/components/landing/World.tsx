"use client"

import { useEffect, useRef } from "react"

import widths from "@/content/world-widths.json"

import { print } from "./print"
import s from "./landing.module.css"

const encodes: Record<string, number[]> = widths

/** The picture's WebP encodes (scripts/encode-worlds.mjs), for the browser to pick from by `sizes`. */
function srcSet(file: string) {
  const sizes = encodes[file]
  if (!sizes) throw new Error(`no encodes of "${file}" in content/world-widths.json`)
  const stem = file.replace(/\.[^.]+$/, "")
  return sizes.map((w) => `/worlds/${stem}-${w}.webp ${w}w`).join(", ")
}

/**
 * One of the app's own pictures, printed through its dither (print.ts) to fill the box it is given.
 * It is drawn once, and again only when the box changes size. Until it is printed, and without
 * script, the picture itself shows. `x` and `y` say where its subject sits, kept in the box. `sizes`
 * is the box's width, so the browser fetches an encode at the size it is drawn, and the print reads the
 * same file; without it, the full picture is used, as the share card is.
 */
export function World({
  file,
  x = 0.5,
  y = 0.5,
  sizes,
  className,
}: {
  file: string
  x?: number
  y?: number
  sizes?: string
  className?: string
}) {
  const picture = useRef<HTMLImageElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const focus: [number, number] = [x, y]
    const el = canvas.current
    const img = picture.current
    if (!el || !img) return
    let size = ""
    let alive = true
    const draw = () => {
      const box = el.getBoundingClientRect()
      const next = `${Math.round(box.width)}x${Math.round(box.height)}`
      if (next === size || box.width === 0) return
      size = next
      void img
        .decode()
        .then(() => print(el, img.currentSrc, focus))
        .then(() => {
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
    <div className={className} aria-hidden>
      <img
        ref={picture}
        src={`/worlds/${file}`}
        srcSet={sizes ? srcSet(file) : undefined}
        sizes={sizes}
        alt=""
        className={s.worldPicture}
        style={{ objectPosition: `${x * 100}% ${y * 100}%` }}
      />
      <canvas ref={canvas} className={s.worldPrint} />
    </div>
  )
}
