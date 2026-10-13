"use client"

import { useRef, useState, type PointerEvent } from "react"

import type { Feature } from "@/content/features"

import { Register, Seam } from "./kinetic"
import s from "./paper.module.css"

/** How much the loupe magnifies, and its size in CSS px. */
const LOUPE = { power: 3, size: 148 }

/**
 * Every capture, on one sheet: the whole run of the capture script, frame by frame, each captioned
 * with what is in it (content/features.ts, which is written against the frames). The section pins and
 * the reader's scroll carries the sheet sideways past the window; Skip goes straight past it. Without
 * scroll timelines, or with reduced motion, it is simply a sheet: every frame in a grid.
 *
 * A contact sheet is read with a loupe, so pointing at a frame puts one over it — three times the
 * frame, drawn from the full-size capture — and the sheet's head reads out that frame's whole caption.
 * Focusing a frame from the keyboard reads the caption the same way.
 */
export function ContactSheet({ frames }: { frames: Feature[] }) {
  const [looking, setLooking] = useState<number | null>(null)
  const shown = looking === null ? null : frames[looking]

  return (
    <section data-running-head="Contact sheet" aria-labelledby="sheet-title" className={`${s.sheet} pt-[clamp(48px,7vw,112px)]`}>
      <Seam />
      <div className={s.sheetPin}>
        <div className={`${s.measure} ${s.grid} items-end gap-y-5`}>
          <div className="col-span-12 lg:col-span-7">
            <Register id="sheet-title" text="Every capture, on one sheet." className={`${s.statement} text-ink`} />
          </div>
          <div className="col-span-12 flex min-h-[7.5rem] flex-col justify-end gap-4 lg:col-span-5">
            <p aria-live="polite" className={`${s.body} max-w-[46ch] text-[16px]`}>
              {shown ? (
                <>
                  <span className={`${s.note} mr-2 text-ink-3`}>{String(looking! + 1).padStart(2, "0")}</span>
                  <span className="text-ink">{shown.title}.</span> {shown.blurb}
                </>
              ) : (
                <>
                  All {frames.length} scenes the capture script takes of the shipped app, each on a scratch home, in the order the
                  features page tours them. Point at one to read it.
                </>
              )}
            </p>
            <a href="#after-sheet" className={`${s.note} self-start text-accent-ink underline decoration-1 underline-offset-4 hover:text-ink`}>
              Skip the sheet
            </a>
          </div>
        </div>
        <ol
          className={s.strip}
          aria-label="Captures"
          style={{ ["--count" as string]: frames.length, ["--half" as string]: Math.ceil(frames.length / 2) }}
          onPointerLeave={() => setLooking(null)}
        >
          {frames.map((frame, i) => (
            <Frame key={frame.slug} frame={frame} index={i} onLook={setLooking} />
          ))}
        </ol>
      </div>
      <div id="after-sheet" className="scroll-mt-20" />
    </section>
  )
}

function Frame({ frame, index, onLook }: { frame: Feature; index: number; onLook: (i: number | null) => void }) {
  const plate = useRef<HTMLDivElement>(null)
  const src = `/product/${frame.slug}-1440.webp`

  // The loupe follows the pointer without a render: two custom properties, written straight to the frame.
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || !plate.current) return
    const r = plate.current.getBoundingClientRect()
    plate.current.style.setProperty("--lx", `${event.clientX - r.left}px`)
    plate.current.style.setProperty("--ly", `${event.clientY - r.top}px`)
    plate.current.style.setProperty("--lw", `${r.width}px`)
    plate.current.style.setProperty("--lh", `${r.height}px`)
  }

  return (
    <li className={s.frame}>
      <figure
        tabIndex={0}
        aria-label={`${String(index + 1).padStart(2, "0")}. ${frame.title}`}
        onPointerEnter={() => onLook(index)}
        onFocus={() => onLook(index)}
        onBlur={() => onLook(null)}
        className="group rounded-[12px] outline-offset-4"
      >
        <div
          ref={plate}
          onPointerMove={move}
          className={s.loupeHost}
          style={{ ["--src" as string]: `url(${src})`, ["--power" as string]: LOUPE.power, ["--loupe" as string]: `${LOUPE.size}px` }}
        >
          <div className={`${s.dark} ${s.plate} aspect-[16/10]`}>
            <img src={src} alt={frame.blurb} width={1440} height={900} loading="lazy" decoding="async" className="h-full w-full object-cover" />
          </div>
          <span aria-hidden className={s.loupe} />
        </div>
        <figcaption className="mt-3 flex gap-3">
          <span className={`${s.note} w-6 shrink-0 text-ink-3`}>{String(index + 1).padStart(2, "0")}</span>
          <span className="text-[14px] leading-[1.4] text-ink transition-colors duration-150 group-hover:text-accent-ink">{frame.title}</span>
        </figcaption>
      </figure>
    </li>
  )
}
