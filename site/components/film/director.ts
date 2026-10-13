import type { Rect } from "@/components/field/stage"
import { HOLE, type HoleDirection, type ScriptedDrop } from "@/components/realms/blackhole"
import { basis, clamp, Follow, lerp, project, smooth, smoother, type View, type Vec3 } from "@/components/realms/camera"
import type { ScreenImage } from "@/components/realms/Screen"
import { presented, type DirectedRealm, type DirectedScreen, type Direction, type Director } from "@/components/realms/stage"
import { bob, type Pose } from "@/components/realms/world"
import { partImage, sceneImage } from "@/lib/pictures"

/**
 * Realm's launch film, as a function of time: twenty seconds through the landing page's own world, with
 * the camera, the realms it visits, the pictures that come out of their doorways, the words, and the
 * black hole all keyed to the film's clock rather than to a reader's scroll.
 *
 *   0.0  deep space, a slow push up the route; one doorway ahead brightens
 *   2.3  the wordmark, then the line under it
 *   5.2  that doorway is thrown open and Realm's window comes out of it; the camera eases in
 *   7.6  three stops, each a realm whose picture comes out of its doorway, with the site's own line
 *  14.0  the camera rises and turns to the black hole; a realm drops in and comes back out
 *  17.2  the sky dips to black under the end card while its clock runs down; still from 18.5
 *
 * Nothing here touches the DOM or the GPU: the stage draws `at(t)` (directedRealms), and the film's page
 * lays its pictures and words out from `overlay(t)`. Both are pure, so any frame can be drawn alone.
 */

export const FILM = { width: 1920, height: 1080, duration: 20 } as const

const W = FILM.width
const H = FILM.height
const FOCAL = 1500
const DEG = Math.PI / 180
/** The shutter the near stars streak through: a sixtieth, whatever rate the film is drawn at. */
const SHUTTER = 1 / 60
/** The camera's track is worked out at this rate, then read between samples. */
const TRACK_RATE = 240
/** The camera's mass: the critically damped spring the landing page's camera follows the scroll with. */
const MASS = 7

// ---- arithmetic -----------------------------------------------------------------------------------

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const normalize = (a: Vec3): Vec3 => mul(a, 1 / (length(a) || 1))

/** 0..1 across [a, b], eased in and out. */
const span = (t: number, a: number, b: number) => smoother((t - a) / (b - a))

/** The site's spring (globals.css `--ease-spring`): a critically damped settle from rest. */
const spring = (x: number) => {
  const u = clamp(x, 0, 1) * 7.4
  return (1 - (1 + u) * Math.exp(-u)) / (1 - 8.4 * Math.exp(-7.4))
}

/** A direction from a heading and an elevation, in degrees. */
const toward = (yaw: number, pitch: number): Vec3 => [Math.cos(pitch * DEG) * Math.cos(yaw * DEG), Math.cos(pitch * DEG) * Math.sin(yaw * DEG), Math.sin(pitch * DEG)]

/** Where a point of the page is in the world at `depth` along a view's axis. */
function onPage(view: View, x: number, y: number, depth: number): Vec3 {
  const b = basis(view)
  const ray = add(add(b.fwd, mul(b.right, (x - view.px) / view.focal)), mul(b.up, -(y - view.py) / view.focal))
  return add(view.eye, mul(ray, depth))
}

const level = (eye: Vec3, yaw: number, pitch = 0): View => ({ eye, yaw: yaw * DEG, pitch: pitch * DEG, focal: FOCAL, px: W / 2, py: H / 2 })

// ---- the camera -----------------------------------------------------------------------------------

/**
 * A key of the camera's path: where it is at `t`, and how fast it is going there (world units, and
 * degrees, a second); a key with no speed is a stop. `lift` raises the eye on an arc on the way to the
 * next key, as the landing page's flight lifts off one realm and settles onto the next.
 */
type CameraKey = { t: number; eye: Vec3; yaw: number; pitch: number; speed?: { eye?: Vec3; yaw?: number; pitch?: number }; lift?: number }

/** Cubic Hermite between two values with their slopes (per second), across `d` seconds. */
function hermite(p0: number, p1: number, m0: number, m1: number, s: number, d: number) {
  const s2 = s * s
  const s3 = s2 * s
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 * d + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1 * d
}

