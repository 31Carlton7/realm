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
      <div className="relative mt-40 sm:mt-24 lg:mt-40">
        {/* Without WebGPU, the field as a still drawing: the same cubes, the same light, rising out of
            the page under the words and fading before the section ends. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-32 bottom-[-6rem] -z-10 hidden [mask-image:linear-gradient(to_bottom,transparent,black_9rem,black_calc(100%-12rem),transparent)] [html[data-lab-field=off]_&]:block"
          style={{ backgroundImage: FIELD_PATTERN, backgroundSize: `${TILE.width}px ${TILE.height}px`, backgroundPosition: "center top" }}
        />
        <ProductWindow className="mx-auto w-full max-w-[72rem] px-4 sm:px-10" />
      </div>
    </section>
  )
}
