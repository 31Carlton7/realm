import type { Metadata } from "next"

import { Walk } from "@/components/changelog/Field"
import { Rail } from "@/components/changelog/Rail"
import { ReleaseList } from "@/components/changelog/ReleaseList"
import { FieldPanel } from "@/components/realms/FieldPanel"
import { SiteFooter } from "@/components/SiteFooter"
import { SiteHeader } from "@/components/SiteHeader"
import { formatDate, formatShortDate, isWithdrawn, releases, unreleased } from "@/lib/changelog"

export const metadata: Metadata = {
  title: "Changelog",
  description: "Every release of Realm, newest first, with the changes that shipped in each.",
}

/**
 * The changelog: every release, newest first, as a walk up the landing page's sky. Each release is a
 * realm hanging in a row up the route, its doorway lit; scrolling walks the route beside them, and the
 * release whose card is being read is the realm the camera has come to. The list reads the same
 * without any of it.
 */
export default function ChangelogPage() {
  const avenue = releases.map((release) => ({ slug: release.slug, dark: isWithdrawn(release) }))
  const first = releases.at(-1)

  return (
    <div className="relative min-h-[100dvh]">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-20 bg-[#03050b]" />
      <SiteHeader width="max-w-[92rem]" />

      <main>
        <section aria-labelledby="changelog-title" className="relative">
          <Walk releases={avenue} />
          <div className="mx-auto w-full max-w-[92rem] px-6 pt-2 pb-12 sm:px-10 sm:pt-6 lg:pt-16 lg:pb-[clamp(4rem,14vh,8rem)] xl:pl-[calc(2.5rem+10rem+4rem)]">
            {/* On a narrow screen the releases hang over the title, in the band the sky is kept to. */}
            <div aria-hidden data-field-anchor="s:avenue" className="h-56 sm:h-64 lg:hidden" />
            <div data-field-anchor="c:hero" className="mt-4 max-w-[32rem] lg:mt-0">
              <h1 id="changelog-title" className="text-[clamp(2.5rem,4.4vw,3.5rem)] leading-[1] font-[580] tracking-[-0.045em] text-ink">
                Changelog
              </h1>
              <p className="mt-5 text-[17px] leading-[1.6] text-ink-2">Every release of Realm, newest first, with the changes that shipped in each.</p>
              {first ? (
                <p className="mt-5 font-mono text-[13px] text-ink-2">
                  {releases.length} releases since <time dateTime={first.date}>{formatDate(first.date)}</time>
                </p>
              ) : null}
            </div>
          </div>
        </section>

        <div className="mx-auto grid w-full max-w-[92rem] grid-cols-1 px-6 pb-32 sm:px-10 lg:grid-cols-[minmax(0,34rem)] xl:grid-cols-[10rem_minmax(0,34rem)] xl:gap-x-16">
          <div className="hidden xl:block">
            <FieldPanel anchor="c:rail" radius={12} wrapClassName="sticky top-24" className="px-3 py-2">
              <Rail label="Releases" items={releases.map((release) => ({ id: release.slug, label: release.version, detail: formatShortDate(release.date) }))} />
            </FieldPanel>
          </div>
          <ReleaseList releases={releases} unreleased={unreleased} />
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
