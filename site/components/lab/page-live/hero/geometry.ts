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
  /** The map's own column, beside the window (plate-local CSS px). */
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
  lines: Record<LineId, Line | null>
  stations: Station[]
  /** Dark mode's sub-agent loops, from the fork through each station to the merge. */
  branches: Record<SubAgent, { route: Route; stationS: number }>
  merge: Pt
  fork: Pt
  /** The collector: one vertical run every space's line crosses on its way to the window. */
  bus: { x: number; top: number; bottom: number }
  /** How far along each space's line the collector crosses it. */
  busS: Record<SpaceId, number>
  /** Where the station area ends and the lines' turns begin. */
  turnsFrom: number
  radius: number
}

/** The corner radius every bend is drawn at. */
export const RADIUS = 12
/** How far apart the nested turns are, and the parallel runs into the window. */
const PITCH = 11
const RING = 11

export function layoutMap({ column, win, termini }: MapInput): MapGeometry {
  const x0 = column.x
  const right = win.x
  // The nested turns: the top line (Needs you) turns furthest from the window, each line under it
  // one pitch nearer, so a line moving up past another's row passes outside it.
  const turnX = (k: number) => right - 22 - PITCH * (LINE_ORDER.length - 1 - k)
  const busX = turnX(0) - 26
  const turnsFrom = busX

  // Rows: Needs you near the top of the window, the four spaces evenly below it.
  const top = win.y + 40
  const first = win.y + win.h * 0.24
  const last = win.y + win.h * 0.8
  const rowOf = (id: LineId) => {
    if (id === "needs") return top
    const i = SPACE_ORDER.indexOf(id)
    return first + ((last - first) * i) / (SPACE_ORDER.length - 1)
  }
  const lineStart = x0 + 98
  const col = [x0 + 140, x0 + 262] as const

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
    lines,
    stations,
    branches,
    merge,
    fork,
    bus: { x: busX, top: rowOf("needs"), bottom: rowOf("school") },
    busS,
    turnsFrom,
    radius: RADIUS,
  }
}

/** A request's way to Needs you: along its own line to the collector, up it, and along Needs you into
 *  the window. Read backwards, it is the way an answer comes back. */
export function requestRoute(g: MapGeometry, from: Pt): Route | null {
  const needs = g.lines.needs
  if (!needs) return null
  const pts: Pt[] = [from, [g.bus.x, from[1]], [g.bus.x, needs.row]]
  if (needs.turn === null) pts.push(needs.end)
  else pts.push([needs.turn, needs.row], [needs.turn, needs.end[1]], needs.end)
  return route(pts, RADIUS)
}

/** The way a session's finished work runs into the window: along its line from the station to the end. */
export function resultRoute(g: MapGeometry, line: SpaceId, fromX: number): { route: Route; from: number } | null {
  const l = g.lines[line]
  if (!l) return null
  return { route: l.route, from: sAtX(l.route, fromX) }
}
