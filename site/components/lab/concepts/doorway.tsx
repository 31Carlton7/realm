"use client"

import { createDoorway } from "@/components/lab/doorway/stage"
import { Actions, Announcement, Headline, Lede, ProductWindow, type ConceptProps } from "@/components/lab/HeroParts"
import { LabCanvas } from "@/components/lab/LabCanvas"

/**
 * The Doorway. Realm's mark is a cube with a lit doorway in its dark wall; here the doorway is the
 * product window, at the size of a room. The words stand in the dark in front of it, and the light from
 * inside the realm comes out through the window into the room: through a faint haze, onto the floor.
 *
 * The section runs on below the window so the floor in front of it has somewhere to be, and the pool
 * of light on it is found by scrolling rather than shown at once.
 */
export default function Doorway({ download }: ConceptProps) {
  return (
    <section data-lab-anchor="stage" className="relative pb-[min(44vh,420px)]">
      <LabCanvas create={createDoorway} />
      <div
        data-lab-anchor="copy"
        className="mx-auto flex w-full max-w-[60rem] flex-col items-center px-6 pt-6 text-center sm:px-10 sm:pt-12"
      >
        <Announcement />
        <Headline className="mt-5 sm:mt-7 lg:mt-8" />
        <Lede className="mt-5 max-w-[42rem] sm:mt-6" />
        <Actions download={download} center className="mt-7 sm:mt-8" />
      </div>
      <ProductWindow
        className="relative mx-auto mt-9 w-full max-w-[72rem] px-6 sm:mt-12 sm:px-10"
        frameClassName="h-[540px] sm:h-[600px] lg:h-[min(620px,calc(100dvh-8rem))] lg:min-h-[540px] [html[data-lab-field=on]_&]:shadow-[0_0_0_1px_oklch(1_0_0/0.16)] [html[data-lab-field=off]_&]:shadow-[0_0_0_1px_oklch(1_0_0/0.16),0_0_60px_-12px_oklch(0.86_0.04_250/0.55),0_30px_140px_-40px_oklch(0.8_0.05_250/0.45)]"
      />
      {/* Without WebGPU there is no room to light, so the floor's pool is drawn plainly: a soft ellipse of
          the same cool light, widening toward the reader, under the window it comes from. */}
      <div
        aria-hidden
        className="pointer-events-none mx-auto hidden h-[300px] w-full max-w-[72rem] px-5 sm:px-10 [html[data-lab-field=off]_&]:block"
      >
        <div className="h-full w-full bg-[radial-gradient(70%_100%_at_50%_0%,oklch(0.8_0.04_250/0.16),transparent_70%)] [clip-path:polygon(4%_0,96%_0,100%_100%,0_100%)]" />
      </div>
    </section>
  )
}
