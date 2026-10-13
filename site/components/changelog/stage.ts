import { draw, effect, sampler, target, type Frame, type Gpu, type Surface } from "vgpu"

import type { Rect, StageFactory, StageInput } from "@/components/field/stage"
import { basis, blend, clamp, Follow, lerp, orbit, place, rayThrough, smooth, smoother, type Key, type Vec3, type View } from "@/components/realms/camera"
import { CLEAR, compositeShader, LIT, PANELS, PLAZAS, SCREENS, sceneShader, type CompositeUniforms, type SceneUniforms } from "@/components/realms/shaders"
import { latticeOf, PLANET_RADIUS } from "@/components/realms/world"

import { aimed, AVENUE_X, EYE, FOCAL, footOf, lateralFor, realmOf, standing, STREET, streetView } from "./avenue"

/**
 * The changelog's two views of the landing page's world, drawn with its shaders (components/realms):
 *
 *   the walk     the index. The releases stand in a row up the field, newest nearest, and the camera
 *                walks the street beside them as the page scrolls, arriving at each release as its
 *                card comes to the reading line. Each release's doorway is lit; the one being read is
 *                lit fully, and a withdrawn build's stands dark.
 *   the arrival  an entry's header band. The camera stands in front of that release's realm with the
 *                older ones going away behind it, and walks up to its doorway as the reader scrolls
 *                into the notes. The band's own box is the canvas, so the picture leaves with the band
 *                and the loop stops once it has (FieldCanvas, `stage`).
 *
 * The layout is the DOM's. `stage` is the canvas's box; `c:<name>` is a block of words the field keeps
 * clear of; `k:<r>` is release r's card on the index, whose scroll position is the release's stop;
 * `s:door` is where an entry's realm stands in its band.
 */

const DEG = Math.PI / 180
const GRID = 64
const GRID_PHONE = 40
/** The realm mesh: thirteen quads, two triangles each (components/realms/stage.ts). */
const REALM_VERTICES = 78
/** A doorway that is not the one being read is lit this much of the way. */
const LIT_AHEAD = 0.5
/** The evening the changelog is set in: the landing page's dusk, a little on. */
const NIGHT = 0.12

export type AvenueRelease = { slug: string; dark: boolean }

type Scene = Awaited<ReturnType<typeof world>>

async function world(gpu: Gpu, size: [number, number]) {
  const zero = () => [0, 0, 0, 0]
  const scene: SceneUniforms = {
    eye: [0, 0, 10, FOCAL],
    fwd: [0, 1, 0, 0.05],
    right: [1, 0, 0, 1],
    up: [0, 0, 1, 0],
    view: [1, 1, 0, 0],
    clock: [0, NIGHT, 0, 0],
    fog: [10, 0.02, 0, 0],
    planet: [0, 0, PLANET_RADIUS, 0],
    sun: [0, 0, 1, 0],
    air: [1, 0, 0, 1],
    field: [0, 0, 0, 0],
    fence: [0, 0, 0, 0],
    lamp: [0, 0, 2, 0],
    grid: [0, 0, GRID, 120],
    screens: Array.from({ length: SCREENS * 2 }, zero),
    plazas: Array.from({ length: PLAZAS * 2 }, zero),
    lit: Array.from({ length: LIT }, () => [0, 0, -1, 0]),
  }
  const comp: CompositeUniforms = {
    view: [1, 1, 1, 0],
    look: [0, 0, 0, 0],
    clear: Array.from({ length: CLEAR }, zero),
    panels: Array.from({ length: PANELS * 2 }, zero),
  }

  let current = size
  const scenery = target(gpu, { size, format: "rgba16float", depth: "depth32float", msaa: true, label: "changelog-world" })
  const realms = draw(gpu, {
    label: "changelog-realm",
    shader: sceneShader,
    entry: { vertex: "vs_realm", fragment: "fs_realm" },
    cull: "back",
    depth: { write: true, compare: "greater" },
    set: { scene },
  })
  const sky = draw(gpu, {
    label: "changelog-sky",
    shader: sceneShader,
    entry: { vertex: "vs_sky", fragment: "fs_sky" },
    vertices: 3,
    depth: { write: false, compare: "greater-equal" },
    set: { scene },
  })
  const linear = sampler(gpu, { minFilter: "linear", magFilter: "linear" })
  const composite = effect(gpu, compositeShader, { label: "changelog-composite", set: { comp, sceneTex: scenery, sceneSampler: linear } })
  await Promise.all([realms.compile(scenery), sky.compile(scenery)])

  return {
    scene,
    comp,
    render(frame: Frame, output: Surface, size: [number, number], instances: number) {
      if (size[0] !== current[0] || size[1] !== current[1]) {
        current = size
        scenery.resize(size)
        composite.set({ sceneTex: scenery })
      }
      realms.set({ scene })
      sky.set({ scene })
      composite.set({ comp })
      frame.pass({ target: scenery, clear: [0, 0, 0, 1], clearDepth: 0 }, (pass) => {
        if (instances > 0) pass.draw(realms, { vertices: REALM_VERTICES, instances })
        pass.draw(sky, { vertices: 3 })
      })
      frame.pass(output, composite)
    },
  }
}

