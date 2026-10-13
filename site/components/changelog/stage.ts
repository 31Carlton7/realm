import { draw, effect, sampler, target, type Frame, type Gpu, type Surface } from "vgpu"

import type { Rect, StageFactory, StageInput } from "@/components/field/stage"
import { holeOff } from "@/components/realms/blackhole"
import { basis, blend, clamp, Follow, lerp, orbit, place, project, smooth, smoother, type Basis, type Key, type Vec3, type View } from "@/components/realms/camera"
import {
  BEAMS,
  BURSTS,
  CLEAR,
  compositeShader,
  PAGE_REALMS,
  PANELS,
  PULSES,
  REALM_VERTICES,
  sceneShader,
  spaceShader,
  STAR_BLOCK,
  STAR_CELL,
  TOUCHED,
  type CompositeUniforms,
  type RealmData,
  type SceneUniforms,
} from "@/components/realms/shaders"
import { clearOff, doorCorners, MAX_REALMS, packRealms, populate, type Pose, type Realm } from "@/components/realms/world"

import { poseOf, realmOf, SPACING, viewAt } from "./world"

/**
 * The changelog's two views of the landing page's sky, drawn with its passes (components/realms):
 *
 *   the walk     the index. Each release is a realm hanging in a row up the route, newest nearest, its
 *                doorway lit; the camera walks up the route as the page scrolls and comes to each
 *                release as its card comes to the reading line, the older ones waiting ahead of it.
 *                The release being read is lit fully, and a withdrawn build's stands dark.
 *   the arrival  an entry's band. The camera hangs in front of that release's realm, the older ones
 *                going away behind it, and comes up to its doorway as the reader scrolls into the
 *                notes, the doorway thrown open as they go in. The band's own box is the canvas, so
 *                the picture leaves with the band and the loop stops once it has (FieldCanvas).
 *
 * The layout is the DOM's. `stage` is the canvas's box; `k:<r>` is release r's head on the index, whose
 * scroll position is its stop, and `r:<r>` its whole card, read while the camera stays; `c:<name>` is
 * any other block of words; `s:<name>` is where a realm hangs in a band. Words on a FieldPanel tell the
 * composite their corner, and the field is dimmed inside exactly that.
 */

const DEG = Math.PI / 180

// The landing page's sky, as components/realms/stage.ts sets it.
const SPACE_SCALE = 0.5
const PANE_FIELD = 0.45
const KEY_LIGHT: Vec3 = (() => {
  const v: Vec3 = [-0.45, -0.62, 0.64]
  const l = Math.hypot(...v)
  return [v[0] / l, v[1] / l, v[2] / l]
})()
const KEY_STRENGTH = 1.15
const DOOR_SHARE = 0.36
const SKY_TURN = 0.0026
const STAR_DRIFT: Vec3 = [0.07, -0.11, 0.03]

/** A doorway that is not the one being read is lit this much of the way. */
const LIT_AHEAD = 0.45

export type AvenueRelease = { slug: string; dark: boolean }

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const length3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2])

/** The canvas's own box in the viewport: the `stage` anchor, or the viewport when there is none. */
const boxOf = (input: StageInput): Rect => input.anchors.stage ?? [0, 0, input.width, input.height]

const inView = (r: Rect, height: number) => r[2] > 0 && r[3] > 0 && r[1] < height + 200 && r[1] + r[3] > -200

/** The corners of the panes words sit on (FieldPanel's `data-field-panel`), by their anchor. */
function panes(): Map<string, number> {
  const out = new Map<string, number>()
  for (const el of document.querySelectorAll<HTMLElement>("[data-field-panel]")) {
    if (el.dataset.fieldAnchor) out.set(el.dataset.fieldAnchor, Number(el.dataset.fieldPanel))
  }
  return out
}

/**
 * The sky: the landing page's passes, its population, and its uniforms, drawn into a canvas of any
 * size. `frame` writes everything the camera and the moment decide; the caller decides the rest.
 */
