import type { Pt } from "../kit/route"

/**
 * What the hero's light draws, published by the map every frame it changes, in the map's own
 * coordinates (CSS px from the plate's top-left). The map owns every position; the light only reads
 * them, so it can never drift from the line it belongs to.
 *
 *   segments  stretches of line that carry light: a hovered line along its length, a pulse's tail
 *             (brightening toward its head); intensity at each end
 *   points    pulse heads and landings: a centre, a reach (CSS px), an intensity
 *   rim       where on the window's left edge light arrives: a y, an intensity, a spread
 *   win       the window's frame, which the rim light runs along, outside its edge only
 */
export type LightSegment = { a: Pt; b: Pt; ia: number; ib: number; width: number }
export type LightPoint = { at: Pt; reach: number; i: number }
export type RimLight = { y: number; i: number; spread: number }
export type LightFrame = {
  segments: LightSegment[]
  points: LightPoint[]
  /** Positions along the window's left edge (a wide screen) or its top edge (a phone). */
  rim: RimLight[]
  edge: "left" | "top"
  win: { x: number; y: number; w: number; h: number } | null
}

const EMPTY: LightFrame = { segments: [], points: [], rim: [], edge: "left", win: null }

let current: LightFrame = EMPTY
const listeners = new Set<() => void>()

export function publishLight(frame: LightFrame) {
  current = frame
  for (const l of listeners) l()
}

export const readLight = () => current

/** For a still frame: the light redraws only when the map publishes something new. */
export function onLight(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
