"use client"

import { useEffect, useRef, useState } from "react"

import type { Facet } from "@/content/home"
import { TREE_STEPS } from "@/lib/dimension/tree"

/**
 * The interlude between the claims: one agent opening more, drawn by the field as sessions opening
 * sessions in `data-dim="tree"` while the words beside it follow the same scroll position.
 *
 * One beat is shown at a time and they cross-fade in place, so the column never grows while the tree
 * does. All four stay in the document; before JavaScript runs they are simply a list.
 */
export function Delegation({ beats }: { beats: Facet[] }) {
  const sectionRef = useRef<HTMLElement>(null)
  const [beat, setBeat] = useState(-1)

  useEffect(() => {
    const section = sectionRef.current
    if (!section) return
    let frame = 0
    const measure = () => {
      frame = 0
      const rect = section.getBoundingClientRect()
      const progress = Math.min(1, Math.max(0, -rect.top / Math.max(rect.height - window.innerHeight, 1)))
      setBeat(Math.min(TREE_STEPS - 1, Math.floor(progress * TREE_STEPS)))
    }
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener("scroll", queue, { passive: true })
    window.addEventListener("resize", queue)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", queue)
      window.removeEventListener("resize", queue)
    }
  }, [])

  return (
    <section ref={sectionRef} data-dim-stage="tree" aria-label="Delegation" className="relative h-[380vh]">
      <div className="sticky top-0 mx-auto flex h-[100dvh] w-full max-w-[92rem] flex-col-reverse justify-between gap-4 px-6 pt-20 pb-16 sm:px-10 lg:flex-row lg:items-center lg:justify-start lg:gap-12 lg:py-0">
        <div className="grid min-w-0 lg:w-[25rem] lg:shrink-0">
          {beats.map((item, i) => {
            const shown = beat < 0 || beat === i
            return (
              <div
                key={item.title}
                className={`transition-[opacity,translate] duration-500 ease-[var(--ease-out-strong)] motion-reduce:transition-none ${beat >= 0 ? "[grid-area:1/1]" : "mb-8"} ${shown ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"}`}
              >
                <h2 className="text-[clamp(1.6rem,2.6vw,2.2rem)] leading-[1.1] font-[560] tracking-[-0.034em] text-balance text-ink">
                  {item.title}
                </h2>
                <p className="mt-4 max-w-[44ch] text-[16px] leading-[1.6] text-ink-2">{item.body}</p>
              </div>
            )
          })}
          {/* Where in the story the reader is: four segments, filled up to the current beat. */}
          <div aria-hidden className="mt-8 flex gap-1.5 [grid-row:2]">
            {beats.map((item, i) => (
              <span
                key={item.title}
                className={`h-0.5 w-8 rounded-full transition-colors duration-300 motion-reduce:transition-none ${i <= beat ? "bg-accent" : "bg-line-strong"}`}
              />
            ))}
          </div>
        </div>

        {/* Where the field draws the tree. Without WebGPU there is no tree, and the words stand alone. */}
        <div data-dim="tree" className="relative aspect-[1.4] w-full self-center lg:aspect-auto lg:h-[78dvh] lg:flex-1" />

        <a
          href="#after-delegation"
          className="absolute right-6 bottom-6 text-[13px] text-ink-3 transition-colors hover:text-ink sm:right-10"
        >
          Skip
        </a>
      </div>
    </section>
  )
}
