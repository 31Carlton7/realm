"use client"

import Image from "next/image"
import { useCallback, useEffect, useState } from "react"

import { ArrowIcon } from "@/components/icons"
import type { Feature } from "@/content/features"

/** The capture's viewport. Every scene is shot at this size, at 2× device pixels. */
const SHOT = { width: 2880, height: 1800 }

/**
 * The features page: one screen, one screenshot at a time.
 *
 * The page does not scroll, so the image has to be sized against what is left after the caption and
 * the rail — `min-h-0` on the figure is what lets it give height back instead of pushing the
 * controls off the bottom.
 *
 * Only the current slide and its two neighbours are mounted. All fourteen at once is four megabytes
 * of screenshot for a page where thirteen of them are invisible; a window of three keeps the next
 * and previous instant without paying for the rest.
 */
export function Carousel({ features }: { features: Feature[] }) {
  const [index, setIndex] = useState(0)
  const count = features.length

  const go = useCallback((next: number) => setIndex((next + count) % count), [count])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === "ArrowRight") go(index + 1)
      if (event.key === "ArrowLeft") go(index - 1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [go, index])

  const active = features[index]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 sm:gap-6">
      <figure className="relative min-h-0 flex-1">
        {features.map((feature, position) => {
          const distance = Math.min(
            Math.abs(position - index),
            count - Math.abs(position - index),
          )
          if (distance > 1) return null
          return (
            <div
              key={feature.slug}
              aria-hidden={position !== index}
              className={`absolute inset-0 flex items-center justify-center transition-opacity duration-300 ease-[var(--ease-out-strong)] ${
                position === index ? "opacity-100" : "opacity-0"
              }`}
            >
              <Image
                src={`/product/${feature.slug}.png`}
                alt={`Realm: ${feature.title}`}
                width={SHOT.width}
                height={SHOT.height}
                priority={position === 0}
                sizes="(max-width: 640px) 100vw, 90vw"
                className="app-corner h-auto w-auto max-h-full max-w-full rounded-[20px] shadow-[0_0_0_1px_oklch(1_0_0/0.09),0_24px_60px_-24px_oklch(0_0_0/0.75)]"
              />
            </div>
          )
        })}
      </figure>

      {/* Caption and controls share a row rather than stacking: on a 900px screen the stacked
          version cost the screenshot ninety pixels of height, and the screenshot is the page. */}
      <div className="flex shrink-0 flex-col gap-5 sm:flex-row sm:items-end sm:justify-between sm:gap-10">
        <figcaption className="max-w-[40rem]">
          <h2 className="text-[clamp(1.15rem,2.2vw,1.5rem)] leading-[1.2] font-[560] tracking-[-0.025em] text-ink">
            {active.title}
          </h2>
          <p className="mt-2 text-[15px] leading-[1.55] text-ink-2">{active.blurb}</p>
        </figcaption>

        <div className="flex shrink-0 items-center gap-3">
          <Step direction="previous" onClick={() => go(index - 1)} />

          <div role="tablist" aria-label="Features" className="flex items-center gap-1.5 px-1">
            {features.map((feature, position) => (
              <button
                key={feature.slug}
                type="button"
                role="tab"
                aria-selected={position === index}
                aria-label={feature.title}
                onClick={() => setIndex(position)}
                className="group grid h-8 w-4 place-items-center"
              >
                <span
                  className={`h-1.5 rounded-full transition-[width,background-color] duration-300 ease-[var(--ease-out-strong)] ${
                    position === index ? "w-5 bg-accent" : "w-1.5 bg-ink-3 group-hover:bg-ink-2"
                  }`}
                />
              </button>
            ))}
          </div>

          <Step direction="next" onClick={() => go(index + 1)} />

          <p className="ml-1 min-w-[4rem] font-mono text-[12px] tabular-nums text-ink-3">
            {index + 1} / {count}
          </p>
        </div>
      </div>
    </div>
  )
}

function Step({ direction, onClick }: { direction: "previous" | "next"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === "next" ? "Next feature" : "Previous feature"}
      className="app-corner grid h-11 w-11 shrink-0 place-items-center rounded-[20px] bg-surface text-ink-2 shadow-[inset_0_1px_0_oklch(1_0_0/0.07)] transition-[scale,background-color,color] duration-150 ease-out hover:bg-raised hover:text-ink active:scale-[0.94]"
    >
      <ArrowIcon className={`h-4 w-4 ${direction === "previous" ? "rotate-180" : ""}`} />
    </button>
  )
}
