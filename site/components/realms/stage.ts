import { draw, effect, sampler, target } from "vgpu"

import type { Rect, StageFactory, StageInput } from "@/components/field/stage"

import { BlackHole, holeOff } from "./blackhole"
import { basis, blend, clamp, dot, Follow, lerp, orbit, place, project, ramp, smooth, smoother, type Basis, type Key, type Place, type Vec3, type View } from "./camera"
import { CHAPTERS, CLIMB, FINALE, OPENING, TEAM } from "./route"
import {
  BEAMS,
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
} from "./shaders"
import { takeOpened } from "./hands"
import { ROLES, WORLD_REALMITE } from "./Team"
import { between, clearOff, doorCorners, doorSill, facing, inWorld, MAX_REALMS, packRealms, populate, realmAt, type Pose, type Realm } from "./world"

const DEG = Math.PI / 180
/** The scene is drawn at this many target pixels per CSS px (the canvas itself runs up to 1.5), and
 *  multisampled, so its edges stay clean where the canvas scales it up. The deep sky is drawn at half
 *  that: it is soft everywhere, and it is the costliest thing on the page per pixel. */
const RENDER_SCALE = 1
const SPACE_SCALE = 0.5
/** The share of the field left under a pane of words, before the pane's own blur and tint: enough
 *  for the blur to have something to show, little enough that no lit doorway behind it can take the
 *  words below AA. */
const PANE_FIELD = 0.45
/** Which way the far star cluster that lights the realms is, from them, and how strongly. */
const KEY_LIGHT: Vec3 = normalize([-0.45, -0.62, 0.64])
const KEY_STRENGTH = 1.15
/** The share of the sky's doorways lit by agents at work. */
const DOOR_SHARE = 0.3
/** The far sky's turn, in radians a second: a full turn in about forty minutes. */
const SKY_TURN = 0.0026
/** The near stars drift through the world at this rate (world units a second), as shaders.ts has it. */
const STAR_DRIFT: Vec3 = [0.07, -0.11, 0.03]
/** The nebulae's middles, as shaders.ts places them: a flare is set off in one of them now and then. */
const NEBULAE: Vec3[] = [
  [183, 394, 183],
  [-163, 350, 140],
  [60, 820, -120],
  [30, 620, -200],
  [40, 950, 180],
]

type Mode = "flight" | "still" | "drift"

/** A stop of the flight, with what the page puts there: a screen, a team, or nothing. */
type Stand = {
  key: Key
  /** Where the haze into the sky starts, and how thick it is. */
  haze: [number, number]
  /** How far in front of this stop's camera nothing but the page's own realms may hang. */
  keepClear: number
  /** The words this stop is read at, where they stand then: nothing of the sky hangs behind them. */
  words?: Rect
  /** A chapter's screen: its foot, its size at rest in CSS px, its depth then, which side it is on. */
  foot?: Vec3
  slot?: [number, number]
  depth?: number
  side?: 1 | -1
  /** The team's realms. */
  team?: Vec3[]
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const mix3 = (a: Vec3, b: Vec3, k: number): Vec3 => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const length3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2])

const rest = (r: Rect, scrollY: number, keyY: number): Rect => [r[0], r[1] + scrollY - keyY, r[2], r[3]]

/** The scroll position at which a block's middle is in the middle of the view. */
const centred = (r: Rect, scrollY: number, height: number) => scrollY + r[1] + r[3] / 2 - height / 2

/** A level view from `eye` facing `yaw`, its axis meeting the page at (x, y). */
const level = (eye: Vec3, yaw: number, focal: number, x: number, y: number, pitch = 0): View => ({ eye, yaw, pitch, focal, px: x, py: y })

/** The direction from the eye through a point of the page. */
function rayAt(view: View, b: Basis, x: number, y: number): Vec3 {
  return normalize(add(add(b.fwd, mul(b.right, (x - view.px) / view.focal)), mul(b.up, -(y - view.py) / view.focal)))
}

/**
 * Every stop, read from the page as it is laid out right now: each is composed around the block
 * marked `k:<id>` (its words) or `p:<id>` (its picture), at the scroll position that centres it. A
 * chapter's camera stands where the route puts it, and its lens is shifted so the foot of the
 * chapter's screen lands on the bottom middle of the screen's slot at exactly that position. The
 * layout is the DOM's; the world is built round it.
 */
function stands(input: StageInput, scrollY: number, mode: Mode): Stand[] {
  const { width, height, anchors } = input
  const out: Stand[] = []
  const phone = mode === "drift"

  // The opening: looking up the route into the thick of the realms, the lens's axis meeting the page
  // at the middle of the product window's top edge.
  const portal = anchors.portal
  if (portal) {
    const yaw = OPENING.yaw * DEG
    const eye: Vec3 = [...OPENING.eye]
    const view = level(eye, yaw, phone ? OPENING.phoneFocal : OPENING.focal, phone ? width / 2 : portal[0] + portal[2] / 2, phone ? height * 0.55 : portal[1] + scrollY, OPENING.pitch * DEG)
    const ahead: Vec3 = [eye[0] + Math.cos(yaw) * 40, eye[1] + Math.sin(yaw) * 40, eye[2]]
    const copy = anchors.copy
    out.push({
      key: { id: "open", kind: "open", y: 0, view, hold: [0, 0.1], turn: 3 * DEG, pivot: ahead, lift: 0 },
      haze: [40, 1 / 220],
      keepClear: 7,
      words: copy ? rest(copy, scrollY, 0) : undefined,
    })
  }

  for (const [name, rect] of Object.entries(anchors)) {
    // A stop is composed around its words (`k:`), or, where the words come first and the picture is
    // the whole width under them, around its picture (`p:`).
    if (!name.startsWith("k:") && !name.startsWith("p:")) continue
    const id = name.slice(2)
    const y = Math.max(1, centred(rect, scrollY, height))
    const stop = CHAPTERS[id]
    const slotRect = anchors[`s:${id}`]
    if (stop && slotRect) {
      const foot: Vec3 = [...stop.at]
      const yaw = stop.yaw * DEG
      const eye: Vec3 = [foot[0] - stop.distance * Math.cos(yaw), foot[1] - stop.distance * Math.sin(yaw), foot[2] + stop.height]
      const slot = rest(slotRect, scrollY, y)
      const view = level(eye, yaw, stop.focal, slot[0] + slot[2] / 2, slot[1] + slot[3] - (stop.focal * stop.height) / stop.distance)
      out.push({
        key: { id, kind: "chapter", y, view, hold: [0.24, 0.24], turn: stop.orbit * DEG, pivot: foot, lift: 1.2 },
        haze: [stop.distance + 26, 1 / 150],
        keepClear: stop.distance + 9,
        words: rest(rect, scrollY, y),
        foot,
        slot: [slot[2], slot[3]],
        depth: stop.distance,
        side: slot[0] + slot[2] / 2 >= width * 0.45 ? 1 : -1,
      })
      continue
    }
    if (id === "teams" && slotRect) {
      const yaw = TEAM.yaw * DEG
      const at: Vec3 = [...TEAM.at]
      const right: Vec3 = [Math.sin(yaw), -Math.cos(yaw), 0]
      const fwd: Vec3 = [Math.cos(yaw), Math.sin(yaw), 0]
      const team = TEAM.realms.map(([across, back, up]) => add(add(add(at, mul(right, across)), mul(fwd, back)), [0, 0, up]))
      const eye: Vec3 = [at[0] - TEAM.distance * fwd[0], at[1] - TEAM.distance * fwd[1], at[2] + TEAM.height]
      const slot = rest(slotRect, scrollY, y)
      // The pair in front a little under the slot's middle, the camera a little over them.
      const view = level(eye, yaw, TEAM.focal, slot[0] + slot[2] / 2, slot[1] + slot[3] * 0.62 - (TEAM.focal * TEAM.height) / TEAM.distance)
      out.push({
        key: { id, kind: "teams", y, view, hold: [0.24, 0.24], turn: TEAM.orbit * DEG, pivot: at, lift: 1.2 },
        haze: [TEAM.distance + 26, 1 / 150],
        keepClear: TEAM.distance + 7,
        words: rest(rect, scrollY, y),
        team,
      })
      continue
    }
    const climb = CLIMB[id]
    if (climb) {
      const yaw = climb.yaw * DEG
      const pitch = climb.pitch * DEG
      const view = level([climb.at[0], climb.at[1], climb.height], yaw, climb.focal, width / 2, height * 0.56, pitch)
      const reach = climb.height / Math.tan(-pitch)
      out.push({
        key: { id, kind: "calm", y, view, hold: [0.2, 0.2], turn: 3 * DEG, pivot: [climb.at[0] + Math.cos(yaw) * reach, climb.at[1] + Math.sin(yaw) * reach, 0], lift: 0 },
        haze: [climb.height * 1.2, 1 / (climb.height * 9)],
        keepClear: 12,
      })
      continue
    }
    if (id === "finale") {
      // The finale: lifted over the swarm, the camera looks up and out into the deep sky, and the black
      // hole the page ends on comes up into it from below.
      const last = out[out.length - 1]?.key.view
      const yaw = last ? last.yaw : 90 * DEG
      const ahead: Vec3 = last ? [last.eye[0] + Math.cos(yaw) * 40, last.eye[1] + Math.sin(yaw) * 40, FINALE.height] : [0, 0, FINALE.height]
      const view = level(ahead, yaw, FINALE.focal, width / 2, height * 0.5, FINALE.pitch * DEG)
      out.push({
        key: { id, kind: "finale", y, view, hold: [0.12, 0.3], turn: 0, pivot: ahead, lift: 0 },
        haze: [60, 1 / 500],
        keepClear: 24,
      })
    }
  }
  out.sort((a, b) => a.key.y - b.key.y)
  return out
}

