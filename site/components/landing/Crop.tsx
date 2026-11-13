import type { CSSProperties } from "react"

import s from "./landing.module.css"

/** A capture shot at 2x (`src`) and scaled to 1x (`src1x`); `w` and `h` are points, its size in the app. */
export type Picture = { src: string; src1x: string; w: number; h: number }

/**
 * One component from the app, as captured. A phone gets the same component laid out at a phone's
 * width, never the wide one shrunk (design.md).
 */
export type Shot = Picture & {
  alt: string
  phone?: Picture
  /** Cut out on the component's own corners, which the file carries as alpha: no frame radius of ours. */
  cut?: boolean
}

const srcSet = (p: Picture) => `${p.src1x} ${p.w}w, ${p.src} ${p.w * 2}w`

/**
 * Drawn at its size in the app, times the stage's `--scale` (1px a point unless the stage is too
 * narrow), so every crop on a stage shares one scale. `sizes` overrides that width for the browser's
 * pick of file, for a crop the layout sizes itself.
 */
export function Crop({ shot, sizes, className }: { shot: Shot; sizes?: { wide: string; phone: string }; className?: string }) {
  const { phone } = shot
  const style = { "--w": shot.w, "--wp": phone?.w ?? shot.w } as CSSProperties
  return (
    <picture className={`${s.crop} ${className ?? ""}`} style={style} data-cut={shot.cut || undefined}>
      {phone && (
        <source
          media="(max-width: 720px)"
          srcSet={srcSet(phone)}
          sizes={sizes?.phone ?? `${phone.w}px`}
          width={phone.w}
          height={phone.h}
        />
      )}
      <img
        src={shot.src}
        srcSet={srcSet(shot)}
        sizes={sizes?.wide ?? `${shot.w}px`}
        width={shot.w}
        height={shot.h}
        alt={shot.alt}
        decoding="async"
      />
    </picture>
  )
}
