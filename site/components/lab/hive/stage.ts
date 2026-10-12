import { effect } from "vgpu"

import { anchor, type Rect, type StageFactory, type StageInput } from "../stage"
import { hiveShader, type HiveUniforms } from "./shader"

type Vec3 = [number, number, number]

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a))

/**
 * The camera looks down the cube's diagonal — x, y and -z together — which is the direction the mark
 * is drawn from, 35.3° below the horizon, so each cube is the mark's own drawing of it: three faces of
 * equal size, the doorway in the dark one. It is level, like a camera on a tripod over a model, so the
 * ground runs away up the page and into fog; the mark is the same cube turned a sixth of a turn.
 */
const FORWARD = normalize([1, 1, -1])
const FLAT_RIGHT = normalize([1, -1, 0])
const FLAT_UP: Vec3 = normalize([1, 1, 2])
// DEV: ?roll=30 shows the cubes the way the logo stands, with the ground running off to the upper left.
const DEV = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search)
const ROLL = DEV.has("roll") ? (Number(DEV.get("roll")) * Math.PI) / 180 : 0
const RIGHT = add(scale(FLAT_RIGHT, Math.cos(ROLL)), scale(FLAT_UP, -Math.sin(ROLL)))
const UP = add(scale(FLAT_RIGHT, Math.sin(ROLL)), scale(FLAT_UP, Math.cos(ROLL)))

/** A long lens: about 18° across the height of a laptop's window, so the field flattens like a model
 *  photographed from across the room. In CSS px, so the perspective is the same on every screen. */
const FOCAL = 2800
/** A cube's edge, as drawn at the distance the lens is aimed at, in CSS px. */
const EDGE_PX = 19
const ISO = Math.sqrt(2 / 3)
const DISTANCE = (ISO * FOCAL) / EDGE_PX
const EYE = scale(FORWARD, -DISTANCE)

/** How long the cubes take to follow the pointer up and down, in seconds. */
const RISE_EASE = 0.32
/** How quickly the field goes into the fog above the window: 95% gone at the words. */
const FOG_AT_WORDS = Math.sqrt(-Math.log(0.05))

/** The point of the plane at height `z` that a pixel of the page looks at. */
function onPlane(x: number, y: number, principal: readonly [number, number], z: number): Vec3 {
  const ray = add(add(FORWARD, scale(RIGHT, (x - principal[0]) / FOCAL)), scale(UP, -(y - principal[1]) / FOCAL))
  return add(EYE, scale(ray, (z - EYE[2]) / ray[2]))
}

const along = (p: Vec3) => dot(sub(p, EYE), FORWARD)

const rect = (r: Rect): [number, number, number, number] => [r[0], r[1], r[2], r[3]]

/**
 * The hive's runtime: one full-screen pass a frame, told where the window, the words and the pointer
 * are. The field is pinned to the window — the lens points at the middle of its top edge — so it
 * scrolls with the page rather than sliding under it, and the fog and the focus are measured from the
 * same two things the reader sees: sharp at the window's top edge, gone by the words.
 */
export const createHive: StageFactory = (gpu, output) => {
  const zero: [number, number, number, number] = [0, 0, 0, 0]
  const uniforms: HiveUniforms = {
    view: [1, 1, 0, 0],
    eye: [...EYE, FOCAL],
    forward: [...FORWARD, DISTANCE],
    right: [...RIGHT, 1],
    up: [...UP, 0],
    principal: zero,
    pointer: zero,
    copy: zero,
    portal: zero,
    look: [0, 0.1, 0.1, 3],
  }
  const shader = effect(gpu, hiveShader, { label: "realm-hive", set: { hive: uniforms } })

  // The pointer as the cubes feel it: eased again, slower than the page's, so a cube rises with weight.
  const eased = { x: 0, y: 0, presence: 0, seconds: -1 }

  return {
    draw(frame, input: StageInput) {
      const portal = anchor(input, "portal")
      const copy = anchor(input, "copy")
      const principal: [number, number] =
        portal[2] > 0 ? [portal[0] + portal[2] * 0.5, portal[1]] : [input.width * 0.5, input.height * 0.6]

      // Focused on the ground at the window's top edge; the fog begins a little above it and has
      // taken the field by the bottom of the words.
      const focus = along(onPlane(principal[0], principal[1], principal, 0))
      const wordsY = copy[2] > 0 ? copy[1] + copy[3] : principal[1] - input.height * 0.4
      const fogFrom = principal[1] - (principal[1] - wordsY) * 0.2
      const fogStart = along(onPlane(principal[0], fogFrom, principal, 0)) - focus
      const fogEnd = along(onPlane(principal[0], wordsY, principal, 0)) - focus
      const fogScale = FOG_AT_WORDS / Math.max(fogEnd - fogStart, 1)

      const [px, py, presence] = input.pointer
      const dt = eased.seconds < 0 ? 1 : Math.max(0, input.seconds - eased.seconds)
      eased.seconds = input.seconds
      const k = input.still ? 1 : 1 - Math.exp(-dt / RISE_EASE)
      if (eased.presence < 0.001) {
        eased.x = px
        eased.y = py
      }
      eased.x += (px - eased.x) * k
      eased.y += (py - eased.y) * k
      eased.presence += (presence - eased.presence) * k
      const pointer = onPlane(eased.x, eased.y, principal, 0.5)

      uniforms.view = [input.width, input.height, input.seconds, input.still ? 1 : 0]
      uniforms.forward = [...FORWARD, focus]
      uniforms.right = [...RIGHT, output.size[0] / Math.max(input.width, 1)]
      uniforms.principal = [principal[0], principal[1], 0, 0]
      uniforms.pointer = [pointer[0], pointer[1], input.still ? 0 : eased.presence, 0]
      uniforms.copy = rect(copy)
      uniforms.portal = rect(portal)
      uniforms.look = [fogStart, fogScale, 0.1, 3]
      shader.set({ hive: uniforms })
      frame.pass(output, shader)
    },
  }
}