/** The camera the path asks for at `t`, before the spring. */
function aim(keys: CameraKey[], t: number): View {
  if (t <= keys[0]!.t) return level(keys[0]!.eye, keys[0]!.yaw, keys[0]!.pitch)
  const last = keys[keys.length - 1]!
  if (t >= last.t) return level(last.eye, last.yaw, last.pitch)
  let k = 0
  while (t > keys[k + 1]!.t) k++
  const a = keys[k]!
  const z = keys[k + 1]!
  const d = z.t - a.t
  const s = (t - a.t) / d
  const va = a.speed ?? {}
  const vz = z.speed ?? {}
  const eye: Vec3 = [0, 1, 2].map((i) => hermite(a.eye[i]!, z.eye[i]!, va.eye?.[i] ?? 0, vz.eye?.[i] ?? 0, s, d)) as Vec3
  // The lift rises and settles with no kick at either end.
  eye[2] += (a.lift ?? 0) * Math.sin(Math.PI * s) ** 2
  return level(eye, hermite(a.yaw, z.yaw, va.yaw ?? 0, vz.yaw ?? 0, s, d), hermite(a.pitch, z.pitch, va.pitch ?? 0, vz.pitch ?? 0, s, d))
}

/** The camera's whole path, through the spring, sampled at TRACK_RATE: the frame at any time is read from it. */
function track(keys: CameraKey[], until: number): View[] {
  const follow = new Follow(MASS)
  const out: View[] = []
  const step = 1 / TRACK_RATE
  out.push(follow.step(aim(keys, 0), 0))
  for (let i = 1; i <= Math.ceil(until * TRACK_RATE); i++) out.push(follow.step(aim(keys, i * step), step))
  return out
}

function between(a: View, b: View, k: number): View {
  return {
    eye: [lerp(a.eye[0], b.eye[0], k), lerp(a.eye[1], b.eye[1], k), lerp(a.eye[2], b.eye[2], k)],
    yaw: lerp(a.yaw, b.yaw, k),
    pitch: lerp(a.pitch, b.pitch, k),
    focal: lerp(a.focal, b.focal, k),
    px: lerp(a.px, b.px, k),
    py: lerp(a.py, b.py, k),
  }
}

// ---- the shots ------------------------------------------------------------------------------------

/** A part of the window the site photographed on its own (public/product/parts.json). */
function part(name: string): ScreenImage {
  const image = partImage(name)
  if (!image) throw new Error(`The site has no capture of ${name}`)
  return image
}

/** The captures the film shows: Realm's whole window, then the part each stop's claim is about. */
export type PictureId = "window" | "agents" | "delegation" | "gateway"
export const PICTURES: Record<PictureId, ScreenImage & { kind: "window" | "part" }> = {
  window: { ...sceneImage("workspace"), kind: "window" },
  agents: { ...part("models"), kind: "part" },
  delegation: { ...part("delegation"), kind: "part" },
  gateway: { ...part("connections"), kind: "part" },
}

/** A picture's corner on the page, its surface's own, at the width it is drawn. */
const cornerOf = (id: PictureId, rect: Rect) => (PICTURES[id].radius / PICTURES[id].width) * rect[2]

/** The window's realm, the doorway that brightens first, and the window under it. */
const WINDOW = { mid: [4, -40, 2.4] as Vec3, half: [4.6, 2.875] as const }
const FIRST_REALM: Vec3 = [6.6, -40.6, 6.75]
const FIRST_SIZE = 1.35

/** The opening's push up the route, toward the window's place, and the approach once it is out. */
const OPEN = { from: [4, -100, 2.4] as Vec3, to: [4, -64, 2.4] as Vec3, until: 5.6 }
const PUSH_SPEED = (OPEN.to[1] - OPEN.from[1]) / OPEN.until
const CLOSE: Vec3 = [4, -51, 2.4]

/** A stop where a picture comes out of its realm: the camera, and where on the page the picture rests. */
type Stop = {
  id: Exclude<PictureId, "window">
  eye: Vec3
  yaw: number
  at: [number, number]
  size: [number, number]
  /** Which top corner of the picture its realm hangs over. */
  corner: "outer" | "inner"
}

