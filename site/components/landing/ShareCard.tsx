"use client"

import { useRef } from "react"

import { Aperture } from "./Aperture"
import { Mark } from "./Mark"
import { World } from "./World"
import s from "./landing.module.css"

/**
 * The hero at a share card's size: the mark and the headline on deep navy, and beside them the ring
 * opening onto the hero's world. The Aperture keeps every star out from under the words it marks
 * `data-clear`, as it does on the page. The boxes are fixed in px from the left, so a wider frame
 * (GitHub's 1280 × 640) re-lays rather than stretches.
 */
export function ShareCard({ world }: { world: { file: string } }) {
  const ring = useRef<HTMLDivElement>(null)
  return (
    <main className={`${s.page} relative h-[100dvh] overflow-hidden`}>
      <div ref={ring} className="absolute" style={{ left: 676, top: 95, width: 440, height: 440 }}>
        <World file={world.file} x={0.4} y={0.4} className={s.ringWorld} />
      </div>
      <Aperture ring={ring} className={s.sky} />
      <div className="absolute flex flex-col justify-between" style={{ left: 80, top: 80, bottom: 80, width: 560 }}>
        <p className="inline-flex items-center gap-[14px] self-start text-[30px] font-medium tracking-[-0.01em]" data-clear>
          <Mark className="h-[40px] w-auto" />
          <span>Realm</span>
        </p>
        <h1 className="self-start text-[80px] leading-none font-medium tracking-[-0.045em]" data-clear>
          One workspace
          <br />
          for every
          <br />
          coding agent.
        </h1>
      </div>
    </main>
  )
}
