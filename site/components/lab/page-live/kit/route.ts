/**
 * Routes in the map's line language: straight runs joined by arcs, the way a transit diagram draws a
 * line — horizontal and vertical runs, 45° diagonals, and every bend a circular arc of one radius.
 *
 * A route is built from its corner points and keeps its own arc-length table, so anything that
 * travels it (an agent's mark, a pulse) is placed by distance rather than by a parameter that bunches
 * up in the bends, and the SVG path and the light behind it are drawn from the same segments.
 */
export type Pt = readonly [number, number]

type Line = { kind: "line"; a: Pt; b: Pt; len: number }
type Arc = { kind: "arc"; c: Pt; r: number; a0: number; turn: number; len: number }
export type Segment = Line | Arc

export type Route = {
  segments: Segment[]
  length: number
  /** The SVG path. */
  d: string
}

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]]
const add = (a: Pt, b: Pt, k = 1): Pt => [a[0] + b[0] * k, a[1] + b[1] * k]
const len = (a: Pt) => Math.hypot(a[0], a[1])
const unit = (a: Pt): Pt => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l]
}
const f = (n: number) => (Math.round(n * 100) / 100).toString()

/**
 * A route through `points`, with every interior corner rounded to `radius` (less where the runs on
 * either side are too short to hold it). Consecutive duplicate points are dropped.
 */
export function route(input: readonly Pt[], radius = 14): Route {
  const points = input.filter((p, i) => i === 0 || len(sub(p, input[i - 1]!)) > 0.01)
  const segments: Segment[] = []
  if (points.length < 2) return { segments, length: 0, d: points.length ? `M${f(points[0]![0])} ${f(points[0]![1])}` : "" }

  // How far back from each corner its arc starts, limited so two arcs never overlap on one run.
  const cuts = points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return { t: 0, r: 0 }
    const u = unit(sub(p, points[i - 1]!))
    const v = unit(sub(points[i + 1]!, p))
    const cos = Math.min(1, Math.max(-1, u[0] * v[0] + u[1] * v[1]))
    const theta = Math.acos(cos)
    if (theta < 1e-3) return { t: 0, r: 0 }
    const room = Math.min(len(sub(p, points[i - 1]!)), len(sub(points[i + 1]!, p))) / 2
    const t = Math.min(radius * Math.tan(theta / 2), room)
    return { t, r: t / Math.tan(theta / 2) }
  })

  let cursor = points[0]!
  let d = `M${f(cursor[0])} ${f(cursor[1])}`
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!
    const u = unit(sub(p, points[i - 1]!))
    const cut = cuts[i]!
    const end = add(p, u, -cut.t)
    const runLength = len(sub(end, cursor))
    if (runLength > 0.01) {
      segments.push({ kind: "line", a: cursor, b: end, len: runLength })
      d += `L${f(end[0])} ${f(end[1])}`
    }
    cursor = end
    if (cut.t > 0 && i < points.length - 1) {
      const v = unit(sub(points[i + 1]!, p))
      const out = add(p, v, cut.t)
      // The centre sits off the incoming run toward the side the route turns to.
      const cross = u[0] * v[1] - u[1] * v[0]
      const normal: Pt = cross > 0 ? [-u[1], u[0]] : [u[1], -u[0]]
      const c = add(cursor, normal, cut.r)
      const a0 = Math.atan2(cursor[1] - c[1], cursor[0] - c[0])
      const a1 = Math.atan2(out[1] - c[1], out[0] - c[0])
      let turn = a1 - a0
      if (cross > 0 && turn < 0) turn += Math.PI * 2
      if (cross < 0 && turn > 0) turn -= Math.PI * 2
      const arcLength = Math.abs(turn) * cut.r
      segments.push({ kind: "arc", c, r: cut.r, a0, turn, len: arcLength })
      d += `A${f(cut.r)} ${f(cut.r)} 0 0 ${cross > 0 ? 1 : 0} ${f(out[0])} ${f(out[1])}`
      cursor = out
    }
  }
  const length = segments.reduce((sum, s) => sum + s.len, 0)
  return { segments, length, d }
}

