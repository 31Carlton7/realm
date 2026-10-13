import { draw, effect, sampler, target } from "vgpu"

import type { Rect, StageFactory, StageInput } from "@/components/field/stage"

import { BlackHole, holeOff } from "./blackhole"
import {
  basis,
  blend,
  clamp,
  dot,
  Follow,
  lerp,
  orbit,
  place,
  project,
  ramp,
  rayThrough,
  smooth,
  smoother,
  sub,
  type Key,
  type Place,
  type Vec3,
  type View,
} from "./camera"
import { CHAPTERS, CLIMB, FINALE, OPENING, TEAM } from "./route"
import {
  CLEAR,
  compositeShader,
  LIT,
  PANELS,
  PLAZAS,
  SCREENS,
  sceneShader,
  type CompositeUniforms,
  type SceneUniforms,
} from "./shaders"
import { ROLES, WORLD_REALMITE } from "./Team"
import { cellCentre, DOOR, doorFoot, latticeOf, nearestCell, PLANET_RADIUS } from "./world"

const DEG = Math.PI / 180
/** Lattice cells drawn around the camera's look point, per side: fewer on a phone, whose drift
 *  looks down on a smaller patch of the field. */
const GRID = 64
const GRID_PHONE = 44
/** The realm mesh: thirteen quads, two triangles each. */
const REALM_VERTICES = 78
/** The scene is drawn at this many target pixels per CSS px (the canvas itself runs up to 1.5), and
 *  multisampled, so its edges stay clean where the canvas scales it up. */
const RENDER_SCALE = 1

type Mode = "flight" | "still" | "drift"

/** A stop of the flight, with what the page puts there: a screen, a team, or nothing. */
type Stand = {
  key: Key
  fog: [number, number]
  realm?: [number, number]
  foot?: Vec3
  /** The screen's size at rest in CSS px, and its foot's depth then. */
  slot?: [number, number]
  depth?: number
  cells?: [number, number][]
}

const rest = (r: Rect, scrollY: number, keyY: number): Rect => [r[0], r[1] + scrollY - keyY, r[2], r[3]]

/** The scroll position at which a block's middle is in the middle of the view. */
const centred = (r: Rect, scrollY: number, height: number) => scrollY + r[1] + r[3] / 2 - height / 2

function levelView(foot: Vec3, yaw: number, height: number, distance: number, focal: number, x: number, bottom: number): View {
  return {
    eye: [foot[0] - distance * Math.cos(yaw), foot[1] - distance * Math.sin(yaw), height],
    yaw,
    pitch: 0,
    focal,
    px: x,
    py: bottom - (focal * height) / distance,
  }
}

/**
 * Every stop, read from the page as it is laid out right now: each is composed around the block of
 * words marked `k:<id>`, at the scroll position that centres it, and a chapter's camera is solved so
 * that the foot of its realm's doorway lands on the bottom middle of the screen's slot at exactly that
 * position. The layout is the DOM's; the world is built round it.
 */
