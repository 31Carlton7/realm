/**
 * Which of the hero's stars the sky keeps, as plain functions of CSS-px boxes, so a test can check the
 * decision Aperture's shader makes. `clearOf` in the shader is `distanceTo` over every clear box, and a
 * star is drawn only where that distance is above 0 (it then fades in over CLEAR_FEATHER).
 */

/** How many text blocks the shader can clear; any past it are ignored. */
export const MAX_CLEAR = 12
/** Clear space round a text block, in CSS px: a few px of air plus the widest star's own reach. */
export const CLEAR_MARGIN = 10
export const CLEAR_FEATHER = 8

/** A star's radius is STAR_SIZE + STAR_GROWTH × its magnitude (0 to 1), in CSS px. */
export const STAR_SIZE = 0.5
export const STAR_GROWTH = 0.8
/** Radii from its centre at which a star's gaussian has fallen under 1/255 of its peak. */
export const STAR_REACH = 3

export type Box = { left: number; top: number; right: number; bottom: number }

/** How far out a star of this magnitude still lights a pixel, in CSS px. */
export const starReach = (magnitude: number) => STAR_REACH * (STAR_SIZE + STAR_GROWTH * magnitude)

export const grow = (b: Box, by: number): Box => ({
  left: b.left - by,
  top: b.top - by,
  right: b.right + by,
  bottom: b.bottom + by,
})

/** The distance from a point to a box, 0 on or inside it. */
export function distanceTo(b: Box, x: number, y: number) {
  return Math.hypot(Math.max(b.left - x, x - b.right, 0), Math.max(b.top - y, y - b.bottom, 0))
}

/** The boxes the sky clears: each text block's box grown by the margin, as many as the shader holds. */
export const clearBoxes = (text: Box[]) => text.slice(0, MAX_CLEAR).map((b) => grow(b, CLEAR_MARGIN))

/** Whether the sky draws a star centred at (x, y), given the boxes it clears. */
export const keepsStar = (clear: Box[], x: number, y: number) =>
  clear.slice(0, MAX_CLEAR).every((b) => distanceTo(b, x, y) > 0)

/** A clear box in the shader's terms: device px from the canvas's lower left, as [x0, y0, x1, y1]. */
export const toShader = (b: Box, canvas: Box, dpr: number) => [
  (b.left - canvas.left) * dpr,
  (canvas.bottom - b.bottom) * dpr,
  (b.right - canvas.left) * dpr,
  (canvas.bottom - b.top) * dpr,
]