/** The point `s` CSS px along a route (clamped to its ends), and the direction it runs there. */
export function pointAt(r: Route, s: number): { p: Pt; dir: Pt } {
  if (!r.segments.length) return { p: [0, 0], dir: [1, 0] }
  let left = Math.min(Math.max(s, 0), r.length)
  for (const seg of r.segments) {
    if (left <= seg.len || seg === r.segments[r.segments.length - 1]) {
      const k = seg.len ? Math.min(1, left / seg.len) : 0
      if (seg.kind === "line") return { p: add(seg.a, sub(seg.b, seg.a), k), dir: unit(sub(seg.b, seg.a)) }
      const a = seg.a0 + seg.turn * k
      const sign = Math.sign(seg.turn)
      return { p: [seg.c[0] + Math.cos(a) * seg.r, seg.c[1] + Math.sin(a) * seg.r], dir: [-Math.sin(a) * sign, Math.cos(a) * sign] }
    }
    left -= seg.len
  }
  const lastSeg = r.segments[r.segments.length - 1]!
  return { p: lastSeg.kind === "line" ? lastSeg.b : [0, 0], dir: [1, 0] }
}

/** How far along a route the point nearest `q` is, and how far `q` is from it. Sampled every 4px. */
export function nearestOn(r: Route, q: Pt): { s: number; distance: number } {
  let best = Infinity
  let at = 0
  const step = 4
  for (let s = 0; s <= r.length; s += step) {
    const { p } = pointAt(r, s)
    const dd = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2
    if (dd < best) {
      best = dd
      at = s
    }
  }
  return { s: at, distance: Math.sqrt(best) }
}

/** The SVG path of part of a route, from `s0` to `s1` CSS px along it: a lit stretch of a line. */
export function slice(r: Route, s0: number, s1: number): string {
  const a = Math.max(0, Math.min(s0, s1))
  const b = Math.min(r.length, Math.max(s0, s1))
  if (b - a < 0.5) return ""
  let d = ""
  let walked = 0
  for (const seg of r.segments) {
    const start = walked
    const end = walked + seg.len
    walked = end
    if (end <= a || start >= b) continue
    const k0 = Math.max(0, (a - start) / seg.len)
    const k1 = Math.min(1, (b - start) / seg.len)
    if (seg.kind === "line") {
      const p0 = add(seg.a, sub(seg.b, seg.a), k0)
      const p1 = add(seg.a, sub(seg.b, seg.a), k1)
      d += `${d ? "L" : "M"}${f(p0[0])} ${f(p0[1])}L${f(p1[0])} ${f(p1[1])}`
    } else {
      const a0 = seg.a0 + seg.turn * k0
      const a1 = seg.a0 + seg.turn * k1
      const p0: Pt = [seg.c[0] + Math.cos(a0) * seg.r, seg.c[1] + Math.sin(a0) * seg.r]
      const p1: Pt = [seg.c[0] + Math.cos(a1) * seg.r, seg.c[1] + Math.sin(a1) * seg.r]
      d += `${d ? "L" : "M"}${f(p0[0])} ${f(p0[1])}A${f(seg.r)} ${f(seg.r)} 0 0 ${seg.turn > 0 ? 1 : 0} ${f(p1[0])} ${f(p1[1])}`
    }
  }
  return d
}

/** The arc length along `r` at which it first reaches x (for routes that run left to right). */
export function sAtX(r: Route, x: number): number {
  let best = 0
  let bestDx = Infinity
  for (let s = 0; s <= r.length; s += 2) {
    const dx = Math.abs(pointAt(r, s).p[0] - x)
    if (dx < bestDx) {
      bestDx = dx
      best = s
    }
  }
  return best
}
