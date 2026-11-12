import s from "./landing.module.css"

/** A capture at twice its size in points; `w` and `h` are points, the size it has in the app. */
export type Picture = { src: string; w: number; h: number }

/**
 * One component from the app, as captured. A phone gets the same component laid out at a phone's
 * width, never the wide one shrunk (design.md).
 */
export type Shot = Picture & { alt: string; phone?: Picture }

export function Crop({ shot, className }: { shot: Shot; className?: string }) {
  return (
    <picture className={`${s.crop} ${className ?? ""}`}>
      {shot.phone && <source media="(max-width: 720px)" srcSet={shot.phone.src} width={shot.phone.w} height={shot.phone.h} />}
      <img src={shot.src} width={shot.w} height={shot.h} alt={shot.alt} decoding="async" />
    </picture>
  )
}
