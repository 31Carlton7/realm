"use client"

import { useEffect, useRef, useState } from "react"

import { useReducedMotion } from "./hooks"

type Stop = { y: number; x: number }

/**
 * The page's own line: a hairline down the left gutter from the first chapter to the last, a station
 * at each chapter's heading, lit down to the reading line (the middle of the viewport), the way a
 * line diagram over a train door lights the stations already passed. It is how one chapter hands on
 * to the next, and it ends at the download, where the closing lines run in.
 *
 * Drawn only where the gutter has room for it (a wide screen); headings mark themselves with
 * `data-station`. Under reduced motion it is drawn whole and lit to where the reader is, with no
 * transition.
 */
export function Spine() {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const [stops, setStops] = useState<Stop[]>([])
  const [reach, setReach] = useState(0)

  useEffect(() => {
    const root = ref.current?.parentElement
    if (!root) return
    let frame = 0
    const measure = () => {
      frame = 0
      const box = root.getBoundingClientRect()
      const next: Stop[] = []
      for (const node of root.querySelectorAll<HTMLElement>("[data-station]")) {
        const r = node.getBoundingClientRect()
        // The heading's first line: its cap height sits about a third of the way down the line box.
        const style = getComputedStyle(node)
        const line = parseFloat(style.lineHeight) || r.height
        next.push({ y: r.top - box.top + line * 0.52, x: r.left - box.left })
      }
      setStops(next)
      setReach(window.innerHeight * 0.5 - box.top)
    }
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    const observer = new ResizeObserver(queue)
    observer.observe(root)
    window.addEventListener("scroll", queue, { passive: true })
    window.addEventListener("resize", queue)
    void document.fonts?.ready.then(queue)
    return () => {
      observer.disconnect()
      window.removeEventListener("scroll", queue)
      window.removeEventListener("resize", queue)
      cancelAnimationFrame(frame)
    }
  }, [])

  const first = stops[0]
  const last = stops[stops.length - 1]
  // The gutter: the line sits midway between the page's edge and the column, when there is room.
  const x = first ? Math.min(...stops.map((s) => s.x)) - 26 : 0

  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 hidden xl:block">
      {first && last && x > 14 ? (
        <svg className="absolute inset-0 h-full w-full overflow-visible" fill="none">
          <path d={`M${x} ${first.y - 40}V${last.y}`} stroke="oklch(1 0 0 / 0.07)" />
          <path
            d={`M${x} ${first.y - 40}V${Math.max(first.y - 40, Math.min(last.y, reach))}`}
            stroke="oklch(1 0 0 / 0.26)"
            className={reduced ? "" : "transition-[d] duration-150"}
          />
          <path d={`M${x - 4.5} ${first.y - 40}H${x + 4.5}`} stroke="oklch(1 0 0 / 0.4)" strokeWidth={1.25} />
          {stops.map((s, i) => {
            const passed = reach >= s.y
            return (
              <circle
                key={i}
                cx={x}
                cy={s.y}
                r={4.5}
                fill="var(--color-page)"
                stroke={passed ? "var(--color-accent-ink)" : "oklch(1 0 0 / 0.22)"}
                className={reduced ? "" : "transition-[stroke] duration-300"}
              />
            )
          })}
        </svg>
      ) : null}
    </div>
  )
}
