/**
 * The flight's camera, as plain arithmetic: where it is, which way it faces, its lens, and where its
 * optical axis meets the page. Nothing here touches the DOM or the GPU, so the shader, the screens
 * positioned from it and the Realmites standing at their doors all read one camera.
 *
 * The camera never rolls. Chapter views are level, like an architect's camera on a tripod, and look
 * down by shifting the lens rather than tilting it, so every realm's vertical edges stay vertical and
 * a screen standing on the ground stays a rectangle.
 */

export type Vec3 = [number, number, number]

export type View = {
  eye: Vec3
  /** Radians from +x, anticlockwise seen from above. */
  yaw: number
  /** Radians; negative looks down. */
  pitch: number
  /** Focal length in CSS px. */
  focal: number
  /** Where the optical axis meets the page, in viewport CSS px. */
  px: number
  py: number
}

export type Basis = { fwd: Vec3; right: Vec3; up: Vec3 }

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const smooth = (t: number) => {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}
/** Smootherstep: zero velocity and acceleration at both ends, so a move leaves rest and arrives at it. */
export const smoother = (t: number) => {
  const x = clamp(t, 0, 1)
  return x * x * x * (x * (x * 6 - 15) + 10)
}
export const ramp = (lo: number, hi: number, t: number) => smooth((t - lo) / (hi - lo))

export function basis(view: View): Basis {
  const cy = Math.cos(view.yaw)
  const sy = Math.sin(view.yaw)
  const cp = Math.cos(view.pitch)
  const sp = Math.sin(view.pitch)
  return {
    fwd: [cp * cy, cp * sy, sp],
    right: [sy, -cy, 0],
    up: [-cy * sp, -sy * sp, cp],
  }
}

/** Where a point of the world lands on the page (CSS px), and its depth along the axis. */
export function project(view: View, b: Basis, p: Vec3): [number, number, number] {
  const d = sub(p, view.eye)
  const z = dot(d, b.fwd)
  const k = view.focal / Math.max(z, 1e-4)
  return [view.px + dot(d, b.right) * k, view.py - dot(d, b.up) * k, z]
}

