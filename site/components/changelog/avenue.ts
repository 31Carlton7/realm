import { basis, project, type Vec3, type View } from "@/components/realms/camera"
import { cellCentre, doorFoot } from "@/components/realms/world"

/**
 * The changelog's ground: the landing page's field of realms, with the releases standing in one
 * lattice column of it, newest nearest, older ones further up the field. Plain arithmetic, shared by
 * the index's walk and an entry's arrival, so a release stands in the same place in both.
 *
 * World units are the cube's edge; x and y run along the ground, z is up, and a realm's doorway faces
 * -y (components/realms/world.ts). The avenue runs +y, so walking up it is walking back in time.
 */

/** The lattice column the releases stand in (cells with i + 2j = COLUMN), and how many of its cells
 *  apart they stand. A column's cells are 4.8 edges apart; two of them is further than the camera
 *  stands back from a doorway, so the release just passed is behind it, not between it and the next. */
const COLUMN = 2
const STEP = 2
export const AVENUE_X = 1.6 * COLUMN
export const SPACING = 4.8 * STEP

/** Where release `r` stands, 0 being the newest. */
export const realmOf = (r: number): [number, number] => cellCentre(COLUMN - 2 * r * STEP, r * STEP)

/** The ground just in front of release `r`'s doorway. */
export const footOf = (r: number): Vec3 => {
  const [x, y] = realmOf(r)
  return doorFoot(x, y)
}

/**
 * The street the camera walks: a clearing down the left of the releases' column, taking the column
 * beside it too, so each release stands on open ground with the field resuming beyond. As a plaza in
 * the scene's terms: a capsule's two ends and its radius.
 */
export const STREET = { x: AVENUE_X - 0.8, radius: 3.3 }

/** The lens every view of the avenue uses, in CSS px of focal length. */
export const FOCAL = 1500
/** How far left of the releases' column the camera walks, and how high it stands. The walk narrows
 *  the first to fit the room beside the list (`lateralFor`). */
export const LATERAL = 1.6
export const EYE = 2.2

/**
 * How far left of the column to walk so the avenue's vanishing point, where the older releases go
 * into the haze, lands `reach` px left of the doorway being read: the further left the camera, the
 * further the row runs across the page toward the list.
 */
export const lateralFor = (reach: number, sy: number, horizon: number, eye = EYE) =>
  Math.min(1.8, Math.max(0.8, (reach * eye) / Math.max(sy - horizon, 40)))

const DEG = Math.PI / 180

/**
 * A level view up the avenue at release `r`, solved so that the foot of its doorway lands on the page
 * at (sx, sy) with the horizon at `horizon`: the camera stands LATERAL left of the column and EYE up,
 * as far back as puts the foot that far under the horizon, and the lens is shifted so the doorway
 * lands at sx. Verticals stay vertical, as the landing page's chapters keep them.
 */
export function streetView(r: number, sx: number, sy: number, horizon: number, eye = EYE, lateral = LATERAL): View {
  const foot = footOf(r)
  const distance = (FOCAL * eye) / Math.max(sy - horizon, 40)
  return {
    eye: [foot[0] - lateral, foot[1] - distance, eye],
    yaw: 90 * DEG,
    pitch: 0,
    focal: FOCAL,
    px: sx - (FOCAL * lateral) / distance,
    py: horizon,
  }
}

/** How far back a street view stands from release `r`'s doorway, for the haze. */
export const distanceOf = (view: View, r: number) => footOf(r)[1] - view.eye[1]

/**
 * Release `r` standing in a box of the page (left, top, width, height): its doorway's foot on the
 * box's bottom middle, the cube a little over half the box's height, and the camera walking far
 * enough left of it that the older releases go away behind it across most of the box's width.
 */
export function standing(r: number, box: readonly [number, number, number, number]): { view: View; distance: number; horizon: number } {
  const sx = box[0] + box[2] / 2
  const sy = box[1] + box[3]
  const distance = FOCAL / Math.max(box[3] * 0.62, 50)
  const horizon = sy - (FOCAL * EYE) / distance
  return { view: streetView(r, sx, sy, horizon, EYE, lateralFor(Math.min(box[2] * 0.9, 260), sy, horizon)), distance, horizon }
}

/** A view with its lens shifted so that `point` lands on the page at (sx, sy). */
export function aimed(view: View, point: Vec3, sx: number, sy: number): View {
  const b = basis(view)
  const [x, y] = project({ ...view, px: 0, py: 0 }, b, point)
  return { ...view, px: sx - x, py: sy - y }
}
