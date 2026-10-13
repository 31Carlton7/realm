import type { CSSProperties, ReactNode } from "react"

import type { Claim } from "@/content/home"
import { claimFile, cropPixels, FRAME, liftOf } from "@/lib/frames"

/**
 * A chapter: its words in a column, the instrument beside them, and under both the real capture that
 * is the evidence. The columns sit on the page's one twelve-column grid; `flip` puts the instrument
 * first on a wide screen without changing the reading order, which stays words, instrument, evidence.
 */
export function Chapter({
  id,
  title,
  children,
  instrument,
  evidence,
  flip = false,
  wide = false,
}: {
  id: string
  title: ReactNode
  children: ReactNode
  instrument: ReactNode
  evidence?: ReactNode
  flip?: boolean
  /** The instrument takes the whole width under the words, for drawings that need it. */
  wide?: boolean
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="mx-auto w-full max-w-[85rem] px-5 py-20 sm:px-10 sm:py-28 lg:py-32">
      <div className={wide ? "" : `grid gap-x-12 gap-y-10 lg:grid-cols-12 lg:items-start ${flip ? "lg:[&>*:first-child]:order-2" : ""}`}>
        <div className={wide ? "max-w-[44rem]" : "lg:sticky lg:top-28 lg:col-span-4"}>
          <h2 id={`${id}-title`} className="text-[clamp(1.9rem,3.2vw,2.75rem)] leading-[1.04] font-[580] tracking-[-0.042em] text-balance text-ink">
            {title}
          </h2>
          <div className="mt-5 space-y-4 text-[16.5px] leading-[1.6] text-ink-2 [&_strong]:font-[520] [&_strong]:text-ink">{children}</div>
        </div>
        <div className={wide ? "mt-12" : "min-w-0 lg:col-span-8"}>{instrument}</div>
      </div>
      {evidence ? <div className="mt-14 sm:mt-20">{evidence}</div> : null}
    </section>
  )
}

/**
 * The frame an instrument is drawn in: a caption that says what it is (a diagram, or a sample you can
 * use) and how to play it, over the drawing itself. No box around it — the drawing's own lines are
 * its edges.
 */
export function Instrument({
  kind,
  caption,
  children,
  className = "",
  controls,
}: {
  kind: "Diagram" | "Sample"
  caption: ReactNode
  children: ReactNode
  className?: string
  controls?: ReactNode
}) {
  return (
    <figure className={className}>
      <figcaption className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <span className="text-[13px] leading-[1.5] text-ink-2">
          <span className="mr-2 font-mono text-[11.5px] text-accent-ink">{kind}</span>
          {caption}
        </span>
        {controls}
      </figcaption>
      {children}
    </figure>
  )
}

const WHOLE = { x: 0.5, y: 0, span: 1 }

/**
 * A claim's real capture, cut to the part of the window the claim is about (lib/frames.ts carries the
 * arithmetic, shared with the encoder that cut the file), with the caption that says what is in it.
 */
export function Evidence({ claim, label = "In the app" }: { claim: Claim; label?: string }) {
  if (!claim.capture) return null
  const focus = claim.focus ?? WHOLE
  const crop = cropPixels(focus)
  return (
    <figure className="grid gap-x-12 gap-y-4 lg:grid-cols-12 lg:items-end">
      <div className="relative aspect-4/3 w-full overflow-hidden rounded-[16px] bg-page sm:aspect-[15/8] lg:col-span-9">
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
        <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[16px] shadow-[inset_0_0_0_1px_oklch(1_0_0/0.1)]" />
      </div>
      <figcaption className="text-[14px] leading-[1.55] text-ink-2 lg:col-span-3 lg:pb-1">
        <span className="mb-1.5 block font-mono text-[11.5px] text-ink-3">{label}</span>
        {claim.caption}
      </figcaption>
    </figure>
  )
}

/** A detail crop (public/product/details), at its own aspect, with the inset outline. */
export function Detail({ src, alt, width, height, caption, className = "" }: { src: string; alt: string; width: number; height: number; caption?: ReactNode; className?: string }) {
  return (
    <figure className={className}>
      <div className="relative overflow-hidden rounded-[14px] bg-page">
        <img src={src} alt={alt} width={width} height={height} loading="lazy" decoding="async" className="block h-auto w-full" />
        <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[14px] shadow-[inset_0_0_0_1px_oklch(1_0_0/0.1)]" />
      </div>
      {caption ? <figcaption className="mt-3 text-[13.5px] leading-[1.5] text-ink-2">{caption}</figcaption> : null}
    </figure>
  )
}
