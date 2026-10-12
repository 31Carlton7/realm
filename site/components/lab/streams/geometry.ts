import type { Rect } from "@/components/lab/stage"

import { AGENTS, type StreamAgent } from "./agents"

export type Point = readonly [number, number]
export type Curve = readonly [Point, Point, Point, Point]

/** The product window's corner — the `rounded-[20px]` on the frame the rim traces. */
export const PORTAL_RADIUS = 20

/** Below Tailwind's `xl` the marks leave their arcs for one row above the window. */
export const ROW_BELOW = 1280

export type StreamLayout = {
  curve: Curve
  /** Where the stream meets the window, as CSS px along its rim from the top edge's left end, clockwise. */
  landU: number
  /** The mark's centre and the radius of its socket. */
  mark: readonly [number, number, number]
  /** Which way along the rim the window's middle is from the landing: +1 clockwise, -1 back. */
  inward: 1 | -1
}

const add = (a: Point, b: Point, k = 1): Point => [a[0] + b[0] * k, a[1] + b[1] * k]
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]]
const len = (a: Point) => Math.hypot(a[0], a[1])

/** The rim's length — the same walk `rimU` takes in the shader: four edges and four quarter turns. */
export function rimLength(portal: Rect, r = PORTAL_RADIUS) {
  const [, , w, h] = portal
  return 2 * (w - 2 * r) + 2 * (h - 2 * r) + 4 * (Math.PI / 2) * r
}

/** How far each stream turns from its chord at either end: one bend, the same for all, so the fan reads as a family. */
const BEND = (13 * Math.PI) / 180

/**
 * Lays every stream out from where its mark and the window are right now. Each is a single bend —
 * a cubic whose ends turn the same angle either side of its chord, so it has no inflection — that
 * leaves its socket's ring and lands on the window's top edge leaning in toward the window's middle.
 * On a wide screen the landings of each side cluster at one shoulder of the window, so a side's
 * streams converge on it; in the row they fall nearly straight, gathered in a little.
 */
export function layoutStreams(portal: Rect, marks: readonly (Rect | undefined)[], width: number): (StreamLayout | null)[] {
  const [left, top, w] = portal
  const row = width < ROW_BELOW
  const centre = left + w / 2
  return AGENTS.map((agent: StreamAgent, i) => {
    const rect = marks[i]
    if (!rect || rect[2] <= 0 || w <= 0) return null
    const r = rect[2] / 2
    const c: Point = [rect[0] + r, rect[1] + rect[3] / 2]
    const land: Point = row
      ? [centre + (c[0] - centre) * 0.74, top]
      : [agent.side === "left" ? left + agent.land * w : left + w - agent.land * w, top]
    // Angles from straight down, turning toward the side the landing is on.
    const toward = land[0] >= c[0] ? 1 : -1
    const dir = (angle: number): Point => [toward * Math.sin(angle), Math.cos(angle)]
    const chord = Math.atan2(Math.abs(land[0] - c[0]), Math.max(land[1] - c[1], 1))
    const bend = row ? BEND * 0.6 : BEND
    const leave = dir(chord + bend)
    const arrive = dir(Math.max(chord - bend, 0))
    const p0 = add(c, leave, r + 0.5)
    const span = len(sub(land, p0))
    const p1 = add(p0, leave, span * 0.35)
    const p2 = add(land, arrive, -span * 0.35)
    return {
      curve: [p0, p1, p2, land],
      landU: land[0] - (left + PORTAL_RADIUS),
      mark: [c[0], c[1], r],
      inward: land[0] < centre ? 1 : -1,
    }
  })
}

export function pointAt([a, b, c, d]: Curve, t: number): Point {
  const s = 1 - t
  const k0 = s * s * s
  const k1 = 3 * s * s * t
  const k2 = 3 * s * t * t
  const k3 = t * t * t
  return [k0 * a[0] + k1 * b[0] + k2 * c[0] + k3 * d[0], k0 * a[1] + k1 * b[1] + k2 * c[1] + k3 * d[1]]
}

/** The point of a curve nearest `p`, its distance and its parameter, from 32 samples — plenty for a pointer. */
export function nearestPoint(curve: Curve, p: Point) {
  let prev = curve[0]
  let best = Infinity
  let at: Point = prev
  let t = 0
  for (let k = 1; k <= 32; k++) {
    const cur = pointAt(curve, k / 32)
    const ex = cur[0] - prev[0]
    const ey = cur[1] - prev[1]
    const ee = ex * ex + ey * ey || 1e-6
    const h = Math.min(1, Math.max(0, ((p[0] - prev[0]) * ex + (p[1] - prev[1]) * ey) / ee))
    const qx = prev[0] + ex * h
    const qy = prev[1] + ey * h
    const dd = (p[0] - qx) ** 2 + (p[1] - qy) ** 2
    if (dd < best) {
      best = dd
      at = [qx, qy]
      t = (k - 1 + h) / 32
    }
    prev = cur
  }
  return { distance: Math.sqrt(best), at, t }
}

export const pathOf = ([a, b, c, d]: Curve) =>
  `M${a[0].toFixed(1)} ${a[1].toFixed(1)}C${b[0].toFixed(1)} ${b[1].toFixed(1)} ${c[0].toFixed(1)} ${c[1].toFixed(1)} ${d[0].toFixed(1)} ${d[1].toFixed(1)}`

/** The share of a curve's length at t = 1/4, 1/2 and 3/4, and the whole length — the shader's arc table. */
export function arcTable(curve: Curve): [number, number, number, number] {
  const marks: number[] = []
  let prev = curve[0]
  let length = 0
  for (let k = 1; k <= 32; k++) {
    const cur = pointAt(curve, k / 32)
    length += Math.hypot(cur[0] - prev[0], cur[1] - prev[1])
    if (k % 8 === 0) marks.push(length)
    prev = cur
  }
  const total = length || 1
  return [marks[0]! / total, marks[1]! / total, marks[2]! / total, length]
}
