import { features } from "@/content/features"
import captured from "@/public/product/manifest.json"

import { Register } from "./kinetic"
import s from "./paper.module.css"

/**
 * Every capture, on one sheet: the whole run of the capture script, frame by frame, each captioned
 * with what is in it (content/features.ts, which is written against the frames). The section pins and
 * the reader's scroll carries the sheet sideways past the window; Skip goes straight past it. Without
 * scroll timelines, or with reduced motion, it is simply a sheet: every frame in a grid.
 */
export function ContactSheet() {
  const taken = new Set(captured as string[])
  const frames = features.filter((feature) => taken.has(feature.slug))
  return (
    <section data-running-head="Contact sheet" aria-labelledby="sheet-title" className={`${s.sheet} mt-[clamp(96px,13vw,200px)]`}>
      <div className={s.sheetPin}>
        <div className={`${s.measure} ${s.grid} items-end gap-y-5`}>
          <div className="col-span-12 lg:col-span-7">
            <Register id="sheet-title" text="Every capture, on one sheet." className={`${s.statement} text-ink`} />
          </div>
          <div className="col-span-12 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between lg:col-span-5 lg:flex-col lg:items-start">
            <p className={`${s.body} max-w-[46ch] text-[16px]`}>
              All {frames.length} scenes the capture script takes of the shipped app, each on a scratch home, in the order
              the features page tours them.
            </p>
            <a href="#after-sheet" className={`${s.note} ${s.skip} text-accent-ink underline decoration-1 underline-offset-4 hover:text-ink`}>
              Skip the sheet
            </a>
          </div>
        </div>
        <ol className={s.strip} aria-label="Captures">
          {frames.map((frame, i) => (
            <li key={frame.slug} className={s.frame}>
              <figure>
                <div className={`${s.dark} ${s.plate} aspect-[16/10]`}>
                  <img
                    src={`/product/${frame.slug}-1440.webp`}
                    alt={frame.blurb}
                    width={1440}
                    height={900}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                </div>
                <figcaption className="mt-3 flex gap-3">
                  <span className={`${s.note} w-6 shrink-0 text-ink-3`}>{String(i + 1).padStart(2, "0")}</span>
                  <span className="text-[14px] leading-[1.4] text-ink">{frame.title}</span>
                </figcaption>
              </figure>
            </li>
          ))}
        </ol>
      </div>
      <div id="after-sheet" className="scroll-mt-20" />
    </section>
  )
}
