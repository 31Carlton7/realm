import Image, { type StaticImageData } from "next/image"
import type { CSSProperties, ReactNode } from "react"

import { CAPTURE_DENSITY } from "@/lib/frames"

/**
 * A capture of the app, shown as the landing page shows its screens: a lit frame on the page's own
 * ground, with the one-device-pixel outline drawn inside the picture so a dark capture's edge never
 * dissolves into the page, and its caption under it.
 *
 * It is laid out at its natural size, which is a third of its pixels (the crops are cut from a window
 * drawn at three times its density, lib/frames.ts), and never wider than the room the page gives it
 * in `--figure-room`: a narrow crop is not blown up, and a whole window may run past the reading
 * column into the space beside it. Served as written, lossless; Next's optimiser would re-encode it.
 *
 * The API is the picture, what it shows, and what the caption says, so it can become the landing
 * page's Screen when that is shared.
 */
export function Figure({ image, alt, caption }: { image: StaticImageData; alt: string; caption: ReactNode }) {
  const width = Math.round(image.width / CAPTURE_DENSITY)
  const height = Math.round(image.height / CAPTURE_DENSITY)
  return (
    <figure className="w-[min(var(--w),var(--figure-room,100%))] max-w-none" style={{ "--w": `${width}px` } as CSSProperties}>
      <div className="relative overflow-hidden rounded-[12px] bg-page shadow-[0_0_0_1px_oklch(1_0_0/0.08),0_0_10px_oklch(0.8_0.07_250/0.1),0_0_64px_oklch(0.78_0.08_250/0.06),0_32px_80px_-32px_oklch(0_0_0/0.85)]">
        <Image src={image} alt={alt} width={width} height={height} sizes={`(min-width: 1024px) ${width}px, 100vw`} unoptimized className="block h-auto w-full" />
        <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[12px] shadow-[inset_0_0_0_1px_oklch(1_0_0/0.1)]" />
      </div>
      <figcaption className="mt-3.5 max-w-[62ch] text-[14px] leading-[1.55] text-ink-2">{caption}</figcaption>
    </figure>
  )
}
