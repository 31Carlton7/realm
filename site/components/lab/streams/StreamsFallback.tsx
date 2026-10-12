"use client"

import { useEffect, useRef, useState } from "react"

import type { Rect } from "@/components/lab/stage"

import { AGENTS } from "./agents"
import { layoutStreams, pathOf } from "./geometry"

/**
 * The streams as plain vector hairlines, for a browser without WebGPU: the same curves the shader
 * lights, measured from the same elements, drawn once and redrawn when the layout moves. No pulses —
 * a still drawing of where the light would run.
 */
export function StreamsFallback() {
  const ref = useRef<SVGSVGElement>(null)
  const [paths, setPaths] = useState<{ d: string; y0: number; y1: number }[]>([])

  useEffect(() => {
    const svg = ref.current
    const section = svg?.closest("section")
    if (!svg || !section) return
    const measure = () => {
      const s = section.getBoundingClientRect()
      const rect = (name: string): Rect | undefined => {
        const node = section.querySelector<HTMLElement>(`[data-lab-anchor="${name}"]`)
        if (!node) return undefined
        const r = node.getBoundingClientRect()
        return [r.left - s.left, r.top - s.top, r.width, r.height]
      }
      const portal = rect("portal")
      if (!portal) return
      const streams = layoutStreams(
        portal,
        AGENTS.map((a) => rect(`mark-${a.id}`)),
        window.innerWidth,
      )
      setPaths(streams.flatMap((stream) => (stream ? [{ d: pathOf(stream.curve), y0: stream.curve[0][1], y1: stream.curve[3][1] }] : [])))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(section)
    window.addEventListener("resize", measure)
    void document.fonts?.ready.then(measure)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [])

  return (
    <svg
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 hidden h-full w-full overflow-visible [html[data-lab-field=off]_&]:block"
    >
      <defs>
        {/* Each line brightens toward the window it runs into, as the lit version does. */}
        {paths.map(({ y0, y1 }, i) => (
          <linearGradient key={i} id={`streams-line-${i}`} gradientUnits="userSpaceOnUse" x1="0" y1={y0} x2="0" y2={y1}>
            <stop offset="0" stopColor="oklch(0.86 0.05 250)" stopOpacity="0.1" />
            <stop offset="1" stopColor="oklch(0.86 0.05 250)" stopOpacity="0.3" />
          </linearGradient>
        ))}
      </defs>
      {paths.map(({ d }, i) => (
        <path key={i} d={d} fill="none" stroke={`url(#streams-line-${i})`} strokeWidth={1} />
      ))}
    </svg>
  )
}
