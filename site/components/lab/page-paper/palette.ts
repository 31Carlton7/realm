/**
 * The Paper page's ground, as the glass's shader needs it.
 *
 * The page is Realm's light face: the paper is the light theme's `--page`, oklch(0.968 0.004 264)
 * (apps/desktop/src/renderer/src/theme/tokens.css, `:root[data-mode="light"]`). The canvas paints that
 * colour itself wherever no shadow or caustic falls, so it has to be the same colour to the code value
 * or the canvas reads as a rectangle on the page. Worked out from the OKLCH once, here.
 */
export const PAPER_SRGB = [0.95278, 0.95836, 0.96923] as const
export const PAPER_LINEAR = [0.89592, 0.90788, 0.93144] as const