/** What one frame of either view needs besides the camera. */
type Setting = {
  width: number
  height: number
  seconds: number
  still: boolean
  fog: [number, number]
  /** Release index and how lit its doorway is (0 dark .. 1 the one being read). */
  doors: [number, number][]
  lamp: { x: number; y: number; presence: number }
  clears: Rect[]
  grid: number
  dpr: number
  /** How many releases stand in the avenue. Past the oldest the field closes over the street, so the
   *  avenue ends at the first release. */
  total: number
}

function compose(s: Scene, view: View, set: Setting): number {
  const b = basis(view)
  const { scene, comp } = s

  // The pointer's lamp, where its ray meets the ground, held a little above it.
  const ray = rayThrough(view, b, set.lamp.x, set.lamp.y)
  let lampAt: Vec3 = [0, 0, 0]
  let lampOn = 0
  if (ray[2] < -1e-3) {
    const t = -view.eye[2] / ray[2]
    lampAt = [view.eye[0] + ray[0] * t, view.eye[1] + ray[1] * t, 0]
    lampOn = set.lamp.presence
  }

  // The lattice round where the camera looks, and how far out a realm is still worth drawing.
  const [fogStart, fogDensity] = set.fog
  const level = view.pitch > -0.05
  const ahead = level ? clamp(fogStart * 1.4, 18, 70) : Math.min(view.eye[2] / Math.tan(-view.pitch), 120)
  const lookX = view.eye[0] + Math.cos(view.yaw) * ahead
  const lookY = view.eye[1] + Math.sin(view.yaw) * ahead
  const [gi, gj] = latticeOf(lookX, lookY).map(Math.round) as [number, number]
  const cull = Math.min(fogStart + 4.2 / Math.max(fogDensity, 1e-4), 260)

  // The street: cleared from behind the camera to the oldest release, and quiet everywhere, so the only
  // doorways lit in the field are the releases'.
  const end = Math.min(view.eye[1] + cull + 12, realmOf(set.total - 1)[1] + 2.4)
  const plazas: number[][] = [[STREET.x, view.eye[1] - 12, STREET.radius, 1e5], [STREET.x, Math.max(end, view.eye[1] - 11), 0, 0]]
  while (plazas.length < PLAZAS * 2) plazas.push([0, 0, 0, 0])

  // The releases nearest where the camera looks: the scene keeps LIT of them, and a release it is not
  // told about stands in the street's clearing and so is not drawn, which only ever happens far into
  // the haze.
  const lit = set.doors
    .map(([r, glow]) => {
      const [x, y] = realmOf(r)
      return { x, y, glow, d: Math.hypot(x - lookX, y - lookY) }
    })
    .sort((a, c) => a.d - c.d)
    .slice(0, LIT)
    .map(({ x, y, glow }) => [x, y, glow, 0])
  while (lit.length < LIT) lit.push([0, 0, -1, 0])

  scene.eye = [...view.eye, view.focal]
  scene.fwd = [...b.fwd, clamp(view.eye[2] * 0.02, 0.03, 4)]
  scene.right = [...b.right, 1]
  scene.up = [...b.up, 0]
  scene.view = [set.width, set.height, view.px, view.py]
  scene.clock = [set.seconds, NIGHT, set.still ? 1 : 0, 0]
  scene.fog = [fogStart, fogDensity, 0, 0]
  scene.planet = [view.eye[0], view.eye[1], PLANET_RADIUS, 0]
  scene.lamp = [lampAt[0], lampAt[1], clamp(view.eye[2] * 0.35, 1.2, 6), lampOn]
  scene.grid = [gi, gj, set.grid, cull]
  scene.plazas = plazas
  scene.lit = lit

  const clears = set.clears.filter((r) => r[2] > 0 && r[3] > 0).slice(0, CLEAR)
  comp.view = [set.width, set.height, set.dpr, set.seconds]
  comp.look = [set.still ? 1 : 0, clears.length, 0, 0]
  comp.clear = [...clears.map((r) => [...r]), ...Array.from({ length: CLEAR - clears.length }, () => [0, 0, 0, 0])]
  return set.grid * set.grid
}

