import { DocsNav } from "@/components/docs/DocsNav"
import { SiteFooter } from "@/components/SiteFooter"
import { SiteHeader } from "@/components/SiteHeader"
import { groups } from "@/lib/docs"

/**
 * Every docs page: the site's header and footer round a two-column field, the docs' map in a narrow
 * column on the left and the page beside it. The map is the layout's, so it stays where it is while
 * the reader moves from page to page; on a phone it folds into one control at the head of the page.
 *
 * The docs sit on the page's own ground, not the landing page's sky: a manual is read for minutes at
 * a time, and design.md asks the docs for quiet navigation rather than drama.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const nav = groups.map((group) => ({ title: group.title, pages: group.pages.map(({ slug, title }) => ({ slug, title })) }))
  return (
    <div className="relative min-h-[100dvh]">
      <SiteHeader width="max-w-[92rem]" />
      <div className="mx-auto grid w-full max-w-[92rem] grid-cols-1 px-6 pt-2 sm:px-10 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-x-12 lg:pt-10 xl:gap-x-16">
        <aside className="min-w-0 lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7rem)] lg:self-start lg:overflow-y-auto lg:pb-10">
          <DocsNav groups={nav} />
        </aside>
        <main id="content" className="min-w-0 pt-8 lg:pt-0">
          {children}
        </main>
      </div>
      <SiteFooter />
    </div>
  )
}
