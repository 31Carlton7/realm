import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { ArrowIcon } from "@/components/icons"
import { Prose } from "@/components/changelog/Prose"
import { SiteHeader } from "@/components/SiteHeader"
import { changelog, entryBySlug, formatDate, neighbours } from "@/lib/changelog"

type Params = { params: Promise<{ slug: string }> }

export function generateStaticParams() {
  return changelog.map((entry) => ({ slug: entry.slug }))
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params
  const entry = entryBySlug(slug)
  if (!entry) return {}

  return {
    title: entry.title,
    description: entry.summary,
    openGraph: {
      type: "article",
      title: entry.title,
      description: entry.summary,
      publishedTime: entry.date,
    },
  }
}

export default async function ChangelogEntryPage({ params }: Params) {
  const { slug } = await params
  const entry = entryBySlug(slug)
  if (!entry) notFound()

  const { newer, older } = neighbours(slug)

  return (
    <>
      <SiteHeader width="max-w-[46rem]" />
      <main className="mx-auto w-full max-w-[46rem] px-6 pt-8 pb-28 sm:px-10 sm:pt-12">
        <Link
          href="/changelog"
          className="group inline-flex min-h-10 items-center gap-2 text-[13px] text-ink-2 transition-colors duration-150 hover:text-ink"
        >
          <ArrowIcon className="h-3.5 w-3.5 rotate-180 transition-transform duration-300 ease-[var(--ease-out-strong)] group-hover:-translate-x-0.5" />
          Changelog
        </Link>

        <article className="mt-8">
          <p className="font-mono text-[13px] text-ink-3">
            <time dateTime={entry.date}>{formatDate(entry.date)}</time>
            {` · ${entry.area}`}
            {entry.version ? ` · ${entry.version}` : ""}
          </p>
          <h1 className="mt-3 text-[clamp(1.85rem,4.5vw,2.5rem)] leading-[1.08] font-[560] tracking-[-0.035em] text-ink">
            {entry.title}
          </h1>
          <p className="mt-5 text-[17px] leading-[1.6] text-ink-2">{entry.summary}</p>

          <hr className="mt-9 border-0 border-t border-line" />

          <div className="mt-9">
            <Prose blocks={entry.body} />
          </div>
        </article>

        {newer || older ? (
          <nav
            aria-label="More entries"
            className="mt-16 grid gap-3 border-t border-line pt-8 sm:grid-cols-2"
          >
            {newer ? <Neighbour entry={newer} direction="newer" /> : <span className="hidden sm:block" />}
            {older ? <Neighbour entry={older} direction="older" /> : null}
          </nav>
        ) : null}
      </main>
    </>
  )
}

function Neighbour({
  entry,
  direction,
}: {
  entry: { slug: string; title: string }
  direction: "newer" | "older"
}) {
  return (
    <Link
      href={`/changelog/${entry.slug}`}
      className={`rounded-xl bg-canvas p-5 transition-colors duration-200 hover:bg-surface ${
        direction === "older" ? "sm:text-right" : ""
      }`}
    >
      <span className="font-mono text-[12px] text-ink-3">
        {direction === "newer" ? "Newer" : "Older"}
      </span>
      <span className="mt-1.5 block text-[15px] leading-[1.4] font-[500] text-ink">{entry.title}</span>
    </Link>
  )
}
