import type { ProvenClaim } from "@/components/lab/pages"

import { captureSrc, chapters, cutStyle, stills } from "./content"
import css from "./inside.module.css"

type Picture = { src: string; size: readonly [number, number]; box?: readonly [number, number, number, number]; caption: string }

/**
 * Each chapter's picture where the tour cannot run — a phone, a narrow window, reduced motion — cut
 * to the part the chapter is about. They are the site's own cuts of the captures, at three times the
 * window's density, so they stay legible at a phone's width. The captions are the changelog's and the
 * landing page's own, and describe what is in each frame.
 */
const pictures = (claims: ProvenClaim[]): Record<string, Picture> => {
  const caption = (id: string) => claims.find((c) => c.id === id)?.caption ?? ""
  return {
    spaces: { src: "/product/claims/spaces.webp", size: [2419, 1814], caption: caption("spaces") },
    "needs-you": {
      src: "/product/details/question-card.webp",
      size: [2280, 1080],
      caption: "The one card every agent's questions come on: who is asking first, and three options as pictures. Press 1 to 3 to pick one.",
    },
    transcript: {
      src: "/product/details/edited-files.webp",
      size: [1674, 1428],
      caption: "A turn's card: the two files it edited, with the counts git measured when the turn settled, plus Review and Undo.",
    },
    "side-panel": {
      src: captureSrc("workspace", 4320),
      size: [4320, 2700],
      box: [2658, 120, 4320, 2160],
      caption: "The file the agent named, open in the side panel at the line it named.",
    },
    delegation: {
      src: "/product/details/sub-agents.webp",
      size: [1674, 804],
      caption: "Two sub-agents on two harnesses. One stopped on a permission, the other finished with its report.",
    },
    agents: {
      src: "/product/details/model-picker.webp",
      size: [1236, 1680],
      caption: "Opus 5.5 picked, what it's for and what it costs under the list, and the effort track at Max (lit) with fast mode on.",
    },
    gateway: { src: "/product/claims/gateway.webp", size: [3024, 2268], caption: caption("gateway") },
    sandbox: { src: "/product/claims/sandbox.webp", size: [2938, 2203], caption: caption("sandbox") },
    review: {
      src: "/product/details/review-findings.webp",
      size: [2256, 1404],
      caption: "Three findings from a reviewer, one of them on a line the diff doesn't show.",
    },
    durable: { src: "/product/claims/durable.webp", size: [4320, 2700], caption: caption("durable") },
  }
}

export function Cards({ claims }: { claims: ProvenClaim[] }) {
  const shown = pictures(claims)
  return (
    <div className={css.cardsOnly}>
      <section aria-label="What Realm does" className="mx-auto w-full max-w-[1200px] px-6 pt-20 sm:px-10 sm:pt-28">
        <ol className="space-y-20 sm:space-y-28">
          {chapters.map((chapter) => {
            const picture = shown[chapter.id]
            const lines = chapter.beats.map((b) => b.line).filter(Boolean)
            return (
              <li key={chapter.id}>
                <article aria-labelledby={`card-${chapter.id}`} className="grid gap-7 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center lg:gap-14">
                  <div>
                    <h2 id={`card-${chapter.id}`} className="text-[clamp(1.6rem,6vw,2.1rem)] leading-[1.1] font-[560] tracking-[-0.032em] text-balance text-ink">
                      {chapter.title}
                    </h2>
                    <p className="mt-4 text-[16px] leading-[1.6] text-ink-2">{chapter.body}</p>
                    {lines.length ? (
                      <ul className="mt-5 space-y-3">
                        {lines.map((line) => (
                          <li key={line} className="border-l border-accent/70 pl-4 text-[16px] leading-[1.5] text-ink">
                            {line}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  {picture ? <Crop picture={picture} /> : null}
                </article>
              </li>
            )
          })}
        </ol>
      </section>

      <section aria-labelledby="stills-title" className="mx-auto w-full max-w-[1200px] pt-24 sm:pt-32">
        <div className="px-6 sm:px-10">
          <h2 id="stills-title" className="text-[clamp(1.6rem,6vw,2.1rem)] leading-[1.1] font-[560] tracking-[-0.032em] text-ink">
            More of the app, captured.
          </h2>
          <p className="mt-4 max-w-[56ch] text-[16px] leading-[1.6] text-ink-2">
            Every picture here is a capture of the shipped app, taken on a scratch home by the same script each release.
          </p>
        </div>
        <ul className="mt-8 flex snap-x snap-mandatory gap-4 overflow-x-auto px-6 pb-4 [scrollbar-width:none] sm:gap-6 sm:px-10">
          {stills.map((s) => (
            <li key={s.slug} className="w-[min(82vw,520px)] shrink-0 snap-start">
              <figure>
                <div className="relative aspect-[16/10] overflow-hidden rounded-[12px] bg-page">
                  <img
                    src={captureSrc(s.slug, 1440)}
                    srcSet={`${captureSrc(s.slug, 1440)} 1440w, ${captureSrc(s.slug, 4320)} 4320w`}
                    sizes={`(min-width: 640px) ${Math.round(520 / s.cut[2])}px, ${Math.round(82 / s.cut[2])}vw`}
                    alt=""
                    width={1440}
                    height={900}
                    loading="lazy"
                    decoding="async"
                    style={cutStyle(s.cut)}
                    className="absolute h-auto max-w-none"
                  />
                  <span aria-hidden className={css.edge} />
                </div>
                <figcaption className="mt-3.5">
                  <span className="block text-[15px] leading-[1.4] font-[560] text-ink">{s.title}</span>
                  <span className="mt-1 block text-[14px] leading-[1.55] text-ink-2">{s.blurb}</span>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

/** A capture shown whole, or cut to `box` ([left, top, right, bottom] in its own pixels). */
function Crop({ picture }: { picture: Picture }) {
  const [sw, sh] = picture.size
  const [x0, y0, x1, y1] = picture.box ?? [0, 0, sw, sh]
  const w = x1 - x0
  const h = y1 - y0
  return (
    <figure className="min-w-0">
      <div style={{ aspectRatio: `${w} / ${h}` }} className="relative max-h-[78svh] overflow-hidden rounded-[12px] bg-page">
        <img
          src={picture.src}
          alt={picture.caption}
          width={Math.round(sw / 3)}
          height={Math.round(sh / 3)}
          loading="lazy"
          decoding="async"
          style={{ width: `${(sw / w) * 100}%`, left: `${(-x0 / w) * 100}%`, top: `${(-y0 / h) * 100}%` }}
          className="absolute h-auto max-w-none"
        />
        <span aria-hidden className={css.edge} />
      </div>
      <figcaption className="mt-3.5 flex gap-2.5 text-[14px] leading-[1.5] text-ink-2">
        <span>
          <span className="text-ink">A capture of the app.</span> {picture.caption}
        </span>
      </figcaption>
    </figure>
  )
}