/** The canvas's own box in the viewport: the `stage` anchor, or the viewport when there is none. */
function box(input: StageInput): Rect {
  return input.anchors.stage ?? [0, 0, input.width, input.height]
}

const inView = (r: Rect, height: number) => r[2] > 0 && r[1] < height + 200 && r[1] + r[3] > -200

/** The pointer's lamp, easing after it as the landing page's does. */
function lampFollower() {
  const lamp = { x: 0, y: 0, presence: 0 }
  let sway = 0
  return {
    lamp,
    get sway() {
      return sway
    },
    step(input: StageInput, origin: Rect, dt: number) {
      const [px, py, presence] = input.pointer
      const x = px - origin[0]
      const y = py - origin[1]
      const k = input.still ? 1 : 1 - Math.exp(-Math.max(dt, 0) / 0.6)
      if (lamp.presence < 0.001) {
        lamp.x = x
        lamp.y = y
      }
      lamp.x += (x - lamp.x) * k
      lamp.y += (y - lamp.y) * k
      lamp.presence += ((input.still ? 0 : presence) - lamp.presence) * k
      sway += ((x / Math.max(origin[2], 1) - 0.5) * presence - sway) * k
    },
  }
}

/**
 * The index: a walk up the avenue, one stop per release card.
 */
export function walkStage(releases: AvenueRelease[]): StageFactory {
  return async (gpu, output) => {
    const sizeOf = (r: Rect): [number, number] => [Math.max(1, Math.round(r[2])), Math.max(1, Math.round(r[3]))]
    const s = await world(gpu, [Math.max(1, window.innerWidth), Math.max(1, window.innerHeight)])
    const follow = new Follow(9)
    const pointer = lampFollower()
    let lastSeconds = -1
    let drawn = ""
    let mode = ""

    return {
      draw(frame, input) {
        const canvas = box(input)
        const [W, H] = [canvas[2], canvas[3]]
        if (W < 2 || H < 2) return
        const dt = lastSeconds < 0 ? 0 : input.seconds - lastSeconds
        lastSeconds = input.seconds
        const scrollY = window.scrollY
        const local = (r: Rect): Rect => [r[0] - canvas[0], r[1] - canvas[1], r[2], r[3]]
        // A phone, or any window too narrow for the field beside the list, gets the field only in the
        // band at the top of the page, where the canvas has been confined.
        const banded = H < input.height * 0.9 || W < 1024
        const next = input.still ? "still" : banded ? "band" : "walk"
        if (next !== mode) {
          mode = next
          follow.reset()
        }

        // The doorway being read stands right of the list, on the reading line's level, with the
        // horizon high enough to see the street; the camera walks as far left of the releases as puts
        // the avenue's far end a little clear of the list.
        const list = input.anchors["c:list"]
        const columnRight = list ? local(list)[0] + list[2] : W * 0.5
        const horizon = H * 0.27
        const sx = columnRight + (W - columnRight) * 0.68
        const sy = H * 0.68
        const lateral = lateralFor(sx - (columnRight + 190), sy, horizon)
        const street = (r: number) => streetView(r, sx, sy, horizon, EYE, lateral)

        // The opening, over the top of the page: up and back from the newest release, looking down
        // the street, so the releases' doorways are lights in one row going away into the haze.
        // On a narrow screen the newest release stands in the right half of the band over the title,
        // the older ones going away to its left, as an entry's band stands its release.
        const slot = input.anchors["s:avenue"] ? local(input.anchors["s:avenue"]) : undefined
        const opening: View =
          banded && slot
            ? standing(0, [slot[0] + slot[2] * 0.5, slot[1] + slot[3] * 0.08, slot[2] * 0.42, slot[3] * 0.84]).view
            : aimed({ eye: [AVENUE_X - lateral - 0.8, footOf(0)[1] - 14, 6.4], yaw: 90 * DEG, pitch: -15 * DEG, focal: FOCAL, px: 0, py: 0 }, footOf(0), sx, H * 0.74)

        type Stop = { key: Key; fog: [number, number]; release: number; through: number }
        const stops: Stop[] = [
          { key: { id: "open", kind: "open", y: 0, view: opening, hold: [0, 0.08], turn: 0, pivot: footOf(0), lift: 0 }, fog: [20, 1 / 60], release: -1, through: 0 },
        ]
        if (!banded) {
          releases.forEach((_, r) => {
            const head = input.anchors[`k:${r}`]
            if (!head) return
            const h = local(head)
            const whole = input.anchors[`r:${r}`] ? local(input.anchors[`r:${r}`]!) : h
            // A release's stop is where its card's head sits a little above the middle of the view, and
            // the camera stays there for as long as the rest of the card (its changes) is being read.
            const y = Math.max(1, scrollY + h[1] + h[3] / 2 - H * 0.4)
            const view = street(r)
            const distance = footOf(r)[1] - view.eye[1]
            stops.push({
              key: { id: String(r), kind: "chapter", y, view, hold: [0.12, 0.12], turn: 0, pivot: footOf(r), lift: 0 },
              fog: [distance + 4, 1 / (distance * 3.4)],
              release: r,
              through: scrollY + whole[1] + whole[3] - H * 0.4,
            })
          })
          // The end of the page: the camera rises off the street and looks back down on the first
          // release, where the avenue begins, standing above the footer.
          const last = releases.length - 1
          const footer = input.anchors["c:footer"]
          const end = document.documentElement.scrollHeight - input.height
          const lastStop = stops.at(-1)
          if (footer && lastStop && end > lastStop.key.y + H * 0.3) {
            const footerTop = local(footer)[1] + scrollY - end
            const high: View = { eye: [AVENUE_X - 3.4, footOf(last)[1] - 10, 7.5], yaw: 82 * DEG, pitch: -32 * DEG, focal: FOCAL, px: 0, py: 0 }
            stops.push({
              key: { id: "end", kind: "calm", y: end, view: aimed(high, footOf(last), sx, Math.max(H * 0.3, footerTop - 110)), hold: [0.15, 0], turn: 0, pivot: footOf(last), lift: 0 },
              fog: [14, 1 / 40],
              release: last,
              through: end,
            })
          }
        }
        stops.sort((a, c) => a.key.y - c.key.y)
        // Each stop holds across its own card: the share of the way to the next stop that the card's
        // remaining length takes up.
        stops.forEach((stop, k) => {
          const next = stops[k + 1]
          if (!next || stop.key.kind !== "chapter") return
          const gap = Math.max(next.key.y - stop.key.y, 1)
          stop.key.hold[1] = clamp((stop.through - stop.key.y) / gap, 0.12, 0.72)
        })
        const keys = stops.map((stop) => stop.key)

        const at = place(keys, scrollY)
        const nearest = at.u < 0.5 ? at.from : at.to
        let view = at.view
        if (mode === "band") {
          // The band at the top of a phone's page: the opening, carried a little up the street as it
          // scrolls away.
          view = { ...opening, eye: [opening.eye[0], opening.eye[1] + scrollY * 0.006, opening.eye[2]] }
        } else if (mode === "still") {
          view = keys[nearest]!.view
        }

        pointer.step(input, canvas, dt)
        if (mode === "walk") {
          view = follow.step(view, dt)
          view = orbit(view, keys[nearest]!.pivot, -pointer.sway * 0.8 * DEG)
        }

        // How far along the releases the reader is, in releases: the doorway being read is lit fully.
        const from = stops[at.from]!
        const to = stops[at.to]!
        const reading = mode === "band" ? 0 : mode === "still" ? stops[nearest]!.release : lerp(from.release, to.release, smooth(at.u))
        const doors: [number, number][] = releases.map((release, r) =>
          release.dark ? [r, 0] : [r, lerp(LIT_AHEAD, 1, clamp(1 - Math.abs(r - reading), 0, 1))],
        )

        const e = smoother(at.u)
        let fog: [number, number] = [lerp(from.fog[0], to.fog[0], e), Math.exp(lerp(Math.log(from.fog[1]), Math.log(to.fog[1]), e))]
        if (mode === "band") fog = stops[0]!.fog
        if (mode === "still") fog = stops[nearest]!.fog

        // Clean ground for the words: on a wide screen the whole of the list's side of the page, and
        // everything from the footer down.
        const clears: Rect[] = []
        if (!banded) clears.push([-400, -400, columnRight + 400, H + 800])
        for (const [name, rect] of Object.entries(input.anchors)) {
          if (!name.startsWith("c:") || !inView(local(rect), H)) continue
          const r = local(rect)
          clears.push(name === "c:footer" ? [-400, r[1] - 40, W + 800, H + 800] : r)
        }

        const size = sizeOf(canvas)
        const dpr = output.size[0] / Math.max(W, 1)
        const state = `${scrollY}|${W}x${H}|${view.eye.map((v) => v.toFixed(4)).join(",")}|${view.yaw.toFixed(5)}|${pointer.lamp.x.toFixed(1)},${pointer.lamp.y.toFixed(1)},${pointer.lamp.presence.toFixed(3)}|${mode}`
        if (state === drawn && !input.still) return
        drawn = state

        const instances = compose(s, view, {
          width: W,
          height: H,
          seconds: input.seconds,
          still: input.still,
          fog,
          doors,
          lamp: pointer.lamp,
          clears,
          grid: banded ? GRID_PHONE : GRID,
          dpr,
          total: releases.length,
        })
        s.render(frame, output, size, instances)
      },
    }
  }
}

