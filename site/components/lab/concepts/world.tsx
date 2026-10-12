"use client"

import { Actions, Announcement, Headline, Lede, ProductWindow, type ConceptProps } from "@/components/lab/HeroParts"
import { LabCanvas } from "@/components/lab/LabCanvas"
import { createWorld } from "@/components/lab/world/scene"

/**
 * World: "Give your agents a world to work in", taken literally. The words sit on clean deep space;
 * the workspace sits lower, in front of the night side of a planet whose limb crosses behind it, a
 * moment before sunrise. The sun is under the limb to the right of centre and the window's top rim
 * catches it. The sun follows the pointer a little along the limb; nothing else moves.
 */
export default function World({ download }: ConceptProps) {
  return (
    <>
      <LabCanvas create={createWorld} />
      <section data-lab-anchor="stage" className="relative overflow-x-clip pb-24 sm:pb-32">
        <div className="mx-auto w-full max-w-[92rem] px-6 pt-8 sm:px-10 sm:pt-16 lg:pt-20">
          {/* `copy` bounds every light with area; the three blocks inside keep the stars off the words. */}
          <div data-lab-anchor="copy">
            <div data-lab-anchor="words-a" className="w-fit">
              <Announcement />
            </div>
            <div className="mt-8 grid gap-8 lg:mt-10 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-end lg:gap-12">
              <div data-lab-anchor="words-h" className="w-fit">
                <Headline className="max-w-[12ch]" />
              </div>
              <div data-lab-anchor="words-l" className="lg:pb-2.5">
                <Lede />
                <Actions download={download} className="mt-7" />
              </div>
            </div>
          </div>
        </div>
        <div className="relative mx-auto mt-20 w-full max-w-[82rem] px-4 sm:mt-28 sm:px-10 lg:mt-[8.5rem]">
          <FallbackPlanet />
          <ProductWindow frameClassName="h-[620px] sm:h-[640px] lg:h-[min(680px,calc(100dvh-7rem))] lg:min-h-[560px] [html[data-lab-field=off]_&]:shadow-[0_0_0_1px_oklch(1_0_0/0.12),0_-1px_0_0_oklch(0.93_0.03_250/0.55)]" />
        </div>
      </section>
    </>
  )
}

/**
 * Without WebGPU: the same limb drawn by the stylesheet — a planet-sized circle of the night side's
 * colour with the air as a blue edge on it, and the sunrise as a soft white mark on that edge.
 */
function FallbackPlanet() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute -top-40 bottom-0 left-1/2 hidden w-screen -translate-x-1/2 overflow-hidden [html[data-lab-field=off]_&]:block"
    >
      <div className="absolute top-[calc(10rem+2rem-4.5rem)] left-1/2 aspect-square w-[325vw] -translate-x-1/2 rounded-full bg-[oklch(0.165_0.004_264)] shadow-[0_0_0_1px_oklch(0.79_0.11_248/0.5),0_-3px_16px_-2px_oklch(0.68_0.173_253.3/0.5),0_-12px_60px_-8px_oklch(0.68_0.173_253.3/0.22)]" />
      {/* The sunrise: a short stretch of the edge gone white, tilted to the arc's tangent, and the
          faint glow over it. */}
      <div className="absolute top-[calc(7.5rem+10px)] left-[calc(50%+15.5vw)] h-[3px] w-[12rem] -translate-x-1/2 -translate-y-1/2 rotate-[5deg] rounded-full bg-[radial-gradient(closest-side,oklch(0.99_0.01_250),oklch(0.86_0.07_250/0.7)_45%,transparent)]" />
      <div className="absolute top-[calc(7.5rem+4px)] left-[calc(50%+15.5vw)] h-[3rem] w-[13rem] -translate-x-1/2 -translate-y-1/2 rotate-[5deg] rounded-full bg-[radial-gradient(closest-side,oklch(0.9_0.05_250/0.22),transparent)] blur-[6px]" />
    </div>
  )
}
