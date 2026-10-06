import type { CSSProperties } from "react"

import type { Claim } from "@/content/home"
import { claimFile, cropPixels, FRAME, liftOf } from "@/lib/frames"

/**
 * A claim with no region named takes the whole capture, top-anchored.
 *
 * Top-anchored because the bottom band of a capture is the prompter, the least telling part of most
 * frames. It once carried a chip reading "Fake" — the harness's scripted agent, true of the harness
 * and not of Realm — which shipped into view once. The scripted agent now stands in under Claude's and
 * Codex's names, so the chip names a real model; still, read the rendered frame, not the number.
 */
const WHOLE = { x: 0.5, y: 0, span: 1 }

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
  const crop = cropPixels(focus)

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
        {/* A window into the realm, like the hero's portal: the field draws its edge (`data-dim`), so
            it casts no shadow of its own — and without WebGPU a CSS glow stands in for that edge. */}
        <div
          data-dim="window"
          className="app-corner relative aspect-4/3 w-full overflow-hidden rounded-[20px] bg-page shadow-[0_0_0_1px_oklch(1_0_0/0.09)] sm:aspect-[15/8] [html[data-dim-field=off]_&]:shadow-[0_0_0_1px_oklch(1_0_0/0.12),0_0_70px_-20px_oklch(0.68_0.173_253.301/0.45)]"
        >
          {/* The claim's own cut of the window (lib/frames.ts), at three times the window's density,
              so the frame never shows fewer than two picture pixels per CSS pixel. It is written
              lossless, because a lossy encoder smears exactly what a screenshot is made of: the
              edges of small text. A plain img, since Next's optimiser would re-encode it lossy. */}
          <img
            src={claimFile(claim.id)}
            alt={claim.caption ?? claim.title}
            width={crop.width}
            height={crop.height}
            loading="lazy"
            decoding="async"
            style={
              {
                "--y": `${-liftOf(focus, FRAME.narrow) * 100}%`,
                "--y-wide": `${-liftOf(focus, FRAME.wide) * 100}%`,
              } as CSSProperties
            }
            className="absolute top-1/2 left-0 h-auto w-full max-w-none translate-y-[var(--y)] sm:translate-y-[var(--y-wide)]"
          />
        </div>
        {claim.caption ? (
          <figcaption className="mt-3.5 max-w-[62ch] text-[14px] leading-[1.5] text-ink-3">{claim.caption}</figcaption>
        ) : null}
      </figure>
    </section>
  )
}