/** Where the reader is: the view, and for every stop how open its screen and doorway are. */
type Moment = { view: View; at: Place; nearest: number; open: number[]; door: number[]; picture: number[] }

function moment(list: Stand[], scrollY: number, mode: Mode): Moment {
  const keys = list.map((s) => s.key)
  const at = place(keys, scrollY)
  const view = at.view
  const nearest = at.from === at.to ? at.from : at.u < 0.5 ? at.from : at.to

  const open: number[] = []
  const door: number[] = []
  const picture: number[] = []
  list.forEach((_, k) => {
    if (mode !== "flight") {
      open.push(k === nearest ? 1 : 0)
      door.push(k === nearest ? 1 : 0.4)
      picture.push(1)
      return
    }
    if (at.from === k && at.to === k) {
      open.push(1)
      door.push(1)
      picture.push(1)
    } else if (at.to === k) {
      door.push(ramp(0.3, 0.62, at.u))
      open.push(ramp(0.5, 0.86, at.u))
      picture.push(ramp(0.7, 0.98, at.u))
    } else if (at.from === k) {
      picture.push(1 - ramp(0.02, 0.24, at.u))
      open.push(1 - ramp(0.08, 0.36, at.u))
      door.push(1 - 0.6 * ramp(0.2, 0.5, at.u))
    } else {
      open.push(0)
      picture.push(0)
      door.push(k < at.from ? 0.4 : 0)
    }
  })
  return { view, at, nearest, open, door, picture }
}

/**
 * A chapter's realm, hung over its screen's outer top corner, a few edges behind it, and turned so
 * its doorway looks out at the camera and down at the screen: the screen came out of that doorway,
 * and the light still runs from one to the other. Placed by where it should land on the page at the
 * chapter's own view, so it sits in the room the layout leaves above the screen, whatever its size.
 */
function chapterRealm(stand: Stand, slot: Rect, height: number, t: number, index: number, turned: number): Pose {
  const view = stand.key.view
  const b = basis(view)
  const side = stand.side ?? 1
  const room = Math.max(slot[1], 0)
  // Its edge in px, and how much of the page the whole cube takes, turned as it is.
  const px = clamp(room * 0.62, 56, 96)
  const extent = px * 1.5
  const size = 1
  const z = (view.focal * size) / px
  const x = side > 0 ? slot[0] + slot[2] - extent * 0.6 : slot[0] + extent * 0.6
  const y = clamp(slot[1] - extent * 0.42, extent * 0.5 + 8, height * 0.4)
  const ray = rayAt(view, b, x, y)
  const along = z / Math.max(dot(ray, b.fwd), 1e-3)
  const sway: Vec3 = [Math.sin(t * 0.31 + index) * 0.08, Math.cos(t * 0.23 + index * 2) * 0.06, Math.sin(t * 0.27 + index * 3) * 0.1]
  const at = add(add(view.eye, mul(ray, along)), sway)
  // Turned as the mark is drawn: its doorway a little to one side of the eye, so a wall shows beside
  // it, and pitched down toward the screen under it, so its top is what faces the reader. A slow turn
  // either way about that, so it is never quite still.
  const toEye = normalize(sub3(view.eye, at))
  // A hand near it turns it to the reader: its doorway square to them, its top still showing.
  const heading = Math.atan2(toEye[1], toEye[0]) - side * 0.5 * (1 - turned) + Math.sin(t * 0.17 + index * 1.7) * 0.08 * (1 - turned)
  const pitch = lerp(-0.62, -0.32, turned) + Math.sin(t * 0.13 + index) * 0.04
  return facing(at, [Math.cos(pitch) * Math.cos(heading), Math.cos(pitch) * Math.sin(heading), Math.sin(pitch)], size)
}

/**
 * A realm turned to an eye as the mark is drawn for it: the doorway a little to the right of the eye,
 * the left wall beside it, and pitched toward the eye so its top shows.
 */
function presented(at: Vec3, eye: Vec3, size: number, aside = 0.5, down = 0.42): Pose {
  const toEye = normalize(sub3(eye, at))
  const heading = Math.atan2(toEye[1], toEye[0]) + aside
  const pitch = Math.asin(clamp(toEye[2], -1, 1)) - down
  return facing(at, [Math.cos(pitch) * Math.cos(heading), Math.cos(pitch) * Math.sin(heading), Math.sin(pitch)], size)
}

/** A direction turned about the vertical by `angle` (anticlockwise seen from above). */
const spun = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]
}

type Node = { el: HTMLElement; last: string }

/** A realm the reader has a hand on: how near the pointer is, how far it has turned to them, how
 *  open its doorway is, and when it was thrown open. */
type Touch = { hover: number; turn: number; open: number; opened: number; glow: number; until: number }

/** A hand-off between two realms of the sky: from one doorway to the other, over `duration` seconds. */
type Pulse = { from: number; to: number; start: number; duration: number }

