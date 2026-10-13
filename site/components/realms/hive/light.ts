/**
 * The light of the realms' sky, in linear RGB, shared by the shader and the drawing that stands in for
 * it without WebGPU, so the two are the same sky.
 */

/** Door light: white, a little toward the accent. */
export const DOOR_LIGHT = [0.82, 0.9, 1.0] as const
/** Some agents' doorways burn bluer — Realm's accent, never warm. */
export const DOOR_BLUE = [0.42, 0.66, 1.0] as const

export const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
export const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

const hex = (value: string) => [1, 3, 5].map((i) => toLinear(parseInt(value.slice(i, i + 2), 16) / 255)) as [number, number, number]

/**
 * Deep space, in Realm's own range: blacks and navies, blues, cyans and white light, and nothing warm,
 * green or violet (those mean state in Realm, and design.md refuses the purple glow). Linear.
 */
export const SPACE = {
  /** The black between the stars, a breath of navy in it. */
  deep: hex("#03050b"),
  /** Where the sky is lit by nothing in particular: the galaxy's own faint glow. */
  navy: hex("#0a1430"),
  /** A nebula thin and far: the deep blue of its outskirts. */
  cloud: hex("#0b2c78"),
  /** Thicker: Realm's blue, a little brighter than the accent. */
  blue: hex("#2b74ea"),
  /** Where it is lit from inside: cyan. */
  cyan: hex("#56cdff"),
  /** And at the heart of it: white, a little toward blue. */
  white: hex("#eaf3ff"),
  /** The light a far star cluster throws on the realms. */
  key: hex("#dde9ff"),
} as const
