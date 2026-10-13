"use client"

import { useMemo, type ReactNode } from "react"

import { FieldCanvas } from "@/components/field/FieldCanvas"
import { FIELD_PATTERN, TILE } from "@/components/realms/hive/fallback"

import { arrivalStage, walkStage, type AvenueRelease } from "./stage"

/**
 * The box the field draws in. `contain: paint` makes it the containing block of FieldCanvas's fixed
 * canvas, so the canvas is exactly this box: the viewport where the box is fixed, and a band of the
 * page where it is not, which then scrolls away with its band rather than holding its last frame over
 * the reading. The box is also the `stage` anchor, so the loop stops once it has left the view.
 *
 * Without WebGPU (`data-field="off"` on <html>) the field is drawn once by the stylesheet, as the
 * landing page draws it: the Hive's realms in the same light. It is laid out on the page's own grid,
 * in the column beside the words, so it can never reach behind them.
 */
function Ground({ className, fallback, children }: { className: string; fallback: ReactNode; children: ReactNode }) {
  return (
    <div data-field-anchor="stage" aria-hidden className={`pointer-events-none -z-10 [contain:paint] ${className}`}>
      <div className="absolute inset-0 hidden [html[data-field=off]_&]:block">{fallback}</div>
      {children}
    </div>
  )
}

const pattern = { backgroundImage: FIELD_PATTERN, backgroundSize: `${TILE.width}px ${TILE.height}px`, backgroundPosition: "left top" }

/** The index's walk: behind the whole page on a wide screen, in the opening band on a narrow one. */
export function Walk({ releases }: { releases: AvenueRelease[] }) {
  const create = useMemo(() => walkStage(releases), [releases])
  return (
    <Ground
      className="absolute inset-0 lg:fixed"
      fallback={
        <div className="mx-auto grid h-full w-full max-w-[92rem] px-6 sm:px-10 lg:grid-cols-[32rem_1fr] lg:gap-x-16 xl:grid-cols-[10rem_32rem_1fr]">
          <div
            className="h-60 w-screen [mask-image:linear-gradient(to_bottom,black_40%,transparent)] max-lg:-mx-10 lg:col-start-2 lg:h-full lg:[mask-image:linear-gradient(to_right,transparent,black_14rem)] xl:col-start-3"
            style={pattern}
          />
        </div>
      }
    >
      <FieldCanvas create={create} />
    </Ground>
  )
}

/** An entry's band: the release's realm, and the walk up to its door as the band scrolls away. */
export function Arrival({ release, total, dark }: { release: number; total: number; dark: boolean }) {
  const create = useMemo(() => arrivalStage(release, total, dark), [release, total, dark])
  return (
    <Ground
      className="absolute inset-0"
      fallback={
        <div className="mx-auto grid h-full w-full max-w-[92rem] px-6 sm:px-10 lg:grid-cols-[36rem_1fr] lg:gap-x-16 xl:grid-cols-[10rem_40rem_1fr]">
          <div
            className="h-64 w-screen [mask-image:linear-gradient(to_bottom,black_40%,transparent)] max-lg:-mx-10 lg:col-start-2 lg:h-full lg:[mask-image:linear-gradient(to_right,transparent,black_12rem),linear-gradient(to_bottom,black_60%,transparent)] lg:[mask-composite:intersect] xl:col-start-3"
            style={pattern}
          />
        </div>
      }
    >
      <FieldCanvas create={create} />
    </Ground>
  )
}
