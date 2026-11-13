import type { Metadata } from "next"

import { Rail } from "@/components/changelog/Rail"
import { ReleaseList } from "@/components/changelog/ReleaseList"
import { Subpage } from "@/components/landing/Subpage"
import { formatDate, formatShortDate, releases, unreleased } from "@/lib/changelog"

export const metadata: Metadata = {
  title: "Changelog",
  description: "Every release of Realm, newest first, with the changes that shipped in each.",
}

/**
 * The changelog: every release, newest first, on the landing page's navy. The title sits on the band
 * of space under the header; past it, an index of the releases pinned beside the list on a wide screen.
 */
export default function ChangelogPage() {
  const first = releases.at(-1)

  return (
    <Subpage
      current="changelog"
      head={
        <>
          <h1 id="changelog-title" className="text-[clamp(2.5rem,5vw,3.5rem)] leading-[1] font-[500] tracking-[-0.045em] text-ink">
            Changelog
          </h1>
          <p className="mt-5 text-[17px] leading-[1.6] text-ink-2">Every release of Realm, newest first, with the changes that shipped in each.</p>
          {first ? (
            <p className="mt-5 font-mono text-[13px] text-ink-2">
              {releases.length} releases since <time dateTime={first.date}>{formatDate(first.date)}</time>
            </p>
          ) : null}
        </>
      }
    >
      <main aria-labelledby="changelog-title" className="mx-auto grid w-full max-w-[1240px] grid-cols-1 px-5 pb-16 sm:px-7 xl:grid-cols-[10rem_minmax(0,44rem)] xl:gap-x-20">
        <div className="hidden xl:block">
          <Rail
            label="Releases"
            className="sticky top-10"
            items={releases.map((release) => ({ id: release.slug, label: release.version, detail: formatShortDate(release.date) }))}
          />
        </div>
        <ReleaseList releases={releases} unreleased={unreleased} />
      </main>
    </Subpage>
  )
}
