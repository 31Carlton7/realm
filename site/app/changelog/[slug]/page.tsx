import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Arrival } from "@/components/changelog/Field"
import { Onward } from "@/components/changelog/Onward"
import { Prose } from "@/components/changelog/Prose"
import { Rail } from "@/components/changelog/Rail"
import { ArrowIcon } from "@/components/icons"
import { PassageLink } from "@/components/passage/PassageLink"
import { FieldPanel } from "@/components/realms/FieldPanel"
import { SiteFooter } from "@/components/SiteFooter"
import { SiteHeader } from "@/components/SiteHeader"
import { changelog, entryBySlug, formatDate, isWithdrawn, outline, releaseOf, releases } from "@/lib/changelog"

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
 * One entry. It opens in a band where the release it belongs to stands in the field, and walks up to
 * that realm's doorway as the reader scrolls into the notes; the field is the band's alone, and stops
 * when the band has gone. Then the notes, in a reading column, with a map of their sections beside a
 * long one, and the way on: the releases either side, or the release a change shipped in.
 */
export default async function ChangelogEntryPage({ params }: Params) {
  const { slug } = await params
  const entry = entryBySlug(slug)
  if (!entry) notFound()

  const release = releaseOf(slug)
  const index = release ? releases.indexOf(release) : 0
  const sections = outline(entry.body)
  const withdrawn = isWithdrawn(entry)

  return (
    <div className="relative min-h-[100dvh]">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-20 bg-[#03050b]" />
      <SiteHeader width="max-w-[92rem]" />

      <main>
        <article aria-labelledby="entry-title">
          {/* The band reaches up under the header, so the sky is behind the bar as it is on the landing page. */}
          <header className="relative -mt-[72px] pt-[72px]">
            <Arrival release={index} total={releases.length} dark={release ? isWithdrawn(release) : false} />
            <div className="mx-auto grid w-full max-w-[92rem] grid-cols-1 px-6 pt-6 pb-16 sm:px-10 sm:pt-10 lg:min-h-[min(62vh,38rem)] lg:grid-cols-[minmax(0,36rem)_1fr] lg:items-end lg:gap-x-16 lg:pt-20 lg:pb-20 xl:grid-cols-[10rem_minmax(0,40rem)_1fr]">
              {/* Where the realm stands. On a phone it stands over the words; beside them otherwise. */}
              <div
                aria-hidden
                data-field-anchor="s:door"
                className="mx-auto h-44 w-40 sm:h-52 lg:order-2 lg:mx-0 lg:mb-4 lg:h-[clamp(11rem,26vh,15rem)] lg:w-[min(100%,16rem)] lg:justify-self-center"
              />
              <FieldPanel anchor="c:title" wrapClassName="mt-8 min-w-0 lg:order-1 lg:mt-0 xl:col-start-2" className="px-6 py-6 sm:px-8 sm:py-7">
                <PassageLink
                  href="/changelog"
                  passage="surface"
                  release={index}
                  className="-ml-1 inline-flex min-h-10 items-center gap-2 rounded-[8px] px-1 text-[14px] text-ink-2 transition-colors duration-150 ease-out hover:text-ink hover:duration-220 hover:ease-spring"
                >
                  <ArrowIcon className="nudge h-3.5 w-3.5 rotate-180 [--nudge:-3px]" />
                  <span className="link-line">Changelog</span>
                </PassageLink>
                <p className="mt-4 font-mono text-[13px] text-ink-2">
                  <time dateTime={entry.date}>{formatDate(entry.date)}</time>
                  {entry.version ? null : ` · ${entry.area}`}
                  {withdrawn ? <span className="text-orange"> · Withdrawn</span> : null}
                </p>
                <h1 id="entry-title" className="mt-3 text-[clamp(2.1rem,3.6vw,3rem)] leading-[1.04] font-[580] tracking-[-0.042em] text-balance text-ink">
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
              </FieldPanel>
            </div>
          </header>

          <div className="mx-auto grid w-full max-w-[92rem] grid-cols-1 px-6 sm:px-10 xl:grid-cols-[10rem_minmax(0,40rem)] xl:gap-x-16 [--figure-room:100%] lg:[--figure-room:min(58rem,calc(100vw-5rem))] xl:[--figure-room:min(58rem,calc(100vw-21rem))]">
            <div className="hidden xl:block">
              {sections.length >= MAP_FROM ? (
                <Rail label="On this page" className="sticky top-28" items={sections.map((section) => ({ id: section.id, label: section.text }))} />
              ) : null}
            </div>
            <div className="min-w-0 max-w-[40rem]">
              <Prose blocks={entry.body} />
            </div>
          </div>
        </article>

        <Onward entry={entry} />
      </main>

      <SiteFooter />
    </div>
  )
}