/**
 * An entry's band: the release's realm, and the walk up to its doorway as the band scrolls away.
 */
export function arrivalStage(release: number, total: number, dark: boolean): StageFactory {
  return async (gpu, output) => {
    const s = await world(gpu, [Math.max(1, window.innerWidth), Math.max(1, Math.round(window.innerHeight * 0.7))])
    const pointer = lampFollower()
    let lastSeconds = -1
    let drawn = ""

    return {
      draw(frame, input) {
        const canvas = box(input)
        const [W, H] = [canvas[2], canvas[3]]
        if (W < 2 || H < 2) return
        const dt = lastSeconds < 0 ? 0 : input.seconds - lastSeconds
        lastSeconds = input.seconds
        const local = (r: Rect): Rect => [r[0] - canvas[0], r[1] - canvas[1], r[2], r[3]]

        // Where the realm stands: in `s:door`, with room for the older releases to go away behind it.
        const slot = input.anchors["s:door"] ? local(input.anchors["s:door"]) : ([W * 0.6, H * 0.25, W * 0.3, H * 0.5] as Rect)
        const sx = slot[0] + slot[2] / 2
        const sy = slot[1] + slot[3]
        const { view: far, distance, horizon } = standing(release, slot)

        // Up to the door: the camera comes down level with the doorway and in toward it, the lens
        // shifting so the doorway's middle stays where it stood on the band.
        const foot = footOf(release)
        const wall = 0.1
        const doorMid = 0.485
        const doorY = horizon + (FOCAL * (EYE - doorMid)) / (distance + wall)
        const nearDistance = 4.2
        const nearLateral = 0.7
        const nearEye: Vec3 = [foot[0] - nearLateral, foot[1] - nearDistance, doorMid + 0.15]
        const near: View = {
          eye: nearEye,
          yaw: 90 * DEG,
          pitch: 0,
          focal: FOCAL,
          px: sx - (FOCAL * nearLateral) / (nearDistance + wall),
          py: doorY - (FOCAL * (nearEye[2] - doorMid)) / (nearDistance + wall),
        }
        // The walk covers the band's own height of scroll, from the moment it starts to leave.
        const travelled = clamp(-canvas[1] / Math.max(H * 0.85, 1), 0, 1)
        const u = input.still ? 0 : travelled
        let view = blend(far, near, u, 0)
        pointer.step(input, canvas, dt)
        if (!input.still) view = orbit(view, foot, -pointer.sway * 0.8 * DEG)

        const doors: [number, number][] = []
        for (let r = 0; r < total; r++) doors.push([r, r === release ? (dark ? 0 : 1) : LIT_AHEAD])

        const away = lerp(foot[1] - far.eye[1], nearDistance, smoother(u))
        const fog: [number, number] = [away + 3, 1 / (Math.max(away, 3) * 3.4)]

        // The band's foot, where the field gives way to the page, and the words: where the realm stands
        // beside the title, the whole of the title's side of the band.
        const clears: Rect[] = [[-400, H, W + 800, 800]]
        const title = input.anchors["c:title"] ? local(input.anchors["c:title"]) : undefined
        if (title && slot[0] > title[0] + title[2]) clears.push([-400, -400, title[0] + title[2] + 400, H + 800])
        for (const [name, rect] of Object.entries(input.anchors)) {
          if (name.startsWith("c:") && inView(local(rect), H)) clears.push(local(rect))
        }

        const dpr = output.size[0] / Math.max(W, 1)
        const state = `${canvas.join(",")}|${view.eye.map((v) => v.toFixed(4)).join(",")}|${pointer.lamp.x.toFixed(1)},${pointer.lamp.y.toFixed(1)},${pointer.lamp.presence.toFixed(3)}`
        if (state === drawn && !input.still) return
        drawn = state

        const instances = compose(s, view, {
          width: W,
          height: H,
          seconds: input.seconds,
          still: input.still,
          fog,
          doors,
          lamp: pointer.lamp,
          clears,
          grid: W < 1024 ? GRID_PHONE : GRID,
          dpr,
          total,
        })
        s.render(frame, output, [Math.max(1, Math.round(W)), Math.max(1, Math.round(H))], instances)
      },
    }
  }
}
