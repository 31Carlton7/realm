import Link from "next/link"

import { ArrowIcon } from "@/components/icons"
import { Wordmark } from "@/components/Wordmark"

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-5xl flex-col justify-center px-6 py-16 sm:px-10">
      <Wordmark className="text-ink" />
      <h1 className="mt-8 text-[clamp(1.75rem,4vw,2.25rem)] leading-[1.1] font-[560] tracking-[-0.035em] text-ink">
        There is nothing at this address.
      </h1>
      <p className="mt-3 max-w-[34rem] text-[16px] leading-[1.6] text-ink-2">
        The page may have been renamed, or it may never have existed.
      </p>
      <div className="mt-7 flex flex-wrap gap-2.5">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-lg bg-surface px-4 py-2.5 text-[14px] text-ink-2 shadow-[0_0_0_1px_oklch(1_0_0/0.12)] transition-[scale,color,box-shadow] duration-150 ease-out hover:text-ink hover:shadow-[0_0_0_1px_oklch(1_0_0/0.18)] active:scale-[0.96]"
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
    </main>
  )
}