async function sky(gpu: Gpu, output: Surface, size: [number, number]) {
  const zero = () => [0, 0, 0, 0]
  const scene: SceneUniforms = {
    eye: [0, 0, 10, 1500],
    fwd: [0, 1, 0, 0.05],
    right: [1, 0, 0, 1],
    up: [0, 0, 1, 0],
    view: [1, 1, 0, 0],
    clock: [0, 0, DOOR_SHARE, 0],
    prevEye: [0, 0, 10, 1500],
    prevFwd: [0, 1, 0, 0],
    prevRight: [1, 0, 0, 0],
    prevUp: [0, 0, 1, 0],
    stars: [0, 0, 0, 60],
    haze: [30, 0.004, 0, 0],
    light: [...KEY_LIGHT, KEY_STRENGTH],
    holeBox: [0, 0, 0, 0],
    flare: [0, 0, 0, 0],
    touched: Array.from({ length: TOUCHED }, () => [zero(), zero(), zero(), zero(), [-1, 0, 0, 0]]).flat(),
    page: Array.from({ length: PAGE_REALMS * 5 }, zero),
  }
  const comp: CompositeUniforms = {
    view: [1, 1, 1, 0],
    look: [0, 0, 0, 0],
    cam: Array.from({ length: 4 }, zero),
    clear: Array.from({ length: CLEAR * 2 }, zero),
    panels: Array.from({ length: PANELS * 2 }, zero),
    plates: Array.from({ length: PANELS * 2 }, zero),
    beams: Array.from({ length: BEAMS * 7 }, (_, i) => (i % 7 === 1 ? [0, 0, 1, 0] : zero())),
    pulses: Array.from({ length: PULSES * 5 }, zero),
    bursts: Array.from({ length: BURSTS * 2 }, zero),
    fence: Array.from({ length: 10 }, zero),
  }

  const population = populate()
  const realmData: RealmData = { items: packRealms(population) }
  const spaceOf = (s: [number, number]): [number, number] => [Math.max(1, Math.round(s[0] * SPACE_SCALE)), Math.max(1, Math.round(s[1] * SPACE_SCALE))]
  let current = size
  const scenery = target(gpu, { size, format: "rgba16float", depth: "depth32float", msaa: true, label: "changelog-world" })
  const space = target(gpu, { size: spaceOf(size), format: "rgba16float", label: "changelog-space" })
  const linear = sampler(gpu, { minFilter: "linear", magFilter: "linear" })

  const deep = effect(gpu, spaceShader, { label: "changelog-space", set: { scene } })
  const realms = draw(gpu, {
    label: "changelog-realm",
    shader: sceneShader,
    entry: { vertex: "vs_realm", fragment: "fs_realm" },
    cull: "back",
    depth: { write: true, compare: "greater" },
    set: { scene, realms: realmData, spaceTex: space, spaceSampler: linear },
  })
  const backdrop = draw(gpu, {
    label: "changelog-sky",
    shader: sceneShader,
    entry: { vertex: "vs_sky", fragment: "fs_sky" },
    vertices: 3,
    depth: { write: false, compare: "greater-equal" },
    set: { scene, hole: holeOff(), spaceTex: space, spaceSampler: linear },
  })
  const additive = { color: { src: "one", dst: "one" }, alpha: { src: "zero", dst: "one" } } as const
  const glows = draw(gpu, {
    label: "changelog-glow",
    shader: sceneShader,
    entry: { vertex: "vs_glow", fragment: "fs_glow" },
    blend: additive,
    depth: { write: false, compare: "greater" },
    set: { scene, realms: realmData },
  })
  const stars = draw(gpu, {
    label: "changelog-stars",
    shader: sceneShader,
    entry: { vertex: "vs_star", fragment: "fs_star" },
    blend: additive,
    depth: { write: false, compare: "greater" },
    set: { scene },
  })
  const composite = effect(gpu, compositeShader, { label: "changelog-composite", set: { comp, sceneTex: scenery, sceneSampler: linear } })
  await Promise.all([realms.compile(scenery), backdrop.compile(scenery), glows.compile(scenery), stars.compile(scenery)])

  let prev: { view: View; b: Basis; seconds: number } | null = null
  let cleared = ""
  let spaceDrawn = ""
  let spaceFrame = 0

  return {
    scene,
    comp,
    /**
     * Clear the sky out of the page's way, whenever the stops move: nothing may hang where the camera
     * passes between stops, nor in front of a stop's camera as near as its own realm, nor behind the
     * words as anything more than a point.
     */
    clearFor(stops: { view: View; keep: number; words: Rect[] }[], path: Vec3[], width: number, height: number) {
      const key = `${width}x${height}|${stops.map((s) => `${s.view.eye.map((v) => v.toFixed(2)).join(",")}@${s.view.px.toFixed(0)},${s.view.py.toFixed(0)}:${s.words.map((w) => w.map(Math.round).join(",")).join("/")}`).join(";")}`
      if (key === cleared) return
      cleared = key
      const views = stops.map((s) => ({ ...s, b: basis(s.view) }))
      const kept: Realm[] = clearOff(population, (at, size) => {
        for (const p of path) if (length3(sub3(at, p)) < 3 + size * 0.9) return false
        for (const { view, b, keep, words } of views) {
          const [x, y, z] = project(view, b, at)
          if (z <= 0.3) continue
          const across = (view.focal * size) / z
          const r = across + 40
          if (x > -r && x < width + r && y > -r && y < height + r && (z <= keep + size || across > 90)) return false
          // Behind the words, nothing more than a point, however far off: the far giants as well.
          if (across > 4 && words.some((w) => x > w[0] - r && x < w[0] + w[2] + r && y > w[1] - r && y < w[1] + w[3] + r)) return false
        }
        return true
      })
      realmData.items = packRealms(kept)
      realms.set({ realms: realmData })
      glows.set({ realms: realmData })
    },
    /** The page's own realms this frame: their poses, how lit each doorway is, and how open. */
    page(list: { pose: Pose; glow: number; open: number }[]) {
      for (let k = 0; k < PAGE_REALMS; k++) {
        const item = list[k]
        if (!item) {
          scene.page[k * 5] = [0, 0, 0, 0]
          continue
        }
        const { pose, glow, open } = item
        scene.page[k * 5] = [...pose.at, Math.hypot(...pose.z)]
        scene.page[k * 5 + 1] = [...pose.x, glow]
        scene.page[k * 5 + 2] = [...pose.y, 0]
        scene.page[k * 5 + 3] = [...pose.z, open]
        scene.page[k * 5 + 4] = [-1, 0, 0, 0]
      }
    },
    render(
      frame: Frame,
      view: View,
      set: { width: number; height: number; seconds: number; still: boolean; haze: [number, number]; clears: [Rect, number, number][]; bursts: [number, number, number, number, number][] },
    ) {
      const b = basis(view)
      const t = set.seconds
      const last = prev ?? { view, b, seconds: t }
      scene.eye = [...view.eye, view.focal]
      scene.fwd = [...b.fwd, 0.05]
      scene.right = [...b.right, 1]
      scene.up = [...b.up, 0]
      scene.view = [set.width, set.height, view.px, view.py]
      scene.clock = [t, set.still ? 1 : 0, DOOR_SHARE, last.seconds]
      scene.prevEye = [...last.view.eye, last.view.focal]
      scene.prevFwd = [...last.b.fwd, last.view.px]
      scene.prevRight = [...last.b.right, last.view.py]
      scene.prevUp = [...last.b.up, 0]
      const drifted = sub3(view.eye, [STAR_DRIFT[0] * t, STAR_DRIFT[1] * t, STAR_DRIFT[2] * t])
      scene.stars = [
        Math.floor(drifted[0] / STAR_CELL) - STAR_BLOCK / 2,
        Math.floor(drifted[1] / STAR_CELL) - STAR_BLOCK / 2,
        Math.floor(drifted[2] / STAR_CELL) - STAR_BLOCK / 2,
        (STAR_BLOCK / 2 - 1) * STAR_CELL,
      ]
      scene.haze = [set.haze[0], set.haze[1], t * SKY_TURN, 0]
      prev = { view, b, seconds: t }

      const clears = set.clears.filter(([r]) => r[2] > 0 && r[3] > 0).slice(0, CLEAR)
      const dpr = output.size[0] / Math.max(set.width, 1)
      comp.view = [set.width, set.height, dpr, t]
      comp.look = [set.still ? 1 : 0, clears.length, 0, 0]
      comp.cam = [
        [...view.eye, view.focal],
        [...b.fwd, view.px],
        [...b.right, view.py],
        [...b.up, 0],
      ]
      comp.clear = [...clears.flatMap(([r, radius, inside]) => [[...r], [radius, inside, 0, 0]]), ...Array.from({ length: (CLEAR - clears.length) * 2 }, () => [0, 0, 0, 0])]
      for (let k = 0; k < BURSTS; k++) {
        const burst = set.bursts[k]
        comp.bursts[k * 2] = burst ? [burst[0], burst[1], burst[2], burst[3]] : [0, 0, 0, 0]
        comp.bursts[k * 2 + 1] = burst ? [burst[4], k * 0.61, 0, 0] : [0, 0, 0, 0]
      }

      const wanted: [number, number] = [Math.max(1, Math.round(set.width)), Math.max(1, Math.round(set.height))]
      if (wanted[0] !== current[0] || wanted[1] !== current[1]) {
        current = wanted
        scenery.resize(wanted)
        space.resize(spaceOf(wanted))
        composite.set({ sceneTex: scenery })
        realms.set({ spaceTex: space })
        backdrop.set({ spaceTex: space })
      }
      deep.set({ scene })
      realms.set({ scene })
      backdrop.set({ scene })
      glows.set({ scene })
      stars.set({ scene })
      composite.set({ comp })
      // The deep sky moves slowly: while the camera holds still it is redrawn every other frame, as the
      // landing page redraws it.
      const camera = `${view.eye.map((v) => v.toFixed(3)).join(",")}|${b.fwd.map((v) => v.toFixed(4)).join(",")}|${view.px.toFixed(1)},${view.py.toFixed(1)}|${wanted.join("x")}`
      if (camera !== spaceDrawn || spaceFrame++ % 2 === 0 || set.still) frame.pass({ target: space, clear: [0, 0, 0, 1] }, (pass) => pass.draw(deep))
      spaceDrawn = camera
      frame.pass({ target: scenery, clear: [0, 0, 0, 0], clearDepth: 0 }, (pass) => {
        pass.draw(realms, { vertices: REALM_VERTICES, instances: MAX_REALMS + PAGE_REALMS })
        pass.draw(backdrop, { vertices: 3 })
        pass.draw(glows, { vertices: 6, instances: MAX_REALMS + PAGE_REALMS })
        pass.draw(stars, { vertices: 6, instances: STAR_BLOCK * STAR_BLOCK * STAR_BLOCK })
      })
      frame.pass(output, composite)
    },
  }
}

