import { DOOR, FACES, MARK_CENTER, MARK_RADIUS } from "@/lib/mark"

/**
 * Realm's mark as a solid: the cube the drawing in `lib/mark.ts` is a picture of, with its doorway cut
 * where the drawing cuts it.
 *
 * The mark is an isometric drawing. Its near corner is the centre and its three edges run to V1 (u),
 * V3 (v) and V5 (w, down), so any point of the cube is C + a·u + b·v + c·w. The doorway is a box cut
 * into the right wall (b = 0): `across` it in a, `down` it in c, and `depth` into the cube in b. Those
 * fractions are not copied here. They are read back out of the drawing: the doorway's corners give
 * a and c, and the doorway's floor, which runs from the wall to the doorway's back, gives the depth.
 * A change to the door in mark.mjs is a change here with nothing edited.
 */

type Point = readonly [number, number]

const sub = (p: Point, q: Point): Point => [p[0] - q[0], p[1] - q[1]]
const scale = (p: Point, k: number): Point => [p[0] * k, p[1] * k]
const corner = (i: number): Point => [
  MARK_CENTER[0] + MARK_RADIUS * Math.cos((-i * Math.PI) / 3),
  MARK_CENTER[1] + MARK_RADIUS * Math.sin((-i * Math.PI) / 3),
]

const U = sub(corner(1), MARK_CENTER)
const V = sub(corner(3), MARK_CENTER)
const W = sub(corner(5), MARK_CENTER)

/** The x, y with x·a + y·b = q. */
const along = (q: Point, a: Point, b: Point): Point => {
  const det = a[0] * b[1] - a[1] * b[0]
  return [(q[0] * b[1] - q[1] * b[0]) / det, (a[0] * q[1] - a[1] * q[0]) / det]
}

// DOOR is P(a0, 0, c0), P(a1, 0, c0), P(a1, 0, c1), P(a0, 0, c1): two opposite corners give all four.
const [a0, c0] = along(sub(DOOR[0], MARK_CENTER), U, W)
const [a1, c1] = along(sub(DOOR[2], MARK_CENTER), U, W)
// The floor lies at c = c1 and runs from the wall (b = 0) back to the lit face (b = depth).
const floorFace = FACES.find((face) => face.name === "floor")?.polygon ?? []
const depth = Math.max(...floorFace.map((p) => along(sub(sub(p, MARK_CENTER), scale(W, c1)), U, V)[1]))

/** The doorway in the cube's own terms, its edge 1. */
export const DOORWAY = { across: [a0, a1], down: [c0, c1], depth } as const

const hex = (value: string) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)

/**
 * The mark's own tones (resources/icon-src/mark.mjs, MARK_TONES), each face's pair running the way
 * one soft light from above falls on a matte cube: the top from its far corner to its near one, each
 * wall from its top edge to its floor, and the lit back from the lintel down. The jamb and the floor
 * of the doorway take the darker end of the face each is parallel to, as the drawing does.
 */
export const TONES = {
  top: [hex("#f4f5f7"), hex("#e3e5e8")],
  left: [hex("#b4b8be"), hex("#9ea2a9")],
  right: [hex("#6c7078"), hex("#575b63")],
  lit: [hex("#ffffff"), hex("#f1f2f4")],
} as const
