import Link from "next/link"

import { ArrowIcon } from "@/components/icons"
import { formatDate, isWithdrawn, shortTitle, type Entry, type Release } from "@/lib/changelog"

/**
 * The releases, newest first, each with the changes that shipped in it, a hairline between them.
 *
 * A release's head is one link, to its notes: the date, its name, and its summary, which is the part
 * a reader scanning the page actually reads. The changes under it are quieter rows, one line each,
 * every one its own link: the title says what changed, the area where.
 */
export function ReleaseList({ releases, unreleased }: { releases: Release[]; unreleased: Entry[] }) {
  return (
    <div className="min-w-0">
      {unreleased.length > 0 ? (
        <section className="border-t border-line py-10 sm:py-12">
          <h2 className="text-[15px] font-[500] text-ink">Not in a release yet</h2>
          <Changes entries={unreleased} />
        </section>
      ) : null}
      <ol>
        {releases.map((release) => (
          <li key={release.slug} id={release.slug} className="scroll-mt-10 border-t border-line py-10 sm:py-14">
            <article>
              <ReleaseHead release={release} />
              {release.changes.length > 0 ? (
                <section aria-label={`Changes in ${release.version}`} className="mt-8">
                  <h3 className="text-[13px] text-ink-2">
                    {release.changes.length} {release.changes.length === 1 ? "change" : "changes"} shipped in {release.version}
                  </h3>
                  <Changes entries={release.changes} />
                </section>
              ) : null}
            </article>
          </li>
        ))}
      </ol>
    </div>
  )
}

function ReleaseHead({ release }: { release: Release }) {
  const withdrawn = isWithdrawn(release)
  return (
    <div className="group relative">
      <p className="font-mono text-[13px] text-ink-2">
        <time dateTime={release.date}>{formatDate(release.date)}</time>
        {withdrawn ? <span className="text-orange"> · Withdrawn</span> : null}
      </p>
      <h2 id={`${release.slug}-title`} className="mt-2.5 text-[clamp(1.75rem,2.6vw,2.25rem)] leading-[1.1] font-[500] tracking-[-0.04em] text-balance text-ink">
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

/** A release's changes (or those not in one yet), each its own link. */
function Changes({ entries }: { entries: Entry[] }) {
  return (
    <ul className="-mx-3 mt-3">
      {entries.map((entry) => (
        <li key={entry.slug}>
          <Link
            href={`/changelog/${entry.slug}`}
            className="row-link flex min-h-10 items-baseline justify-between gap-6 rounded-[8px] px-3 py-2 [--row-hover:var(--color-surface)]"
          >
            <span className="min-w-0 text-[15px] leading-[1.45] text-ink">{entry.title}</span>
            <span className="shrink-0 text-[13px] text-ink-2">{entry.area}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