/** The pointer: the smallest sway of the camera about where it stands, easing after the mouse. */
function swayer() {
  let sway = 0
  return (input: StageInput, box: Rect, dt: number) => {
    const [x, , presence] = input.pointer
    const k = input.still ? 1 : 1 - Math.exp(-Math.max(dt, 0) / 0.6)
    sway += ((((x - box[0]) / Math.max(box[2], 1) - 0.5) * (input.still ? 0 : presence)) - sway) * k
    return sway
  }
}

/** A doorway thrown open, as the composite draws one: its middle on the page, distance, light, size. */
function burstOf(pose: Pose, view: View, open: number): [number, number, number, number, number] | null {
  if (open <= 0.01) return null
  const b = basis(view)
  const door = doorCorners(pose)
  const mid: Vec3 = [0, 1, 2].map((i) => (door[0][i]! + door[1][i]! + door[2][i]! + door[3][i]!) / 4) as Vec3
  const [x, y, z] = project(view, b, mid)
  if (z < 1) return null
  const out = [-pose.y[0], -pose.y[1], -pose.y[2]] as Vec3
  const toEye = sub3(view.eye, mid)
  const facingEye = (out[0] * toEye[0] + out[1] * toEye[1] + out[2] * toEye[2]) / (length3(out) * length3(toEye))
  if (facingEye <= 0) return null
  return [x, y, length3(toEye), open * (0.4 + 0.6 * facingEye), (view.focal * Math.hypot(...pose.z)) / z]
}

