import Link from "next/link"
import type { Route } from "next"

import { ArrowIcon } from "@/components/icons"

/**
 * The shell every docs page shares: title, lede, prose, and a link on to the next page. Keeping the
 * next-page link here rather than in each file means the chain is visible in one place when the
 * order changes.
 */
export function DocPage({
  title,
  lede,
  next,
  children,
}: {
  title: string
  lede?: string
  next?: { href: Route; label: string }
  children: React.ReactNode
}) {
  return (
    <article>
      <h1 className="display-tight text-[clamp(2rem,3.4vw,2.75rem)] font-semibold text-ink">{title}</h1>
      {lede ? <p className="mt-4 text-[17px] leading-relaxed text-ink-2">{lede}</p> : null}
      <div className="doc-prose mt-10">{children}</div>

      {next ? (
        <Link
          href={next.href}
          className="group mt-16 flex items-center justify-between gap-4 rounded-xl border border-line px-5 py-4 transition-colors hover:border-line-strong hover:bg-surface/50"
        >
          <span>
            <span className="block text-[12px] tracking-[0.06em] text-ink-3 uppercase">Next</span>
            <span className="mt-0.5 block text-[15px] font-medium text-ink">{next.label}</span>
          </span>
          <ArrowIcon className="h-4 w-4 shrink-0 text-ink-3 transition-transform duration-300 ease-[var(--ease-out-strong)] group-hover:translate-x-0.5 group-hover:text-ink" />
        </Link>
      ) : null}
    </article>
  )
}
