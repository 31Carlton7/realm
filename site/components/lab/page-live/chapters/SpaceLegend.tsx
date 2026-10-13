import type { ReactNode } from "react"

import type { Claim, Facet } from "@/content/home"

import { Evidence } from "../kit/Chapter"

/** Each of a space's six parts, as a symbol in the map's own line language. */
const SYMBOLS: Record<string, ReactNode> = {
  "The checkout": (
    <>
      <path d="M1 8h14" />
      <path d="M4 5.5v5M8 5.5v5M12 5.5v5" strokeOpacity="0.6" />
    </>
  ),
  "The terminal": <path d="M2.5 4.5 6 8l-3.5 3.5M8.5 11.5h5" />,
  "The browser": (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c1.6 1.7 2.3 3.5 2.3 5.5S9.6 11.8 8 13.5C6.4 11.8 5.7 10 5.7 8S6.4 4.2 8 2.5Z" />
    </>
  ),
  "The tools": <path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.2a3.5 3.5 0 0 1-7 0Zm3.5 5.7v2.3" />,
  "The boundary": <rect x="2" y="3" width="12" height="10" rx="2.5" strokeDasharray="2 2" />,
  "The agent": (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.75" fill="currentColor" stroke="none" />
    </>
  ),
}

/**
 * The key to the map: every line is a space, and this is what a space holds — the six parts of the
 * landing page's own list, each with the limit it states — with the real sidebar as the evidence.
 */
export function SpaceLegend({ facets, claim }: { facets: Facet[]; claim: Claim }) {
  return (
    <section aria-labelledby="spaces-title" className="mx-auto w-full max-w-[85rem] px-5 py-20 sm:px-10 sm:py-28 lg:pt-36">
      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <h2 id="spaces-title" className="text-[clamp(1.9rem,3.2vw,2.75rem)] leading-[1.04] font-[580] tracking-[-0.042em] text-balance text-ink">
            Every line is a space.
          </h2>
          <p className="mt-5 text-[16.5px] leading-[1.6] text-ink-2">
            Each space gets its own section of the sidebar: its name in its colour, a count of what&rsquo;s waiting and
            working, and its sessions. Needs you sits on top and collects every session that&rsquo;s waiting on a
            permission or a question, from every space and every profile. Switching spaces loads nothing, because
            they&rsquo;re all loaded already.
          </p>
        </div>
        <dl className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:col-span-8 lg:grid-cols-3 lg:pt-2">
          {facets.map((f) => (
            <div key={f.title}>
              <dt className="flex items-center gap-2.5 text-[15px] font-[540] text-ink">
                <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-ink-2" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
                  {SYMBOLS[f.title]}
                </svg>
                {f.title.replace(/^The /, "").replace(/^./, (c) => c.toUpperCase())}
              </dt>
              <dd className="mt-2 text-[14.5px] leading-[1.55] text-ink-2">{f.body}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="mt-16 sm:mt-20">
        <Evidence claim={claim} />
      </div>
    </section>
  )
}
