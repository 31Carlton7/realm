/**
 * Where the site's pictures of the app come from.
 *
 * Pure arithmetic with no imports, because two programs read it: the site, laying the pictures out,
 * and `scripts/capture-product.mjs` with `encode-product.mjs`, which take and write them. They must
 * agree to the pixel, and one copy is how they do.
 */

/** The window every scene is shot at, in CSS pixels. */
export const WINDOW = { width: 1440, height: 900 }

/**
 * Device pixels per CSS pixel the window is drawn at when it is shot. 3, so a picture drawn at the
 * size it has in the app is sharp on a 2× screen with room for the page to enlarge it by half, and a
 * phone at 3× gets every pixel it can show.
 */
export const CAPTURE_DENSITY = 3

/**
 * The widths a whole-window scene is written at: the window's 1× for a phone, and the capture
 * itself, at 3×, for everything else. Not 2×: a lossless file of a capture scaled down to 2× came out
 * nearly twice the size of the 3× original, because scaling turns every flat edge into a ramp of new
 * colours, and the 3× one is sharper besides.
 */
export const SCENE_WIDTHS = [WINDOW.width, WINDOW.width * CAPTURE_DENSITY] as const

/** A whole-window scene's file at one of SCENE_WIDTHS. */
export const sceneFile = (slug: string, width: number) => `/product/${slug}-${width}.webp`

/** The srcset of a whole-window scene. */
export const sceneSrcSet = (slug: string) => SCENE_WIDTHS.map((width) => `${sceneFile(slug, width)} ${width}w`).join(", ")
