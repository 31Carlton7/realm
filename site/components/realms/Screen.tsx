import type { CSSProperties, ReactNode } from "react"

/**
 * A capture of the app as the site shows it, at the capture's own size and shape.
 *
 * `width` and `height` are the size the surface had in the app, in points; the file is that at the
 * capture's density (3×, lib/frames.ts), so it stays sharp on a Retina screen up to 1.5× zoom.
 * `radius` is the surface's own corner in the same points; it is drawn as a share of the box, so it
 * scales with the picture.
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
  /** What is in the frame (design.md: a caption describes what is IN the frame), set under it on a
   *  small pane of the field: from its left edge, or centred under a picture narrower than it. */
  caption?: ReactNode
  /**
   * `window`: the app's whole window (or a scene of it), standing in the page under a window's
   * shadow. `part`: a surface lifted off the window — a picker, a column, a card and its ground —
   * floating under the app's own raised shadow. Default `part`.
   */
  kind?: "window" | "part"
  /** The most it is enlarged past the size it had in the app. Default 1.15: a part is read at about
   *  the size it is used at, so its text stays at the size it was set. */
  zoom?: number
  /** The tallest it may be drawn, as a CSS length: a tall part shrinks to stay in one view with its
   *  caption under it, below the page's header. Default `min(76vh, 760px)`. */
  maxHeight?: string
  /** `sizes` for `srcSet`. Default: the chapter column on a wide screen, the viewport below it. */
  sizes?: string
  /** Load it eagerly (above the fold). */
  priority?: boolean
  /**
   * The landing page's flight. Given an id, the box is the slot the field reads (`s:<id>`), the figure
   * is what the field moves and lights (`data-screen`, with `data-radius` its corner as a share of
   * its width), the caption rides with it, and a contact shadow stands it on the field's ground.
   */
  fieldId?: string
  className?: string
}

const percent = (n: number) => `${+(n * 100).toFixed(4)}%`

/**
 * A picture of the app: a real capture, drawn the way the app draws the surface it shows.
 *
 * Its box always has the picture's own aspect, so the page crops nothing; it takes the width it is
 * given up to `zoom` times its own. The one-device-pixel inset outline (design.md, Surfaces), the light
 * from above on its top edge and, in the flight, the pointer's lamp on its rim are each a ring a
 * hairline wide on the surface's own curve — nothing is laid over the picture itself.
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
  const corner = { "--screen-radius": `${percent(radius / width)} / ${percent(radius / height)}` } as CSSProperties
  // As wide as the column, never past `zoom` times its own size, and never so wide that it is taller
  // than `maxHeight`: the aspect is the picture's, so the height follows.
  const maxWidth = `min(${Math.round(width * zoom)}px, calc(${maxHeight} * ${+(width / height).toFixed(5)}))`
  return (
    <div className={`screen ${className}`} data-kind={kind} style={{ maxWidth }}>
      <div data-field-anchor={fieldId ? `s:${fieldId}` : undefined} className="screen-slot" style={{ aspectRatio: `${width} / ${height}`, ...corner }}>
        <figure data-screen={fieldId} data-radius={fieldId ? (radius / width).toFixed(5) : undefined} className="screen-figure @container">
          {fieldId ? <span aria-hidden className="screen-ground" /> : null}
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
          {caption ? (
            <figcaption
              data-field-anchor={fieldId ? `c:caption-${fieldId}` : undefined}
              data-field-panel={fieldId ? 12 : undefined}
              className="field-panel absolute top-full left-0 mt-6 w-max max-w-[min(34rem,max(22rem,100%),calc(100vw-3rem))] rounded-[12px] px-3.5 py-2.5 text-[14px] leading-[1.5] text-ink-2 @max-[22rem]:left-1/2 @max-[22rem]:-translate-x-1/2"
            >
              {caption}
            </figcaption>
          ) : null}
        </figure>
      </div>
    </div>
  )
}