/** The direction through a point of the page. */
export function rayThrough(view: View, b: Basis, x: number, y: number): Vec3 {
  const r = add(add(b.fwd, scale(b.right, (x - view.px) / view.focal)), scale(b.up, -(y - view.py) / view.focal))
  return scale(r, 1 / Math.hypot(...r))
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/**
 * Between two views: the eye eases out of one and into the other on smootherstep, and rises on an
 * arc as it goes, so the camera lifts off the realm it leaves and settles onto the next rather than
 * sliding along the ground. Turning takes the short way round.
 */
export function blend(a: View, b: View, u: number, lift: number): View {
  const s = smoother(u)
  const eye: Vec3 = [lerp(a.eye[0], b.eye[0], s), lerp(a.eye[1], b.eye[1], s), lerp(a.eye[2], b.eye[2], s) + lift * Math.sin(Math.PI * s)]
  return {
    eye,
    yaw: a.yaw + wrap(b.yaw - a.yaw) * s,
    pitch: lerp(a.pitch, b.pitch, s),
    focal: Math.exp(lerp(Math.log(a.focal), Math.log(b.focal), s)),
    px: lerp(a.px, b.px, s),
    py: lerp(a.py, b.py, s),
  }
}

/** A view turned about the vertical line through `pivot`: a point under the axis stays where it is
 *  on the page while everything around it turns. */
export function orbit(view: View, pivot: Vec3, angle: number): View {
  if (angle === 0) return view
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const dx = view.eye[0] - pivot[0]
  const dy = view.eye[1] - pivot[1]
  return { ...view, eye: [pivot[0] + dx * c - dy * s, pivot[1] + dx * s + dy * c, view.eye[2]], yaw: view.yaw + angle }
}

/**
 * One stop of the flight, composed for the scroll position `y`: the view, how much of the scroll on
 * either side holds it while the reader reads, the slow turn about `pivot` across that hold, and how
 * high the camera rises leaving for the next.
 */
export type Key = {
  id: string
  kind: "open" | "chapter" | "teams" | "calm" | "finale" | "end"
  y: number
  view: View
  /** Fractions of the gap to the previous and next key spent holding this view. */
  hold: [number, number]
  /** Radians turned across the whole hold. */
  turn: number
  pivot: Vec3
  lift: number
}

/** The view at one key, `w` running -1..1 across its hold. */
const held = (key: Key, w: number) => orbit(key.view, key.pivot, (key.turn * clamp(w, -1, 1)) / 2)

export type Place = {
  view: View
  /** The key behind the reader and the one ahead, and how far through the move between them (0..1). */
  from: number
  to: number
  u: number
  /** Where the reader is relative to each key: (scroll - key.y) / gap, signed. */
  local: (index: number) => number
}

/** The camera for a scroll position: held at a key while the reader is in its stretch of page,
 *  carried between keys on the eased arc otherwise. */
export function place(keys: Key[], y: number): Place {
  const n = keys.length
  const local = (index: number) => {
    const key = keys[index]!
    const next = keys[index + 1]
    const prev = keys[index - 1]
    const after = next ? next.y - key.y : 1
    const before = prev ? key.y - prev.y : 1
    return y >= key.y ? (y - key.y) / Math.max(after, 1) : (y - key.y) / Math.max(before, 1)
  }
  if (n === 1 || y <= keys[0]!.y) {
    const key = keys[0]!
    const gap = n > 1 ? keys[1]!.y - key.y : 1
    return { view: held(key, (y - key.y) / Math.max(gap * Math.max(key.hold[1], 1e-3), 1)), from: 0, to: 0, u: 0, local }
  }
  if (y >= keys[n - 1]!.y) {
    const key = keys[n - 1]!
    const gap = key.y - keys[n - 2]!.y
    const w = (y - key.y) / Math.max(gap * Math.max(key.hold[0], 1e-3), 1)
    return { view: held(key, w), from: n - 1, to: n - 1, u: 0, local }
  }
  let k = 0
  while (k < n - 2 && y >= keys[k + 1]!.y) k++
  const a = keys[k]!
  const b = keys[k + 1]!
  const gap = Math.max(b.y - a.y, 1)
  const t = (y - a.y) / gap
  const out = a.hold[1]
  const into = b.hold[0]
  if (t <= out) return { view: held(a, t / Math.max(out, 1e-3)), from: k, to: k, u: 0, local }
  if (t >= 1 - into) return { view: held(b, -(1 - t) / Math.max(into, 1e-3)), from: k + 1, to: k + 1, u: 0, local }
  const u = (t - out) / Math.max(1 - out - into, 1e-3)
  return { view: blend(held(a, 1), held(b, -1), u, a.lift), from: k, to: k + 1, u, local }
}

/**
 * The camera's mass: it follows the scroll's view through a critically damped spring, so a wheel's
 * steps arrive as one glide and a stop settles instead of snapping. Its resting point is always the
 * scroll's own view; nothing moves once the reader stops but the last of the settle.
 */
export class Follow {
  private x: number[] | null = null
  private v: number[] = []
  constructor(private readonly omega = 11) {}

  reset() {
    this.x = null
  }

  step(target: View, dt: number): View {
    const t = [...target.eye, target.yaw, target.pitch, Math.log(target.focal), target.px, target.py]
    if (!this.x || dt <= 0 || dt > 0.25) {
      this.x = t
      this.v = t.map(() => 0)
    } else {
      // Yaw follows the short way round.
      t[3] = this.x[3]! + wrap(t[3]! - this.x[3]!)
      const w = this.omega
      const e = Math.exp(-w * dt)
      for (let i = 0; i < t.length; i++) {
        const offset = this.x[i]! - t[i]!
        const temp = (this.v[i]! + w * offset) * dt
        this.v[i] = (this.v[i]! - w * temp) * e
        this.x[i] = t[i]! + (offset + temp) * e
      }
    }
    const x = this.x
    return { eye: [x[0]!, x[1]!, x[2]!], yaw: x[3]!, pitch: x[4]!, focal: Math.exp(x[5]!), px: x[6]!, py: x[7]! }
  }

  /** Still moving, by more than a hair? */
  get settling() {
    return this.v.some((v) => Math.abs(v) > 1e-3)
  }
}
