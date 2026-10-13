/**
 * The hive's light, in linear RGB, shared by the shader and the drawing that stands in for it without
 * WebGPU, so the two are the same field at the same hour.
 */

/** How far apart the cubes stand, as a multiple of the spacing at which their outlines would touch. */
export const SPACING = 1.3

/** Blue hour: the cubes catch only a cool sky, a long way down from the mark's daylight. */
export const DUSK = [0.052, 0.057, 0.072] as const
/** A top sees all of the sky, a wall half of it: the top's share over the walls'. */
export const OPEN_SKY = 1.35
/** Door light: white, a little toward the accent. */
export const DOOR_LIGHT = [0.82, 0.9, 1.0] as const
/** Some agents' doorways burn bluer — Realm's accent, never warm. */
export const DOOR_BLUE = [0.42, 0.66, 1.0] as const
/** What a doorway throws onto the ground, bluer than the doorway itself. */
export const SPILL_LIGHT = [0.62, 0.8, 1.0] as const
/** The lamp the pointer holds over the model. */
export const POINTER_LIGHT = [0.84, 0.9, 1.0] as const

export const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
export const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)