export const createRealms: StageFactory = async (gpu, output) => {
  const zero = [0, 0, 0, 0]
  const special = () => Array.from({ length: 5 }, () => [0, 0, 0, 0])
  const scene: SceneUniforms = {
    eye: [0, 0, 10, 1500],
    fwd: [0, 1, 0, 0.05],
    right: [1, 0, 0, RENDER_SCALE],
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
    touched: Array.from({ length: TOUCHED }, () => [...special().slice(0, 4), [-1, 0, 0, 0]]).flat(),
    page: Array.from({ length: PAGE_REALMS }, special).flat(),
  }
  const comp: CompositeUniforms = {
    view: [1, 1, 1, 0],
    look: [0, 0, 0, 0],
    cam: Array.from({ length: 4 }, () => [...zero]),
    clear: Array.from({ length: CLEAR * 2 }, () => [...zero]),
    panels: Array.from({ length: PANELS * 2 }, () => [...zero]),
    beams: Array.from({ length: BEAMS * 6 }, () => [...zero]),
    pulses: Array.from({ length: PULSES * 5 }, () => [...zero]),
    fence: Array.from({ length: 9 }, () => [...zero]),
  }

  const population = populate()
  let realmsNow: Realm[] = population
  const realmData: RealmData = { items: packRealms(population) }

  const sizeOf = (scale: number): [number, number] => [
    Math.max(1, Math.round(window.innerWidth * scale)),
    Math.max(1, Math.round(window.innerHeight * scale)),
  ]
  let size = sizeOf(RENDER_SCALE)
  let spaceSize = sizeOf(SPACE_SCALE)
  const world = target(gpu, { size, format: "rgba16float", depth: "depth32float", msaa: true, label: "realms-world" })
  const space = target(gpu, { size: spaceSize, format: "rgba16float", label: "realms-space" })
  const linear = sampler(gpu, { minFilter: "linear", magFilter: "linear" })

  const sky = effect(gpu, spaceShader, { label: "realms-space", set: { scene } })
  const realms = draw(gpu, {
    label: "realms-realm",
    shader: sceneShader,
    entry: { vertex: "vs_realm", fragment: "fs_realm" },
    cull: "back",
    depth: { write: true, compare: "greater" },
    set: { scene, realms: realmData, spaceTex: space, spaceSampler: linear },
  })
  const blackHole = new BlackHole()
  const backdrop = draw(gpu, {
    label: "realms-sky",
    shader: sceneShader,
    entry: { vertex: "vs_sky", fragment: "fs_sky" },
    vertices: 3,
    depth: { write: false, compare: "greater-equal" },
    set: { scene, hole: holeOff(), spaceTex: space, spaceSampler: linear },
  })
  const additive = { color: { src: "one", dst: "one" }, alpha: { src: "zero", dst: "one" } } as const
  const glows = draw(gpu, {
    label: "realms-glow",
    shader: sceneShader,
    entry: { vertex: "vs_glow", fragment: "fs_glow" },
    blend: additive,
    depth: { write: false, compare: "greater" },
    set: { scene, realms: realmData },
  })
  const stars = draw(gpu, {
    label: "realms-stars",
    shader: sceneShader,
    entry: { vertex: "vs_star", fragment: "fs_star" },
    blend: additive,
    depth: { write: false, compare: "greater" },
    set: { scene },
  })
  const composite = effect(gpu, compositeShader, { label: "realms-composite", set: { comp, sceneTex: world, sceneSampler: linear } })

  if (process.env.NODE_ENV !== "production") {
    // Surface the compiler's own words in development: vgpu reports only that compilation failed.
    for (const [name, code] of [["space", spaceShader], ["scene", sceneShader], ["composite", compositeShader]] as const) {
      const info = await gpu.gpu.createShaderModule({ code, label: name }).getCompilationInfo()
      for (const m of info.messages) if (m.type === "error") console.error(`[realms ${name}] ${m.lineNum}:${m.linePos} ${m.message}`)
    }
  }
  await Promise.all([realms.compile(world), backdrop.compile(world), glows.compile(world), stars.compile(world)])

  const follow = new Follow(9)
  const lamp = { x: 0, y: 0, presence: 0 }
  let sway = 0
  let lastSeconds = -1
  let mode: Mode | null = null
  let cleared = ""
  let prev: { view: View; b: Basis; seconds: number } | null = null
  let spaceDrawn = ""
  let spaceFrame = 0
  const root = document.documentElement
  const screens = new Map<string, Node>()
  const realmites = new Map<string, Node>()
  /** The keyboard's keys to the chapters' realms (RealmKey), by chapter. */
  const keys = new Map<string, Node>()
  /** The panes words sit on (FieldPanel), by their anchor: each one's corner as drawn right now. */
  const panes = new Map<string, number>()

  // ---- the reader's hand ------------------------------------------------------------------------
  /** Realms the reader is touching, by index: the sky's from 0, the page's from MAX_REALMS. */
  const touches = new Map<number, Touch>()
  const hand = { x: -1, y: -1, over: false, inside: false, clicked: false, clickX: 0, clickY: 0, key: "" }
  /** Content under the pointer takes the pointer: words, pictures, controls. */
  const CONTENT = "a,button,input,select,textarea,summary,label,[data-field-panel],[data-screen],[data-field-anchor='portal'],header,footer,[role='button']"
  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return
    hand.x = event.clientX
    hand.y = event.clientY
    hand.inside = true
    const target = event.target instanceof Element ? event.target : null
    // A realm's own key is the realm, not content over it.
    const key = target?.closest<HTMLElement>("[data-realm-key]")
    hand.key = key?.dataset.realmKey ?? ""
    hand.over = !key && target?.closest(CONTENT) != null
  }
  const onLeave = () => {
    hand.inside = false
  }
  const onClick = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest(CONTENT)) return
    if (event.target instanceof Element && event.target.closest("[data-realm-key]")) return
    hand.clicked = true
    hand.clickX = event.clientX
    hand.clickY = event.clientY
  }
  window.addEventListener("pointermove", onMove, { passive: true })
  root.addEventListener("pointerleave", onLeave)
  window.addEventListener("click", onClick)
  let hovered = -1
  let cursor = false

  // ---- the sky's own events ---------------------------------------------------------------------
  const pulses: Pulse[] = []
  let nextPulse = 3
  let flare = { at: [0, 0, 0] as Vec3, start: -100 }
  let nextFlare = 6

  const nodes = () => {
    panes.clear()
    for (const el of document.querySelectorAll<HTMLElement>("[data-field-panel]")) {
      const name = el.dataset.fieldAnchor
      if (!name) continue
      // A caption rides its screen's scale in the flight; its corner scales with it.
      const scale = el.offsetWidth > 0 ? el.getBoundingClientRect().width / el.offsetWidth : 1
      panes.set(name, Number(el.dataset.fieldPanel) * scale)
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-screen]")) {
      const id = el.dataset.screen!
      if (screens.get(id)?.el !== el) screens.set(id, { el, last: "" })
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-realmite]")) {
      const id = el.dataset.realmite!
      if (realmites.get(id)?.el !== el) realmites.set(id, { el, last: "" })
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-realm-key]")) {
      const id = el.dataset.realmKey!
      if (keys.get(id)?.el !== el) keys.set(id, { el, last: "" })
    }
  }

  const write = (node: Node, css: string) => {
    if (node.last === css) return
    node.last = css
    node.el.style.cssText = css
  }

  /**
   * The pointer's lamp on a picture's rim (Screen's `.screen-light`): where the lamp is in the
   * picture's own unscaled box, and how present it is. Only the rim takes it, so nothing is laid over
   * the picture; under reduced motion the lamp is out and the rim is its resting outline.
   */
  const rimLamp = (x: number, y: number) =>
    lamp.presence < 0.002 ? "" : `--lx:${x.toFixed(1)}px;--ly:${y.toFixed(1)}px;--lamp:${lamp.presence.toFixed(3)}`

  const setMode = (next: Mode) => {
    if (next === mode) return
    mode = next
    root.dataset.realmsFlight = next === "flight" ? "on" : "off"
    root.dataset.realmsWorld = next === "drift" ? "off" : "on"
    for (const node of screens.values()) write(node, "")
    follow.reset()
  }

  /**
   * Clear the sky out of the page's way: in front of every stop's camera, as far as the page's own
   * realms hang, nothing may stand between the reader and the screen or the words; and nothing may
   * hang where the camera passes between stops. Worked out again whenever the stops move.
   */
  const clearSky = (list: Stand[], width: number, height: number) => {
    const views = list.map((s) => ({ view: s.key.view, b: basis(s.key.view), keep: s.keepClear, words: s.words }))
    const path: Vec3[] = []
    for (let k = 0; k + 1 < list.length; k++) {
      const a = list[k]!.key
      const z = list[k + 1]!.key
      for (let i = 0; i <= 24; i++) path.push(blend(a.view, z.view, i / 24, a.lift).eye)
    }
    if (mode === "drift" && list[0]) {
      const open = list[0].key.view
      for (let i = 0; i <= 60; i++) path.push([open.eye[0] + Math.cos(open.yaw) * i * 5, open.eye[1] + Math.sin(open.yaw) * i * 5, open.eye[2]])
    }
    realmsNow = clearOff(population, (at, size) => {
      for (const p of path) if (length3(sub3(at, p)) < 3 + size * 0.9) return false
      for (const { view, b, keep, words } of views) {
        const [x, y, z] = project(view, b, at)
        if (z <= 0.3) continue
        const r = (view.focal * size) / z + 40
        if (z <= keep + size && x > -r && x < width + r && y > -r && y < height + r) return false
        // Behind the words a stop is read at, nothing near enough to be more than a point.
        if (words && z < 140 && x > words[0] - r && x < words[0] + words[2] + r && y > words[1] - r && y < words[1] + words[3] + r) return false
      }
      return true
    })
    realmData.items = packRealms(realmsNow)
    realms.set({ realms: realmData })
    glows.set({ realms: realmData })
  }

  /** The pose of realm `index` (the sky's, or the page's past MAX_REALMS) as drawn last. */
  const pagePoses: (Pose | null)[] = Array.from({ length: PAGE_REALMS }, () => null)
  const naturalPose = (index: number, t: number): Pose | null => {
    if (index >= MAX_REALMS) return pagePoses[index - MAX_REALMS] ?? null
    const realm = realmsNow[index]
    return realm && realm.size > 0 ? realmAt(realm, index, t) : null
  }

  const writeSpecial = (list: number[][], k: number, pose: Pose, glow: number, blue: number, open: number, index: number, hover: number) => {
    list[k * 5] = [...pose.at, Math.hypot(...pose.z)]
    list[k * 5 + 1] = [...pose.x, glow]
    list[k * 5 + 2] = [...pose.y, blue]
    list[k * 5 + 3] = [...pose.z, open]
    list[k * 5 + 4] = [index, hover, 0, 0]
  }

  /** A beam from a doorway: to a far rect (a screen), or thrown out ahead of it. */
  const writeBeam = (
    k: number,
    view: View,
    b: Basis,
    width: number,
    height: number,
    door: [Vec3, Vec3, Vec3, Vec3],
    farMid: Vec3,
    farHalf: [number, number],
    light: number,
    kind: number,
    moment: number,
  ) => {
    const doorMid = mul(add(add(door[0], door[1]), add(door[2], door[3])), 0.25)
    const across0 = sub3(door[1], door[0])
    const up0 = sub3(door[3], door[0])
    const axisRaw = sub3(farMid, doorMid)
    const L = length3(axisRaw)
    if (L < 1e-3 || light <= 0.001) {
      comp.beams[k * 6 + 1] = [0, 0, 1, 0]
      return
    }
    const axis = mul(axisRaw, 1 / L)
    const u = normalize(sub3(across0, mul(axis, dot(across0, axis))))
    const v = normalize(cross(axis, u))
    const vUp = dot(v, up0) < 0 ? mul(v, -1) : v
    const hu0 = length3(across0) / 2
    const hv0 = length3(up0) / 2
    // The beam's rect on the page: its eight corners projected, grown a little.
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [s, hu, hv] of [
      [0, hu0, hv0],
      [L, farHalf[0], farHalf[1]],
    ] as const) {
      for (const [a, c] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const p = add(add(add(doorMid, mul(axis, s)), mul(u, a * hu)), mul(vUp, c * hv))
        const [x, y, z] = project(view, b, p)
        if (z <= 0.05) {
          x0 = -1e4
          y0 = -1e4
          x1 = 1e4
          y1 = 1e4
          continue
        }
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
    }
    comp.beams[k * 6] = [...doorMid, L]
    comp.beams[k * 6 + 1] = [...axis, light]
    comp.beams[k * 6 + 2] = [...u, hu0]
    comp.beams[k * 6 + 3] = [...vUp, hv0]
    comp.beams[k * 6 + 4] = [farHalf[0], farHalf[1], kind, moment]
    comp.beams[k * 6 + 5] = [Math.max(x0 - 6, 0), Math.max(y0 - 6, 0), Math.min(x1 + 6, width), Math.min(y1 + 6, height)]
  }

  return {
    draw(frame, input) {
      const { width, height } = input
      const scrollY = window.scrollY
      const t = input.seconds
      const dt = lastSeconds < 0 ? 0 : t - lastSeconds
      lastSeconds = t
      setMode(input.still ? "still" : width < 1024 ? "drift" : "flight")
      nodes()

      const list = stands(input, scrollY, mode!)
      if (list.length === 0) return

      // The sky cleared out of the page's way, whenever the stops move.
      const eyes = `${mode}|${width}x${height}|${list.map((s) => `${s.key.view.eye.map((v) => v.toFixed(2)).join(",")}@${s.key.view.px.toFixed(0)},${s.key.view.py.toFixed(0)}`).join(";")}`
      if (eyes !== cleared) {
        cleared = eyes
        clearSky(list, width, height)
      }

      // ---- the camera ------------------------------------------------------------------------
      const now = moment(list, scrollY, mode!)
      let view: View = now.view
      if (mode === "drift") {
        // A phone: the opening's view, carried slowly up the route as the page scrolls, then the same
        // lift to the deep sky at the end, where the black hole comes up under the links.
        const open = list[0]!.key.view
        const travel = scrollY * 0.014
        view = { ...open, eye: [open.eye[0] + Math.cos(open.yaw) * travel, open.eye[1] + Math.sin(open.yaw) * travel, open.eye[2]] }
        const into = list.find((s) => s.key.kind === "finale")
        if (into) {
          const from = Math.max(0, into.key.y - height * 1.4)
          const u = clamp((scrollY - from) / Math.max(into.key.y - from, 1), 0, 1)
          if (u > 0) view = blend(view, into.key.view, u, 0)
        }
      } else if (mode === "still") {
        // Reduced motion: each stop's own composed view, redrawn as the reader moves between them.
        view = list[now.nearest]!.key.view
      }

      // The pointer: a lamp on the screens' rims, and the smallest sway of the camera about the stop's
      // pivot, so what is at rest on the page stays where it is.
      const [pointerX, pointerY, presence] = input.pointer
      const k = input.still ? 1 : 1 - Math.exp(-Math.max(dt, 0) / 0.6)
      if (lamp.presence < 0.001) {
        lamp.x = pointerX
        lamp.y = pointerY
      }
      lamp.x += (pointerX - lamp.x) * k
      lamp.y += (pointerY - lamp.y) * k
      lamp.presence += ((input.still ? 0 : presence) - lamp.presence) * k
      sway += ((pointerX / Math.max(width, 1) - 0.5) * presence - sway) * k

      if (mode === "flight") {
        view = follow.step(view, dt)
        view = orbit(view, list[now.nearest]!.key.pivot, -sway * 0.9 * DEG)
      }
      const b = basis(view)

      // ---- the page's own realms: each chapter's, over its screen, and the team's ----------------
      const panels: number[][] = []
      const clears: [Rect, number, number][] = []
      /** How present each screen's caption is: a caption has its pane only while it can be seen. */
      const captions = new Map<string, number>()
      const visible = (r: Rect) => r[2] > 0 && r[1] < height + 160 && r[1] + r[3] > -160 && r[0] < width + 160 && r[0] + r[2] > -160
      const progress = now.at.from + now.at.u
      const teams = list.findIndex((s) => s.team)
      const beamsNow: { door: [Vec3, Vec3, Vec3, Vec3]; mid: Vec3; half: [number, number]; light: number; kind: number; moment: number; reach: number }[] = []
      let fence: { pose: Pose; amount: number } | null = null
      let pageCount = 0
      const pageIndex = new Map<string, number>()

      list.forEach((stand, index) => {
        const opening = now.open[index]!
        const id = stand.key.id
        if (stand.foot && stand.slot && stand.depth !== undefined && pageCount < PAGE_REALMS) {
          const slotNow = input.anchors[`s:${id}`]
          const slotAtKey: Rect = slotNow ? rest(slotNow, scrollY, stand.key.y) : [0, 0, stand.slot[0], stand.slot[1]]
          const pose = chapterRealm(stand, slotAtKey, height, t, index, smooth(touches.get(MAX_REALMS + pageCount)?.turn ?? 0))
          const near = Math.max(0, 1 - Math.abs(index - progress))
          const slot = pageCount++
          pageIndex.set(id, slot)
          pagePoses[slot] = pose
          const touch = touches.get(MAX_REALMS + slot)
          const glow = mode === "still" ? 0.75 : Math.max(now.door[index]!, 0.35 * near)
          writeSpecial(scene.page, slot, pose, glow + (touch?.glow ?? 0), 0, touch?.open ?? 0, -1, touch?.hover ?? 0)
          if (id === "sandbox" && mode !== "drift") fence = { pose, amount: mode === "still" ? (now.nearest === index ? 1 : 0) : smooth(Math.max(opening, 1 - Math.abs(index - progress) * 1.2)) }
        }
        if (stand.team) {
          const here = mode === "still" ? (now.nearest === index ? 1 : 0) : Math.max(0, 1 - Math.abs(index - progress) * 0.9)
          stand.team.forEach((at, r) => {
            if (pageCount >= PAGE_REALMS) return
            const role = ROLES[r]
            const node = role ? realmites.get(role.id) : undefined
            const state = node?.el.dataset.state
            const picked = node?.el.dataset.picked !== undefined
            const toEye = normalize(sub3(stand.key.view.eye, at))
            const bobbing: Vec3 = [0, 0, Math.sin(t * 0.5 + r * 1.9) * 0.06]
            const turned = smooth(touches.get(MAX_REALMS + pageCount)?.turn ?? 0)
            const pose = facing(add(at, bobbing), spun([toEye[0], toEye[1], toEye[2] * 0.6 * turned], 0.5 * (1 - turned)), 1)
            const slot = pageCount++
            pageIndex.set(`team-${r}`, slot)
            pagePoses[slot] = pose
            // A doorway says what its role's run is doing: lit at work, Realm's blue when it needs you,
            // low when idle, dark when it is done for the day; the role picked on the board is a step
            // brighter.
            const base = state === "working" ? 1 : state === "needs-you" ? 0.9 : state === "idle" ? 0.22 : 0
            const touch = touches.get(MAX_REALMS + slot)
            writeSpecial(scene.page, slot, pose, Math.min(1.2, (base + (picked ? 0.35 : 0)) * Math.max(here, 0.25)) + (touch?.glow ?? 0), state === "needs-you" ? 1 : 0, touch?.open ?? 0, -1, touch?.hover ?? 0)
          })
        }

        const node = screens.get(id)
        if (!node || !stand.slot || !stand.foot || stand.depth === undefined) return
        const pictureOn = now.picture[index]!
        // The picture's own corner (Screen's `data-radius`, a share of its width), so the light drawn
        // round it follows the surface it shows: a window's corner, a picker's, a column's.
        const corner = Number(node.el.dataset.radius ?? 0)
        const slot = pageIndex.get(id)
        const pose = slot !== undefined ? pagePoses[slot] : null
        if (mode === "flight") {
          const [bx, by, z] = project(view, b, stand.foot)
          const shown = z > 0.6 && pictureOn > 0.001
          const s = stand.depth / Math.max(z, 1e-3)
          const w = stand.slot[0] * s
          const h = stand.slot[1] * s
          const left = bx - w / 2
          const top = by - h
          write(
            node,
            shown
              ? `width:${stand.slot[0].toFixed(1)}px;height:${stand.slot[1].toFixed(1)}px;transform:translate3d(${left.toFixed(2)}px,${top.toFixed(2)}px,0) scale(${s.toFixed(4)});opacity:${pictureOn.toFixed(3)};${rimLamp((lamp.x - left) / s, (lamp.y - top) / s)}`
              : `width:${stand.slot[0].toFixed(1)}px;height:${stand.slot[1].toFixed(1)}px;opacity:0;pointer-events:none`,
          )
          if (shown) captions.set(id, pictureOn)
          if (!pose) return
          const door = doorCorners(pose)
          const W = (stand.slot[0] * stand.depth) / stand.key.view.focal
          const H = (stand.slot[1] * stand.depth) / stand.key.view.focal
          const screenMid = add(stand.foot, [0, 0, H / 2])
          if (z > 0.6 && (opening > 0.001 || pictureOn > 0.001) && panels.length < PANELS * 2) {
            // The doorway's own rect on the page, opening out into the screen's.
            const corners = door.map((p) => project(view, b, p))
            const xs = corners.map((c) => c[0])
            const ys = corners.map((c) => c[1])
            const doorRect: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
            // It has reached the screen's rect by the time the picture starts to fade in over it.
            const e = smoother(opening / 0.6)
            const rect: Rect = [lerp(doorRect[0], left, e), lerp(doorRect[1], top, e), lerp(doorRect[2], w, e), lerp(doorRect[3], h, e)]
            // The doorway's light, spread over the rect as it grows: bright while it is the doorway, dim
            // by the time it is the screen, and gone under the picture.
            const spread = Math.min(1, ((doorRect[2] * doorRect[3]) / Math.max(rect[2] * rect[3], 1)) ** 0.55)
            // Opaque while it opens (nothing shows through a picture still arriving); on the way out it
            // goes with the picture, so no dark rect is left behind it.
            const leaving = now.at.from === index && now.at.to !== index
            const fill = leaving ? pictureOn : smooth(Math.min(1, opening * 2.4))
            panels.push([...rect], [fill, lerp(1.5, corner * w, e), pictureOn, (0.35 + 0.65 * spread) * (1 - pictureOn) * smooth(opening)])
          }
          // The light from the doorway to the screen, as it opens out and while it is there.
          const reach = Math.max(opening, pictureOn)
          if (reach > 0.001 && z > 0.6) {
            const e = smoother(opening / 0.6)
            const mid = mix3(mul(add(add(door[0], door[1]), add(door[2], door[3])), 0.25), screenMid, Math.max(e, 0.04))
            const half: [number, number] = [lerp(0.2, W * 0.48, e), lerp(0.4, H * 0.48, e)]
            beamsNow.push({ door, mid, half, light: 0.55 + 0.7 * (1 - pictureOn) * smooth(opening), kind: 0, moment: index * 0.37, reach })
          }
        } else {
          // In the slot: the screen is where the layout put it, and its light is read from there.
          const slotRect = input.anchors[`s:${id}`]
          write(node, slotRect ? rimLamp(lamp.x - slotRect[0], lamp.y - slotRect[1]) : "")
          captions.set(id, 1)
          if (slotRect && visible(slotRect) && panels.length < PANELS * 2) panels.push([...slotRect], [0, corner * slotRect[2], 1, 0])
        }
      })
      for (let k = pageCount; k < PAGE_REALMS; k++) {
        pagePoses[k] = null
        scene.page[k * 5] = [0, 0, 0, 0]
      }

      // The Realmites, standing at their doors.
      for (const [roleIndex, role] of ROLES.entries()) {
        const node = realmites.get(role.id)
        if (!node) continue
        const stand = list[teams]
        const slot = pageIndex.get(`team-${roleIndex}`)
        const pose = slot !== undefined ? pagePoses[slot] : null
        if (!stand || !pose || mode === "drift") {
          write(node, "")
          continue
        }
        const here = mode === "still" ? (now.nearest === teams ? 1 : 0) : Math.max(0, 1 - Math.abs(teams - progress) * 1.6)
        const [x, y, z] = project(view, b, doorSill(pose))
        const px = (0.46 * view.focal) / Math.max(z, 1e-3)
        const s = px / WORLD_REALMITE
        const shown = z > 0.8 && here > 0.01
        write(
          node,
          shown
            ? `width:${WORLD_REALMITE}px;height:${WORLD_REALMITE}px;transform:translate3d(${(x - px / 2).toFixed(2)}px,${(y - px * 0.94).toFixed(2)}px,0) scale(${s.toFixed(4)});opacity:${smooth(here).toFixed(3)};visibility:visible`
            : `width:${WORLD_REALMITE}px;height:${WORLD_REALMITE}px;opacity:0;visibility:hidden`,
        )
      }

      // The keyboard's keys, each over its chapter's realm while that is in view.
      for (const [id, node] of keys) {
        const slot = pageIndex.get(id)
        const pose = slot !== undefined ? pagePoses[slot] : null
        let css = ""
        if (pose && mode !== "still") {
          let x0 = Infinity
          let y0 = Infinity
          let x1 = -Infinity
          let y1 = -Infinity
          let behind = false
          for (const cx of [-0.5, 0.5]) for (const cy of [-0.5, 0.5]) for (const cz of [-0.5, 0.5]) {
            const [x, y, z] = project(view, b, inWorld(pose, [cx, cy, cz]))
            if (z < 1) behind = true
            x0 = Math.min(x0, x)
            y0 = Math.min(y0, y)
            x1 = Math.max(x1, x)
            y1 = Math.max(y1, y)
          }
          const w = x1 - x0
          const h = y1 - y0
          if (!behind && w > 24 && w < width && x1 > 0 && y1 > 0 && x0 < width && y0 < height) {
            css = `width:${(w + 12).toFixed(1)}px;height:${(h + 12).toFixed(1)}px;transform:translate3d(${(x0 - 6).toFixed(1)}px,${(y0 - 6).toFixed(1)}px,0);visibility:visible`
          }
        }
        write(node, css)
      }

      // The working sample is a lit screen too: the same breath of light at its edge as every chapter's.
      const portal = input.anchors.portal
      if (portal && visible(portal) && panels.length < PANELS * 2) panels.push([...portal], [0, 16, 0.85, 0])

      // ---- the words the field keeps clear of ----------------------------------------------
      for (const [name, rect] of Object.entries(input.anchors)) {
        if (!(name === "copy" || name.startsWith("k:") || name.startsWith("c:")) || !visible(rect)) continue
        // A caption's pane comes and goes with its picture; one whose picture is away is not there.
        const present = name.startsWith("c:caption-") ? captions.get(name.slice("c:caption-".length)) ?? 0 : 1
        if (present > 0.02) clears.push([rect, panes.get(name) ?? -1, 1 - (1 - PANE_FIELD) * present])
      }

      // ---- the reader's hand on the realms -------------------------------------------------------
      const live = mode !== "still"
      const reaching = live && hand.inside && !hand.over
      let found = -1
      if (reaching) {
        // The realm nearest the pointer that it is over or close beside, in front of any other.
        let best = Infinity
        const consider = (index: number, pose: Pose) => {
          const [x, y, z] = project(view, b, pose.at)
          if (z < 1) return
          const px = (view.focal * Math.hypot(...pose.z)) / z
          if (px < 10) return
          const reach = Math.max(px * 0.8, 22)
          const d = Math.hypot(x - hand.x, y - hand.y)
          if (d < reach && z < best) {
            best = z
            found = index
          }
        }
        for (let i = 0; i < realmsNow.length; i++) {
          const realm = realmsNow[i]!
          if (realm.size <= 0) continue
          const [x, y, z] = project(view, b, realm.at)
          if (z < 1) continue
          const px = (view.focal * realm.size) / z
          if (Math.abs(x - hand.x) > px + 40 || Math.abs(y - hand.y) > px + 40) continue
          const pose = naturalPose(i, t)
          if (pose) consider(i, pose)
        }
        for (let k = 0; k < pageCount; k++) {
          const pose = pagePoses[k]
          if (pose) consider(MAX_REALMS + k, pose)
        }
      }
      // A key with the focus, or under the pointer, is its realm.
      const focusedKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.realmKey : undefined
      for (const id of [focusedKey, hand.inside ? hand.key : ""]) {
        const slot = id ? pageIndex.get(id) : undefined
        if (live && slot !== undefined) found = MAX_REALMS + slot
      }
      for (const id of takeOpened()) {
        const slot = pageIndex.get(id)
        if (!live || slot === undefined) continue
        const index = MAX_REALMS + slot
        const touch = touches.get(index) ?? { hover: 0, turn: 0, open: 0, opened: -100, glow: 0, until: 0 }
        touch.opened = t
        touches.set(index, touch)
      }
      if (found !== hovered) hovered = found
      const wantCursor = hovered >= 0
      if (wantCursor !== cursor) {
        cursor = wantCursor
        root.style.cursor = cursor ? "pointer" : ""
      }
      if (hovered >= 0 && !touches.has(hovered)) touches.set(hovered, { hover: 0, turn: 0, open: 0, opened: -100, glow: 0, until: 0 })
      if (hand.clicked) {
        hand.clicked = false
        if (live && hovered >= 0) {
          const touch = touches.get(hovered)!
          touch.opened = t
        }
      }

      // ---- the sky's own events: a hand-off now and then, a flare in a nebula --------------------
      if (live && t >= nextPulse && pulses.length < PULSES) {
        nextPulse = t + 4 + Math.random() * 5
        const seen: number[] = []
        for (let i = 0; i < realmsNow.length; i++) {
          const realm = realmsNow[i]!
          if (realm.size <= 0) continue
          const [x, y, z] = project(view, b, realm.at)
          if (z < 14 || z > 70) continue
          if (x < 40 || y < 40 || x > width - 40 || y > height - 40) continue
          seen.push(i)
        }
        if (seen.length > 2) {
          const from = seen[Math.floor(Math.random() * seen.length)]!
          const a = realmsNow[from]!.at
          const near = seen.filter((i) => i !== from && length3(sub3(realmsNow[i]!.at, a)) > 6 && length3(sub3(realmsNow[i]!.at, a)) < 30)
          if (near.length) {
            const to = near[Math.floor(Math.random() * near.length)]!
            pulses.push({ from, to, start: t, duration: 1.6 + length3(sub3(realmsNow[to]!.at, a)) * 0.04 })
            for (const index of [from, to]) if (!touches.has(index)) touches.set(index, { hover: 0, turn: 0, open: 0, opened: -100, glow: 0, until: 0 })
            touches.get(from)!.until = Math.max(touches.get(from)!.until, t + 2.5)
          }
        }
      }
      if (live && t >= nextFlare) {
        nextFlare = t + 9 + Math.random() * 9
        flare = { at: NEBULAE[Math.floor(Math.random() * NEBULAE.length)]!, start: t }
      }
      const sinceFlare = t - flare.start
      const flareLight = live ? smooth(sinceFlare / 0.5) * Math.exp(-Math.max(sinceFlare - 0.5, 0) / 1.4) : 0

      // Each touch eases toward what the hand is doing to it.
      const touchList: number[] = []
      for (const [index, touch] of touches) {
        const over = index === hovered ? 1 : 0
        const ease = 1 - Math.exp(-Math.max(dt, 0) / 0.18)
        touch.hover += (over - touch.hover) * ease
        touch.turn += (Math.max(over, smooth(1 - (t - touch.opened) / 5)) - touch.turn) * (1 - Math.exp(-Math.max(dt, 0) / 0.45))
        const since = t - touch.opened
        touch.open = since < 0 ? 0 : smooth(since / 0.35) * (1 - smooth((since - 1.2) / 2.8))
        // A realm receiving a hand-off stays lit a while after it arrives.
        const sending = t < touch.until ? 1 : 0
        touch.glow += (Math.max(sending, touch.hover * 0.8) - touch.glow) * (1 - Math.exp(-Math.max(dt, 0) / 0.3))
        const busy = touch.hover > 0.002 || touch.turn > 0.002 || touch.open > 0.002 || touch.glow > 0.002 || t < touch.until
        if (!busy && index !== hovered) {
          touches.delete(index)
          continue
        }
        if (index < MAX_REALMS) touchList.push(index)
      }
      touchList.sort((a, z) => (touches.get(z)!.open + touches.get(z)!.hover) - (touches.get(a)!.open + touches.get(a)!.hover))
      for (let j = 0; j < TOUCHED; j++) {
        const index = touchList[j]
        const touch = index !== undefined ? touches.get(index) : undefined
        const natural = index !== undefined ? naturalPose(index, t) : null
        if (index === undefined || !touch || !natural) {
          scene.touched[j * 5] = [0, 0, 0, 0]
          scene.touched[j * 5 + 4] = [-1, 0, 0, 0]
          continue
        }
        // It turns toward the reader as the hand comes near, as the mark is drawn for them.
        const turned = between(natural, presented(natural.at, view.eye, Math.hypot(...natural.z)), smooth(touch.turn))
        writeSpecial(scene.touched, j, turned, touch.glow, 0, touch.open, index, touch.hover)
      }

      // The doorways thrown open: light pouring out of them toward the reader.
      for (const [index, touch] of touches) {
        if (touch.open <= 0.01 || beamsNow.length >= BEAMS) continue
        const natural = naturalPose(index, t)
        if (!natural) continue
        const pose = index < MAX_REALMS ? between(natural, presented(natural.at, view.eye, Math.hypot(...natural.z)), smooth(touch.turn)) : natural
        const door = doorCorners(pose)
        const out = normalize(mul(pose.y, -1))
        const s = Math.hypot(...pose.z)
        const mid = add(mul(add(add(door[0], door[1]), add(door[2], door[3])), 0.25), mul(out, 5 * s))
        beamsNow.unshift({ door, mid, half: [1.1 * s, 1.5 * s], light: 1.1 * touch.open, kind: 1, moment: index * 0.13, reach: touch.open })
      }

      // The hand-offs in flight: a point of light from one doorway to the other.
      for (let k = 0; k < PULSES; k++) comp.pulses[k * 5] = [0, 0, 0, 0]
      for (let k = pulses.length - 1; k >= 0; k--) {
        const pulse = pulses[k]!
        const u = (t - pulse.start) / pulse.duration
        const a = naturalPose(pulse.from, t)
        const z = naturalPose(pulse.to, t)
        if (u > 1 || !a || !z || !live) {
          if (z && u > 1) {
            const touch = touches.get(pulse.to) ?? { hover: 0, turn: 0, open: 0, opened: -100, glow: 0, until: 0 }
            touch.until = t + 10
            touches.set(pulse.to, touch)
          }
          pulses.splice(k, 1)
        }
      }
      pulses.forEach((pulse, k) => {
        const a = naturalPose(pulse.from, t)
        const z = naturalPose(pulse.to, t)
        if (!a || !z) return
        const from = inWorld(a, [0, -0.62, 0])
        const to = inWorld(z, [0, -0.62, 0])
        const span = length3(sub3(to, from))
        const lift: Vec3 = mul(normalize(cross(sub3(to, from), b.fwd)), span * 0.18)
        const along = (s: number): Vec3 => {
          const c = clamp(s, 0, 1)
          return add(mix3(from, to, c), mul(lift, Math.sin(Math.PI * c)))
        }
        const u = (t - pulse.start) / pulse.duration
        const head = smoother(u)
        for (let i = 0; i < 5; i++) {
          const s = head - i * 0.06
          const p = along(s)
          const [x, y, depth] = project(view, b, p)
          const d = length3(sub3(p, view.eye))
          const fade = s < 0 ? 0 : (1 - i / 5) * smooth(u / 0.1) * (1 - smooth((u - 0.92) / 0.08))
          comp.pulses[k * 5 + i] = depth > 0.5 ? [x, y, d, fade * 1.2] : [0, 0, 0, 0]
        }
      })

      // ---- the hour, and the haze ----------------------------------------------------------------
      const fa = list[now.at.from]!.haze
      const fz = list[now.at.to]!.haze
      const e = smoother(now.at.u)
      let hazeStart = lerp(fa[0], fz[0], e)
      let hazeDensity = Math.exp(lerp(Math.log(fa[1]), Math.log(fz[1]), e))
      if (mode === "drift") [hazeStart, hazeDensity] = list[0]!.haze
      if (mode === "still") [hazeStart, hazeDensity] = list[now.nearest]!.haze

      // The finale's night: how far the camera has lifted its eyes to it, which the hole's stars take.
      const finaleIndex = list.findIndex((s) => s.key.kind === "finale")
      const lifted = finaleIndex < 0 ? 0 : mode === "still" ? (now.nearest >= finaleIndex ? 1 : 0) : smooth(clamp(progress - (finaleIndex - 1), 0, 1))

      // ---- the uniforms ----------------------------------------------------------------------------
      const last = prev ?? { view, b, seconds: t }
      scene.eye = [...view.eye, view.focal]
      scene.fwd = [...b.fwd, 0.05]
      scene.right = [...b.right, RENDER_SCALE]
      scene.up = [...b.up, 0]
      scene.view = [width, height, view.px, view.py]
      scene.clock = [t, input.still ? 1 : 0, DOOR_SHARE, last.seconds]
      scene.prevEye = [...last.view.eye, last.view.focal]
      scene.prevFwd = [...last.b.fwd, last.view.px]
      scene.prevRight = [...last.b.right, last.view.py]
      scene.prevUp = [...last.b.up, 0]
      const drifted = sub3(view.eye, mul(STAR_DRIFT, t))
      scene.stars = [
        Math.floor(drifted[0] / STAR_CELL) - STAR_BLOCK / 2,
        Math.floor(drifted[1] / STAR_CELL) - STAR_BLOCK / 2,
        Math.floor(drifted[2] / STAR_CELL) - STAR_BLOCK / 2,
        (STAR_BLOCK / 2 - 1) * STAR_CELL,
      ]
      scene.haze = [hazeStart, hazeDensity, t * SKY_TURN, 0]
      scene.flare = [...flare.at, flareLight]
      const holeRect = input.anchors.hole
      scene.holeBox = holeRect && holeRect[1] < height && holeRect[1] + holeRect[3] > 0 ? [holeRect[0], holeRect[1], holeRect[0] + holeRect[2], holeRect[1] + holeRect[3]] : [0, 0, 0, 0]
      prev = { view, b, seconds: t }

      // The beams: those of the screens in view and the doorways thrown open, the strongest first.
      beamsNow.sort((a, z) => z.reach * z.light - a.reach * a.light)
      for (let k = 0; k < BEAMS; k++) {
        const beam = beamsNow[k]
        if (!beam) {
          comp.beams[k * 6 + 1] = [0, 0, 1, 0]
          continue
        }
        writeBeam(k, view, b, width, height, beam.door, beam.mid, beam.half, beam.light * (beam.kind === 0 ? smooth(beam.reach) : 1), beam.kind, beam.moment)
      }

      // The confined realm's boundary.
      if (fence) {
        const { pose, amount } = fence as { pose: Pose; amount: number }
        const r = 1.3
        const corners: Vec3[] = []
        for (const zz of [-1, 1]) for (const [xx, yy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) corners.push(inWorld(pose, [xx * r, yy * r, zz * r]))
        corners.forEach((p, i) => {
          const [x, y, depth] = project(view, b, p)
          comp.fence[i] = depth > 0.3 ? [x, y, length3(sub3(p, view.eye)), 0] : [0, 0, 0, 0]
        })
        comp.fence[8] = [amount, 0, 0, 0]
      } else comp.fence[8] = [0, 0, 0, 0]

      const clearList = clears.slice(0, CLEAR)
      while (panels.length < PANELS * 2) panels.push([...zero])
      const dpr = output.size[0] / Math.max(width, 1)
      comp.view = [width, height, dpr, t]
      comp.look = [input.still ? 1 : 0, clearList.length, 0, 0]
      comp.cam = [
        [...view.eye, view.focal],
        [...b.fwd, view.px],
        [...b.right, view.py],
        [...b.up, 0],
      ]
      comp.clear = [
        ...clearList.flatMap(([r, radius, inside]) => [[...r], [radius, inside, 0, 0]]),
        ...Array.from({ length: (CLEAR - clearList.length) * 2 }, () => [...zero]),
      ]
      comp.panels = panels.slice(0, PANELS * 2)

      const wanted = sizeOf(RENDER_SCALE)
      if (wanted[0] !== size[0] || wanted[1] !== size[1]) {
        size = wanted
        world.resize(size)
        composite.set({ sceneTex: world })
      }
      const wantedSpace = sizeOf(SPACE_SCALE)
      if (wantedSpace[0] !== spaceSize[0] || wantedSpace[1] !== spaceSize[1]) {
        spaceSize = wantedSpace
        space.resize(spaceSize)
        realms.set({ spaceTex: space })
        backdrop.set({ spaceTex: space })
        spaceDrawn = ""
      }

      // The black hole under the footer: retraced every frame it is on screen, since its disk turns.
      const holeNow = blackHole.frame({ view, b, rect: input.anchors.hole, width, height, seconds: t, dt, still: input.still, pointer: input.pointer })
      holeNow.uniforms.ax[3] = lifted

      sky.set({ scene })
      realms.set({ scene })
      backdrop.set({ scene, hole: holeNow.uniforms })
      glows.set({ scene })
      stars.set({ scene })
      composite.set({ comp })

      // The deep sky moves slowly: while the camera holds still it is redrawn every other frame.
      const camera = `${view.eye.map((v) => v.toFixed(3)).join(",")}|${b.fwd.map((v) => v.toFixed(4)).join(",")}|${view.px.toFixed(1)},${view.py.toFixed(1)}|${width}x${height}`
      const redrawSpace = camera !== spaceDrawn || spaceFrame++ % 2 === 0 || input.still
      spaceDrawn = camera
      if (redrawSpace) frame.pass({ target: space, clear: [0, 0, 0, 1] }, (pass) => pass.draw(sky))
      frame.pass({ target: world, clear: [0, 0, 0, 0], clearDepth: 0 }, (pass) => {
        pass.draw(realms, { vertices: REALM_VERTICES, instances: MAX_REALMS + PAGE_REALMS })
        pass.draw(backdrop, { vertices: 3 })
        pass.draw(glows, { vertices: 6, instances: MAX_REALMS + PAGE_REALMS })
        pass.draw(stars, { vertices: 6, instances: STAR_BLOCK * STAR_BLOCK * STAR_BLOCK })
      })
      frame.pass(output, composite)
    },
    dispose() {
      window.removeEventListener("pointermove", onMove)
      root.removeEventListener("pointerleave", onLeave)
      window.removeEventListener("click", onClick)
      root.style.cursor = ""
      delete root.dataset.realmsFlight
      delete root.dataset.realmsWorld
      for (const node of screens.values()) node.el.style.cssText = ""
      for (const node of realmites.values()) node.el.style.cssText = ""
    },
  }
}
