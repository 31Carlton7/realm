"use client"

import { useEffect, useRef, useState, type RefObject } from "react"

import { AgentMark, type AgentId } from "@/components/AgentMark"
import { Icon } from "@/components/home/mini/icons"
import { spaces as SPACES } from "@/content/mini-realm"

import { publishLight, type LightPoint, type LightSegment, type RimLight } from "../field/lights"
import { useOnScreen, useReducedMotion } from "../kit/hooks"
import { easeInOut, spring } from "../kit/math"
import { pointAt, sAtX, slice, type Pt, type Route } from "../kit/route"
import { subscribe } from "../kit/ticker"
import { useSample } from "../sample/Sample"
import { SUB_AGENTS, TRAVEL, type SampleState, type SampleStore, type Status, type SubAgent } from "../sample/store"
import { layoutMap, requestRoute, SPACE_ORDER, STATIONS, type Box, type LineId, type MapGeometry, type MapInput, type SpaceId } from "./geometry"

type TripKind = "delegate" | "report" | "final" | "request" | "answer" | "work"
type Trip = { id: number; kind: TripKind; target: string; start: number; duration: number }
type Landing = { id: number; at: Pt; start: number }

/** What moves this frame: pulses with their lit stretch, marks between stations, landings at the window. */
type Movers = {
  pulses: { id: number; head: Pt; tail: string; kind: TripKind; alpha: number; route: Route; s: number; dir: number }[]
  marks: { id: string; at: Pt; agent: AgentId }[]
  landings: { id: number; at: Pt; age: number }[]
  /** Sub-agents whose marks are on their way out and not yet in their rings. */
  away: Set<string>
}

const NO_MOVERS: Movers = { pulses: [], marks: [], landings: [], away: new Set() }
const LINES: LineId[] = ["needs", ...SPACE_ORDER]
const TAIL = 56
const LANDING_MS = 1100

const STATE_STROKE: Record<Status, string> = {
  working: "var(--color-green)",
  waiting: "var(--color-orange)",
  done: "oklch(1 0 0 / 0.32)",
  scheduled: "oklch(1 0 0 / 0.32)",
}
const STATE_WORD: Record<Status, string> = { working: "working", waiting: "waiting on you", done: "done", scheduled: "scheduled" }

const SPACE_OF: Record<string, SpaceId> = Object.fromEntries([...STATIONS.map((s) => [s.id, s.line]), ["luna", "realm"], ["fable", "realm"]])

/**
 * The hero's map of a workspace, drawn like a transit map and wired to the working sample beside it.
 *
 * Every mover is something the sample is doing: a sub-agent's mark travelling out along its branch as
 * the lead starts it, a request running up the collector into Needs you, an answer coming back down,
 * a report merging back into the lead's line, a finished turn running into the window. The pointer
 * reads it like a map: a line under it lights its space here and in the window's sidebar, and a
 * station opens its session in the window.
 *
 * The drawing is SVG and HTML, crisp at any density and complete on its own; the light under it is
 * the hero's WebGPU canvas (../field), fed from here every frame.
 */
