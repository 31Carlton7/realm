import type { ReactNode } from "react"

import { FieldPanel } from "@/components/realms/FieldPanel"
import { Screen, type ScreenImage } from "@/components/realms/Screen"

/** A chapter's evidence: the capture, what it is, and how it stands on the page. */
export type ChapterPicture = {
  image: ScreenImage
  alt: string
  caption: string
  kind?: "window" | "part"
  zoom?: number
}

/**
 * A chapter of the flight: the claim on a pane of the field on one side, and on the other the slot
 * its picture comes to rest in. The picture is a real capture at its own size and shape (Screen). On a
 * wide screen with motion the field positions it every frame from the realm whose doorway it opens
 * out of (it rides `position: fixed` then, so it moves with the world and not with the scroll), and it
 * lands in this slot exactly when the claim is in the middle of the view. Everywhere else it simply
 * sits in the slot.
 *
 * Source order is claim, then evidence, whichever side the evidence is drawn on. A claim with no
 * capture takes the full measure and reads as prose (design.md).
 */
export function Chapter({
  id,
  side,
  title,
  children,
  picture,
  tall = false,
  stacked = false,
}: {
  id: string
  side: "left" | "right"
  title: ReactNode
  children: ReactNode
  picture: ChapterPicture | null
  tall?: boolean
  /** The words across the page and the picture the whole width under them, for a picture of the whole
   *  window: beside the words it is drawn at half its size, and its type is too small to read. The
   *  stop is then composed around the picture. */
  stacked?: boolean
}) {
  if (stacked) {
    return (
      <section aria-labelledby={`${id}-title`} className="relative">
        <div className="mx-auto w-full max-w-[92rem] px-6 pt-24 pb-28 sm:px-10 lg:pt-40 lg:pb-44">
          <FieldPanel anchor={`c:${id}`} wrapClassName="z-[2] mx-auto max-w-[76rem]" className="px-5 py-6 sm:px-9 sm:py-9">
            <h2 id={`${id}-title`} className="text-[clamp(1.9rem,2.9vw,2.6rem)] leading-[1.06] font-[580] tracking-[-0.04em] text-balance text-ink">
              {title}
            </h2>
            <div className="mt-5 space-y-4 text-[17px] leading-[1.6] text-ink-2">{children}</div>
          </FieldPanel>
          {picture ? (
            <div data-field-anchor={`p:${id}`} className="relative mt-20 lg:mt-32">
              <Screen
                image={picture.image}
                alt={picture.alt}
                caption={picture.caption}
                kind={picture.kind}
                zoom={picture.zoom ?? 1}
                maxHeight="min(calc(100vh - 13rem), 820px)"
                fieldId={id}
                className="mx-auto"
              />
            </div>
          ) : null}
        </div>
      </section>
    )
  }
  const textCols = !picture ? "lg:col-start-3 lg:col-end-11" : side === "right" ? "lg:col-start-1 lg:col-end-6" : "lg:col-start-8 lg:col-end-13"
  const slotCols = side === "right" ? "lg:col-start-6 lg:col-end-13 lg:pl-6 xl:pl-10" : "lg:col-start-1 lg:col-end-8 lg:pr-6 xl:pr-10"
  return (
    <section aria-labelledby={`${id}-title`} className="relative">
      <div
        className={`mx-auto grid w-full max-w-[92rem] grid-cols-1 gap-y-16 px-6 py-24 sm:px-10 lg:grid-cols-12 lg:items-center lg:gap-x-8 lg:py-0 ${tall ? "lg:min-h-[175vh]" : "lg:min-h-[135vh]"}`}
      >
        <FieldPanel anchor={`k:${id}`} wrapClassName={`z-[2] min-w-0 lg:row-start-1 ${textCols}`} className="px-5 py-6 sm:px-8 sm:py-8">
          <h2 id={`${id}-title`} className="text-[clamp(1.9rem,2.9vw,2.6rem)] leading-[1.06] font-[580] tracking-[-0.04em] text-balance text-ink">
            {title}
          </h2>
          <div className="mt-5 max-w-[34rem] space-y-4 text-[17px] leading-[1.6] text-ink-2">{children}</div>
        </FieldPanel>
        {picture ? (
          <div className={`relative min-w-0 pb-24 lg:row-start-1 lg:pb-0 ${slotCols}`}>
            <Screen
              image={picture.image}
              alt={picture.alt}
              caption={picture.caption}
              kind={picture.kind}
              zoom={picture.zoom}
              fieldId={id}
              className="mx-auto"
            />
          </div>
        ) : null}
      </div>
    </section>
  )
}
