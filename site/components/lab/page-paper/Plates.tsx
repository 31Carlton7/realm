import type { CSSProperties, ReactNode } from "react"

import type { Claim } from "@/content/home"
import { claimFile, cropPixels, FRAME, liftOf } from "@/lib/frames"

import { Register } from "./kinetic"
import s from "./paper.module.css"

const WHOLE = { x: 0.5, y: 0, span: 1 }

/**
 * A claim's capture as a plate: the claim's own cut of the window (lib/frames.ts), laid in a frame
 * the same proportions as every other plate, uncovered from its leading edge as it rises into view.
 * The caption says what is in the frame; the note under it says what kind of picture it is.
 */
export function Plate({ claim, from = "left", priority = false }: { claim: Claim; from?: "left" | "right"; priority?: boolean }) {
  if (!claim.capture) return null
  const focus = claim.focus ?? WHOLE
  const crop = cropPixels(focus)
  return (
    <figure className="min-w-0">
      <div data-from={from} className={`${s.dark} ${s.plate} ${s.wipe} aspect-[4/3] sm:aspect-[15/8]`}>
        <img
          src={claimFile(claim.id)}
          alt={claim.caption ?? claim.title}
          width={crop.width}
          height={crop.height}
          loading={priority ? undefined : "lazy"}
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
      <figcaption className="mt-4 grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-8">
        <span className={`${s.caption} max-w-[62ch]`}>{claim.caption}</span>
        <span className={`${s.note} sm:pt-0.5 sm:text-right`}>Capture · {claim.capture}</span>
      </figcaption>
    </figure>
  )
}

/**
 * One claim as a spread: its statement and its account on four columns, its plate on the other
 * eight, the sides alternating down the page. Stacked, the claim is read before its evidence either
 * way round, because the alternation is done with the grid's columns rather than the markup's order.
 */
export function ClaimSpread({ claim, flip = false, note }: { claim: Claim; flip?: boolean; note?: ReactNode }) {
  return (
    <article aria-labelledby={`claim-${claim.id}`} className={`${s.measure} ${s.grid} gap-y-10 lg:items-end`}>
      <div className={`col-span-12 lg:col-span-4 lg:row-start-1 ${flip ? "lg:col-start-9" : "lg:col-start-1"}`}>
        <Register as="h3" id={`claim-${claim.id}`} text={claim.title} className={`${s.title} text-ink`} />
        <p className={`${s.body} mt-5 max-w-[60ch]`}>{claim.body}</p>
        {note ? <p className={`${s.note} mt-6 border-t border-line pt-4`}>{note}</p> : null}
      </div>
      <div className={`col-span-12 lg:col-span-8 lg:row-start-1 ${flip ? "lg:col-start-1" : "lg:col-start-5"}`}>
        <Plate claim={claim} from={flip ? "left" : "right"} />
      </div>
    </article>
  )
}
