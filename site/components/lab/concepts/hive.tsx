"use client"

import { FIELD_PATTERN, TILE } from "@/components/lab/hive/fallback"
import { createHive } from "@/components/lab/hive/stage"
import { Actions, Announcement, Headline, Lede, ProductWindow, type ConceptProps } from "@/components/lab/HeroParts"
import { LabCanvas } from "@/components/lab/LabCanvas"

/**
 * A realm for every project: under the words, a field of spaces — each one Realm's mark as a solid,
 * standing on the page in the mark's own lattice — with a doorway lit wherever an agent is at work,
 * and the window floating over the field as the space you are in.
 */
export default function Hive({ download }: ConceptProps) {
  return (
    <section data-lab-anchor="stage" className="relative pb-24 sm:pb-32">
      <LabCanvas create={createHive} />
      <div className="mx-auto w-full max-w-[92rem] px-6 pt-12 sm:px-10 sm:pt-16 lg:pt-20">
        <div data-lab-anchor="copy">
          <Announcement />
          <div className="mt-8 grid gap-8 lg:mt-10 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-end lg:gap-12">
            <Headline className="max-w-[12ch]" />
            <div className="lg:pb-2.5">
              <Lede />
              <Actions download={download} className="mt-7" />
            </div>
          </div>
        </div>
      </div>
      {/* The field shows in the gap between the words and the window. On a laptop it is as tall as the
          screen allows while a third of the window stays in view (900 tall: 10rem); on a phone and a
          tablet the window waits below the first screen and the field rises into view under the words. */}
      <div className="relative mt-32 sm:mt-36 lg:mt-[clamp(4rem,calc(100dvh-46rem),10rem)]">
        {/* Without WebGPU, the field as a still drawing: the same cubes, the same light, hazing toward
            the words, a calm plate of the page under the window, and gone before the section ends. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-32 bottom-[-6rem] -z-10 hidden [mask-image:linear-gradient(to_bottom,transparent,rgb(0_0_0/0.5)_9rem,black_22rem,black_calc(100%-12rem),transparent)] [html[data-lab-field=off]_&]:block"
          style={{ backgroundImage: FIELD_PATTERN, backgroundSize: `${TILE.width}px ${TILE.height}px`, backgroundPosition: "center top" }}
        />
        <ProductWindow className="mx-auto w-full max-w-[72rem] px-4 sm:px-10 [html[data-lab-field=off]_&]:bg-page [html[data-lab-field=off]_&]:shadow-[0_0_48px_28px_var(--color-page)]" />
      </div>
    </section>
  )
}