const STOPS: Stop[] = [
  { id: "agents", eye: [3, -30, 2.2], yaw: 92, at: [1330, 548], size: [519, 700], corner: "outer" },
  { id: "delegation", eye: [8, -5, 3.1], yaw: 88, at: [1330, 548], size: [584, 700], corner: "outer" },
  { id: "gateway", eye: [2, 20, 1.6], yaw: 92, at: [1330, 548], size: [860, 648], corner: "inner" },
]
/** The film's realms bob on seeds past the sky's 1100 (world.ts, MAX_REALMS), so none keeps time with one of them. */
const SEEDS = 1500

/** How far in front of its camera a stop's picture hangs, and its realm behind that. */
const STOP_DEPTH = 10
const STOP_REALM_DEPTH = 15

/** When each stop is arrived at and left, and when its words and picture come and go. */
const BEAT = { first: 8.15, every: 2.15, hold: 1.55 }
const beatAt = (k: number) => BEAT.first + k * BEAT.every

/** The black hole: which way it hangs from the camera's last stop. */
const HOLE_WAY = normalize(toward(68, 15))

/** When words that stay to the end leave: after it. */
const STAYS: [number, number] = [FILM.duration + 1, FILM.duration + 2]

/** The words, each with when it comes up and when it goes. */
export type WordsId = "wordmark" | "tagline" | "agents" | "delegation" | "gateway" | "endmark" | "domain" | "download"
const WORDS: Record<WordsId, { in: [number, number]; out: [number, number] }> = {
  wordmark: { in: [2.3, 3.1], out: [5.15, 5.42] },
  tagline: { in: [2.8, 3.45], out: [5.15, 5.42] },
  agents: { in: [beatAt(0) - 0.15, beatAt(0) + 0.15], out: [beatAt(1) - 0.3, beatAt(1) - 0.12] },
  delegation: { in: [beatAt(1) - 0.15, beatAt(1) + 0.15], out: [beatAt(2) - 0.3, beatAt(2) - 0.12] },
  gateway: { in: [beatAt(2) - 0.15, beatAt(2) + 0.15], out: [beatAt(3) - 0.3, beatAt(3) - 0.12] },
  endmark: { in: [17.7, 18.25], out: STAYS },
  domain: { in: [17.8, 18.35], out: STAYS },
  download: { in: [17.88, 18.42], out: STAYS },
}

/** The sky's clock runs down to a stop under the end card, so its last moment is a still. */
const CLOCK = { slows: 17.6, stops: 18.5 }
function skyClock(t: number) {
  const L = CLOCK.stops - CLOCK.slows
  const x = clamp((t - CLOCK.slows) / L, 0, 1)
  // The rate eases from 1 to 0 across [slows, stops]; this is its integral.
  return t <= CLOCK.slows ? t : CLOCK.slows + L * (x - x * x * x + (x * x * x * x) / 2)
}

// ---- the overlay the page draws ---------------------------------------------------------------------

export type WordsState = { opacity: number; blur: number; rise: number }
export type PictureState = { rect: Rect; shown: number; corner: number }
export type Overlay = {
  /** The black the film opens out of and dips back into under the end card (0..1). */
  dark: number
  words: Record<WordsId, WordsState>
  pictures: Record<PictureId, PictureState | null>
}

export type FilmDirector = Director & {
  overlay(t: number): Overlay
  /** The page's measured rect of each block of words, which the field is held off while it shows. */
  measure(id: WordsId, rect: Rect): void
}

/**
 * The film. Its camera's path is worked out once, through the same spring the landing page's camera
 * has, so it leaves and arrives the way that one does; every frame is then read off it.
 */
