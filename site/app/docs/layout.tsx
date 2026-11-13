import { DocsNav } from "@/components/docs/DocsNav"
import { Subpage } from "@/components/landing/Subpage"
import { groups } from "@/lib/docs"

/**
 * Every docs page: the site's header and foot round a two-column field, the docs' map in a narrow
 * column on the left and the page beside it. The map is the layout's, so it stays where it is while
 * the reader moves from page to page; on a phone it folds into one control at the head of the page.
 *
 * The space is the header's band alone: a manual is read for minutes at a time, and design.md asks
 * the docs for quiet navigation rather than drama, so the reading sits on plain navy.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const nav = groups.map((group) => ({ title: group.title, pages: group.pages.map(({ slug, title }) => ({ slug, title })) }))
  return (
    <Subpage current="docs">
      <div className="mx-auto grid w-full max-w-[1240px] grid-cols-1 px-5 sm:px-7 lg:grid-cols-[14.5rem_minmax(0,1fr)] lg:gap-x-12 lg:pt-6 xl:gap-x-16">
        <aside className="docs-nav-scroll min-w-0 lg:sticky lg:-mx-1 lg:px-1 lg:top-10 lg:max-h-[calc(100dvh-5rem)] lg:self-start lg:overflow-y-auto lg:pb-10">
          <DocsNav groups={nav} />
        </aside>
        <main id="content" className="min-w-0 pt-8 lg:pt-0">
          {children}
        </main>
      </div>
    </Subpage>
  )
}
