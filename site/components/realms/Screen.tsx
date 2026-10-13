import type { CSSProperties, ReactNode } from "react"

/**
 * A capture of the app as the site shows it, at the capture's own size and shape.
 *
 * `width` and `height` are the size the surface had in the app, in points; the file is that at the
 * capture's density (3×, lib/frames.ts), so it stays sharp on a Retina screen up to 1.5× zoom.
 * `radius` is the surface's own corner in the same points; it is drawn as a share of the picture's
 * width, so it scales with the picture.
 */
export type ScreenImage = {
  /** The file at full density. */
  src: string
  /** Width-described candidates, for a whole-window scene that also has a 1× copy for phones. */
  srcSet?: string
  width: number
  height: number
  radius: number
}

export type ScreenProps = {
  image: ScreenImage
  alt: string
  /** What is in the frame (design.md: a caption describes what is IN the frame), on a tab that hangs
   *  from the middle of the plate's foot. */
  caption?: ReactNode
  /**
   * `window`: the app's whole window (or a scene of it). `part`: a surface lifted off the window — a
   * picker, a column, a card and its ground. Each sits on the plate under its own shadow. Default
   * `part`.
   */
  kind?: "window" | "part"
  /** The most it is enlarged past the size it had in the app. Default 1.15: a part is read at about
   *  the size it is used at, so its text stays at the size it was set. */
  zoom?: number
  /** The tallest the plate may be drawn, as a CSS length: a tall part shrinks to stay in one view
   *  with its caption under it, below the page's header. Default `min(76vh, 760px)`. */
  maxHeight?: string
  /** `sizes` for `srcSet`. Default: the chapter column on a wide screen, the viewport below it. */
  sizes?: string
  /** Load it eagerly (above the fold). */
  priority?: boolean
  /**
   * The landing page's flight. Given an id, the plate is the slot the field reads (`s:<id>`), the
   * figure is what the field moves and lights (`data-screen`, with `data-radius` the plate's corner
   * as a share of its width), and the caption's tab rides with it.
   */
  fieldId?: string
  className?: string
}

/** The plate's margin round the picture on a wide screen, in CSS px (globals.css `.screen`). */
const PLATE = 16

/**
 * A picture of the app: a real capture, drawn the way the app draws the surface it shows, set on a
 * plate of the realm it comes from.
 *
 * The plate is a margin of the field's own dark, lit from above: a rim of the doorways' blue-white
 * light along its edge, brightest across the top, and the lattice the realms stand on in its margin,
 * fading down it. Its corner is concentric with the picture's. The caption hangs from the middle of
 * its foot on a tab cut from the same plate, so the words read as coming out of the picture rather
 * than as a card left under it.
 *
 * The picture's box always has the capture's own aspect, so the page crops nothing; it takes the
 * width it is given up to `zoom` times its own. It keeps the one-device-pixel inset outline
 * (design.md, Surfaces) and the light from above on its top edge, each a ring a hairline wide on its
 * own curve, so nothing is laid over the picture itself.
 */
export function Screen({
  image,
  alt,
  caption,
  kind = "part",
  zoom = 1.15,
  maxHeight = "min(76vh, 760px)",
  sizes = "(min-width: 1024px) 760px, 100vw",
  priority = false,
  fieldId,
  className = "",
}: ScreenProps) {
  const { width, height, radius } = image
  const share = radius / width
  const aspect = +(width / height).toFixed(5)
  // The plate is the picture's width and the margin either side, and never so wide that it is
  // taller than `maxHeight`: the picture's aspect sets its height, and the margin adds to both.
  const maxWidth = `min(${Math.round(width * zoom) + 2 * PLATE}px, calc((${maxHeight} - 2 * var(--pad)) * ${aspect} + 2 * var(--pad)))`
  // The plate's corner as a share of its width, at the width it is drawn at on a wide screen: what
  // the field rounds the screen's light to.
  const plateWidth = Math.round(width * zoom) + 2 * PLATE
  const plateRadius = (share * (plateWidth - 2 * PLATE) + PLATE) / plateWidth
  return (
    <div className={`screen ${className}`} data-kind={kind} style={{ maxWidth, "--share": share } as CSSProperties}>
      <div data-field-anchor={fieldId ? `s:${fieldId}` : undefined} className="screen-slot">
        <span aria-hidden className="screen-room" style={{ aspectRatio: `${width} / ${height}` }} />
        <figure data-screen={fieldId} data-radius={fieldId ? plateRadius.toFixed(5) : undefined} className="screen-figure @container">
          <div className="plate screen-plate">
            <div className="screen-frame">
              <img
                src={image.src}
                srcSet={image.srcSet}
                sizes={image.srcSet ? sizes : undefined}
                alt={alt}
                width={width}
                height={height}
                loading={priority ? "eager" : "lazy"}
                fetchPriority={priority ? "high" : undefined}
                decoding="async"
                className="screen-image"
              />
              <span aria-hidden className="screen-light" />
            </div>
          </div>
          {caption ? <figcaption className="screen-tab">{caption}</figcaption> : null}
        </figure>
      </div>
    </div>
  )
}