export function createFilm(): FilmDirector {
  // ---- the camera's path ----
  const keys: CameraKey[] = [
    { t: 0, eye: OPEN.from, yaw: 90, pitch: 0, speed: { eye: [0, PUSH_SPEED, 0] } },
    { t: OPEN.until, eye: OPEN.to, yaw: 90, pitch: 0, speed: { eye: [0, PUSH_SPEED, 0] } },
    { t: 7.55, eye: CLOSE, yaw: 90, pitch: 0, lift: 1.4 },
  ]
  STOPS.forEach((stop, k) => {
    const arrive = beatAt(k)
    const leave = arrive + BEAT.hold
    // A slow turn about the picture while it is read, then away.
    const drift = k % 2 === 0 ? 1 : -1
    keys.push({ t: arrive, eye: stop.eye, yaw: stop.yaw, pitch: 0, speed: { eye: [0.18 * drift, 0.35, 0], yaw: 0.6 * drift } })
    keys.push({ t: leave, eye: add(stop.eye, [0.27 * drift, 0.52, 0]), yaw: stop.yaw + 0.9 * drift, pitch: 0, speed: { eye: [0.18 * drift, 0.35, 0], yaw: 0.6 * drift }, lift: k < STOPS.length - 1 ? 1.2 : 0 })
  })
  // Up out of the last stop and round to the black hole, then a slow push toward it that comes to rest
  // under the end card.
  const last = STOPS[STOPS.length - 1]!
  const rise: Vec3 = add(last.eye, [1.5, 9, 7])
  const holeYaw = (Math.atan2(HOLE_WAY[1], HOLE_WAY[0]) * 180) / Math.PI
  const holePitch = (Math.asin(HOLE_WAY[2]) * 180) / Math.PI
  keys.push({ t: 15.2, eye: rise, yaw: holeYaw + 3, pitch: holePitch - 1, speed: { eye: [0.25, 1.3, 0.2], yaw: -0.8, pitch: 0.3 } })
  keys.push({ t: 18.3, eye: add(rise, [0.7, 3.9, 0.6]), yaw: holeYaw + 1.1, pitch: holePitch - 0.2 })
  keys.push({ t: FILM.duration, eye: add(rise, [0.7, 3.9, 0.6]), yaw: holeYaw + 1.1, pitch: holePitch - 0.2 })

  const path = track(keys, FILM.duration + 0.1)
  // Held exactly where it is once the sky's clock has stopped.
  const cameraAt = (t: number): View => {
    const x = clamp(Math.min(t, CLOCK.stops), 0, FILM.duration) * TRACK_RATE
    const i = Math.min(Math.floor(x), path.length - 2)
    return between(path[i]!, path[i + 1]!, x - i)
  }

  // ---- the realms the film visits ----
  const realmOver = (stop: Stop): Vec3 => {
    const view = level(stop.eye, stop.yaw)
    const [x, y] = stop.at
    const [w, h] = stop.size
    return onPage(view, stop.corner === "outer" ? x + w / 2 - 70 : x - w / 2 + 70, y - h / 2 - 78, STOP_REALM_DEPTH)
  }
  const stopRealms = STOPS.map(realmOver)

  /** A realm of the film's: where it hangs at `clock`, turned to look at `eye` and down at its picture. */
  const posed = (at: Vec3, index: number, clock: number, eye: Vec3, size: number, aside: number, down: number): Pose => {
    const drift = bob(SEEDS + index, size, clock)
    const here: Vec3 = add(at, mul(drift, 0.6))
    const sway = Math.sin(clock * 0.21 + index * 1.7) * 0.05
    return presented(here, eye, size, aside + sway, down + Math.sin(clock * 0.17 + index) * 0.03)
  }

  // ---- the pictures ----
  /** Where a picture hangs in the world for a view: its middle and half size there. */
  const stopPicture = STOPS.map((stop) => {
    const view = level(stop.eye, stop.yaw)
    const mid = onPage(view, stop.at[0], stop.at[1], STOP_DEPTH)
    const half: [number, number] = [(stop.size[0] / 2 / FOCAL) * STOP_DEPTH, (stop.size[1] / 2 / FOCAL) * STOP_DEPTH]
    return { mid, half }
  })

  /** A picture's rect on the page from the camera, a little smaller while it is still coming up. */
  const rectOf = (view: View, mid: Vec3, half: readonly [number, number], shown: number): Rect | null => {
    const b = basis(view)
    const [x, y, z] = project(view, b, mid)
    if (z < 0.6) return null
    const grow = lerp(0.965, 1, spring(shown))
    const w = ((FOCAL * 2 * half[0]) / z) * grow
    const h = ((FOCAL * 2 * half[1]) / z) * grow
    return [x - w / 2, y - h / 2, w, h]
  }

  /** How far a picture has come out at `t`: the light reaching out, the picture up in it, and away. */
  const timing = (t: number, reach0: number, show0: number, leave0: number) => {
    const leaving = t >= leave0
    const reach = span(t, reach0, reach0 + 0.5)
    const shown = span(t, show0, show0 + 0.42) * (1 - span(t, leave0, leave0 + 0.3))
    return { reach, shown, leaving }
  }

  const windowTiming = (t: number) => timing(t, 5.42, 5.72, 7.62)
  const stopTiming = (t: number, k: number) => timing(t, beatAt(k) - 0.18, beatAt(k) + 0.02, beatAt(k) + BEAT.hold + 0.15)

  // ---- the words ----
  const measured = new Map<WordsId, Rect>()
  const wordsShown = (id: WordsId, t: number) => {
    const w = WORDS[id]
    return span(t, w.in[0], w.in[1]) * (1 - span(t, w.out[0], w.out[1]))
  }

  // ---- the black hole ----
  const holeAt = (t: number, view: View): HoleDirection | null => {
    if (t < 14) return null
    const b = basis(view)
    const [x, y, z] = project(view, b, add(view.eye, mul(HOLE_WAY, 1e4)))
    if (z <= 0) return null
    // In on the far side before the hole is in view, round the side coming at the camera and across the
    // front, where a face takes it at 15.65; back out of the doorway at 16.55 (from 4.2 half-edges at
    // this angle the fall takes 2.15 s, by the hole's own arithmetic).
    const drop: ScriptedDrop = { start: 13.5, r: 4.2, phi: 200 * DEG, strength: 1, seed: 0.37 }
    return {
      at: [x, y],
      radius: lerp(112, 150, span(t, 14.6, 17.8)),
      shown: span(t, 14.0, 14.9),
      arrived: span(t, 14.5, 15.45),
      lean: [-0.4 * (1 - span(t, 14.2, 16.2)), 0.15 * (1 - span(t, 14.2, 16.2))],
      drops: [drop],
      realm: 3.2,
    }
  }

  // ---- what to clear out of the film's way: the film seen fifteen times a second ----
  const samples = Array.from({ length: Math.round(FILM.duration * 15) + 1 }, (_, i) => i / 15)
  let sampled: { view: View; shot: Direction }[] | null = null

  const film: FilmDirector = {
    at(t) {
      const view = cameraAt(t)
      const clock = skyClock(t)
      const realms: DirectedRealm[] = []
      const screens: DirectedScreen[] = []

      // The window's realm: lit as the push begins, thrown open to let the window out, then left lit.
      const first = windowTiming(t)
      realms.push({
        pose: posed(FIRST_REALM, 0, clock, OPEN.to, FIRST_SIZE, -0.42, 0.62),
        glow: lerp(0.04, 1.1, span(t, 0.9, 2.4)),
        open: Math.max(0.14 * span(t, 1.9, 2.7), span(t, 5.2, 5.5)) * (1 - 0.7 * span(t, 6.5, 7.6)),
      })
      if (first.reach > 0 || first.shown > 0) {
        const rect = rectOf(view, WINDOW.mid, WINDOW.half, first.shown)
        if (rect) screens.push({ rect, corner: cornerOf("window", rect), shown: first.shown, realm: 0, mid: WINDOW.mid, half: WINDOW.half, reach: first.reach, leaving: first.leaving })
      }

      STOPS.forEach((stop, k) => {
        const index = realms.length
        const arrive = beatAt(k)
        const near = span(t, arrive - 0.6, arrive - 0.1) * (1 - span(t, arrive + BEAT.hold + 0.1, arrive + BEAT.hold + 0.7))
        const flood = span(t, arrive - 0.2, arrive + 0.08) * (1 - span(t, arrive + 0.3, arrive + 1.2))
        // Its doorway turned in toward the picture, from whichever corner it hangs over.
        const aside = stop.corner === "outer" ? -0.5 : 0.5
        realms.push({ pose: posed(stopRealms[k]!, k + 1, clock, stop.eye, 1, aside, 0.62), glow: lerp(0.25, 1, near), open: 0.6 * flood })
        const at = stopTiming(t, k)
        if (at.reach <= 0 && at.shown <= 0) return
        const { mid, half } = stopPicture[k]!
        const rect = rectOf(view, mid, half, at.shown)
        if (rect) screens.push({ rect, corner: cornerOf(stop.id, rect), shown: at.shown, realm: index, mid, half, reach: at.reach, leaving: at.leaving })
      })

      const words = (Object.keys(WORDS) as WordsId[]).flatMap((id) => {
        const rect = measured.get(id)
        const shown = wordsShown(id, t)
        return rect && shown > 0 ? [{ rect, shown }] : []
      })

      // The far stars come up as the camera lifts its eyes to the night the black hole hangs in.
      const night = span(t, 13.9, 15.2)
      return {
        seconds: clock,
        view,
        before: { view: cameraAt(t - SHUTTER), seconds: skyClock(t - SHUTTER) },
        haze: [lerp(40, 60, night), Math.exp(lerp(Math.log(1 / 220), Math.log(1 / 500), night))],
        night,
        doors: 0.2,
        realms,
        screens,
        words,
        hole: holeAt(t, view),
      }
    },

    keep(at, size) {
      sampled ??= samples.map((t) => ({ view: cameraAt(t), shot: film.at(t) }))
      for (const { view, shot } of sampled) {
        const b = basis(view)
        if (length(sub(at, view.eye)) < 3.2 + size) return false
        const [x, y, z] = project(view, b, at)
        if (z <= 0.3) continue
        const across = (FOCAL * size) / z
        const r = across + 40
        const inView = x > -r && x < W + r && y > -r && y < H + r
        if (!inView) continue
        // Nothing large enough to be a wall, and nothing near enough to fill the view.
        if (z < 7 + size || across > 120) return false
        // Nothing in front of a picture that is out, nor near the words while they show.
        for (const screen of shot.screens) {
          const [sx, sy, sw, sh] = screen.rect
          const depth = project(view, b, screen.mid)[2]
          if (z < depth + 2 && x > sx - r && x < sx + sw + r && y > sy - r && y < sy + sh + r) return false
        }
        // Behind the words nothing larger than a point, however far off: a giant reads as near.
        for (const words of shot.words) {
          const [wx, wy, ww, wh] = words.rect
          if (across > 3 && x > wx - r - 30 && x < wx + ww + r + 30 && y > wy - r - 30 && y < wy + wh + r + 30) return false
        }
        // None over the black hole's disk.
        if (shot.hole && shot.hole.shown > 0) {
          const disk = (HOLE.outer * shot.hole.radius) / HOLE.hexagon
          const dx = (x - shot.hole.at[0]) / (disk * 1.08 + across)
          const dy = (y - shot.hole.at[1]) / (disk * 0.5 + across)
          if (dx * dx + dy * dy < 1) return false
        }
        // And none crowding the film's own realms.
        for (const realm of shot.realms) if (length(sub(at, realm.pose.at)) < 3.5 + size + Math.hypot(...realm.pose.z)) return false
      }
      return true
    },

    overlay(t) {
      const view = cameraAt(t)
      const words = {} as Record<WordsId, WordsState>
      for (const id of Object.keys(WORDS) as WordsId[]) {
        const w = WORDS[id]
        const into = spring((t - w.in[0]) / (w.in[1] - w.in[0]))
        const out = smooth((t - w.out[0]) / (w.out[1] - w.out[0]))
        words[id] = { opacity: smooth((t - w.in[0]) / (w.in[1] - w.in[0])) * (1 - out), blur: (1 - into) * 10 + out * 6, rise: (1 - into) * 22 }
      }
      const pictures = {} as Record<PictureId, PictureState | null>
      const first = windowTiming(t)
      const windowRect = first.shown > 0 ? rectOf(view, WINDOW.mid, WINDOW.half, first.shown) : null
      pictures.window = windowRect ? { rect: windowRect, shown: first.shown, corner: cornerOf("window", windowRect) } : null
      STOPS.forEach((stop, k) => {
        const at = stopTiming(t, k)
        const rect = at.shown > 0 ? rectOf(view, stopPicture[k]!.mid, stopPicture[k]!.half, at.shown) : null
        pictures[stop.id] = rect ? { rect, shown: at.shown, corner: cornerOf(stop.id, rect) } : null
      })
      return { dark: Math.max(1 - span(t, 0, 0.9), span(t, 17.2, 17.85)), words, pictures }
    },

    measure(id, rect) {
      measured.set(id, rect)
    },
  }
  return film
}

