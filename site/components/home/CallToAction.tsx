import Link from "next/link"

import { ArrowIcon, GitHubIcon } from "@/components/icons"
import { site } from "@/lib/site"

export function CallToAction() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(800px_420px_at_50%_100%,color-mix(in_srgb,var(--color-accent)_18%,transparent),transparent_72%)]"
      />
      <div
        aria-hidden
        className="grid-backdrop pointer-events-none absolute inset-0 opacity-25 [mask-image:radial-gradient(700px_360px_at_50%_100%,black,transparent_75%)]"
      />
      <div className="relative mx-auto max-w-3xl px-6 py-28 text-center lg:py-36">
        <h2 className="display-tight text-[clamp(2.25rem,4.4vw,3.5rem)] font-semibold text-ink">
          Give your agents somewhere to live.
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-[17px] leading-relaxed text-ink-2">
          Realm is in active development. The docs cover how it is put together and how to run it
          locally today.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs/getting-started"
            className="group inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-[14px] font-medium text-page transition-opacity hover:opacity-90"
          >
            Get started
            <ArrowIcon className="h-3.5 w-3.5 transition-transform duration-300 ease-[var(--ease-out-strong)] group-hover:translate-x-0.5" />
          </Link>
          <a
            href={site.repo}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/50 px-5 py-2.5 text-[14px] text-ink-2 backdrop-blur transition-colors hover:border-line-strong hover:text-ink"
          >
            <GitHubIcon className="h-4 w-4" />
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  )
}
