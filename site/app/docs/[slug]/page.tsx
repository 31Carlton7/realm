import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { Rail } from "@/components/changelog/Rail"
import { DocsProse } from "@/components/docs/DocsProse"
import { inline } from "@/components/docs/inline"
import { PrevNext } from "@/components/docs/PrevNext"
import { docBySlug, docs, groupOf, headings, neighbours } from "@/lib/docs"

type Params = { params: Promise<{ slug: string }> }

export function generateStaticParams() {
  return docs.map((doc) => ({ slug: doc.slug }))
}

export const dynamicParams = false

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params
  const doc = docBySlug(slug)
  if (!doc) return {}
  return {
    title: doc.title,
    description: doc.summary,
    alternates: { canonical: `/docs/${doc.slug}` },
    openGraph: { type: "article", title: `${doc.title} · Realm docs`, description: doc.summary, url: `/docs/${doc.slug}` },
    twitter: { card: "summary_large_image", title: `${doc.title} · Realm docs`, description: doc.summary },
  }
}

/**
 * One docs page: its group and title, the lede, the body, and the way on. Beside a wide page, a map of
 * its sections that marks the one being read (the changelog's rail); on a narrower one the same map
 * folds under the lede, where it is one tap rather than a column.
 */
export default async function DocPage({ params }: Params) {
  const { slug } = await params
  const doc = docBySlug(slug)
  if (!doc) notFound()

  const group = groupOf(slug)
  const sections = headings(doc.body).filter((heading) => heading.level === 2)
  const { previous, next } = neighbours(slug)

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,44rem)_12.5rem] xl:justify-between xl:gap-x-12">
      <article aria-labelledby="doc-title" className="min-w-0 max-w-[44rem]">
        <header className="mb-12">
          {group ? <p className="text-[14px] text-ink-2">{group.title}</p> : null}
          <h1 id="doc-title" className="mt-2 text-[clamp(2.1rem,3.4vw,2.75rem)] leading-[1.06] font-[580] tracking-[-0.042em] text-balance text-ink">
            {doc.title}
          </h1>
          <p className="mt-4 max-w-[62ch] text-[18px] leading-[1.6] text-pretty text-ink-2">{inline(doc.summary)}</p>
          {sections.length >= 2 ? (
            <details className="group mt-7 rounded-[12px] bg-canvas xl:hidden">
              <summary className="row-link flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 rounded-[12px] px-4 text-[14px] text-ink-2 [--row-hover:var(--color-surface)] [&::-webkit-details-marker]:hidden">
                On this page
                <span aria-hidden className="text-ink-3 transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none">
                  ›
                </span>
              </summary>
              <ol className="px-4 pb-3">
                {sections.map((section) => (
                  <li key={section.id}>
                    <a href={`#${section.id}`} className="flex min-h-10 items-center text-[15px] text-ink-2 hover:text-ink">
                      {section.text}
                    </a>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </header>
        <DocsProse blocks={doc.body} />
        <PrevNext previous={previous ?? "home"} next={next} />
      </article>
      <div className="hidden xl:block">
        {sections.length >= 2 ? (
          <div className="sticky top-24">
            <p aria-hidden className="mb-2 text-[13px] font-[520] text-ink">
              On this page
            </p>
            <Rail label="On this page" items={sections.map((section) => ({ id: section.id, label: section.text }))} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
