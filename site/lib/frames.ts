/**
 * Where the site's pictures of the app come from, and how a claim's frame is cut out of one.
 *
 * Pure arithmetic with no imports, because two programs read it: the landing page, laying a claim's
 * picture in its frame, and `scripts/encode-product.mjs`, cutting that picture out of the raw capture.
 * They must agree to the pixel, and one copy is how they do.
 *
 * Why a claim gets a picture of its own rather than a zoom into the whole window: a claim shows part
 * of the window (`span` of its width) in a column at most CLAIM_FRAME_MAX CSS pixels wide, which
 * blows that part up — a sidebar claim at 0.56 shows 806 of the window's 1440 points across 944 CSS
 * pixels. Zooming a 2× capture that far left 1.7 image pixels per CSS pixel, short of the 2 a Retina
 * screen draws, and the browser's upscaling is what read as blur. The window is shot at
 * CAPTURE_DENSITY instead, and each claim's region is cut from that, so a frame is never short.
 */

/** The window every scene is shot at, in CSS pixels. */
export const WINDOW = { width: 1440, height: 900 }

/**
 * Device pixels per CSS pixel the window is drawn at when it is shot. 3, because the tightest claim
 * shows 0.56 of the window across a 944px column: 1440 × 0.56 × 3 = 2419 pixels for 1888 device
 * pixels, and anything under 2.4 would leave some claim short at 2×.
 */
export const CAPTURE_DENSITY = 3

/** The widest a claim's frame is ever laid out: 92rem less the page's padding, the text column and
 *  the gap between them. Past the `lg` breakpoint it only shrinks, and stacked it is the column. */
export const CLAIM_FRAME_MAX = 944

/**
 * The widths a whole-window scene is written at: the window's 1× for a phone, and the capture
 * itself, at 3×, for everything else. Not 2×: a lossless file of a capture scaled down to 2× came out
 * nearly twice the size of the 3× original, because scaling turns every flat edge into a ramp of new
 * colours, and the 3× one is sharper besides.
 */
export const SCENE_WIDTHS = [WINDOW.width, WINDOW.width * CAPTURE_DENSITY] as const

/**
 * The frames a claim's picture is shown through — 15/8 letterboxes the window's 16/10, 4/3 is
 * taller than it. Neither matches it, which is the point: a box set to the window's own aspect crops
 * nothing and looks exactly like a crop in the markup.
 */
export const FRAME = { narrow: 4 / 3, wide: 15 / 8 }

/** A region of a capture, as fractions of it: the point to keep centred, and how much width to show. */
export type Focus = { x: number; y: number; span: number }

/**
 * Hold a window of size `visible` inside 0..1, centred on `point` where it can be.
 *
 * The subject of a claim is not always near the middle — the activity list is a strip down the far
 * left — and centring a point that close to an edge would pull the page's own background into frame
 * beside it. A point nearer the edge than half a window stops half a window in, so the crop slides up
 * against the edge and stays full.
 */
export function hold(point: number, visible: number): number {
  if (visible >= 1) return 0.5
  return Math.min(Math.max(point, visible / 2), 1 - visible / 2)
}

/** How much of the window's height a frame of this aspect shows at the focus's span. */
const visibleHeight = (focus: Focus, frame: number) => (WINDOW.width / WINDOW.height) * focus.span / frame

/**
 * The part of the window a claim's picture is cut to, as fractions of it: the focus's span across,
 * and down, everything either frame can show — the taller 4/3 one's window and the 15/8 one's, which
 * differ only where one is held against an edge.
 */
export function cropOf(focus: Focus) {
  const x = hold(focus.x, focus.span) - focus.span / 2
  const windows = [FRAME.narrow, FRAME.wide].map((frame) => {
    const visible = Math.min(1, visibleHeight(focus, frame))
    const top = hold(focus.y, visible) - visible / 2
    return [top, top + visible]
  })
  const top = Math.max(0, Math.min(...windows.map(([t]) => t)))
  const bottom = Math.min(1, Math.max(...windows.map(([, b]) => b)))
  return { x, y: top, width: focus.span, height: bottom - top }
}

/** `cropOf` in the raw capture's pixels, rounded once, here, so the file and the markup agree. */
export function cropPixels(focus: Focus) {
  const crop = cropOf(focus)
  const across = WINDOW.width * CAPTURE_DENSITY
  const down = WINDOW.height * CAPTURE_DENSITY
  const left = Math.round(crop.x * across)
  const top = Math.round(crop.y * down)
  return {
    left,
    top,
    width: Math.min(across - left, Math.round(crop.width * across)),
    height: Math.min(down - top, Math.round(crop.height * down)),
  }
}

/**
 * How far up the cut picture is pulled, as a fraction of its own height, so the point the frame
 * centres on lands in the middle of a frame of this aspect. The picture is laid at the frame's width
 * from its vertical middle; `translate` resolves percentages against the element, so this is the
 * whole of the positioning.
 */
export function liftOf(focus: Focus, frame: number): number {
  const crop = cropOf(focus)
  const centre = hold(focus.y, visibleHeight(focus, frame))
  return (centre - crop.y) / crop.height
}

/** A claim's own cut of its scene, at the capture's full density. One size: a smaller copy of a cut
 *  this small saved nothing, for the same reason as SCENE_WIDTHS. */
export const claimFile = (id: string) => `/product/claims/${id}.webp`

/** A whole-window scene's file at one of SCENE_WIDTHS. */
export const sceneFile = (slug: string, width: number) => `/product/${slug}-${width}.webp`

/** The srcset of a whole-window scene. */
export const sceneSrcSet = (slug: string) => SCENE_WIDTHS.map((width) => `${sceneFile(slug, width)} ${width}w`).join(", ")
