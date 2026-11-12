import type { Route } from "next"
import Link from "next/link"

import { ArrowIcon } from "@/components/icons"
import type { DocPage } from "@/lib/docs"

/**
 * The way on from a page: the pages either side of it in the docs' reading order, the one before on
 * the left and the one after on the right, as the changelog's entries end (components/changelog/
 * Onward). The docs home is before the first page.
 */
export function PrevNext({ previous, next }: { previous?: DocPage | "home"; next?: DocPage }) {
  if (!previous && !next) return null
  return (
    <nav aria-label="More docs" className="mt-20 grid gap-3 border-t border-line pt-10 sm:grid-cols-2">
      {previous ? (
        <Side
          href={previous === "home" ? "/docs" : `/docs/${previous.slug}`}
          label="Previous"
          title={previous === "home" ? "Docs overview" : previous.title}
          direction="previous"
        />
      ) : (
        <span aria-hidden className="hidden sm:block" />
      )}
      {next ? <Side href={`/docs/${next.slug}`} label="Next" title={next.title} direction="next" /> : null}
    </nav>
  )
}

function Side({ href, label, title, direction }: { href: string; label: string; title: string; direction: "previous" | "next" }) {
  return (
    <Link
      href={href as Route}
      rel={direction === "next" ? "next" : "prev"}
      className={`row-link group flex flex-col rounded-[12px] bg-canvas p-5 [--row-hover:var(--color-surface)] sm:p-6 ${direction === "next" ? "sm:items-end sm:text-right" : ""}`}
    >
      <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
        {direction === "previous" ? <ArrowIcon className="nudge h-3.5 w-3.5 rotate-180 [--nudge:-3px]" /> : null}
        {label}
        {direction === "next" ? <ArrowIcon className="nudge h-3.5 w-3.5" /> : null}
      </span>
      <span className="mt-2 text-[17px] leading-[1.35] font-[560] text-ink">{title}</span>
    </Link>
  )
}
