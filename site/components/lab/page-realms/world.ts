import { DOORWAY } from "@/components/lab/hive/cube"

/**
 * The world the page flies over: Realm's mark as a solid, one per cell of the lattice the Hive stands
 * its cubes on, on a planet large enough that its curve only shows once the camera has climbed.
 *
 * World units are the cube's edge. x and y run along the ground and z is up; a realm's left wall
 * faces -x, its dark wall faces -y with the doorway cut in it, and its top faces +z, so the mark's own
 * drawing is the view from (-1, -1, +1).
 */

/** How far apart the realms stand, as a multiple of the spacing at which their outlines would touch
 *  seen down the diagonal (the Hive's 1.3, opened up so a low camera sees ground between them). */
export const SPACING = 1.6

/** The lattice: G1 runs beside a realm, G2 behind it. Seen down the diagonal the cells are hexagons. */
export const G1 = [SPACING, -SPACING] as const
export const G2 = [2 * SPACING, SPACING] as const

export const cellCentre = (i: number, j: number): [number, number] => [i * G1[0] + j * G2[0], i * G1[1] + j * G2[1]]

/** The lattice coordinates of a point of the ground, fractional. */
export const latticeOf = (x: number, y: number): [number, number] => [(x - 2 * y) / (3 * SPACING), (x + y) / (3 * SPACING)]

/** The cell whose realm stands nearest a point of the ground. */
export function nearestCell(x: number, y: number): [number, number] {
  const [fi, fj] = latticeOf(x, y)
  let best: [number, number] = [Math.round(fi), Math.round(fj)]
  let bestDistance = Number.POSITIVE_INFINITY
  for (let di = -1; di <= 2; di++) {
    for (let dj = -1; dj <= 2; dj++) {
      const i = Math.floor(fi) + di
      const j = Math.floor(fj) + dj
      const [cx, cy] = cellCentre(i, j)
      const d = Math.hypot(cx - x, cy - y)
      if (d < bestDistance) {
        bestDistance = d
        best = [i, j]
      }
    }
  }
  return best
}

/** The doorway, in the cube's own terms (read out of the mark by the Hive's cube.ts). */
export const DOOR = {
  across: DOORWAY.across,
  down: DOORWAY.down,
  depth: DOORWAY.depth,
} as const

/** The point on the ground just in front of a realm's doorway: where its screen stands. */
export const doorFoot = (cx: number, cy: number): [number, number, number] => [cx - 0.5 + (DOOR.across[0] + DOOR.across[1]) / 2, cy - 0.5 - 0.1, 0]

/** The middle of a realm's doorway, at the wall. */
export const doorMiddle = (cx: number, cy: number): [number, number, number] => [
  cx - 0.5 + (DOOR.across[0] + DOOR.across[1]) / 2,
  cy - 0.5,
  1 - (DOOR.down[0] + DOOR.down[1]) / 2,
]

/** The planet, in cube edges: big enough that from a few edges up the ground is flat to the fog. */
export const PLANET_RADIUS = 2400

/**
 * The flight's stops, as places on the ground. Each chapter's realm is the lattice cell nearest its
 * place, with the realms around it cleared into a plaza so nothing stands between the camera and the
 * screen. The route runs up the field (+y), swinging side to side, so the camera lifts over the realm
 * it leaves and turns toward the next.
 */
export type Stop = {
  /** Where on the ground, before snapping to a cell. */
  at: readonly [number, number]
  /** Which way the camera faces, in degrees from +x (90 looks straight up the field at the doors). */
  yaw: number
  /** The camera's height and how far back it stands from the screen's foot, in edges. */
  height: number
  distance: number
  /** The lens, in CSS px of focal length. */
  focal: number
  /** How far the camera turns about the screen while the reader is in the chapter, in degrees. */
  orbit: number
}
