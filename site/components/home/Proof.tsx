"use client"

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react"

import type { Claim } from "@/content/home"
import { claimFile, cropPixels, FRAME, liftOf } from "@/lib/frames"

const WHOLE = { x: 0.5, y: 0, span: 1 }

/**
 * The claims, as one viewer: a list of what Realm does down the side, and the real capture that is
 * evidence for the one picked. Clerk tabs its product panel; this tabs the proof, so eight claims
 * that used to be eight screens of scrolling read as one place you look into.
 *
 * Tabs, by the WAI-ARIA pattern: arrow keys move along them, Home and End go to the ends, and only
 * the selected one is in the tab order. Before JavaScript runs every claim and its picture is
 * rendered in sequence; the viewer collapses to one once it has mounted.
 *
 * Each frame is the claim's own cut of its capture, at three times the window's density and written
 * lossless (lib/frames.ts carries the arithmetic). The light round it is the field's, through
 * `data-dim="window"`, exactly as it was when each claim had a section to itself.
 */
export function Proof({ claims }: { claims: Claim[] }) {
  const [active, setActive] = useState(0)
  const [hydrated, setHydrated] = useState(false)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])

  // Collapse to one panel once script is running. The panels below the first are far below the
  // fold when this runs, so the page shortening under them moves nothing on screen.
  useEffect(() => setHydrated(true), [])

  const pick = (index: number, focus = false) => {
    setActive(index)
    if (focus) tabs.current[index]?.focus()
  }

  const onKey = (event: KeyboardEvent) => {
    const last = claims.length - 1
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? (active + 1) % claims.length
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? (active - 1 + claims.length) % claims.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null
    if (next === null) return
    event.preventDefault()
    pick(next, true)
  }

  return (
    <section aria-labelledby="proof-title" className="mx-auto w-full max-w-[92rem] px-6 py-24 sm:px-10 sm:py-32">
      <div className="max-w-[44rem]">
        <h2 id="proof-title" className="text-[clamp(2rem,4vw,3.25rem)] leading-[1.02] font-[580] tracking-[-0.045em] text-balance text-ink">
          What it does, shown in the app.
        </h2>
        <p className="mt-5 max-w-[52ch] text-[17px] leading-[1.55] text-ink-2">
          Every picture here is a capture of the shipped app, taken on a scratch home by the same script each
          release.
        </p>
      </div>

      <div className="mt-12 grid gap-8 lg:mt-16 lg:grid-cols-[19rem_minmax(0,1fr)] lg:gap-14">
        <div
          role="tablist"
          aria-label="What Realm does"
          aria-orientation="vertical"
          onKeyDown={onKey}
          className="-mx-6 flex snap-x gap-1 overflow-x-auto px-6 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
        >
          {claims.map((claim, i) => (
            <button
              key={claim.id}
              ref={(node) => {
                tabs.current[i] = node
              }}
              id={`proof-tab-${claim.id}`}
              type="button"
              role="tab"
              aria-selected={active === i}
              aria-controls={`proof-panel-${claim.id}`}
              tabIndex={active === i ? 0 : -1}
              onClick={() => pick(i)}
              className="group relative flex shrink-0 snap-start items-center gap-3 rounded-[12px] px-4 py-3 text-left text-[15px] text-ink-2 transition-colors duration-200 hover:text-ink aria-selected:bg-surface aria-selected:text-ink lg:py-3.5"
            >
              <span
                aria-hidden
                className="hidden h-5 w-0.5 rounded-full bg-transparent transition-colors duration-200 group-aria-selected:bg-accent lg:block"
              />
              {claim.title.replace(/\.$/, "")}
            </button>
          ))}
        </div>

        <div className="min-w-0">
          {claims.map((claim, i) => {
            const focus = claim.focus ?? WHOLE
            const crop = cropPixels(focus)
            const shown = !hydrated || active === i
            return (
              <div
                key={claim.id}
                id={`proof-panel-${claim.id}`}
                role="tabpanel"
                aria-labelledby={`proof-tab-${claim.id}`}
                hidden={!shown}
                className={hydrated ? "proof-in" : "mb-16"}
              >
                {claim.capture ? (
                  <figure>
                    <div
                      data-dim={shown ? "window" : undefined}
                      className="app-corner relative aspect-4/3 w-full overflow-hidden rounded-[20px] bg-page shadow-[0_0_0_1px_oklch(1_0_0/0.09)] sm:aspect-[15/8] [html[data-dim-field=off]_&]:shadow-[0_0_0_1px_oklch(1_0_0/0.12),0_0_70px_-20px_oklch(0.68_0.173_253.301/0.45)]"
                    >
                      <img
                        src={claimFile(claim.id)}
                        alt={claim.caption ?? claim.title}
                        width={crop.width}
                        height={crop.height}
                        loading={i === 0 ? undefined : "lazy"}
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
                      <figcaption className="mt-3.5 max-w-[70ch] text-[14px] leading-[1.5] text-ink-2">{claim.caption}</figcaption>
                    ) : null}
                  </figure>
                ) : null}
                <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:gap-10">
                  <h3 className="text-[22px] leading-[1.2] font-[560] tracking-[-0.025em] text-balance text-ink">{claim.title}</h3>
                  <p className="max-w-[68ch] text-[16px] leading-[1.65] text-ink-2">{claim.body}</p>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
