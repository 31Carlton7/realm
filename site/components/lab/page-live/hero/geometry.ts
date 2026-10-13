/**
 * The hero map, laid out: four spaces as four lines, their sessions as stations, Dark mode's two
 * sub-agents as a loop that branches off its line and merges back, and Needs you as a line of its own
 * fed by a collector that every space's line crosses.
 *
 * Every line ends where the window shows the same thing: a space's line at that space's row in the
 * sample's sidebar, Needs you at its caption. Those rows move — Needs you grows when a request lands
 * and shrinks when one is answered — so the termini are measured from the window and every line
 * turns to meet its own, the turns nested the way parallel lines turn together on a transit map, the
 * lower line outside the upper, so no two cross however far the rows move.
 */
import type { AgentId } from "@/components/AgentMark"

import { route, sAtX, type Pt, type Route } from "../kit/route"
import type { SubAgent } from "../sample/store"

export type SpaceId = "realm" | "dashboard" | "site" | "school"
export type LineId = SpaceId | "needs"

export const SPACE_ORDER: SpaceId[] = ["realm", "dashboard", "site", "school"]
const LINE_ORDER: LineId[] = ["needs", ...SPACE_ORDER]

export type StationSpec = { id: string; line: SpaceId; label: string; agent: AgentId; col: 0 | 1; sub?: SubAgent }

/** The sample's sessions as the map names them: shortened, the way a map shortens a station. */
export const STATIONS: StationSpec[] = [
  { id: "dark", line: "realm", label: "Dark mode", agent: "claude", col: 0 },
  { id: "crash", line: "dashboard", label: "Org access crash", agent: "claude", col: 0 },
  { id: "tests", line: "dashboard", label: "Invite tests", agent: "openai", col: 1 },
  { id: "settings", line: "site", label: "Settings look", agent: "claude", col: 0 },
  { id: "weekly", line: "site", label: "Weekly numbers", agent: "claude", col: 1 },
  { id: "flash", line: "school", label: "Chapter 4 cards", agent: "claude", col: 0 },
]

export const SUB_STATIONS: { id: SubAgent; label: string; agent: AgentId; side: -1 | 1 }[] = [
  { id: "luna", label: "GPT-6 Luna", agent: "openai", side: -1 },
  { id: "fable", label: "Fable 5.1", agent: "claude", side: 1 },
]

export type Box = { x: number; y: number; w: number; h: number }

export type MapInput = {
  /**
   * Beside the window (a wide screen: the lines run in from the left and land on its sidebar's rows)
   * or above it (a phone: the lines run across and turn down together into its top edge).
   */
  mode: "side" | "stacked"
  /** The map's own area (plate-local CSS px). */
  column: Box
  /** The sample window's frame. */
  win: Box
  /** Where each line meets the window, as a y; null where the window shows no such row. */
  termini: Record<LineId, number | null>
}

/** A line: its route, the row its stations sit on, and the x where it turns toward its terminus (null
 *  when the terminus is level with the row and it runs straight in). */
export type Line = { id: LineId; route: Route; row: number; start: Pt; end: Pt; turn: number | null }
export type Station = { id: string; line: SpaceId; at: Pt; label: string; agent: AgentId; sub?: SubAgent; side?: -1 | 1 }

export type MapGeometry = {
  mode: "side" | "stacked"
  /** The window's frame the lines run into. */
  win: Box
  lines: Record<LineId, Line | null>
  stations: Station[]
  /** Dark mode's sub-agent loops, from the fork through each station to the merge. */
  branches: Record<SubAgent, { route: Route; stationS: number }>
  merge: Pt
  /** The collector: one vertical run every space's line crosses on its way to the window. */
  bus: { x: number; top: number; bottom: number }
  /** How far along each space's line the collector crosses it. */
  busS: Record<SpaceId, number>
}

/** The corner radius every bend is drawn at. */
export const RADIUS = 12
/** How far apart the nested turns are, and the parallel runs into the window. */
const PITCH = 11
const RING = 11