function stands(input: StageInput, scrollY: number, mode: Mode): Stand[] {
  const { width, height, anchors } = input
  const out: Stand[] = []
  const phone = mode === "drift"

  // The opening: looking down the mark's own diagonal through a long lens, so every realm on the
  // field is the logo; the lens's axis meets the page at the middle of the window's top edge, and the
  // field point there is the world's origin. The haze is measured from there, as the Hive's is: clear
  // beside the window, gone by the words.
  const portal = anchors.portal
  if (portal) {
    const windowTop = portal[1] + scrollY
    const yaw = OPENING.yaw * DEG
    const pitch = OPENING.pitch * DEG
    const focal = phone ? 1500 : OPENING.focal
    const edge = phone ? 26 : OPENING.edge
    const distance = (Math.sqrt(2 / 3) * focal) / edge
    const fwd: Vec3 = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)]
    const view: View = {
      eye: [OPENING.focus[0] - fwd[0] * distance, OPENING.focus[1] - fwd[1] * distance, -fwd[2] * distance],
      yaw,
      pitch,
      focal,
      px: phone ? width / 2 : portal[0] + portal[2] / 2,
      py: phone ? height * 0.55 : windowTop,
    }
    out.push({
      key: { id: "open", kind: "open", y: 0, view, hold: [0, 0.1], turn: 3 * DEG, pivot: [OPENING.focus[0], OPENING.focus[1], 0], lift: 0 },
      fog: phone ? [distance - 10, 4 / distance] : [distance - 3, 9 / distance],
    })
  }

  for (const [name, rect] of Object.entries(anchors)) {
    if (!name.startsWith("k:")) continue
    const id = name.slice(2)
    const y = Math.max(1, centred(rect, scrollY, height))
    const stop = CHAPTERS[id]
    const slotRect = anchors[`s:${id}`]
    if (stop && slotRect) {
      const [i, j] = nearestCell(stop.at[0], stop.at[1])
      const realm = cellCentre(i, j)
      const foot = doorFoot(realm[0], realm[1])
      const slot = rest(slotRect, scrollY, y)
      const view = levelView(foot, stop.yaw * DEG, stop.height, stop.distance, stop.focal, slot[0] + slot[2] / 2, slot[1] + slot[3])
      out.push({
        key: { id, kind: "chapter", y, view, hold: [0.24, 0.24], turn: stop.orbit * DEG, pivot: foot, lift: 1.6 },
        fog: [stop.distance + 5, 1 / (stop.distance * 4.2)],
        realm,
        foot,
        slot: [slot[2], slot[3]],
        depth: stop.distance,
      })
      continue
    }
    if (id === "teams" && slotRect) {
      const [i, j] = nearestCell(TEAM.at[0], TEAM.at[1])
      const cells = TEAM.cells.map(([di, dj]) => cellCentre(i + di, j + dj))
      const xs = cells.map((c) => c[0])
      const ys = cells.map((c) => c[1])
      const across = Math.max(...xs) - Math.min(...xs) + 1
      const foot: Vec3 = [(Math.max(...xs) + Math.min(...xs)) / 2, Math.min(...ys) - 0.6, 0]
      const slot = rest(slotRect, scrollY, y)
      const distance = (TEAM.focal * across * TEAM.frame) / Math.max(slot[2], 1)
      const view = levelView(foot, TEAM.yaw * DEG, TEAM.height, distance, TEAM.focal, slot[0] + slot[2] / 2, slot[1] + slot[3] * 0.9)
      out.push({
        key: { id, kind: "teams", y, view, hold: [0.24, 0.24], turn: TEAM.orbit * DEG, pivot: foot, lift: 1.6 },
        fog: [distance + 6, 1 / (distance * 3.5)],
        foot,
        cells,
      })
      continue
    }
    const climb = CLIMB[id]
    if (climb) {
      const yaw = climb.yaw * DEG
      const pitch = climb.pitch * DEG
      const view: View = { eye: [climb.at[0], climb.at[1], climb.height], yaw, pitch, focal: climb.focal, px: width / 2, py: height * 0.6 }
      // The point of the field the lens's axis meets: the turn while reading is about it.
      const reach = climb.height / Math.tan(-pitch)
      out.push({
        key: { id, kind: "calm", y, view, hold: [0.2, 0.2], turn: 3 * DEG, pivot: [climb.at[0] + Math.cos(yaw) * reach, climb.at[1] + Math.sin(yaw) * reach, 0], lift: 0 },
        fog: [climb.height * 1.3, 1 / (climb.height * 3.2)],
      })
      continue
    }
    if (id === "finale") {
      // The finale: the camera lifts its eyes off the field to the night over it. It is level, and its
      // lens is shifted so the horizon sits under the bottom of the page, so the whole view is sky,
      // and the black hole the page ends on comes up into it from below.
      const last = out[out.length - 1]?.key.view
      const yaw = last ? last.yaw : 90 * DEG
      const ahead = last ? [last.eye[0] + Math.cos(yaw) * 40, last.eye[1] + Math.sin(yaw) * 40] : [0, 0]
      const view: View = {
        eye: [ahead[0]!, ahead[1]!, FINALE.height],
        yaw,
        pitch: FINALE.pitch * DEG,
        focal: FINALE.focal,
        px: width / 2,
        py: height * FINALE.horizon - FINALE.focal * Math.tan(FINALE.pitch * DEG),
      }
      out.push({
        key: { id, kind: "finale", y, view, hold: [0.12, 0.3], turn: 0, pivot: [ahead[0]!, ahead[1]!, 0], lift: 0 },
        fog: [FINALE.height * 2, 1 / (FINALE.height * 6)],
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
      open.push(1 - ramp(0.08, 0.32, at.u))
      door.push(1 - 0.6 * ramp(0.2, 0.5, at.u))
    } else {
      open.push(0)
      picture.push(0)
      door.push(k < at.from ? 0.4 : 0)
    }
  })
  return { view, at, nearest, open, door, picture }
}

