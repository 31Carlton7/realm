"use client"

import { useRef, type ReactNode } from "react"

import type { Claim, Facet } from "@/content/home"

import { useAnchors } from "../kit/anchors"
import { Evidence } from "../kit/Chapter"
import { useScrollProgress } from "../kit/hooks"
import { span } from "../kit/math"

/** Each of a space's six parts, as a symbol in the map's own line language. */
const SYMBOLS: Record<string, ReactNode> = {
  "The checkout": (
    <>
      <path d="M2 8h12" />
      <path d="M5 5.5v5M8 5.5v5M11 5.5v5" strokeOpacity="0.65" />
    </>
  ),
  "The terminal": <path d="M3.5 5 6.5 8l-3 3M8.5 11h4" />,
  "The browser": (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="M3 8h10M8 3c1.5 1.6 2.1 3.2 2.1 5S9.5 11.4 8 13C6.5 11.4 5.9 9.8 5.9 8S6.5 4.6 8 3Z" />
    </>
  ),
  "The tools": <path d="M6 3v2.6M10 3v2.6M4.6 5.6h6.8v2a3.4 3.4 0 0 1-6.8 0Zm3.4 5.4V13" />,
  "The boundary": <rect x="3" y="3.5" width="10" height="9" rx="2" strokeDasharray="1.8 1.8" />,
  "The agent": (
    <>
      <circle cx="8" cy="8" r="4.6" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
}

/**
 * The map's key: one line drawn as the strip map over a train's door, its stations the six things a
 * space holds, each with the limit the landing page states for it. Scrolling draws the line from its
 * start and lights each station as it arrives; at rest, and under reduced motion, it is all drawn.
 * The real sidebar follows as the evidence.
 */
export function SpaceLegend({ facets, claim }: { facets: Facet[]; claim: Claim }) {
  const stripRef = useRef<HTMLDivElement>(null)
  const progress = useScrollProgress(stripRef, { from: 0.92, to: 0.42 })
  const { at, width } = useAnchors(stripRef)
  const first = at["stop-0"]
  const last = at[`stop-${facets.length - 1}`]
  const y = first ? first.y + first.h / 2 : 0
  const x0 = 0
  const x1 = width
  const front = x0 + (x1 - x0) * span(progress, 0, 0.94)
  const lit = (i: number) => {
    const stop = at[`stop-${i}`]
    return stop ? front >= stop.x + stop.w / 2 - 1 : progress >= 1
  }

  return (
    <section aria-labelledby="spaces-title" className="mx-auto w-full max-w-[85rem] px-5 pt-24 pb-16 sm:px-10 sm:pt-32 sm:pb-24">
      <div className="max-w-[44rem]">
        <h2 id="spaces-title" data-station className="text-[clamp(1.9rem,3.2vw,2.75rem)] leading-[1.04] font-[580] tracking-[-0.042em] text-balance text-ink">
          Every line is a space.
        </h2>
        <p className="mt-5 text-[16.5px] leading-[1.6] text-ink-2">
          Each space gets its own section of the sidebar: its name in its colour, a count of what&rsquo;s waiting and
          working, and its sessions. Needs you sits on top and collects every session that&rsquo;s waiting on a permission
          or a question, from every space and every profile. Switching spaces loads nothing, because they&rsquo;re all
          loaded already.
        </p>
      </div>

      <figure className="mt-14 sm:mt-16">
        <figcaption className="mb-6 flex items-center gap-2 text-[13px] text-ink-2">
          <span className="mr-1 font-mono text-[11.5px] text-accent-ink">Diagram</span>
          What every line holds, from its checkout to its agent.
        </figcaption>
        <div ref={stripRef} className="relative">
          {first && last ? (
            <svg aria-hidden className="pointer-events-none absolute inset-0 hidden h-full w-full overflow-visible lg:block" fill="none">
              <path d={`M${x0} ${y}H${x1}`} stroke="oklch(1 0 0 / 0.1)" />
              <path d={`M${x0} ${y}H${front}`} stroke="oklch(1 0 0 / 0.55)" />
              <path d={`M${x0} ${y - 5}V${y + 5}`} stroke="oklch(1 0 0 / 0.5)" strokeWidth={1.25} />
              <path d={`M${x1} ${y - 5}V${y + 5}`} stroke={progress >= 1 ? "oklch(1 0 0 / 0.5)" : "oklch(1 0 0 / 0.15)"} strokeWidth={1.25} />
              {progress > 0 && progress < 1 ? (
                <>
                  <circle cx={front} cy={y} r={10} fill="url(#strip-glow)" />
                  <circle cx={front} cy={y} r={2.3} fill="oklch(0.95 0.03 250)" />
                </>
              ) : null}
              <defs>
                <radialGradient id="strip-glow">
                  <stop offset="0" stopColor="oklch(0.788 0.113 248.33)" stopOpacity="0.5" />
                  <stop offset="1" stopColor="oklch(0.788 0.113 248.33)" stopOpacity="0" />
                </radialGradient>
              </defs>
            </svg>
          ) : null}
          <ol className="relative grid gap-x-6 gap-y-9 sm:grid-cols-2 lg:grid-cols-6">
            {facets.map((f, i) => {
              const on = lit(i)
              return (
                <li key={f.title} className="relative max-lg:pl-12">
                  <p className={`text-[15px] font-[540] transition-colors duration-300 lg:h-7 ${on ? "text-ink" : "text-ink-2"}`}>{f.title.replace(/^The /, "").replace(/^./, (c) => c.toUpperCase())}</p>
                  <span
                    data-anchor={`stop-${i}`}
                    className={`grid size-[30px] place-items-center rounded-full bg-page transition-[box-shadow,color] duration-300 max-lg:absolute max-lg:top-0 max-lg:left-0 lg:my-3 ${on ? "text-ink shadow-[inset_0_0_0_1px_oklch(0.788_0.113_248.33/0.85)]" : "text-ink-3 shadow-[inset_0_0_0_1px_oklch(1_0_0/0.25)]"}`}
                  >
                    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      {SYMBOLS[f.title]}
                    </svg>
                  </span>
                  <p className="mt-2 text-[14px] leading-[1.55] text-ink-2 lg:mt-1">{f.body}</p>
                </li>
              )
            })}
          </ol>
        </div>
      </figure>

      <div className="mt-16 sm:mt-24">
        <Evidence claim={claim} />
      </div>
    </section>
  )
}

