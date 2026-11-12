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
  /** The colour the capture ends on along its foot, where it is not the app's canvas
   *  (`--picture-foot`): the caption's tab is cut from it. */
  foot?: string
}

export type ScreenProps = {
  image: ScreenImage
  alt: string
  /** What is in the frame (design.md: a caption describes what is IN the frame), on a tab that hangs
   *  from the middle of the picture's foot. */
  caption?: ReactNode
  /**
   * A narrower capture of the same subject for a phone, where the wide one would be drawn at less
   * than half its size; with its own caption where it shows less than the wide one does.
   */
  phone?: { image: ScreenImage; caption?: ReactNode }
  /**
   * `window`: the app's whole window (or a scene of it). `part`: a surface lifted off the window — a
   * picker, a column, a card and its ground. A window casts the wider shade. Default `part`.
   */
  kind?: "window" | "part"
  /** The most it is enlarged past the size it had in the app. Default 1.15: a part is read at about
   *  the size it is used at, so its text stays at the size it was set. */
  zoom?: number
  /** The tallest the picture may be drawn, as a CSS length: a tall part shrinks to stay in one view
   *  with its caption under it, below the page's header. Default `min(76vh, 760px)`. */
  maxHeight?: string
  /** `sizes` for `srcSet`. Default: the chapter column on a wide screen, the viewport below it. */
  sizes?: string
  /** Load it eagerly (above the fold). */
  priority?: boolean
  /**
   * The landing page's flight. Given an id, the picture's box is the slot the field reads (`s:<id>`),
   * the figure is what the field moves and lights (`data-screen`, with `data-radius` the picture's
   * corner as a share of its width), and the caption's tab rides with it.
   */
  fieldId?: string
  className?: string
}

/**
 * A picture of the app: a real capture, drawn the way the app draws the surface it shows.
 *
 * The picture's own edge is its frame. On it, a rim of the doorways' blue-white light, brightest
 * across the top, and the one-device-pixel inset outline (design.md, Surfaces), each a ring on the
 * picture's own curve, so nothing is laid over the picture itself; under it, a shade on the sky. The
 * caption hangs from the middle of its foot on a tab cut from the ground the picture ends on, so the
 * words read as coming out of the picture rather than as a card left under it.
 *
 * The picture's box always has the capture's own aspect, so the page crops nothing; it takes the
 * width it is given up to `zoom` times its own.
 */
export function Screen({
  image,
  alt,
  caption,
  phone,
  kind = "part",
  zoom = 1.15,
  maxHeight = "min(76vh, 760px)",
  sizes = "(min-width: 1024px) 760px, 100vw",
  priority = false,
  fieldId,
  className = "",
}: ScreenProps) {
  const { width, height, radius } = image
  // Never so wide that it is taller than `maxHeight`: the picture's aspect sets its height.
  const limit = (picture: ScreenImage) =>
    `min(${Math.round(picture.width * zoom)}px, calc(${maxHeight} * ${+(picture.width / picture.height).toFixed(5)}))`
  const shape = {
    "--foot": image.foot,
    "--share-wide": radius / width,
    "--aspect-wide": `${width} / ${height}`,
    "--max-wide": limit(image),
    ...(phone
      ? { "--share-phone": phone.image.radius / phone.image.width, "--aspect-phone": `${phone.image.width} / ${phone.image.height}`, "--max-phone": limit(phone.image) }
      : {}),
  } as CSSProperties
  return (
    <div className={`screen ${className}`} data-kind={kind} style={shape}>
      <div data-field-anchor={fieldId ? `s:${fieldId}` : undefined} className="screen-slot">
        <span aria-hidden className="screen-room" />
        {/* `data-radius`: the corner the field rounds the screen's light to, as a share of its width. */}
        <figure data-screen={fieldId} data-radius={fieldId ? (radius / width).toFixed(5) : undefined} className="screen-figure @container">
          <div className="picture-edge screen-frame">
            <picture>
              {phone ? <source media="(max-width: 639px)" srcSet={phone.image.src} width={phone.image.width} height={phone.image.height} /> : null}
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
            </picture>
            <span aria-hidden className="screen-light" />
          </div>
          {caption ? (
            <figcaption className="screen-tab">
              {phone?.caption ? (
                <>
                  <span className="max-sm:hidden">{caption}</span>
                  <span className="sm:hidden">{phone.caption}</span>
                </>
              ) : (
                caption
              )}
            </figcaption>
          ) : null}
        </figure>
      </div>
    </div>
  )
}
