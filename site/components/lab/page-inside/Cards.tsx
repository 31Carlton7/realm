import type { CSSProperties } from "react"

import { AgentMark } from "@/components/AgentMark"
import type { ProvenClaim } from "@/components/lab/pages"

import { captureSrc, chapters, cutStyle, stills } from "./content"
import css from "./inside.module.css"

/** A capture cut to `box` ([left, top, right, bottom] in its own pixels), or shown whole. */
type Cut = { src: string; size: readonly [number, number]; box?: readonly [number, number, number, number]; caption?: string }
type Picture = { wide: Cut; narrow?: Cut; caption: string }

/**
 * Each chapter's picture where the tour cannot run — a phone, a narrow window, reduced motion — cut
 * to the part the chapter is about. They are the site's own cuts of the captures, at three times the
 * window's density. A phone gets a closer cut where the wide one would shrink the app's words past
 * reading, and a cut of a different subject carries its own caption. Every caption is the changelog's
 * or the landing page's own, and describes what is in its frame.
 */
const pictures = (claims: ProvenClaim[]): Record<string, Picture> => {
  const caption = (id: string) => claims.find((c) => c.id === id)?.caption ?? ""
  const sidebar = { src: "/product/details/sidebar.webp", size: [2100, 1800] } as const
  return {
    spaces: {
      wide: { src: "/product/claims/spaces.webp", size: [2419, 1814] },
      narrow: { ...sidebar, box: [150, 640, 960, 1714] },
      caption: "The sidebar's spaces, each in its colour with a count of what's waiting and working in it, and its sessions.",
    },
    "needs-you": {
      wide: {
        src: "/product/details/question-card.webp",
        size: [2280, 1080],
        caption: "The one card every agent's questions come on: who is asking first, and three options as pictures. Press 1 to 3 to pick one.",
      },
      narrow: { ...sidebar, box: [150, 240, 960, 640], caption: "Needs you across every space: two questions, one of them from another profile, and a sub-agent's permission." },
      caption: "",
    },
    transcript: {
      wide: { src: "/product/details/edited-files.webp", size: [1674, 1428] },
      narrow: { src: "/product/details/edited-files.webp", size: [1674, 1428], box: [40, 960, 1640, 1380] },
      caption: "A turn's card: the two files it edited, with the counts git measured when the turn settled, plus Review and Undo.",
    },
    "side-panel": {
      wide: { src: captureSrc("workspace", 4320), size: [4320, 2700], box: [2658, 120, 4320, 1800] },
      narrow: { src: captureSrc("workspace", 4320), size: [4320, 2700], box: [2658, 300, 3900, 1500] },
      caption: "The file the agent named, open in the side panel at the line it named.",
    },
    delegation: {
      wide: { src: "/product/details/sub-agents.webp", size: [1674, 804] },
      caption: "Two sub-agents on two harnesses. One stopped on a permission, the other finished with its report.",
    },
    agents: {
      wide: { src: "/product/details/model-picker.webp", size: [1236, 1680] },
      caption: "Opus 5.5 picked, what it's for and what it costs under the list, and the effort track at Max (lit) with fast mode on.",
    },
    gateway: {
      wide: { src: "/product/claims/gateway.webp", size: [3024, 2268] },
      narrow: { src: captureSrc("connections", 4320), size: [4320, 2700], box: [1158, 570, 2580, 1700] },
      caption: caption("gateway"),
    },
    sandbox: {
      wide: { src: "/product/claims/sandbox.webp", size: [2938, 2203] },
      narrow: { src: captureSrc("sandbox", 4320), size: [4320, 2700], box: [1581, 780, 3741, 1830] },
      caption: caption("sandbox"),
    },
    review: {
      wide: { src: "/product/details/review-findings.webp", size: [2256, 1404] },
      narrow: { src: "/product/details/review-findings.webp", size: [2256, 1404], box: [60, 380, 1960, 1080] },
      caption: "Three findings from a reviewer, one of them on a line the diff doesn't show.",
    },
    durable: {
      wide: { src: "/product/claims/durable.webp", size: [4320, 2700] },
      narrow: { src: captureSrc("schedules", 4320), size: [4320, 2700], box: [168, 150, 2400, 1950] },
      caption: "Three tasks, each on its own model, and one run open as its own session.",
    },
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
                    {chapter.marks ? (
                      <ul aria-label="Agents" className="mt-5 flex flex-wrap items-center gap-x-3.5 gap-y-2 text-ink-2">
                        {chapter.marks.map((id) => (
                          <li key={id}>
                            <AgentMark id={id} className="h-[18px] w-[18px]" />
                          </li>
                        ))}
                      </ul>
                    ) : null}
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
          {stills.filter((s) => !s.claim).map((s) => (
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

/** Where a cut's picture sits in its frame, as custom properties for one breakpoint. */
const placement = (cut: Cut, suffix: "w" | "n") => {
  const [sw, sh] = cut.size
  const [x0, y0, x1, y1] = cut.box ?? [0, 0, sw, sh]
  const w = x1 - x0
  const h = y1 - y0
  return {
    [`--ar-${suffix}`]: `${w} / ${h}`,
    [`--iw-${suffix}`]: `${(sw / w) * 100}%`,
    [`--il-${suffix}`]: `${(-x0 / w) * 100}%`,
    [`--it-${suffix}`]: `${(-y0 / h) * 100}%`,
  }
}

/** A chapter's capture, cut for a phone and for everything wider. */
function Crop({ picture }: { picture: Picture }) {
  const { wide, narrow = wide } = picture
  const style = { ...placement(wide, "w"), ...placement(narrow, "n") } as CSSProperties
  const wideCaption = wide.caption ?? picture.caption
  const narrowCaption = narrow.caption ?? picture.caption
  return (
    <figure className="min-w-0">
      <div style={style} className={`${css.crop} relative overflow-hidden rounded-[12px] bg-page`}>
        <picture>
          {narrow.src !== wide.src ? <source media="(max-width: 639px)" srcSet={narrow.src} /> : null}
          <img
            src={wide.src}
            alt=""
            width={Math.round(wide.size[0] / 3)}
            height={Math.round(wide.size[1] / 3)}
            loading="lazy"
            decoding="async"
            className="absolute h-auto max-w-none"
          />
        </picture>
        <span aria-hidden className={css.edge} />
      </div>
      {wideCaption === narrowCaption ? (
        <Caption text={wideCaption} />
      ) : (
        <>
          <Caption text={narrowCaption} className="sm:hidden" />
          <Caption text={wideCaption} className="max-sm:hidden" />
        </>
      )}
    </figure>
  )
}

function Caption({ text, className = "" }: { text: string; className?: string }) {
  return (
    <figcaption className={`mt-3.5 text-[14px] leading-[1.5] text-ink-2 ${className}`}>
      <span className="text-ink">A capture of the app.</span> {text}
    </figcaption>
  )
}