/**
 * The index: a walk up the route, one stop per release card.
 */
export function walkStage(releases: AvenueRelease[]): StageFactory {
  return async (gpu, output) => {
    const s = await sky(gpu, output, [Math.max(1, window.innerWidth), Math.max(1, window.innerHeight)])
    const follow = new Follow(9)
    const sway = swayer()
    let lastSeconds = -1
    let mode = ""

    return {
      draw(frame, input) {
        const canvas = boxOf(input)
        const [W, H] = [canvas[2], canvas[3]]
        if (W < 2 || H < 2) return
        const t = input.seconds
        const dt = lastSeconds < 0 ? 0 : t - lastSeconds
        lastSeconds = t
        const scrollY = window.scrollY
        const local = (r: Rect): Rect => [r[0] - canvas[0], r[1] - canvas[1], r[2], r[3]]
        // A phone, or any window too narrow for the sky beside the list, gets it only in the band at
        // the top of the page, where the canvas has been confined.
        const banded = H < input.height * 0.9 || W < 1024
        const next = input.still ? "still" : banded ? "band" : "walk"
        if (next !== mode) {
          mode = next
          follow.reset()
        }

        // The release being read hangs right of the list, a little above the reading line.
        const list = input.anchors["c:list"] ?? input.anchors["k:0"]
        const columnRight = list ? local(list)[0] + local(list)[2] : W * 0.5
        const room = W - columnRight
        const sx = columnRight + room * 0.56
        const sy = H * 0.5
        const edge = clamp(room * 0.25, 96, 168)

        // The opening: further back down the route, so the releases ahead are a row of lit doorways.
        const slot = input.anchors["s:avenue"] ? local(input.anchors["s:avenue"]) : null
        const opening = banded && slot ? viewAt(0, slot[0] + slot[2] * 0.62, slot[1] + slot[3] * 0.55, slot[3] * 0.34, 2.2, 1.1) : viewAt(0, sx, H * 0.56, edge * 0.62, 2.8, 1.5)

        type Stop = { key: Key; release: number; through: number }
        const stops: Stop[] = [{ key: { id: "open", kind: "open", y: 0, view: opening, hold: [0, 0.08], turn: 0, pivot: realmOf(0), lift: 0 }, release: 0, through: 0 }]
        if (!banded) {
          releases.forEach((_, r) => {
            const head = input.anchors[`k:${r}`]
            if (!head) return
            const h = local(head)
            const whole = input.anchors[`r:${r}`] ? local(input.anchors[`r:${r}`]!) : h
            // A release's stop is where its head sits a little above the middle of the view, and the
            // camera stays there while the rest of its card (its changes) is read.
            const y = Math.max(1, scrollY + h[1] + h[3] / 2 - H * 0.4)
            stops.push({
              key: { id: String(r), kind: "chapter", y, view: viewAt(r, sx, sy, edge), hold: [0.12, 0.12], turn: 0, pivot: realmOf(r), lift: 0.6 },
              release: r,
              through: scrollY + whole[1] + whole[3] - H * 0.4,
            })
          })
        }
        stops.sort((a, c) => a.key.y - c.key.y)
        stops.forEach((stop, k) => {
          const after = stops[k + 1]
          if (!after || stop.key.kind !== "chapter") return
          stop.key.hold[1] = clamp((stop.through - stop.key.y) / Math.max(after.key.y - stop.key.y, 1), 0.12, 0.72)
        })
        const keys = stops.map((stop) => stop.key)

        // The sky cleared out of the way: of the walk, of each release, of the list's side of the page,
        // and, where the last release is read, of the footer coming up under it.
        // On a phone the band holds the opening and its words, which move with it.
        const hero = input.anchors["c:hero"] ? local(input.anchors["c:hero"]) : null
        const side: Rect[] = banded ? (hero ? [hero] : []) : [[-W, -H, columnRight + W + 40, H * 3]]
        const footer = input.anchors["c:footer"]
        const end = document.documentElement.scrollHeight - input.height
        const foot: Rect[] = footer && !banded ? [[-W, local(footer)[1] + scrollY - end - 60, W * 3, H * 2]] : []
        const path: Vec3[] = []
        for (let k = 0; k + 1 < keys.length; k++) for (let i = 0; i <= 16; i++) path.push(blend(keys[k]!.view, keys[k + 1]!.view, i / 16, keys[k]!.lift).eye)
        if (banded) for (let i = 0; i <= 12; i++) path.push([opening.eye[0], opening.eye[1] + i * 2, opening.eye[2]])
        s.clearFor(keys.map((key, k) => ({ view: key.view, keep: 9, words: k === keys.length - 1 ? [...side, ...foot] : side })), path, W, H)

        const at = place(keys, scrollY)
        const nearest = at.u < 0.5 ? at.from : at.to
        let view = at.view
        if (mode === "band") view = { ...opening, eye: [opening.eye[0], opening.eye[1] + scrollY * 0.006, opening.eye[2]] }
        else if (mode === "still") view = keys[nearest]!.view
        const swayNow = sway(input, canvas, dt)
        if (mode === "walk") {
          view = follow.step(view, dt)
          view = orbit(view, keys[nearest]!.pivot, -swayNow * 0.8 * DEG)
        }

        // How far along the releases the reader is: the doorway being read is lit fully.
        const from = stops[at.from]!
        const to = stops[at.to]!
        const reading = mode === "still" ? stops[nearest]!.release : lerp(from.release, to.release, smooth(at.u))
        const near = Math.max(0, Math.round(view.eye[1] / SPACING))
        const shown = releases
          .map((release, r) => ({ release, r }))
          .filter(({ r }) => r >= near - 2)
          .slice(0, 14)
          .map(({ release, r }) => ({
            pose: poseOf(r, viewAt(r, sx, sy, edge).eye, t, input.still),
            glow: release.dark ? 0 : lerp(LIT_AHEAD, 1, clamp(1 - Math.abs(r - reading), 0, 1)),
            open: 0,
          }))
        s.page(shown)

        // The words: the list's cards and the rail on panes, the opening's and the footer's on none.
        const corners = panes()
        const clears: [Rect, number, number][] = []
        for (const [name, rect] of Object.entries(input.anchors)) {
          if (!(name.startsWith("c:") || name.startsWith("r:")) || name === "c:list" || !inView(local(rect), H)) continue
          const radius = corners.get(name)
          clears.push([local(rect), radius ?? -1, radius === undefined ? 1 : PANE_FIELD])
        }
        clears.sort((a, c) => Math.abs(a[0][1] + a[0][3] / 2 - H / 2) - Math.abs(c[0][1] + c[0][3] / 2 - H / 2))

        const distance = realmOf(Math.max(0, Math.round(reading)))[1] - view.eye[1]
        s.render(frame, view, {
          width: W,
          height: H,
          seconds: t,
          still: input.still,
          haze: [Math.max(distance, 6) + 30, 1 / 170],
          clears,
          bursts: [],
        })
      },
    }
  }
}

