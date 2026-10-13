import Link from "next/link"

import { ArrowIcon } from "@/components/icons"
import { FieldPanel } from "@/components/realms/FieldPanel"
import { formatDate, isWithdrawn, shortTitle, type Entry, type Release } from "@/lib/changelog"

/**
 * The releases, newest first, each on a pane of the sky with the changes that shipped in it.
 *
 * A release's head is one link, to its notes: the date, its name, and its summary, which is the part
 * a reader scanning the page actually reads. The head is the block the walk arrives at (`k:<r>`), and
 * the walk stays at that release while the rest of its pane (`r:<r>`) is read. The changes under it
 * are quieter rows, one line each, every one its own link: the title says what changed, the area where.
 */
export function ReleaseList({ releases, unreleased }: { releases: Release[]; unreleased: Entry[] }) {
  return (
    <div data-field-anchor="c:list" className="min-w-0">
      {unreleased.length > 0 ? (
        <FieldPanel as="section" anchor="c:unreleased" wrapClassName="mb-10 lg:mb-[clamp(4rem,12vh,7rem)]" className="p-6 sm:p-8">
          <h2 className="text-[15px] font-[560] text-ink">Not in a release yet</h2>
          <Changes entries={unreleased} />
        </FieldPanel>
      ) : null}
      <ol className="space-y-10 lg:space-y-[clamp(4rem,14vh,8rem)]">
        {releases.map((release, r) => (
          <li key={release.slug} id={release.slug} className="scroll-mt-28">
            <FieldPanel as="article" anchor={`r:${r}`} className="p-6 sm:p-8">
              <ReleaseHead release={release} index={r} />
              {release.changes.length > 0 ? (
                <section aria-label={`Changes in ${release.version}`} className="mt-8">
                  <h3 className="text-[13px] text-ink-2">
                    {release.changes.length} {release.changes.length === 1 ? "change" : "changes"} shipped in {release.version}
                  </h3>
                  <Changes entries={release.changes} />
                </section>
              ) : null}
            </FieldPanel>
          </li>
        ))}
      </ol>
    </div>
  )
}

function ReleaseHead({ release, index }: { release: Release; index: number }) {
  const withdrawn = isWithdrawn(release)
  return (
    <div data-field-anchor={`k:${index}`} className="group relative">
      <p className="font-mono text-[13px] text-ink-2">
        <time dateTime={release.date}>{formatDate(release.date)}</time>
        {withdrawn ? <span className="text-orange"> · Withdrawn</span> : null}
      </p>
      <h2 id={`${release.slug}-title`} className="mt-2.5 text-[clamp(1.75rem,2.4vw,2.125rem)] leading-[1.1] font-[580] tracking-[-0.035em] text-balance text-ink">
        <Link
          href={`/changelog/${release.slug}`}
          className="rounded-[8px] outline-offset-4 after:absolute after:inset-0 after:content-[''] focus-visible:outline-2"
        >
          {shortTitle(release)}
        </Link>
      </h2>
      <p className="mt-3.5 max-w-[60ch] text-[17px] leading-[1.6] text-ink-2">{release.summary}</p>
      <p aria-hidden className="mt-4 inline-flex items-center gap-1.5 text-[14px] text-accent-ink">
        <span className="link-line">Read the notes</span>
        <ArrowIcon className="nudge h-3.5 w-3.5" />
      </p>
    </div>
  )
}

function Changes({ entries }: { entries: Entry[] }) {
  return (
    <ul className="-mx-3 mt-3">
      {entries.map((entry) => (
        <li key={entry.slug}>
          <Link
            href={`/changelog/${entry.slug}`}
            className="row-link flex min-h-10 items-baseline justify-between gap-6 rounded-[8px] px-3 py-2"
          >
            <span className="min-w-0 text-[15px] leading-[1.45] text-ink">{entry.title}</span>
            <span className="shrink-0 text-[13px] text-ink-2">{entry.area}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
