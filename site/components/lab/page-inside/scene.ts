/**
 * What the page tells the studio light beyond the rects it reads for itself: where the key light
 * hangs, where the floor is, and where the words' side of the stage falls into the dark. The camera
 * writes it as it moves; the light reads it every frame. Where nothing has been written (a phone,
 * reduced motion), the light hangs above the first lit object it finds.
 */
export type Rect = readonly [number, number, number, number]

export const studioScene: {
  key: readonly [number, number, number, number] | null
  floor: number | null
  /** Where the words' side of the stage begins to fall into the dark, and where the light is whole. */
  dark: readonly [number, number] | null
} = { key: null, floor: null, dark: null }

/**
 * Run at the start of every frame the light draws, before it reads a single rect: the camera moves the
 * window here, so the light and the window it belongs to are always of the same frame.
 */
export const beforeLight = new Set<() => void>()