/**
 * An entry's band: its release's realm, and the walk up to its doorway as the band scrolls away, the
 * doorway thrown open as the reader goes in.
 */
export function arrivalStage(release: number, total: number, dark: boolean): StageFactory {
  return async (gpu, output) => {
    const s = await sky(gpu, output, [Math.max(1, window.innerWidth), Math.max(1, Math.round(window.innerHeight * 0.7))])
    const sway = swayer()
    let lastSeconds = -1

    return {
      draw(frame, input) {
        const canvas = boxOf(input)
        const [W, H] = [canvas[2], canvas[3]]
        if (W < 2 || H < 2) return
        const t = input.seconds
        const dt = lastSeconds < 0 ? 0 : t - lastSeconds
        lastSeconds = t
        const local = (r: Rect): Rect => [r[0] - canvas[0], r[1] - canvas[1], r[2], r[3]]

        // Where the realm hangs: in the middle of `s:door`, about half as tall as it.
        const slot = input.anchors["s:door"] ? local(input.anchors["s:door"]) : ([W * 0.62, H * 0.25, W * 0.26, H * 0.5] as Rect)
        const sx = slot[0] + slot[2] / 2
        const sy = slot[1] + slot[3] * 0.5
        const edge = clamp(slot[3] * 0.5, 64, 150)
        const far = viewAt(release, sx, sy, edge)

        // Up to the door, from the moment the band starts to leave until it has gone.
        const travelled = clamp(-canvas[1] / Math.max(H * 0.8, 1), 0, 1)
        const u = input.still ? 0 : travelled
        const near = viewAt(release, sx, sy, edge * 1.4, 1.7, 0.5)
        let view = blend(far, near, smoother(u), 0)
        if (!input.still) view = orbit(view, realmOf(release), -sway(input, canvas, dt) * 0.8 * DEG)

        // The release's own realm, and the older ones going away behind it.
        const pose = poseOf(release, far.eye, t, input.still)
        const open = dark || input.still ? 0 : 0.55 * smooth((u - 0.25) / 0.6)
        const page: { pose: Pose; glow: number; open: number }[] = [{ pose, glow: dark ? 0 : 1, open }]
        for (let r = release + 1; r < total && page.length < 6; r++) page.push({ pose: poseOf(r, viewAt(r, sx, sy, edge).eye, t, input.still), glow: LIT_AHEAD, open: 0 })
        s.page(page)

        const path: Vec3[] = []
        for (let i = 0; i <= 12; i++) path.push(blend(far, near, i / 12, 0).eye)
        // Nothing but points behind the title, nor anywhere on its side of the band where the realm
        // hangs beside it rather than over it.
        const title = input.anchors["c:title"] ? local(input.anchors["c:title"]) : null
        // The band starts at the top of the page, under the header's bar.
        const bar: Rect = [-W, -H, W * 3, H + 80]
        const words: Rect[] = !title ? [bar] : slot[0] > title[0] + title[2] ? [[-W, -H, title[0] + title[2] + W + 40, H * 3], bar] : [title, bar]
        s.clearFor([{ view: far, keep: 9, words }], path, W, H)

        const corners = panes()
        const clears: [Rect, number, number][] = []
        for (const [name, rect] of Object.entries(input.anchors)) {
          if (!name.startsWith("c:") || !inView(local(rect), H)) continue
          const radius = corners.get(name)
          clears.push([local(rect), radius ?? -1, radius === undefined ? 1 : PANE_FIELD])
        }

        const burst = burstOf(pose, view, open)
        s.render(frame, view, {
          width: W,
          height: H,
          seconds: t,
          still: input.still,
          haze: [lerp(realmOf(release)[1] - far.eye[1], 4, smoother(u)) + 30, 1 / 170],
          clears,
          bursts: burst ? [burst] : [],
        })
      },
    }
  }
}
