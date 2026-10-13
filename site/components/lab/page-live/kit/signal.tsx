"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { useReducedMotion } from "./hooks"
import { easeInOut } from "./math"
import { pointAt, slice, type Route } from "./route"
import { subscribe } from "./ticker"

/**
 * The page's one kind of mover between places: a signal — work handed over, a request, a report — as
 * a bright head on a line with a short lit stretch behind it, and a breath of light around the head.
 * Blue is work handed over; orange is a request waiting on you; red is something refused.
 */
export type Tone = "accent" | "orange" | "red" | "green"

const HEAD: Record<Tone, string> = {
  accent: "oklch(0.93 0.04 250)",
  orange: "var(--color-orange)",
  red: "var(--color-red)",
  green: "var(--color-green)",
}
const TRAIL: Record<Tone, string> = {
  accent: "var(--color-accent-ink)",
  orange: "var(--color-orange)",
  red: "var(--color-red)",
  green: "var(--color-green)",
}

/** Draw once per instrument, inside its <svg>, before any <Signal>. */
export function SignalDefs({ id }: { id: string }) {
  return (
    <defs>
      {(Object.keys(TRAIL) as Tone[]).map((tone) => (
        <radialGradient key={tone} id={`${id}-${tone}`}>
          <stop offset="0" stopColor={TRAIL[tone]} stopOpacity="0.5" />
          <stop offset="1" stopColor={TRAIL[tone]} stopOpacity="0" />
        </radialGradient>
      ))}
    </defs>
  )
}

/** A signal `s` CSS px along a route, heading the way `dir` says, at `alpha`. */
export function Signal({ defs, route, s, dir = 1, tone = "accent", alpha = 1, tail = 46 }: { defs: string; route: Route; s: number; dir?: 1 | -1; tone?: Tone; alpha?: number; tail?: number }) {
  const head = pointAt(route, s).p
  return (
    <g opacity={alpha}>
      <path d={slice(route, s - dir * tail, s)} stroke={TRAIL[tone]} strokeWidth={1.5} strokeLinecap="round" opacity={0.85} />
      <circle cx={head[0]} cy={head[1]} r={10} fill={`url(#${defs}-${tone})`} />
      <circle cx={head[0]} cy={head[1]} r={2.4} fill={HEAD[tone]} />
    </g>
  )
}

export type Trip<K extends string = string> = { id: number; key: K; start: number; duration: number }

/**
 * Trips in flight for one instrument, and a clock that ticks only while one is: `fire(key, ms)` sends
 * one, `progress(trip)` is how far it has come (0..1, eased). Under reduced motion nothing travels —
 * `fire` reports the trip as already landed and the drawing shows the end state.
 */
export function useTrips<K extends string>() {
  const reduced = useReducedMotion()
  const [trips, setTrips] = useState<Trip<K>[]>([])
  const [now, setNow] = useState(0)
  const next = useRef(1)

  const fire = useCallback(
    (key: K, duration: number, delay = 0) => {
      if (reduced) return
      const start = performance.now() + delay
      setTrips((list) => [...list, { id: next.current++, key, start, duration }])
    },
    [reduced],
  )
  const clear = useCallback(() => setTrips([]), [])

  useEffect(() => {
    if (!trips.length) return
    return subscribe((t) => {
      setNow(t)
      setTrips((list) => {
        const kept = list.filter((trip) => t - trip.start < trip.duration)
        return kept.length === list.length ? list : kept
      })
    })
  }, [trips.length])

  const progress = (trip: Trip<K>) => easeInOut(Math.min(1, Math.max(0, (now - trip.start) / trip.duration)))
  const started = (trip: Trip<K>) => now >= trip.start
  return { trips, fire, clear, progress, started, now }
}