export function TransitMap({
  store,
  plateRef,
  windowRef,
}: {
  store: SampleStore
  plateRef: RefObject<HTMLDivElement | null>
  windowRef: RefObject<HTMLDivElement | null>
}) {
  const state = useSample(store)
  const reduced = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const onScreen = useOnScreen(rootRef, "0px")
  const [geometry, setGeometry] = useState<MapGeometry | null>(null)
  const [movers, setMovers] = useState<Movers>(NO_MOVERS)
  const [alpha, setAlpha] = useState<Record<LineId, number>>({ needs: 1, realm: 1, dashboard: 1, site: 1, school: 1 })

  // Everything the frame loop keeps between frames.
  const live = useRef({
    termini: {} as Record<LineId, [number, number]>,
    lastTermini: {} as Record<LineId, number>,
    alpha: { needs: 1, realm: 1, dashboard: 1, site: 1, school: 1 } as Record<LineId, number>,
    trips: [] as Trip[],
    landings: [] as Landing[],
    nextId: 1,
    key: "",
    hadMovers: false,
    prev: store.get(),
  })

  /** The window's rows, read where they are right now. */
  const measure = (): MapInput | null => {
    const plate = plateRef.current
    const win = windowRef.current
    if (!plate || !win) return null
    const p = plate.getBoundingClientRect()
    const w = win.getBoundingClientRect()
    if (!w.width || !p.width) return null
    const box: Box = { x: w.left - p.left, y: w.top - p.top, w: w.width, h: w.height }
    const termini: Record<LineId, number | null> = { needs: null, realm: null, dashboard: null, site: null, school: null }
    // Without room beside the window, the map sits above it and runs into its top edge.
    if (box.x < 300) {
      if (box.y < 180) return null
      const sample = store.get()
      const waits = ["tests", "settings", "luna"].some((id) => sample.status[id] === "waiting")
      for (const id of LINES) termini[id] = id === "needs" && !waits ? null : box.y
      return { mode: "stacked", column: { x: 0, y: 0, w: p.width, h: box.y - 14 }, win: box, termini }
    }
    const sidebar = win.querySelector<HTMLElement>("[data-sample-sidebar]")
    const centre = (node: Element | null) => {
      if (!node) return null
      const r = node.getBoundingClientRect()
      const y = r.top + r.height / 2 - p.top
      // A row scrolled out of the sidebar's view has nowhere on the window's edge to land.
      return y < box.y + 30 || y > box.y + box.h - 30 ? null : y
    }
    if (sidebar && sidebar.getBoundingClientRect().width > 0) {
      termini.needs = centre(win.querySelector("[data-sample-needs]"))
      for (const id of SPACE_ORDER) termini[id] = centre(win.querySelector(`[data-sample-space="${id}"]`))
    } else {
      SPACE_ORDER.forEach((id, i) => (termini[id] = box.y + box.h * (0.24 + (0.54 * i) / 3)))
    }
    return { mode: "side", column: { x: 0, y: box.y, w: box.x, h: box.h }, win: box, termini }
  }

  /** Lays the map out from a measurement, each terminus where its spring is (or exactly, when still). */
  const relayout = (input: MapInput, dt: number | null) => {
    const L = live.current
    const termini = { ...input.termini }
    for (const id of LINES) {
      const target = input.termini[id]
      if (target !== null) L.lastTermini[id] = target
      const shown = target ?? L.lastTermini[id] ?? null
      if (shown === null) continue
      const spr = L.termini[id]
      if (!spr || dt === null) L.termini[id] = [shown, 0]
      else {
        const next = spring(spr, shown, dt, 14)
        L.termini[id] = Math.abs(next[0] - shown) < 0.15 && Math.abs(next[1]) < 1 ? [shown, 0] : next
      }
      termini[id] = L.termini[id]![0]
      const a = target === null ? 0 : 1
      L.alpha[id] = dt === null ? a : Math.abs(L.alpha[id] - a) < 0.01 ? a : L.alpha[id] + (a - L.alpha[id]) * (1 - Math.exp(-dt / 0.18))
    }
    const g = layoutMap({ ...input, termini })
    const key = [input.win.x, input.win.y, input.win.w, input.win.h, ...LINES.map((id) => `${termini[id]}:${L.alpha[id]}`)]
      .map((n) => (typeof n === "number" ? n.toFixed(1) : n))
      .join("|")
    const changed = key !== L.key
    L.key = key
    return { g, changed }
  }

  // Store events become trips: what the map draws in transit while the window changes.
  useEffect(() => {
    const L = live.current
    const add = (kind: TripKind, target: string, duration: number, delay = 0) => {
      if (reduced) return
      L.trips.push({ id: L.nextId++, kind, target, start: performance.now() + delay, duration })
    }
    const off = store.onEvent((event) => {
      if (event.type === "reset") {
        L.trips = []
        L.landings = []
        return
      }
      if (event.type === "delegated") {
        add("delegate", "luna", TRAVEL.delegate)
        add("delegate", "fable", TRAVEL.delegate, 140)
      }
      if (event.type === "request") add("request", event.id, TRAVEL.request)
      if (event.type === "answered") {
        add("answer", event.id, TRAVEL.answer)
        if (event.value !== "Deny" && !(event.id in SUB_AGENTS)) add("work", event.id, 1600 - TRAVEL.answer, TRAVEL.answer)
      }
    })
    const unsub = store.subscribe(() => {
      const next = store.get()
      const prev = L.prev
      L.prev = next
      for (const sub of ["luna", "fable"] as SubAgent[]) {
        if (prev.status[sub] !== "done" && next.status[sub] === "done") add("report", sub, TRAVEL.report)
      }
      if (prev.reports.length < 2 && next.reports.length === 2) add("final", "dark", TRAVEL.final)
    })
    return () => {
      off()
      unsub()
    }
  }, [store, reduced])

  // The frame loop: springs and trips, only while the hero is on screen. React hears about a frame
  // only when something in it moved.
  useEffect(() => {
    const L = live.current
    const first = measure()
    const laid = first ? relayout(first, null).g : null
    setGeometry(laid)
    if (laid) publishLight(lightOf(laid, store.get(), NO_MOVERS))
    if (reduced || !onScreen) return
    return subscribe((now, dt) => {
      const input = measure()
      if (!input) {
        setGeometry(null)
        return
      }
      const { g, changed } = relayout(input, dt)
      if (changed) {
        setGeometry(g)
        setAlpha({ ...L.alpha })
      }
      const m = frameMovers(g, L, now)
      const any = m.pulses.length > 0 || m.marks.length > 0 || m.landings.length > 0 || m.away.size > 0
      if (any || L.hadMovers) setMovers(m)
      L.hadMovers = any
      publishLight(lightOf(g, store.get(), m))
    })
    // measure/relayout read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, onScreen, store])

  // Still: lay out again whenever the window's rows might have moved.
  useEffect(() => {
    if (!reduced) return
    const redo = () => {
      const input = measure()
      if (!input) return setGeometry(null)
      const { g } = relayout(input, null)
      setGeometry(g)
      setAlpha({ ...live.current.alpha })
      publishLight(lightOf(g, store.get(), NO_MOVERS))
    }
    redo()
    const observer = new ResizeObserver(redo)
    if (plateRef.current) observer.observe(plateRef.current)
    const scroller = windowRef.current?.querySelector("[data-sample-scroll]")
    scroller?.addEventListener("scroll", redo, { passive: true })
    const unsub = store.subscribe(() => requestAnimationFrame(redo))
    return () => {
      observer.disconnect()
      scroller?.removeEventListener("scroll", redo)
      unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, store])

  // A hover changes what the light draws even when nothing moves.
  useEffect(() => {
    if (geometry) publishLight(lightOf(geometry, state, movers))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.hover.space, state.hover.session, state.selected])

  if (!geometry) return <div ref={rootRef} aria-hidden className="pointer-events-none absolute inset-0" />

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 select-none">
      <MapDrawing geometry={geometry} state={state} movers={movers} alpha={alpha} store={store} reduced={reduced} />
    </div>
  )
}

/** Where every trip is this frame. Finished trips are dropped; arrivals at the window leave a landing. */
function frameMovers(g: MapGeometry, L: { trips: Trip[]; landings: Landing[]; nextId: number }, now: number): Movers {
  const pulses: Movers["pulses"] = []
  const marks: Movers["marks"] = []
  const away = new Set<string>()
  const keep: Trip[] = []
  for (const trip of L.trips) {
    const t = (now - trip.start) / trip.duration
    if (t < 0) {
      if (trip.kind === "delegate") away.add(trip.target)
      keep.push(trip)
      continue
    }
    const path = tripPath(g, trip)
    if (!path) continue
    if (t >= 1) {
      if (trip.kind === "request" || trip.kind === "work" || trip.kind === "final") {
        L.landings.push({ id: L.nextId++, at: pointAt(path.route, path.to).p, start: now })
      }
      continue
    }
    keep.push(trip)
    const k = easeInOut(t)
    const at = path.from + (path.to - path.from) * k
    const head = pointAt(path.route, at).p
    if (trip.kind === "delegate") {
      away.add(trip.target)
      marks.push({ id: `${trip.target}-${trip.id}`, at: head, agent: SUB_AGENTS[trip.target as SubAgent].agent })
      continue
    }
    const dir = Math.sign(path.to - path.from) || 1
    const tail = slice(path.route, at - dir * TAIL, at)
    // A pulse gathers as it leaves and fades as it goes in, so it is never cut off at either end.
    const alpha = Math.min(1, t / 0.12, (1 - t) / 0.08)
    pulses.push({ id: trip.id, head, tail, kind: trip.kind, alpha, route: path.route, s: at, dir })
  }
  L.trips = keep
  L.landings = L.landings.filter((l) => now - l.start < LANDING_MS)
  return { pulses, marks, landings: L.landings.map((l) => ({ id: l.id, at: l.at, age: (now - l.start) / LANDING_MS })), away }
}

/** The route a trip travels and its ends along it, from the geometry as it is now. */
function tripPath(g: MapGeometry, trip: Trip): { route: Route; from: number; to: number } | null {
  const station = g.stations.find((st) => st.id === trip.target)
  switch (trip.kind) {
    case "delegate": {
      const b = g.branches[trip.target as SubAgent]
      return { route: b.route, from: 0, to: b.stationS }
    }
    case "report": {
      const b = g.branches[trip.target as SubAgent]
      return { route: b.route, from: b.stationS, to: b.route.length }
    }
    case "final": {
      const line = g.lines.realm
      if (!line) return null
      return { route: line.route, from: sAtX(line.route, g.merge[0]), to: line.route.length }
    }
    case "work": {
      const line = station ? g.lines[station.line] : null
      if (!line || !station) return null
      return { route: line.route, from: sAtX(line.route, station.at[0] + 12), to: line.route.length }
    }
    case "request":
    case "answer": {
      // A sub-agent's request leaves along its branch: from its station to the merge, then the line.
      if (!station) return null
      const from: Pt = station.sub ? g.merge : [station.at[0] + 12, station.at[1]]
      const r = requestRoute(g, from, station.line)
      if (!r) return null
      return trip.kind === "request" ? { route: r, from: 0, to: r.length } : { route: r, from: r.length, to: 0 }
    }
  }
}

/* ── Light ───────────────────────────────────────────────────────────────────────────────────── */

/** A stretch of route as straight pieces the light can draw: runs as they are, arcs as three chords. */
function pieces(r: Route, s0 = 0, s1 = r.length): [Pt, Pt][] {
  const out: [Pt, Pt][] = []
  let walked = 0
  for (const seg of r.segments) {
    const a = walked
    const b = walked + seg.len
    walked = b
    if (b <= s0 || a >= s1) continue
    const from = Math.max(a, s0)
    const to = Math.min(b, s1)
    const steps = seg.kind === "arc" ? 3 : 1
    for (let i = 0; i < steps; i++) {
      const u = from + ((to - from) * i) / steps
      const v = from + ((to - from) * (i + 1)) / steps
      out.push([pointAt(r, u).p, pointAt(r, v).p])
    }
  }
  return out
}

/** What the light should draw for the map as it is this frame. */
function lightOf(g: MapGeometry, s: SampleState, m: Movers) {
  const segments: LightSegment[] = []
  const points: LightPoint[] = []
  const rim: RimLight[] = []

  // A hovered line is lit along its whole length, the branches of its space with it.
  const hot = s.hover.space as SpaceId | null
  if (hot && g.lines[hot]) {
    const routes = [g.lines[hot]!.route, ...(hot === "realm" ? [g.branches.luna.route, g.branches.fable.route] : [])]
    for (const r of routes) for (const [a, b] of pieces(r)) segments.push({ a, b, ia: 0.26, ib: 0.26, width: 2.2 })
  }

  // Pulses: a tail brightening to its head, and the head itself.
  for (const p of m.pulses) {
    const parts = pieces(p.route, Math.min(p.s, p.s - p.dir * TAIL), Math.max(p.s, p.s - p.dir * TAIL))
    parts.forEach(([a, b], i) => {
      const n = parts.length
      // Ordered from the tail's far end to the head, whichever way the pulse runs.
      const k0 = p.dir > 0 ? i / n : 1 - i / n
      const k1 = p.dir > 0 ? (i + 1) / n : 1 - (i + 1) / n
      segments.push({ a, b, ia: k0 * k0 * 0.7 * p.alpha, ib: k1 * k1 * 0.7 * p.alpha, width: 1.7 })
    })
    points.push({ at: p.head, reach: 6.5, i: 0.85 * p.alpha })
  }
  for (const mk of m.marks) points.push({ at: mk.at, reach: 9, i: 0.35 })

  // Where the lines meet the window, its rim holds a little light; a landing flares there and runs.
  const along = (p: Pt) => (g.mode === "side" ? p[1] : p[0])
  for (const id of LINES) {
    const line = g.lines[id]
    if (line) rim.push({ y: along(line.end), i: id === hot ? 0.6 : 0.26, spread: id === hot ? 30 : 18 })
  }
  for (const l of m.landings) {
    rim.push({ y: along(l.at), i: 1.3 * (1 - l.age) ** 1.5, spread: 10 + l.age * 70 })
    points.push({ at: l.at, reach: 5 + l.age * 10, i: 0.9 * (1 - l.age) ** 2 })
  }

  // The session open in the window: a soft light on its station, where the reader is.
  const here = g.stations.find((st) => st.id === s.selected)
  if (here) points.push({ at: here.at, reach: 16, i: 0.08 })

  return { segments, points, rim, win: g.win, edge: g.mode === "side" ? ("left" as const) : ("top" as const) }
}

/* ── Drawing ─────────────────────────────────────────────────────────────────────────────────── */

const LINE_BASE = "oklch(1 0 0 / 0.3)"
const LINE_LIT = "oklch(1 0 0 / 0.82)"
const LINE_DIM = "oklch(1 0 0 / 0.14)"
const ORANGE_LINE = "oklch(0.746 0.156 55.642 / 0.62)"

function MapDrawing({
  geometry: g,
  state,
  movers,
  alpha,
  store,
  reduced,
}: {
  geometry: MapGeometry
  state: SampleState
  movers: Movers
  alpha: Record<LineId, number>
  store: SampleStore
  reduced: boolean
}) {
  const hot = state.hover.space
  const tone = (id: LineId) => (hot === null ? LINE_BASE : hot === id ? LINE_LIT : LINE_DIM)
  const waiting = (id: string) => state.status[id] === "waiting"
  const waitingSpaces = SPACE_ORDER.filter((sp) => STATIONS.some((st) => st.line === sp && waiting(st.id)) || (sp === "realm" && waiting("luna")))
  const lowest = waitingSpaces.length ? Math.max(...waitingSpaces.map((sp) => g.lines[sp]?.row ?? 0)) : null
  const needs = g.lines.needs

  return (
    <>
      <svg aria-hidden className="absolute inset-0 h-full w-full overflow-visible" fill="none">
        <defs>
          <radialGradient id="live-pulse-glow">
            <stop offset="0" stopColor="oklch(0.788 0.113 248.33)" stopOpacity="0.5" />
            <stop offset="1" stopColor="oklch(0.788 0.113 248.33)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Needs you, and the collector feeding it: drawn only while something waits on you. */}
        {needs && alpha.needs > 0.01 ? (
          <g opacity={alpha.needs}>
            <path d={needs.route.d} stroke={waitingSpaces.length ? ORANGE_LINE : tone("needs")} strokeWidth={1} />
            <TerminalBar at={needs.start} />
            {lowest !== null && g.mode === "side" ? (
              <Bus x={g.bus.x} top={needs.row} bottom={lowest} crossings={SPACE_ORDER.filter((sp) => !waitingSpaces.includes(sp)).map((sp) => g.lines[sp]?.row ?? -1)} />
            ) : null}
            {g.mode === "side"
              ? waitingSpaces.map((sp) => {
                  const row = g.lines[sp]?.row
                  return row === undefined ? null : <circle key={sp} cx={g.bus.x} cy={row} r={2.75} fill="var(--color-orange)" />
                })
              : null}
          </g>
        ) : null}

        {/* The space lines. */}
        {SPACE_ORDER.map((id) => {
          const line = g.lines[id]
          if (!line) return null
          return (
            <g key={id} opacity={alpha[id]}>
              <path d={line.route.d} stroke={tone(id)} strokeWidth={1} className="transition-[stroke] duration-200" />
              <TerminalBar at={line.start} />
              {/* A request's way, from a waiting station to the collector. */}
              {g.stations
                .filter((st) => !st.sub && st.line === id && waiting(st.id))
                .map((st) => (
                  <path key={st.id} d={slice(line.route, sAtX(line.route, st.at[0]), g.busS[id])} stroke={ORANGE_LINE} strokeWidth={1} />
                ))}
              {id === "realm" && waiting("luna") ? (
                <>
                  <path d={slice(g.branches.luna.route, g.branches.luna.stationS, g.branches.luna.route.length)} stroke={ORANGE_LINE} strokeWidth={1} />
                  <path d={slice(line.route, sAtX(line.route, g.merge[0]), g.busS.realm)} stroke={ORANGE_LINE} strokeWidth={1} />
                </>
              ) : null}
            </g>
          )
        })}

        {/* Dark mode's sub-agents: the loop out and back. */}
        {(["luna", "fable"] as SubAgent[]).map((sub) => (
          <path key={sub} d={g.branches[sub].route.d} stroke={tone("realm")} strokeWidth={1} className="transition-[stroke] duration-200" />
        ))}
        <circle cx={g.merge[0]} cy={g.merge[1]} r={3.25} fill="var(--color-page)" stroke={state.reports.length === 2 ? "var(--color-accent)" : tone("realm")} strokeWidth={1} />

        {/* Hit areas: hovering anywhere along a line lights its space. */}
        {SPACE_ORDER.map((id) => {
          const line = g.lines[id]
          if (!line) return null
          return (
            <path
              key={id}
              d={id === "realm" ? `${line.route.d}${g.branches.luna.route.d}${g.branches.fable.route.d}` : line.route.d}
              stroke="transparent"
              strokeWidth={18}
              className="pointer-events-[stroke]"
              onPointerEnter={() => store.hover(id)}
              onPointerLeave={() => store.hover(null)}
            />
          )
        })}

        {/* Stations: a ring in the colour of the session's state, the agent's mark inside it. */}
        {g.stations.map((st) => {
          const status = state.status[st.id] as Status
          return (
            <g key={st.id}>
              {state.selected === st.id ? <circle cx={st.at[0]} cy={st.at[1]} r={15.5} stroke="var(--color-accent)" strokeWidth={1} /> : null}
              <circle cx={st.at[0]} cy={st.at[1]} r={11} fill="var(--color-page)" stroke={STATE_STROKE[status]} strokeWidth={1} />
              {status === "working" && !reduced ? (
                // A working agent's ring turns, slowly, for as long as it works: the one loop on the map.
                <circle
                  cx={st.at[0]}
                  cy={st.at[1]}
                  r={11}
                  stroke="var(--color-green)"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeDasharray={`${(Math.PI * 22) / 5} ${Math.PI * 22}`}
                  className="live-spin"
                />
              ) : null}
              {st.id === "weekly" ? <WeekDial at={st.at} /> : null}
            </g>
          )
        })}

        {/* What is in transit. */}
        {movers.pulses.map((p) => (
          <g key={p.id} opacity={p.alpha}>
            <path d={p.tail} stroke="var(--color-accent-ink)" strokeWidth={1.5} strokeLinecap="round" opacity={0.9} />
            <circle cx={p.head[0]} cy={p.head[1]} r={9} fill="url(#live-pulse-glow)" />
            <circle cx={p.head[0]} cy={p.head[1]} r={2.3} fill="oklch(0.95 0.03 250)" />
          </g>
        ))}
        {movers.landings.map((l) => (
          <circle key={l.id} cx={l.at[0]} cy={l.at[1]} r={3 + l.age * 9} stroke="var(--color-accent-ink)" strokeWidth={1} opacity={(1 - l.age) * 0.8} />
        ))}
      </svg>

      {/* Words and controls, as HTML over the drawing: the names, the marks, and a button per station. */}
      {LINES.map((id) => {
        const line = g.lines[id]
        if (!line) return null
        const space = SPACES.find((s) => s.id === id)
        const count = id === "needs" ? (["tests", "settings", "luna"] as const).filter(waiting).length : 0
        return (
          <div
            key={id}
            style={g.mode === "side" ? { left: line.start[0] - 12, top: line.row, opacity: alpha[id] } : { left: line.start[0], top: line.row + 9, opacity: alpha[id] }}
            onPointerEnter={() => id !== "needs" && store.hover(id)}
            onPointerLeave={() => store.hover(null)}
            className={`pointer-events-auto absolute flex items-center gap-1.5 font-[520] whitespace-nowrap transition-colors duration-200 ${g.mode === "side" ? "-translate-x-full -translate-y-1/2 text-[13px]" : "text-[12.5px]"} ${hot === id ? "text-ink" : "text-ink-2"}`}
          >
            {space ? (
              <span style={{ color: space.color }}>
                <Icon name={space.icon} className="h-3.5 w-3.5" />
              </span>
            ) : (
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-orange" />
            )}
            {space ? space.name : "Needs you"}
            {count ? <span className="font-mono text-[11.5px] font-[450] text-ink-3">{count}</span> : null}
          </div>
        )
      })}

      {g.stations.map((st) => {
        const status = state.status[st.id] as Status
        const space = SPACE_OF[st.id]!
        const lit = hot === space || state.hover.session === st.id
        const below = st.side === 1
        const away = movers.away.has(st.id)
        const open = () => {
          store.select(st.sub ? "dark" : st.id)
          if (status === "waiting") store.expand(st.id)
        }
        return (
          <div key={st.id}>
            {/* On a phone the sub-agents go unnamed: their marks say who they are, and the room is the stations'. */}
            {st.sub && g.mode === "stacked" ? null : (
              <span
                aria-hidden
                style={{ left: st.at[0], top: st.at[1] + (below ? 19 : -19) }}
                className={`absolute -translate-x-1/2 text-[12px] leading-none whitespace-nowrap transition-colors duration-200 ${below ? "" : "-translate-y-full"} ${lit ? "text-ink" : "text-ink-2"}`}
              >
                {st.label}
              </span>
            )}
            <button
              type="button"
              onClick={open}
              onPointerEnter={() => store.hover(space, st.id)}
              onPointerLeave={() => store.hover(null)}
              onFocus={() => store.hover(space, st.id)}
              onBlur={() => store.hover(null)}
              aria-label={`${st.label}, in ${SPACES.find((s) => s.id === space)!.name}: ${STATE_WORD[status]}. Open it in the sample.`}
              style={{ left: st.at[0], top: st.at[1] }}
              className={`pointer-events-auto absolute grid size-[26px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full transition-colors duration-200 focus-visible:outline-offset-1 ${lit ? "text-ink" : "text-ink-2"}`}
            >
              <span className={`transition-opacity duration-300 ${away ? "opacity-0" : "opacity-100"}`}>
                <AgentMark id={st.agent} className="size-3" />
              </span>
            </button>
          </div>
        )
      })}

      {movers.marks.map((m) => (
        <span
          key={m.id}
          aria-hidden
          style={{ transform: `translate(${m.at[0]}px, ${m.at[1]}px) translate(-50%, -50%)` }}
          className="absolute top-0 left-0 grid size-[22px] place-items-center rounded-full bg-page text-ink shadow-[0_0_0_1px_oklch(0.788_0.113_248.33/0.75)]"
        >
          <AgentMark id={m.agent} className="size-3" />
        </span>
      ))}
    </>
  )
}

/** Where a line starts: a short bar across it, as a transit map ends a line. */
function TerminalBar({ at }: { at: Pt }) {
  return <path d={`M${at[0]} ${at[1] - 4.5}V${at[1] + 4.5}`} stroke="oklch(1 0 0 / 0.45)" strokeWidth={1.25} />
}

/** The collector, broken where a line it does not take from passes over it. */
function Bus({ x, top, bottom, crossings }: { x: number; top: number; bottom: number; crossings: number[] }) {
  const gaps = crossings.filter((y) => y > top && y < bottom).sort((a, b) => a - b)
  const parts: [number, number][] = []
  let from = top
  for (const y of gaps) {
    parts.push([from, y - 5])
    from = y + 5
  }
  parts.push([from, bottom])
  return (
    <>
      {parts.map(([a, b]) => (
        <path key={a} d={`M${x} ${a}V${b}`} stroke={ORANGE_LINE} strokeWidth={1} />
      ))}
    </>
  )
}

/**
 * A scheduled session's dial: seven ticks for the days of the week, the run's mark at Monday 9:00,
 * and where this week is now, read from the reader's own clock.
 */
function WeekDial({ at }: { at: Pt }) {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    const read = () => {
      const d = new Date()
      const day = (d.getDay() + 6) % 7
      setNow((day * 24 + d.getHours() + d.getMinutes() / 60) / 168)
    }
    read()
    const t = window.setInterval(read, 60_000)
    return () => window.clearInterval(t)
  }, [])
  const polar = (f: number, r: number): Pt => [at[0] + Math.sin(f * Math.PI * 2) * r, at[1] - Math.cos(f * Math.PI * 2) * r]
  const run = 9 / 168
  const a = polar(run, 13)
  const b = polar(run, 18)
  return (
    <g>
      {Array.from({ length: 7 }, (_, i) => {
        const p = polar(i / 7, 13.5)
        const q = polar(i / 7, 16)
        return <path key={i} d={`M${p[0]} ${p[1]}L${q[0]} ${q[1]}`} stroke="oklch(1 0 0 / 0.32)" strokeWidth={1} />
      })}
      <path d={`M${a[0]} ${a[1]}L${b[0]} ${b[1]}`} stroke="var(--color-accent-ink)" strokeWidth={1.25} />
      {now !== null ? <circle cx={polar(now, 14.75)[0]} cy={polar(now, 14.75)[1]} r={1.6} fill="var(--color-ink)" /> : null}
    </g>
  )
}