type Node = { el: HTMLElement; last: string }

export const createRealms: StageFactory = async (gpu, output) => {
  const zero = [0, 0, 0, 0]
  const scene: SceneUniforms = {
    eye: [0, 0, 10, 1500],
    fwd: [0, 1, 0, 0.05],
    right: [1, 0, 0, RENDER_SCALE],
    up: [0, 0, 1, 0],
    view: [1, 1, 0, 0],
    clock: [0, 0, 0, 0.03],
    fog: [10, 0.02, 0, 0],
    planet: [0, 0, PLANET_RADIUS, 0],
    field: [0, 0, 0, 0],
    fence: [0, 0, 0, 0],
    lamp: [0, 0, 2, 0],
    grid: [0, 0, GRID, 120],
    screens: Array.from({ length: SCREENS * 2 }, () => [...zero]),
    plazas: Array.from({ length: PLAZAS * 2 }, () => [...zero]),
    lit: Array.from({ length: LIT }, () => [0, 0, -1, 0]),
  }
  const comp: CompositeUniforms = {
    view: [1, 1, 1, 0],
    look: [0, 0, 0, 0],
    clear: Array.from({ length: CLEAR }, () => [...zero]),
    panels: Array.from({ length: PANELS * 2 }, () => [...zero]),
  }

  const sizeOf = (): [number, number] => [
    Math.max(1, Math.round(window.innerWidth * RENDER_SCALE)),
    Math.max(1, Math.round(window.innerHeight * RENDER_SCALE)),
  ]
  let size = sizeOf()
  const world = target(gpu, { size, format: "rgba16float", depth: "depth32float", msaa: true, label: "realms-world" })

  const realms = draw(gpu, {
    label: "realms-realm",
    shader: sceneShader,
    entry: { vertex: "vs_realm", fragment: "fs_realm" },
    cull: "back",
    depth: { write: true, compare: "greater" },
    set: { scene },
  })
  const blackHole = new BlackHole()
  const sky = draw(gpu, {
    label: "realms-sky",
    shader: sceneShader,
    entry: { vertex: "vs_sky", fragment: "fs_sky" },
    vertices: 3,
    depth: { write: false, compare: "greater-equal" },
    set: { scene, hole: holeOff() },
  })
  const linear = sampler(gpu, { minFilter: "linear", magFilter: "linear" })
  const composite = effect(gpu, compositeShader, { label: "realms-composite", set: { comp, sceneTex: world, sceneSampler: linear } })

  if (process.env.NODE_ENV !== "production") {
    // Surface the compiler's own words in development: vgpu reports only that compilation failed.
    for (const [name, code] of [["scene", sceneShader], ["composite", compositeShader]] as const) {
      const info = await gpu.gpu.createShaderModule({ code, label: name }).getCompilationInfo()
      for (const m of info.messages) if (m.type === "error") console.error(`[realms ${name}] ${m.lineNum}:${m.linePos} ${m.message}`)
    }
  }
  await Promise.all([realms.compile(world), sky.compile(world)])

  const follow = new Follow(9)
  // What the last drawn frame was drawn from: when none of it has moved, the field only needs its
  // slow doorways redrawn, so it is redrawn a third as often.
  let drawn = ""
  let quietFrames = 0
  const lamp = { x: 0, y: 0, presence: 0 }
  let sway = 0
  let lastSeconds = -1
  let mode: Mode | null = null
  const root = document.documentElement
  const screens = new Map<string, Node>()
  const realmites = new Map<string, Node>()

  const nodes = () => {
    for (const el of document.querySelectorAll<HTMLElement>("[data-screen]")) {
      const id = el.dataset.screen!
      if (screens.get(id)?.el !== el) screens.set(id, { el, last: "" })
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-realmite]")) {
      const id = el.dataset.realmite!
      if (realmites.get(id)?.el !== el) realmites.set(id, { el, last: "" })
    }
  }

  const write = (node: Node, css: string) => {
    if (node.last === css) return
    node.last = css
    node.el.style.cssText = css
  }

  const setMode = (next: Mode) => {
    if (next === mode) return
    mode = next
    root.dataset.realmsFlight = next === "flight" ? "on" : "off"
    root.dataset.realmsWorld = next === "drift" ? "off" : "on"
    for (const node of screens.values()) write(node, "")
    follow.reset()
  }

  return {
    draw(frame, input) {
      const { width, height } = input
      const scrollY = window.scrollY
      const dt = lastSeconds < 0 ? 0 : input.seconds - lastSeconds
      lastSeconds = input.seconds
      setMode(input.still ? "still" : width < 1024 ? "drift" : "flight")
      nodes()

      const list = stands(input, scrollY, mode!)
      if (list.length === 0) return

      // ---- the camera ------------------------------------------------------------------------
      const now = moment(list, scrollY, mode!)
      let view: View = now.view
      if (mode === "drift") {
        // A phone: the opening's view of the field, carried slowly up it as the page scrolls, then the
        // same lift to the night at the end, where the black hole comes up under the links.
        const open = list[0]!.key.view
        const travel = scrollY * 0.012
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

      // The pointer: a lamp over the field, and the smallest sway of the camera about the stop's
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

      // ---- what stands in the world: screens, lit realms, plazas -----------------------------
      const panels: number[][] = []
      const lights: number[][] = []
      const plazas: number[][] = []
      const lit: number[][] = []
      const clears: Rect[] = []
      let fence = [0, 0, 0, 0]
      const visible = (r: Rect) => r[2] > 0 && r[1] < height + 160 && r[1] + r[3] > -160 && r[0] < width + 160 && r[0] + r[2] > -160
      const progress = now.at.from + now.at.u
      const teams = list.findIndex((s) => s.cells)

      list.forEach((stand, index) => {
        const opening = now.open[index]!
        if (stand.realm && stand.foot) {
          // Under reduced motion the screens sit in the page, not at their realms, so the realms stand
          // aside: their plazas stay clear and the screens' light falls on them from where they are.
          if (mode !== "still") lit.push([stand.realm[0], stand.realm[1], Math.max(now.door[index]!, 0), 0])
          const eye = stand.key.view.eye
          const reach = 1
          plazas.push([stand.realm[0], stand.realm[1], 3.4, 7, lerp(stand.realm[0], eye[0], reach), lerp(stand.realm[1], eye[1], reach)])
          // A space can be confined: its realm gets a boundary drawn on the ground round it.
          if (stand.key.id === "sandbox" && mode !== "drift") fence = [stand.realm[0], stand.realm[1], 2.4, opening]
        }
        if (stand.cells) {
          const here = mode === "still" ? (now.nearest === index ? 1 : 0) : Math.max(0, 1 - Math.abs(index - progress) * 0.9)
          const cx = stand.cells.reduce((sum, c) => sum + c[0], 0) / stand.cells.length
          const cy = stand.cells.reduce((sum, c) => sum + c[1], 0) / stand.cells.length
          const eye = stand.key.view.eye
          plazas.push([cx, cy, 6.4, 18, lerp(cx, eye[0], 0.6), lerp(cy, eye[1], 0.6)])
          stand.cells.forEach((cell, r) => {
            const role = ROLES[r]
            const node = role ? realmites.get(role.id) : undefined
            const state = node?.el.dataset.state
            const picked = node?.el.dataset.picked !== undefined
            // A doorway says what its role's run is doing: lit at work, Realm's blue when it needs
            // you, low when idle, dark when it is done for the day; the role picked on the board is
            // a step brighter.
            const base = state === "working" ? 1 : state === "needs-you" ? 0.9 : state === "idle" ? 0.22 : 0
            lit.push([cell[0], cell[1], Math.min(1.2, (base + (picked ? 0.35 : 0)) * here), state === "needs-you" ? 1 : 0])
          })
        }

        const id = stand.key.id
        const node = screens.get(id)
        if (!node || !stand.slot || !stand.foot || stand.depth === undefined) return
        const pictureOn = now.picture[index]!
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
              ? `width:${stand.slot[0].toFixed(1)}px;height:${stand.slot[1].toFixed(1)}px;transform:translate3d(${left.toFixed(2)}px,${top.toFixed(2)}px,0) scale(${s.toFixed(4)});opacity:${pictureOn.toFixed(3)}`
              : `width:${stand.slot[0].toFixed(1)}px;height:${stand.slot[1].toFixed(1)}px;opacity:0;pointer-events:none`,
          )
          if (z > 0.6 && (opening > 0.001 || pictureOn > 0.001) && panels.length < PANELS * 2 && stand.realm) {
            // The doorway's own rect on the page, opening out into the screen's.
            const [cx, cy] = stand.realm
            const corners = [
              [cx + DOOR.across[0] - 0.5, cy - 0.5, 1 - DOOR.down[1]],
              [cx + DOOR.across[1] - 0.5, cy - 0.5, 1 - DOOR.down[1]],
              [cx + DOOR.across[0] - 0.5, cy - 0.5, 1 - DOOR.down[0]],
              [cx + DOOR.across[1] - 0.5, cy - 0.5, 1 - DOOR.down[0]],
            ].map((p) => project(view, b, p as Vec3))
            const xs = corners.map((c) => c[0])
            const ys = corners.map((c) => c[1])
            const door: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
            const e = smoother(opening)
            const rect: Rect = [lerp(door[0], left, e), lerp(door[1], top, e), lerp(door[2], w, e), lerp(door[3], h, e)]
            // The doorway's light, spread over the rect as it grows: bright while it is the doorway, dim
            // by the time it is the screen, and gone under the picture.
            const spread = Math.min(1, ((door[2] * door[3]) / Math.max(rect[2] * rect[3], 1)) ** 0.55)
            // Opaque while it opens (nothing shows through a picture still arriving); on the way out it
            // goes with the picture, so no dark rect is left behind it.
            const leaving = now.at.from === index && now.at.to !== index
            const fill = leaving ? pictureOn : smooth(Math.min(1, opening * 2.4))
            panels.push([...rect], [fill, lerp(1.5, 12 * s, e), pictureOn, (0.35 + 0.65 * spread) * (1 - pictureOn) * smooth(opening)])
            if (lights.length < SCREENS * 2) {
              const W = (stand.slot[0] * stand.depth) / stand.key.view.focal
              const H = (stand.slot[1] * stand.depth) / stand.key.view.focal
              lights.push([...stand.foot, W], [H, stand.key.view.yaw, Math.max(opening, pictureOn), 0])
            }
            if (pictureOn > 0.05) clears.push([left, top + h + 4, Math.min(w, 600), 52])
          }
        } else {
          // In the slot: the screen is where the layout put it, and its light is read from there.
          write(node, "")
          const slot = input.anchors[`s:${id}`]
          if (slot && visible(slot) && lights.length < SCREENS * 2) {
            const ray = rayThrough(view, b, slot[0] + slot[2] / 2, slot[1] + slot[3])
            if (ray[2] < -1e-3) {
              const t = -view.eye[2] / ray[2]
              const foot: Vec3 = [view.eye[0] + ray[0] * t, view.eye[1] + ray[1] * t, 0]
              const depth = dot(sub(foot, view.eye), b.fwd)
              lights.push([...foot, (slot[2] * depth) / view.focal], [(slot[3] * depth) / view.focal, view.yaw, 0.85, 0])
            }
            if (panels.length < PANELS * 2) panels.push([...slot], [0, 12, 1, 0])
          }
          if (slot && visible(slot)) clears.push([slot[0], slot[1] + slot[3] + 4, Math.min(slot[2], 600), 52])
        }
      })

      // The Realmites, standing at their doors.
      for (const [roleIndex, role] of ROLES.entries()) {
        const node = realmites.get(role.id)
        if (!node) continue
        const stand = list[teams]
        const cell = stand?.cells?.[roleIndex]
        if (!stand || !cell || mode === "drift") {
          write(node, "")
          continue
        }
        const here = mode === "still" ? (now.nearest === teams ? 1 : 0) : Math.max(0, 1 - Math.abs(teams - progress) * 1.6)
        const foot = doorFoot(cell[0], cell[1])
        const [x, y, z] = project(view, b, [foot[0], foot[1] - 0.12, 0])
        const size = (0.5 * view.focal) / Math.max(z, 1e-3)
        const s = size / WORLD_REALMITE
        const shown = z > 0.8 && here > 0.01
        write(
          node,
          shown
            ? `width:${WORLD_REALMITE}px;height:${WORLD_REALMITE}px;transform:translate3d(${(x - size / 2).toFixed(2)}px,${(y - size * 0.94).toFixed(2)}px,0) scale(${s.toFixed(4)});opacity:${smooth(here).toFixed(3)};visibility:visible`
            : `width:${WORLD_REALMITE}px;height:${WORLD_REALMITE}px;opacity:0;visibility:hidden`,
        )
      }

      // The working sample is a lit screen too: the same breath of light at its edge as every chapter's.
      const portal = input.anchors.portal
      if (portal && visible(portal) && panels.length < PANELS * 2) panels.push([...portal], [0, 20, 0.85, 0])

      // ---- the words the field keeps clear of ----------------------------------------------
      for (const [name, rect] of Object.entries(input.anchors)) {
        if ((name === "copy" || name.startsWith("k:") || name.startsWith("c:")) && visible(rect)) clears.push(rect)
      }

      // ---- the hour, and what the field has become -------------------------------------------
      const firstChapter = list.findIndex((s) => s.key.kind === "chapter")
      const teamsIndex = Math.max(teams, firstChapter + 1)
      const night = clamp((progress - Math.max(firstChapter, 0) + 0.6) / Math.max(teamsIndex - firstChapter + 0.6, 1), 0, 1)
      // Altitude decides what the field is: realms, then their average with the lit doorways as
      // points of light.
      const altitude = view.eye[2]
      const dissolve = ramp(36, 110, altitude)
      const pointsOn = ramp(28, 90, altitude)

      // The finale's night: how far the camera has lifted its eyes to it, which the hole's stars take.
      const finaleIndex = list.findIndex((s) => s.key.kind === "finale")
      const lifted = finaleIndex < 0 ? 0 : mode === "still" ? (now.nearest >= finaleIndex ? 1 : 0) : smooth(clamp(progress - (finaleIndex - 1), 0, 1))

      // Haze: carried between the stops with the camera.
      const fa = list[now.at.from]!.fog
      const fz = list[now.at.to]!.fog
      const e = smoother(now.at.u)
      let fogStart = lerp(fa[0], fz[0], e)
      let fogDensity = Math.exp(lerp(Math.log(fa[1]), Math.log(fz[1]), e))
      if (mode === "drift") [fogStart, fogDensity] = list[0]!.fog
      if (mode === "still") [fogStart, fogDensity] = list[now.nearest]!.fog

      // The lamp: where the pointer meets the field, held a little above it.
      const ray = rayThrough(view, b, lamp.x, lamp.y)
      let lampAt: Vec3 = [0, 0, 0]
      let lampOn = 0
      if (ray[2] < -1e-3) {
        const t = -view.eye[2] / ray[2]
        lampAt = [view.eye[0] + ray[0] * t, view.eye[1] + ray[1] * t, 0]
        lampOn = lamp.presence
      }
      const lampHeight = clamp(view.eye[2] * 0.35, 1.2, 6)

      // The lattice around where the camera is looking.
      const grid = mode === "drift" ? GRID_PHONE : GRID
      const lookAhead = Math.min(view.eye[2] / Math.max(Math.tan(-view.pitch), 0.05), 120)
      const ahead = view.pitch < -0.05 ? lookAhead : clamp(fogStart * 1.4, 18, 70)
      const lookX = view.eye[0] + Math.cos(view.yaw) * ahead
      const lookY = view.eye[1] + Math.sin(view.yaw) * ahead
      const [gi, gj] = latticeOf(lookX, lookY).map(Math.round) as [number, number]
      const cull = fogStart + 4.2 / Math.max(fogDensity, 1e-4)

      // Only the plazas and lit realms near where the camera looks: the rest are far into the haze.
      const byNearness = (a: number[], c: number[]) => Math.hypot(a[0]! - lookX, a[1]! - lookY) - Math.hypot(c[0]! - lookX, c[1]! - lookY)
      plazas.sort(byNearness)
      lit.sort(byNearness)
      plazas.length = Math.min(plazas.length, PLAZAS)
      lit.length = Math.min(lit.length, LIT)
      while (lights.length < SCREENS * 2) lights.push([...zero])
      while (plazas.length < PLAZAS) plazas.push([0, 0, 0, 0, 0, 0])
      const plazaPairs = plazas.flatMap((q) => [[q[0]!, q[1]!, q[2]!, q[3]!], [q[4] ?? q[0]!, q[5] ?? q[1]!, 0, 0]])
      while (lit.length < LIT) lit.push([0, 0, -1, 0])
      while (panels.length < PANELS * 2) panels.push([...zero])
      const clearList = clears.slice(0, CLEAR)

      scene.eye = [...view.eye, view.focal]
      scene.fwd = [...b.fwd, clamp(view.eye[2] * 0.02, 0.03, 4)]
      scene.right = [...b.right, RENDER_SCALE]
      scene.up = [...b.up, 0]
      scene.view = [width, height, view.px, view.py]
      scene.clock = [input.seconds, night, input.still ? 1 : 0, lerp(0.03, 0.05, night)]
      scene.fog = [fogStart, fogDensity, 0, 0]
      scene.planet = [view.eye[0], view.eye[1], PLANET_RADIUS, 0]
      scene.field = [dissolve, pointsOn, 0, 0]
      scene.fence = fence
      scene.lamp = [lampAt[0], lampAt[1], lampHeight, lampOn]
      scene.grid = [gi, gj, grid, Math.min(cull, 260)]
      scene.screens = lights
      scene.plazas = plazaPairs
      scene.lit = lit

      const dpr = output.size[0] / Math.max(width, 1)
      comp.view = [width, height, dpr, input.seconds]
      comp.look = [input.still ? 1 : 0, clearList.length, 0, 0]
      comp.clear = [...clearList.map((r) => [...r]), ...Array.from({ length: CLEAR - clearList.length }, () => [...zero])]
      comp.panels = panels

      const wanted = sizeOf()
      if (wanted[0] !== size[0] || wanted[1] !== size[1]) {
        size = wanted
        world.resize(size)
        composite.set({ sceneTex: world })
      }

      // The black hole under the footer: retraced every frame it is on screen, since its disk turns.
      const holeNow = blackHole.frame({ view, b, rect: input.anchors.hole, width, height, seconds: input.seconds, dt, still: input.still, pointer: input.pointer })
      holeNow.uniforms.ax[3] = lifted

      const state = `${scrollY}|${width}x${height}|${view.eye.map((v) => v.toFixed(4)).join(",")}|${view.yaw.toFixed(5)}|${lamp.x.toFixed(1)},${lamp.y.toFixed(1)},${lamp.presence.toFixed(3)}|${mode}`
      if (state === drawn && !input.still && !holeNow.live && quietFrames++ % 3 !== 0) return
      if (state !== drawn) quietFrames = 0
      drawn = state

      realms.set({ scene })
      sky.set({ scene, hole: holeNow.uniforms })
      composite.set({ comp })
      const instances = dissolve > 0.995 ? 0 : grid * grid
      frame.pass({ target: world, clear: [0, 0, 0, 1], clearDepth: 0 }, (pass) => {
        if (instances > 0) pass.draw(realms, { vertices: REALM_VERTICES, instances })
        pass.draw(sky, { vertices: 3 })
      })
      frame.pass(output, composite)
    },
    dispose() {
      delete root.dataset.realmsFlight
      delete root.dataset.realmsWorld
      for (const node of screens.values()) node.el.style.cssText = ""
      for (const node of realmites.values()) node.el.style.cssText = ""
    },
  }
}
