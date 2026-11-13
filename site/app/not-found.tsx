import type { Metadata } from "next"
import Link from "next/link"

import { ArrowIcon } from "@/components/icons"
import { Subpage } from "@/components/landing/Subpage"

// The root layout's description is the home's; a missing page has none of its own.
export const metadata: Metadata = {
  title: "Not found",
  description: null,
}

export default function NotFound() {
  return (
    <Subpage
      head={
        <>
          <h1 className="text-[clamp(1.75rem,4vw,2.25rem)] leading-[1.1] font-[500] tracking-[-0.035em] text-ink">
            There is nothing at this address.
          </h1>
          <p className="mt-3 max-w-[34rem] text-[16px] leading-[1.6] text-ink-2">
            The page may have been renamed, or it may never have existed.
          </p>
          <div className="mt-7 flex flex-wrap gap-2.5">
            <Link
              href="/"
              className="inline-flex min-h-11 items-center rounded-lg bg-surface px-4 py-2.5 text-[14px] text-ink-2 transition-[scale,color,background-color] duration-150 ease-out hover:bg-raised hover:text-ink active:scale-[0.96]"
            >
              Home
            </Link>
            <Link
              href="/changelog"
              className="group inline-flex min-h-11 items-center gap-2 rounded-lg px-3 py-2.5 text-[14px] text-ink-2 transition-colors duration-150 hover:bg-surface hover:text-ink"
            >
              Changelog
              <ArrowIcon className="h-3.5 w-3.5 transition-transform duration-300 ease-[var(--ease-out-strong)] group-hover:translate-x-0.5" />
            </Link>
          </div>
        </>
      }
    >
      <div aria-hidden className="min-h-[24vh]" />
    </Subpage>
  )
}
