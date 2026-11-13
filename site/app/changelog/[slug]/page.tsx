import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Onward } from "@/components/changelog/Onward"
import { Prose } from "@/components/changelog/Prose"
import { Rail } from "@/components/changelog/Rail"
import { ArrowIcon } from "@/components/icons"
import { Subpage } from "@/components/landing/Subpage"
import { changelog, entryBySlug, formatDate, isWithdrawn, outline, releaseOf } from "@/lib/changelog"

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

/** Sections a reader is offered a map of: a short entry reads in one go, and a map of it is chrome. */
const MAP_FROM = 3

/**
 * One entry: its date, title and summary on the band of space under the header, then the notes in a
 * reading column, with a map of their sections beside a long one, and the way on: the releases either
 * side, or the release a change shipped in.
 */
export default async function ChangelogEntryPage({ params }: Params) {
  const { slug } = await params
  const entry = entryBySlug(slug)
  if (!entry) notFound()

  const release = releaseOf(slug)
  const sections = outline(entry.body)
  const withdrawn = isWithdrawn(entry)

  return (
    <Subpage
      current="changelog"
      head={
        <>
          {/* Back to the release's own place in the list. */}
          <Link
            href={release ? `/changelog#${release.slug}` : "/changelog"}
            className="-ml-1 inline-flex min-h-10 items-center gap-2 rounded-[8px] px-1 text-[14px] text-ink-2 transition-colors duration-150 ease-out hover:text-ink hover:duration-220 hover:ease-spring"
          >
            <ArrowIcon className="nudge h-3.5 w-3.5 rotate-180 [--nudge:-3px]" />
            <span className="link-line">Changelog</span>
          </Link>
          <p className="mt-4 font-mono text-[13px] text-ink-2">
            <time dateTime={entry.date}>{formatDate(entry.date)}</time>
            {entry.version ? null : ` · ${entry.area}`}
            {withdrawn ? <span className="text-orange"> · Withdrawn</span> : null}
          </p>
          <h1 id="entry-title" className="mt-3 text-[clamp(2.25rem,4.4vw,3.25rem)] leading-[1.04] font-[500] tracking-[-0.045em] text-balance text-ink">
            {entry.title}
          </h1>
          <p className="mt-5 max-w-[60ch] text-[18px] leading-[1.6] text-ink-2">{entry.summary}</p>
          {!entry.version && release ? (
            <p className="mt-5 text-[14px] text-ink-2">
              Shipped in{" "}
              <Link href={`/changelog/${release.slug}`} className="link-line text-accent-ink">
                {release.version}
              </Link>
              , {formatDate(release.date)}
            </p>
          ) : null}
        </>
      }
    >
      <main>
        <article aria-labelledby="entry-title">
          <div className="mx-auto grid w-full max-w-[1240px] grid-cols-1 px-5 sm:px-7 xl:grid-cols-[10rem_minmax(0,44rem)] xl:gap-x-20 [--figure-room:100%] lg:[--figure-room:min(58rem,calc(100vw-3.5rem))] xl:[--figure-room:min(58rem,calc(100vw-21rem))]">
            <div className="hidden xl:block">
              {sections.length >= MAP_FROM ? (
                <Rail label="On this page" className="sticky top-10" items={sections.map((section) => ({ id: section.id, label: section.text }))} />
              ) : null}
            </div>
            <div className="min-w-0 max-w-[44rem]">
              <Prose blocks={entry.body} />
            </div>
          </div>
        </article>

        <Onward entry={entry} />
      </main>
    </Subpage>
  )
}