export function layoutMap(input: MapInput): MapGeometry {
  if (input.mode === "stacked") return layoutStacked(input)
  const { column, win, termini } = input
  const x0 = column.x
  const right = win.x
  // The nested turns: the top line (Needs you) turns furthest from the window, each line under it
  // one pitch nearer, so a line moving up past another's row passes outside it.
  const turnX = (k: number) => right - 22 - PITCH * (LINE_ORDER.length - 1 - k)
  const busX = turnX(0) - 26

  // Rows: Needs you near the top of the window, the four spaces evenly below it.
  const top = win.y + 36
  const first = win.y + win.h * 0.24
  const last = win.y + win.h * 0.745
  const rowOf = (id: LineId) => {
    if (id === "needs") return top
    const i = SPACE_ORDER.indexOf(id)
    return first + ((last - first) * i) / (SPACE_ORDER.length - 1)
  }
  const lineStart = x0 + 110
  const col = [x0 + 152, x0 + 272] as const

  const lines = {} as Record<LineId, Line | null>
  LINE_ORDER.forEach((id, k) => {
    const row = rowOf(id)
    const term = termini[id]
    if (term === null) {
      lines[id] = null
      return
    }
    const straight = Math.abs(term - row) < 0.75
    const tx = turnX(k)
    const pts: Pt[] = straight ? [[lineStart, row], [right, row]] : [[lineStart, row], [tx, row], [tx, term], [right, term]]
    lines[id] = { id, route: route(pts, RADIUS), row, start: [lineStart, row], end: [right, term], turn: straight ? null : tx }
  })

  const stations: Station[] = STATIONS.map((s) => ({ id: s.id, line: s.line, at: [col[s.col], rowOf(s.line)] as Pt, label: s.label, agent: s.agent }))

  // Dark mode's loop: out of its station at 45°, along a track either side of the line, back in.
  const realmRow = rowOf("realm")
  const fork: Pt = [col[0] + RING + 6, realmRow]
  const offset = 30
  const outAt = fork[0] + offset
  const merge: Pt = [Math.min(col[0] + 196, busX - 34), realmRow]
  const inAt = merge[0] - offset
  const subX = (outAt + inAt) / 2
  const branches = {} as MapGeometry["branches"]
  for (const sub of SUB_STATIONS) {
    const y = realmRow + sub.side * offset
    const r = route(
      [fork, [outAt, y], [inAt, y], merge],
      RADIUS,
    )
    branches[sub.id] = { route: r, stationS: sAtX(r, subX) }
    stations.push({ id: sub.id, line: "realm", at: [subX, y], label: sub.label, agent: sub.agent, sub: sub.id, side: sub.side })
  }

  // The collector spans from the Needs you row down to the lowest space's row (the map draws the
  // part of it that carries something).
  const busS = {} as Record<SpaceId, number>
  for (const id of SPACE_ORDER) {
    const line = lines[id]
    busS[id] = line ? sAtX(line.route, busX) : 0
  }

  return {
    mode: "side",
    win,
    lines,
    stations,
    branches,
    merge,
    bus: { x: busX, top: rowOf("needs"), bottom: rowOf("school") },
    busS,
  }
}

/**
 * The phone's map: the same lines and stations across the top of the plate, every line turning down
 * at the right into the window's top edge. The turns nest — the top line outermost — so a line
 * descending past the rows under it never crosses one. There is no collector: Needs you is a line of
 * its own, and a request runs along its session's own line into the window.
 */
function layoutStacked({ column, win, termini }: MapInput): MapGeometry {
  const x0 = column.x + 4
  const w = column.w - 8
  const turnX = (k: number) => x0 + w - 10 - PITCH * k
  const rows = [column.y + 22, ...SPACE_ORDER.map((_, i) => column.y + 104 + ((column.h - 104 - 34) * i) / (SPACE_ORDER.length - 1))]
  const rowOf = (id: LineId) => rows[LINE_ORDER.indexOf(id)]!
  const lineStart = x0
  const col = [x0 + w * 0.42, x0 + w * 0.7] as const
  const bottom = win.y

  const lines = {} as Record<LineId, Line | null>
  LINE_ORDER.forEach((id, k) => {
    const row = rowOf(id)
    if (termini[id] === null) {
      lines[id] = null
      return
    }
    const tx = turnX(k)
    lines[id] = { id, route: route([[lineStart, row], [tx, row], [tx, bottom]], RADIUS), row, start: [lineStart, row], end: [tx, bottom], turn: tx }
  })

  const stations: Station[] = STATIONS.map((s) => ({ id: s.id, line: s.line, at: [col[s.col], rowOf(s.line)] as Pt, label: s.label, agent: s.agent }))
  const realmRow = rowOf("realm")
  const fork: Pt = [col[0] + RING + 3, realmRow]
  const offset = 19
  const outAt = fork[0] + offset
  const merge: Pt = [Math.min(col[0] + w * 0.34, turnX(1) - 30), realmRow]
  const inAt = merge[0] - offset
  const subX = (outAt + inAt) / 2
  const branches = {} as MapGeometry["branches"]
  for (const sub of SUB_STATIONS) {
    const y = realmRow + sub.side * offset
    const r = route([fork, [outAt, y], [inAt, y], merge], RADIUS)
    branches[sub.id] = { route: r, stationS: sAtX(r, subX) }
    stations.push({ id: sub.id, line: "realm", at: [subX, y], label: sub.label, agent: sub.agent, sub: sub.id, side: sub.side })
  }
  const busS = {} as Record<SpaceId, number>
  for (const id of SPACE_ORDER) busS[id] = lines[id]?.route.length ?? 0

  return {
    mode: "stacked",
    win,
    lines,
    stations,
    branches,
    merge,
    bus: { x: -100, top: 0, bottom: 0 },
    busS,
  }
}

/** A request's way to Needs you: along its own line to the collector, up it, and along Needs you into
 *  the window. Read backwards, it is the way an answer comes back. On a phone there is no collector,
 *  and the request runs along its own line into the window. */
export function requestRoute(g: MapGeometry, from: Pt, line: SpaceId): Route | null {
  if (g.mode === "stacked") {
    const own = g.lines[line]
    if (!own || own.turn === null) return null
    return route([from, [own.turn, from[1]], own.end], RADIUS)
  }
  const needs = g.lines.needs
  if (!needs) return null
  const pts: Pt[] = [from, [g.bus.x, from[1]], [g.bus.x, needs.row]]
  if (needs.turn === null) pts.push(needs.end)
  else pts.push([needs.turn, needs.row], [needs.turn, needs.end[1]], needs.end)
  return route(pts, RADIUS)
}
