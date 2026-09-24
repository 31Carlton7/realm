import Image from "next/image"
import type { CSSProperties } from "react"

import type { Claim, Focus } from "@/content/home"

/** Every scene is shot at the whole 1440x900 window and written out at 2x. */
const SHOT = { width: 2880, height: 1800 }

/**
 * The frames the capture is shown through — 15/8 letterboxes the source's 16/10, 4/3 is taller than
 * it. Neither matches it, which is the point: a box set to the source's own aspect crops nothing and
 * looks exactly like a crop in the markup.
 */
const FRAME = { narrow: 4 / 3, wide: 15 / 8 }

/**
 * A claim with no region named takes the whole capture, top-anchored.
 *
 * Top-anchored because the bottom band of a capture is the prompter, whose model chip reads "Fake" —
 * the capture harness drives a scripted agent, which is true of the harness and not of Realm, and is
 * not a word to put under a claim about which agents run here. It has shipped into view once already.
 * A named region stays clear of it by sitting well inside the frame; one with a `y` near the bottom
 * of a capture that has a composer is how it comes back, so read the rendered frame, not the number.
 */
const WHOLE = { x: 0.5, y: 0, span: 1 }

/**
 * How far up the capture is pulled so the focal point lands in the middle of a frame of this shape.
 *
 * The image is laid at `100/span` of the frame's width and then pulled back by the focal point's own
 * fraction of itself — `translate` resolves percentages against the element, not its container, so
 * the width and the horizontal pull are one pair of numbers for both frames. Only this one differs,
 * because a 4/3 frame takes more of the capture's height at that width than a 15/8 frame does.
 */
function lift(focus: Focus, frame: number): string {
  const visible = ((SHOT.width / SHOT.height) * focus.span) / frame
  return `${-hold(focus.y, visible) * 100}%`
}

/**
 * Hold the frame inside the capture.
 *
 * The subject of a claim is not always near the middle — the activity list is a strip down the far
 * left — and centring a point that close to an edge would pull the page's own background into frame
 * beside it. A point nearer the edge than half a frame stops half a frame in, so the crop slides up
 * against the edge and stays full.
 */
function hold(point: number, visible: number): number {
  if (visible >= 1) return 0.5
  return Math.min(Math.max(point, visible / 2), 1 - visible / 2)
}

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

  /*
   * One span, two frames. Zooming the narrow frame further was the obvious thing and it was wrong:
   * a span tighter than the subject cuts the subject, and a plan block sliced down its left edge is
   * exactly the focal relationship a narrow screen is supposed to keep. The phone gets the same crop
   * and reads it smaller, with the taller 4/3 frame giving back the height the 15/8 one spends.
   */
  const focus = claim.focus ?? WHOLE

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
        <div className="app-corner relative aspect-4/3 w-full overflow-hidden rounded-[20px] shadow-[0_0_0_1px_oklch(1_0_0/0.09),0_24px_60px_-24px_oklch(0_0_0/0.75)] sm:aspect-[15/8]">
          <Image
            src={`/product/${claim.capture}.png`}
            alt={claim.caption ?? claim.title}
            width={SHOT.width}
            height={SHOT.height}
            sizes="(max-width: 640px) 150vw, (max-width: 1024px) 160vw, 100vw"
            style={
              {
                "--span": `${100 / focus.span}%`,
                "--x": `${-hold(focus.x, focus.span) * 100}%`,
                "--y": lift(focus, FRAME.narrow),
                "--y-wide": lift(focus, FRAME.wide),
              } as CSSProperties
            }
            className="absolute top-1/2 left-1/2 h-auto w-[var(--span)] max-w-none translate-x-[var(--x)] translate-y-[var(--y)] sm:translate-y-[var(--y-wide)]"
          />
        </div>
        {claim.caption ? (
          <figcaption className="mt-3.5 max-w-[62ch] text-[14px] leading-[1.5] text-ink-3">{claim.caption}</figcaption>
        ) : null}
      </figure>
    </section>
  )
}
