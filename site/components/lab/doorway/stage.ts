import { effect } from "vgpu"

import { anchor, type StageFactory } from "../stage"
import { doorwayWgsl } from "./shader"

type Vec4 = [number, number, number, number]

const ZERO: Vec4 = [0, 0, 0, 0]
const clamp = (value: number, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, value))

/**
 * The room's geometry, every length a multiple of the window's own size so the scene is the same
 * room at every viewport: the eye a little above the window, the floor at its sill, and the light
 * behind the wall at the height of the window's upper part. The haze is thickest at the wall, so the
 * light is seen where it leaves the opening and on the floor it lands on, and the room around stays dark.
 */
const ROOM = {
  /** The focal length, in window widths (or one and a half heights, for a window taller than wide). */
  focal: 1.25,
  /** The eye's height, above the window's top edge in window heights. Looking down at the floor a little
   *  is what keeps the pool's sides on screen as they run toward the reader; the wall stays square to
   *  the eye, so the window itself is never skewed. */
  eyeLevel: 0.35,
  /** The light's projection, down from the window's top edge, in window heights (negative: above it).
   *  Just inside: a thin rim of light over the window's top edge, and the light at its sides beginning
   *  above its top corners. */
  lightDrop: 0.12,
  /** The light's depth: the wall is at 1, the eye at 0. */
  lightDepth: 1.8,
  /** The light's radius, in focal lengths — what softens the floor's pool toward the eye. */
  lightRadius: 0.22,
  /** The light's disc as the eye sees it on the wall, in window widths and heights. Tall enough to
   *  straddle the window's top edge, so the light at the window's sides fades in below its top corners
   *  instead of starting at a level line, and leaves only a thin rim above the window. */
  spreadX: 0.07,
  spreadY: 0.1,
  /** How far the haze reaches out from the wall before thinning, in focal lengths. */
  hazeDepth: 0.1,
  /** The haze's forward scattering: how tightly it glows round the light's direction. */
  hazeG: 0.6,
  /** How far the pointer moves the light, as a share of the window: a few degrees either way. */
  swayX: 0.1,
  swayY: 0.02,
  /** Seconds for the light to follow the pointer: slow, so it drifts like a head turning. */
  swayLag: 0.9,
}

export const createDoorway: StageFactory = (gpu, output) => {
  const fx = effect(gpu, doorwayWgsl, {
    label: "realm-hero-doorway",
    set: { door: { view: [1, 1, 0, 0], pointer: ZERO, win: ZERO, copy: ZERO, stage: ZERO, light: ZERO, cam: ZERO, look: ZERO } },
  })
  const sway = { x: 0, y: 0, at: -1 }

  return {
    draw(frame, input) {
      const [wx, wy, ww, wh] = anchor(input, "portal")
      const cx = wx + ww / 2
      const cy = wy + wh / 2
      const [px, py, presence] = input.pointer

      // The light answers the pointer as a head turning would: eased over most of a second, and held
      // still under reduced motion, where a frame is only redrawn when the page moves.
      const tx = input.still ? 0 : clamp((px - cx) / (input.width * 0.5)) * presence
      const ty = input.still ? 0 : clamp((py - cy) / (input.height * 0.5)) * presence
      const dt = sway.at < 0 ? 1e3 : Math.max(0, input.seconds - sway.at)
      sway.at = input.seconds
      const k = input.still ? 1 : 1 - Math.exp(-dt / ROOM.swayLag)
      sway.x += (tx - sway.x) * k
      sway.y += (ty - sway.y) * k

      fx.set({
        door: {
          view: [input.width, input.height, input.seconds, input.still ? 1 : 0],
          pointer: [px, py, input.still ? 0 : presence, output.dpr],
          win: [wx, wy, ww, wh],
          copy: [...anchor(input, "copy")],
          stage: [...anchor(input, "stage")],
          light: [cx + sway.x * ww * ROOM.swayX, wy + wh * ROOM.lightDrop + sway.y * wh * ROOM.swayY, ROOM.lightDepth, ROOM.lightRadius],
          cam: [cx, wy - wh * ROOM.eyeLevel, ROOM.focal * Math.max(ww, wh * 1.5, 1), wy + wh],
          look: [ROOM.hazeDepth, ROOM.hazeG, ww * ROOM.spreadX, wh * ROOM.spreadY],
        },
      })
      frame.pass(output, fx)
    },
  }
}
