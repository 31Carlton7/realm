import type { CSSProperties, ReactNode } from "react"

import type { Focus } from "@/lib/frames"
import { claimFile, cropPixels, liftOf, sceneSrcSet, WINDOW } from "@/lib/frames"

/** The screens' frame: 3:2, between the landing page's 4:3 and 15:8, so every claim's cut covers it. */
const FRAME = 3 / 2
const WHOLE: Focus = { x: 0.5, y: 0.5, span: 1 }

export type Picture =
  | { kind: "claim"; id: string; focus?: Focus; alt: string }
  | { kind: "scene"; slug: string; alt: string }

/**
 * A chapter of the flight: the claim on clean ground on one side, and on the other the slot its
 * screen comes to rest in. The screen is a real capture. On a wide screen with motion the field
 * positions it every frame from the realm whose doorway it opens out of (it rides `position: fixed`
 * then, so it moves with the world and not with the scroll), and it lands in this slot exactly when
 * the claim is in the middle of the view. Everywhere else it simply sits in the slot.
 *
 * Source order is claim, then evidence, whichever side the evidence is drawn on.
 */
export function Chapter({
  id,
  side,
  title,
  children,
  picture,
  caption,
  tall = false,
}: {
  id: string
  side: "left" | "right"
  title: ReactNode
  children: ReactNode
  picture: Picture
  caption: string
  tall?: boolean
}) {
  const textCols = side === "right" ? "lg:col-start-1 lg:col-end-6" : "lg:col-start-8 lg:col-end-13"
  const slotCols = side === "right" ? "lg:col-start-6 lg:col-end-13 lg:pl-6 xl:pl-10" : "lg:col-start-1 lg:col-end-8 lg:pr-6 xl:pr-10"
  return (
    <section aria-labelledby={`${id}-title`} className="relative">
      <div
        className={`mx-auto grid w-full max-w-[92rem] grid-cols-1 gap-y-10 px-6 py-24 sm:px-10 lg:grid-cols-12 lg:items-center lg:gap-x-8 lg:py-0 ${tall ? "lg:min-h-[175vh]" : "lg:min-h-[135vh]"}`}
      >
        <div data-lab-anchor={`k:${id}`} className={`relative z-[2] min-w-0 lg:row-start-1 ${textCols}`}>
          <h2 id={`${id}-title`} className="text-[clamp(1.9rem,2.9vw,2.6rem)] leading-[1.06] font-[580] tracking-[-0.04em] text-balance text-ink">
            {title}
          </h2>
          <div className="mt-5 max-w-[34rem] space-y-4 text-[17px] leading-[1.6] text-ink-2">{children}</div>
        </div>
        <div data-lab-anchor={`s:${id}`} className={`relative min-w-0 lg:row-start-1 ${slotCols}`}>
          <Screen id={id} picture={picture} caption={caption} />
        </div>
      </div>
    </section>
  )
}

/**
 * The capture as a lit screen: a 3:2 frame with the one-device-pixel inset outline every capture
 * keeps, and its caption under it. The frame's own box is what the field reads for its light.
 */
export function Screen({ id, picture, caption }: { id: string; picture: Picture; caption: string }) {
  return (
    <div className="relative aspect-[3/2] w-full">
      <figure
        data-screen={id}
        className="absolute inset-0 z-[1] origin-top-left [html[data-realms-flight=on]_&]:fixed [html[data-realms-flight=on]_&]:inset-auto [html[data-realms-flight=on]_&]:top-0 [html[data-realms-flight=on]_&]:left-0 [html[data-realms-flight=on]_&]:opacity-0"
      >
        <div className="relative h-full w-full overflow-hidden rounded-[12px] bg-page shadow-[0_0_0_1px_oklch(1_0_0/0.1),0_30px_80px_-30px_oklch(0_0_0/0.8)] [html[data-lab-field=off]_&]:shadow-[0_0_0_1px_oklch(1_0_0/0.12),0_0_70px_-20px_oklch(0.68_0.173_253.301/0.4)]">
          <Capture picture={picture} />
          {/* The inset outline: one device pixel of white, inside the picture, so its dark edge never
              dissolves into the haze behind it. */}
          <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[12px] shadow-[inset_0_0_0_1px_oklch(1_0_0/0.1)]" />
        </div>
        <figcaption className="absolute top-full left-0 mt-3.5 max-w-[60ch] pr-4 text-[14px] leading-[1.5] text-ink-2">{caption}</figcaption>
      </figure>
    </div>
  )
}

function Capture({ picture }: { picture: Picture }) {
  if (picture.kind === "scene") {
    return (
      <img
        src={`/product/${picture.slug}-1440.webp`}
        srcSet={sceneSrcSet(picture.slug)}
        sizes="(min-width: 1024px) 56vw, 100vw"
        alt={picture.alt}
        width={WINDOW.width}
        height={WINDOW.height}
        loading="lazy"
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover object-[50%_40%]"
      />
    )
  }
  const focus = picture.focus ?? WHOLE
  const crop = cropPixels(focus)
  return (
    <img
      src={claimFile(picture.id)}
      alt={picture.alt}
      width={crop.width}
      height={crop.height}
      loading="lazy"
      decoding="async"
      style={{ translate: `0 ${-liftOf(focus, FRAME) * 100}%` } as CSSProperties}
      className="absolute top-1/2 left-0 h-auto w-full max-w-none"
    />
  )
}
