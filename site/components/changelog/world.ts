import { basis, clamp, project, type Vec3, type View } from "@/components/realms/camera"
import { facing, type Pose } from "@/components/realms/world"

/**
 * Where the releases hang in the landing page's sky (components/realms/world.ts): one realm each, in a
 * row up the route the landing page flies (+y), newest nearest. They hang right of the route, a little
 * higher or lower each, so a camera walking up its middle meets them one at a time, with the older
 * ones going away ahead of it. Plain arithmetic, shared by the index's walk and an entry's arrival, so
 * a release hangs in the same place in both.
 */

/** How far apart the releases hang along the route, in edges. */
export const SPACING = 14
/** The route's line (components/realms/world.ts keeps the sky's realms off it). */
const ROUTE_X = 5

/** Where release `r` hangs, 0 being the newest. */
export const realmOf = (r: number): Vec3 => [ROUTE_X + 2.4, r * SPACING, 0.5 * Math.sin(r * 1.7)]

/** The lens the changelog's views use, in CSS px of focal length. */
export const FOCAL = 1500

const DEG = Math.PI / 180

/**
 * A level view up the route at release `r`, solved so that the realm's middle lands on the page at
 * (sx, sy) and its edge is `edge` px across there: the camera stands that far back, `lateral` left of
 * it and `rise` above it, and the lens is shifted to put the realm where the page wants it.
 */
export function viewAt(r: number, sx: number, sy: number, edge: number, lateral = 2.4, rise = 0.9): View {
  const at = realmOf(r)
  const distance = FOCAL / Math.max(edge, 24)
  const eye: Vec3 = [at[0] - lateral, at[1] - distance, at[2] + rise]
  const view: View = { eye, yaw: 90 * DEG, pitch: 0, focal: FOCAL, px: 0, py: 0 }
  const [x, y] = project(view, basis(view), at)
  return { ...view, px: sx - x, py: sy - y }
}

/**
 * Release `r`'s realm as it is drawn: turned to the camera that comes to it as the mark is drawn, its
 * doorway a little to the right of the eye with the left wall beside it, pitched so its top shows; and
 * never quite still, a slow sway either way about that, as the landing page's own realms are.
 */
export function poseOf(r: number, eye: Vec3, t: number, still: boolean): Pose {
  const at = realmOf(r)
  const sway = still ? 0 : 1
  const drift: Vec3 = [Math.sin(t * 0.31 + r) * 0.06 * sway, Math.cos(t * 0.23 + r * 2) * 0.05 * sway, Math.sin(t * 0.27 + r * 3) * 0.08 * sway]
  const toEye: Vec3 = [eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]]
  const heading = Math.atan2(toEye[1], toEye[0]) + 0.48 + Math.sin(t * 0.17 + r * 1.7) * 0.06 * sway
  const pitch = Math.asin(clamp(toEye[2] / Math.hypot(...toEye), -1, 1)) - 0.36
  return facing([at[0] + drift[0], at[1] + drift[1], at[2] + drift[2]], [Math.cos(pitch) * Math.cos(heading), Math.cos(pitch) * Math.sin(heading), Math.sin(pitch)], 1)
}
