import Image from "next/image"

import type { Claim } from "@/content/home"

/**
 * The captures are 2880x1800, and their bottom band is the prompter — whose model chip reads "Fake",
 * because the capture harness drives a scripted agent. True of the harness, not of Realm, and not a
 * word to put under a claim about which agents run here. So the frame CROPS it, and the crop has to
 * survive both breakpoints:
 *
 *   - `sm` and up: a 15/8 box is narrower than the image's 16/10, so `overflow-hidden` takes the
 *     bottom ~260px and the full width stays. (16/10 would have cropped NOTHING — an aspect equal to
 *     the source's is a crop only on paper, which is how the band shipped into view once already.)
 *   - Below `sm`: a 4/3 box is WIDER than the source in the other direction, so object-fit alone can
 *     only ever pan left and right — no object-position hides a bottom band there. The image is laid
 *     out at 180% of the column instead and anchored top-left, which takes the top-left ~1600x1200 of
 *     the frame: one legible region rather than a whole desktop app shrunk to 390px.
 */
const SHOT = { width: 2880, height: 1800 }

/**
 * One claim and the product view that is evidence for it.
 *
 * The capture alternates sides down the page so the eye has somewhere to go, and it alternates with
 * `flex-row-reverse` rather than by reordering the markup: source order stays claim-then-evidence, so
 * the stacked layout reads the right way round and a screen reader hears the argument before its
 * proof.
 *
 * A claim with no capture is not given a borrowed one. It takes the full measure instead and reads as
 * prose — a picture of a different feature under this sentence would be worse than no picture, which
 * is the whole reason the manifest and the copy are separate lists.
 */
export function ClaimSection({ claim, index }: { claim: Claim; index: number }) {
  const flipped = index % 2 === 1

  if (!claim.capture) {
    return (
      <section aria-labelledby={`${claim.id}-title`} className="mx-auto w-full max-w-[46rem] px-6 py-16 sm:px-10 sm:py-20">
        <h2 id={`${claim.id}-title`} className="text-[clamp(1.6rem,2.6vw,2.1rem)] leading-[1.12] font-[560] tracking-[-0.032em] text-balance text-ink">
          {claim.title}
        </h2>
        <p className="mt-4 text-[16px] leading-[1.6] text-ink-2">{claim.body}</p>
      </section>
    )
  }

  return (
    <section
      aria-labelledby={`${claim.id}-title`}
      className={`mx-auto flex w-full max-w-[92rem] flex-col gap-8 px-6 py-16 sm:px-10 sm:py-20 lg:items-center lg:gap-16 ${
        flipped ? "lg:flex-row-reverse" : "lg:flex-row"
      }`}
    >
      <div className="min-w-0 lg:w-[24rem] lg:shrink-0">
        <h2 id={`${claim.id}-title`} className="text-[clamp(1.6rem,2.6vw,2.1rem)] leading-[1.12] font-[560] tracking-[-0.032em] text-balance text-ink">
          {claim.title}
        </h2>
        <p className="mt-4 text-[16px] leading-[1.6] text-ink-2">{claim.body}</p>
      </div>

      <figure className="min-w-0 flex-1">
        <div className="app-corner aspect-4/3 w-full overflow-hidden rounded-[20px] shadow-[0_0_0_1px_oklch(1_0_0/0.09),0_24px_60px_-24px_oklch(0_0_0/0.75)] sm:aspect-[15/8]">
          <Image
            src={`/product/${claim.capture}.png`}
            alt={claim.caption ?? claim.title}
            width={SHOT.width}
            height={SHOT.height}
            sizes="(max-width: 640px) 180vw, (max-width: 1024px) 100vw, 60vw"
            className="h-auto w-[180%] max-w-none sm:w-full"
          />
        </div>
        {claim.caption ? (
          <figcaption className="mt-3.5 max-w-[62ch] text-[14px] leading-[1.5] text-ink-3">{claim.caption}</figcaption>
        ) : null}
      </figure>
    </section>
  )
}
