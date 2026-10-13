"use client"

import { createDoorway } from "@/components/lab/doorway/stage"
import { Actions, Announcement, Headline, Lede, ProductWindow, type ConceptProps } from "@/components/lab/HeroParts"
import { LabCanvas } from "@/components/lab/LabCanvas"

/**
 * The Doorway. Realm's mark is a cube with a lit doorway in its dark wall; here the doorway is the
 * product window, at the size of a room, and the realm behind it is lit. Its light comes out through
 * the window into the room the reader stands in: through a faint haze, and onto the floor in front.
 *
 * On a wide screen the words are set like an inscription over a door — the headline on one line, the
 * lede and the actions on the doorway's own edges — so the whole opening, its threshold and the head of
 * the pool on the floor all fit the first screen. The section runs on below the window so the floor has
 * somewhere to be, and the rest of the pool is found by scrolling.
 */
export default function Doorway({ download }: ConceptProps) {
  return (
    <section data-lab-anchor="stage" className="relative pb-[min(40vh,380px)]">
      <LabCanvas create={createDoorway} />
      <div data-lab-anchor="copy" className="mx-auto w-full max-w-[72rem] px-6 pt-6 sm:px-10 sm:pt-10 lg:pt-6">
        <div className="flex flex-col items-center text-center">
          <Announcement />
          <Headline className="mt-5 sm:mt-6 lg:mt-4 lg:!text-[min(4.4rem,4.89vw)] lg:!text-nowrap" />
        </div>
        <div className="mt-6 grid gap-6 text-center sm:mt-8 lg:mt-6 lg:grid-cols-[minmax(0,34rem)_auto] lg:items-end lg:justify-between lg:gap-12 lg:text-left">
          <Lede />
          <Actions download={download} center className="lg:pb-1 lg:[&>div]:justify-end lg:[&>p]:text-right" />
        </div>
      </div>
      <ProductWindow
        className="relative mx-auto mt-9 w-full max-w-[72rem] px-6 sm:mt-12 sm:px-10 lg:mt-8"
        frameClassName="h-[540px] sm:h-[600px] lg:h-[clamp(420px,calc(100dvh-460px),600px)] [html[data-lab-field=on]_&]:shadow-[0_0_0_1px_oklch(1_0_0/0.2)] [html[data-lab-field=off]_&]:shadow-[0_0_0_1px_oklch(1_0_0/0.16),0_0_60px_-12px_oklch(0.86_0.04_250/0.55),0_30px_140px_-40px_oklch(0.8_0.05_250/0.45)]"
      />
      {/* Without WebGPU there is no room to light, so the floor's pool is drawn plainly: a trapezoid of the
          same cool light that starts at the window's sill, widens toward the reader and fades out. */}
      <div aria-hidden className="pointer-events-none mx-auto hidden w-full max-w-[72rem] px-6 sm:px-10 [html[data-lab-field=off]_&]:block">
        <div className="relative h-[min(36vh,320px)]">
          {/* The blur is on a wrapper because a clip applies after a filter: on one element the cut edges stay hard. */}
          <div className="absolute inset-y-0 -inset-x-[12%] blur-[10px]">
            <div className="h-full w-full bg-[linear-gradient(to_bottom,oklch(0.8_0.03_250/0.2),oklch(0.8_0.03_250/0.06)_45%,transparent_90%)] [clip-path:polygon(9.7%_0,90.3%_0,100%_100%,0_100%)]" />
          </div>
        </div>
      </div>
    </section>
  )
}
