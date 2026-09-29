"use client"

import { useEffect, useRef, useState } from "react"

import type { Facet } from "@/content/home"
import { TRACK_STEPS } from "@/lib/dimension/faces"

/**
 * What a realm is made of, told as Realm's mark assembling: one face per thing a realm holds.
 *
 * The section is a tall scroll track with a viewport pinned inside it. The field behind the page
 * draws the mark in `data-dim="faces"`, reading the same progress this component reads, so the face
 * that is landing and the sentence beside it are the same step. Nothing here scrolls the page for the
 * reader: position is theirs, and "Skip" takes them past the track in one move.
 *
 * Every sentence stays in the document whichever step is showing. The inactive ones collapse
 * visually, not out of the accessibility tree, and before JavaScript runs they are all open — the
 * section reads as a list with no script at all.
 */
export function SixFaces({ facets, coda, many }: { facets: Facet[]; coda: Facet; many: Facet }) {
  const sectionRef = useRef<HTMLElement>(null)
  // -1 until the first measurement: every facet open, which is also the no-script rendering.
  const [step, setStep] = useState(-1)

  useEffect(() => {
    const section = sectionRef.current
    if (!section) return
    let frame = 0
    const measure = () => {
      frame = 0
      const rect = section.getBoundingClientRect()
      const track = Math.max(rect.height - window.innerHeight, 1)
      const progress = Math.min(1, Math.max(0, -rect.top / track))
      setStep(Math.min(TRACK_STEPS - 1, Math.floor(progress * TRACK_STEPS)))
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

  // Steps 0–5 are the faces, 6 is the lit mark, 7 is the pull-back to many.
  const complete = step === facets.length
  const pulledBack = step === facets.length + 1
  // Once measured, the list and the "many" statement share one place and cross-fade; before that
  // they simply follow each other, which is the order they are read in anyway.
  const stacked = step >= 0 ? "[grid-area:1/1]" : ""

  return (
    <section
      ref={sectionRef}
      data-dim-stage="faces"
      aria-labelledby="faces-title"
      className="relative h-[660vh]"
    >
      <div className="sticky top-0 mx-auto flex h-[100dvh] w-full max-w-[92rem] flex-col-reverse justify-between gap-4 px-6 pt-20 pb-16 sm:px-10 lg:flex-row lg:items-center lg:justify-start lg:gap-16 lg:py-0">
        <div className="grid min-w-0 lg:w-[27rem] lg:shrink-0">
          <div
            className={`${stacked} transition-opacity duration-500 ease-[var(--ease-out-strong)] motion-reduce:transition-none ${pulledBack ? "pointer-events-none opacity-0" : "opacity-100"}`}
          >
            <h2
              id="faces-title"
              className="text-[clamp(1.6rem,2.6vw,2.2rem)] leading-[1.1] font-[560] tracking-[-0.034em] text-balance text-ink"
            >
              What a realm is made of.
            </h2>

            {/* The rail fills as the faces land, so where you are in the section is always visible. */}
            <ol className="relative mt-7 border-l border-line pl-5 lg:mt-9">
              <span
                aria-hidden
                className="absolute top-0 -left-px w-px bg-accent transition-[height] duration-300 ease-[var(--ease-out-strong)] motion-reduce:transition-none"
                style={{ height: `${step < 0 ? 0 : Math.min(1, (step + 1) / facets.length) * 100}%` }}
              />
              {facets.map((facet, i) => {
                const state = step < 0 ? "open" : i === step ? "active" : i < step ? "done" : "todo"
                // A phone has room for the face that is landing and nothing else; the others stay in
                // the accessibility tree rather than leaving it.
                return (
                  <li
                    key={facet.title}
                    data-state={state}
                    className="group py-2 max-lg:data-[state=done]:sr-only max-lg:data-[state=todo]:sr-only"
                  >
                    <p className="text-[15px] font-[520] tracking-[-0.01em] text-ink-3 transition-colors duration-300 group-data-[state=active]:text-ink group-data-[state=done]:text-ink-2 group-data-[state=open]:text-ink motion-reduce:transition-none">
                      {facet.title}
                    </p>
                    <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-500 ease-[var(--ease-out-strong)] group-data-[state=active]:grid-rows-[1fr] group-data-[state=open]:grid-rows-[1fr] motion-reduce:transition-none">
                      <p className="overflow-hidden text-[15px] leading-[1.55] text-ink-2">
                        <span className="block pt-1.5">{facet.body}</span>
                      </p>
                    </div>
                  </li>
                )
              })}
            </ol>

            <div
              aria-live="polite"
              className={`mt-6 transition-[opacity,translate] duration-500 ease-[var(--ease-out-strong)] motion-reduce:transition-none ${complete || step < 0 ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0 max-lg:hidden"}`}
            >
              <p className="text-[clamp(1.2rem,1.8vw,1.5rem)] leading-[1.2] font-[560] tracking-[-0.025em] text-ink">
                {coda.title}
              </p>
              <p className="mt-2 max-w-[44ch] text-[15px] leading-[1.55] text-ink-2">{coda.body}</p>
            </div>
          </div>

          <div
            className={`${stacked} self-center transition-[opacity,translate] duration-700 ease-[var(--ease-out-strong)] motion-reduce:transition-none ${pulledBack || step < 0 ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"}`}
          >
            <h2 className="text-[clamp(1.6rem,2.6vw,2.2rem)] leading-[1.1] font-[560] tracking-[-0.034em] text-balance text-ink">
              {many.title}
            </h2>
            <p className="mt-4 max-w-[46ch] text-[16px] leading-[1.6] text-ink-2">{many.body}</p>
          </div>
        </div>

        {/* Where the field draws the mark. Without WebGPU it never draws, so the plain vector stands in. */}
        <div data-dim="faces" className="relative aspect-square w-full max-w-[26rem] self-center lg:max-w-none lg:flex-1">
          <img
            src="/realm-mark.svg"
            alt=""
            aria-hidden
            className="absolute inset-1/2 hidden h-[46%] w-auto -translate-x-1/2 -translate-y-1/2 [html[data-dim-field=off]_&]:block"
          />
        </div>

        <a
          href="#after-faces"
          className="absolute right-6 bottom-6 text-[13px] text-ink-3 transition-colors hover:text-ink sm:right-10"
        >
          Skip
        </a>
      </div>
    </section>
  )
}
