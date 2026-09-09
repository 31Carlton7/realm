import type { Metadata } from "next"

import { ChangelogList, type ListItem } from "@/components/changelog/ChangelogList"
import { SiteHeader } from "@/components/SiteHeader"
import { changelog, formatDate } from "@/lib/changelog"

export const metadata: Metadata = {
  title: "Changelog",
  description: "Everything that has shipped in Realm, newest first.",
}

export default function ChangelogPage() {
  const items: ListItem[] = changelog.map((entry) => ({
    slug: entry.slug,
    title: entry.title,
    area: entry.area,
    version: entry.version,
    summary: entry.summary,
    date: entry.date,
    displayDate: formatDate(entry.date),
  }))

  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-5xl px-6 pt-10 pb-28 sm:px-10 sm:pt-16">
        <div className="pl-6 sm:pl-10">
          <h1 className="text-[clamp(2rem,5vw,2.75rem)] leading-[1.05] font-[560] tracking-[-0.035em] text-ink">
            Changelog
          </h1>
          <p className="mt-4 max-w-[38rem] text-[16px] leading-[1.6] text-ink-2">
            Everything that has shipped in Realm, newest first — from the first commits in August to
            whatever landed this week.
          </p>
        </div>

        <ChangelogList items={items} />
      </main>
    </>
  )
}
