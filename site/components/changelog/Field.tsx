"use client"

import { useMemo, type ReactNode } from "react"

import { FieldCanvas } from "@/components/field/FieldCanvas"

import { arrivalStage, walkStage, type AvenueRelease } from "./stage"

/**
 * The box the sky draws in. `contain: paint` makes it the containing block of FieldCanvas's fixed
 * canvas, so the canvas is exactly this box: the viewport where the box is fixed, and a band of the
 * page where it is not, which then scrolls away with its band rather than holding its last frame over
 * the reading. The box is also the `stage` anchor, so the loop stops once it has left the view.
 *
 * Under it, the deep sky's own black, as the landing page lays it; and without WebGPU
 * (`data-field="off"`), the landing page's opening sky held still (public/realms, photographed from
 * the live field).
 */
function Ground({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div data-field-anchor="stage" aria-hidden className={`pointer-events-none -z-10 bg-[#03050b] [contain:paint] ${className}`}>
      <div className="absolute inset-0 hidden bg-[url(/realms/space-phone.webp)] bg-cover bg-top sm:bg-[url(/realms/space.webp)] [html[data-field=off]_&]:block" />
      {children}
    </div>
  )
}

/** The index's walk: behind the whole page on a wide screen, in the opening band on a narrow one,
 *  where its foot fades into the page's black. */
export function Walk({ releases }: { releases: AvenueRelease[] }) {
  const create = useMemo(() => walkStage(releases), [releases])
  return (
    <Ground className="absolute inset-0 lg:fixed">
      <FieldCanvas create={create} />
      <div className="absolute inset-x-0 bottom-0 h-24 bg-[linear-gradient(to_bottom,transparent,#03050b)] lg:hidden" />
    </Ground>
  )
}

/** An entry's band: the release's realm, and the walk up to its doorway as the band scrolls away. */
export function Arrival({ release, total, dark }: { release: number; total: number; dark: boolean }) {
  const create = useMemo(() => arrivalStage(release, total, dark), [release, total, dark])
  return (
    <Ground className="absolute inset-0">
      <FieldCanvas create={create} />
      <div className="absolute inset-x-0 bottom-0 h-32 bg-[linear-gradient(to_bottom,transparent,#03050b)]" />
    </Ground>
  )
}
