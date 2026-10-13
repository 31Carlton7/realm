"use client"

import { useRef } from "react"

import { DownloadButton, QuietButton } from "@/components/Buttons"
import { GitHubIcon } from "@/components/icons"
import type { MacDownload } from "@/lib/release"

import { useAnchors } from "../kit/anchors"
import { useScrollProgress } from "../kit/hooks"
import { span } from "../kit/math"
import { route, slice, type Pt } from "../kit/route"
import { Signal, SignalDefs } from "../kit/signal"

/**
 * The one next action, as the map's terminus: the four lines the page opened with run in from the
 * left as the reader arrives, turn together, and end at the download — the place they all lead.
 */
export function Close({ download, repo }: { download: MacDownload; repo: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const anchors = useAnchors(ref)
  const progress = useScrollProgress(ref, { from: 0.95, to: 0.35 })
  const end = anchors.at.terminus

  const lines = (() => {
    if (!end || anchors.width < 10) return []
    const ty = end.y + end.h / 2
    const tx = end.x - 14
    return [0, 1, 2, 3].map((i) => {
      const row = 30 + i * 9
      const y = ty + (i - 1.5) * 7
      const turn = tx - 70 - (3 - i) * 9
      // They leave from the gutter, where the page's own line runs (kit/Spine), and turn in together.
      const pts: Pt[] = [[-26, row], [turn, row], [turn, y], [tx, y]]
      return route(pts, 12)
    })
  })()
  const k = span(progress, 0, 0.85)

  return (
    <section aria-labelledby="close-title" className="mx-auto w-full max-w-[85rem] px-5 pt-16 pb-28 sm:px-10 sm:pt-24 sm:pb-36">
      <div ref={ref} className="relative pt-24 sm:pt-28">
        <svg aria-hidden className="pointer-events-none absolute inset-0 hidden h-full w-full overflow-visible sm:block" fill="none">
          <SignalDefs id="close" />
          {lines.map((r, i) => (
            <path key={i} d={k >= 1 ? r.d : slice(r, 0, r.length * k)} stroke="oklch(1 0 0 / 0.3)" />
          ))}
          {k > 0 && k < 1 ? lines.map((r, i) => <Signal key={i} defs="close" route={r} s={r.length * k} tail={60} alpha={0.9} />) : null}
        </svg>
        <div className="relative grid gap-10 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="max-w-[40rem]">
            <h2 id="close-title" data-station className="text-[clamp(2.4rem,5vw,4.25rem)] leading-[0.98] font-[580] tracking-[-0.05em] text-balance text-ink">
              Open your first realm.
            </h2>
            <p className="mt-5 max-w-[46ch] text-[17px] leading-[1.55] text-ink-2">
              Point it at a checkout, start a session with an agent you already have, and leave the window open all day.
            </p>
          </div>
          <div className="sm:pb-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <span data-anchor="terminus" className="inline-flex">
                <DownloadButton href={download.href} size="lg" />
              </span>
              <QuietButton href={repo} external>
                <GitHubIcon className="h-4 w-4" />
                Read the source
              </QuietButton>
            </div>
            <p className="mt-3 font-mono text-[12px] text-ink-3">{download.version ? `${download.version} · ` : ""}macOS on Apple silicon</p>
          </div>
        </div>
      </div>
    </section>
  )
}
