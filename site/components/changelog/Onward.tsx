import Link from "next/link"

import { ArrowIcon } from "@/components/icons"
import { formatDate, releaseNeighbours, releaseOf, shortTitle, type Entry } from "@/lib/changelog"

/**
 * The way on from an entry, under its notes.
 *
 * From a release: the changes that shipped in it, then the releases either side of it. From a change:
 * the release it shipped in, and the changes either side of it in that release. Newer is on the left
 * and older on the right, the way the index reads down.
 */
export function Onward({ entry }: { entry: Entry }) {
  const release = releaseOf(entry.slug)
  if (!release) return null

  if (entry.version) {
    const { newer, older } = releaseNeighbours(release.slug)
    return (
      <Shell label="More releases">
        {release.changes.length > 0 ? (
          <section aria-labelledby="shipped-title" className="mb-14">
            <h2 id="shipped-title" className="text-[15px] font-[560] text-ink">
              {release.changes.length} {release.changes.length === 1 ? "change" : "changes"} shipped in {release.version}
            </h2>
            <ul className="-mx-3 mt-3">
              {release.changes.map((change) => (
                <li key={change.slug}>
                  <Link
                    href={`/changelog/${change.slug}`}
                    className="flex min-h-10 items-baseline justify-between gap-6 rounded-[8px] px-3 py-2 transition-colors duration-150 hover:bg-surface"
                  >
                    <span className="min-w-0 text-[15px] leading-[1.45] text-ink">{change.title}</span>
                    <span className="shrink-0 text-[13px] text-ink-2">{change.area}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <Pair
          newer={newer ? { entry: newer, label: "Newer release" } : undefined}
          older={older ? { entry: older, label: "Older release" } : undefined}
        />
      </Shell>
    )
  }

  const index = release.changes.findIndex((change) => change.slug === entry.slug)
  const newer = release.changes[index - 1]
  const older = release.changes[index + 1]
  return (
    <Shell label="More in this release">
      <Link
        href={`/changelog/${release.slug}`}
        className="group mb-3 block rounded-[12px] bg-canvas p-5 transition-colors duration-200 hover:bg-surface sm:p-6"
      >
        <span className="text-[13px] text-ink-2">Shipped in</span>
        <span className="mt-1.5 flex items-center gap-2 text-[17px] leading-[1.35] font-[560] text-ink">
          {shortTitle(release)}
          <ArrowIcon className="h-3.5 w-3.5 text-ink-2 transition-transform duration-300 ease-[var(--ease-out-strong)] group-hover:translate-x-0.5" />
        </span>
        <span className="mt-1 block font-mono text-[13px] text-ink-2">{formatDate(release.date)}</span>
        <span className="mt-3 block text-[15px] leading-[1.55] text-ink-2">{release.summary}</span>
      </Link>
      <Pair
        newer={newer ? { entry: newer, label: `Newer in ${release.version}` } : undefined}
        older={older ? { entry: older, label: `Older in ${release.version}` } : undefined}
      />
    </Shell>
  )
}

function Shell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <nav aria-label={label} className="mx-auto mt-24 grid w-full max-w-[92rem] grid-cols-1 px-6 sm:px-10 xl:grid-cols-[10rem_minmax(0,40rem)] xl:gap-x-16">
      <div className="min-w-0 border-t border-line pt-12 xl:col-start-2">{children}</div>
    </nav>
  )
}

type Side = { entry: Entry; label: string }

function Pair({ newer, older }: { newer?: Side; older?: Side }) {
  if (!newer && !older) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {newer ? <Neighbour side={newer} direction="newer" /> : <span aria-hidden className="hidden sm:block" />}
      {older ? <Neighbour side={older} direction="older" /> : null}
    </div>
  )
}

function Neighbour({ side, direction }: { side: Side; direction: "newer" | "older" }) {
  const { entry, label } = side
  return (
    <Link
      href={`/changelog/${entry.slug}`}
      className={`group flex flex-col rounded-[12px] bg-canvas p-5 transition-colors duration-200 hover:bg-surface sm:p-6 ${direction === "older" ? "sm:items-end sm:text-right" : ""}`}
    >
      <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
        {direction === "newer" ? (
          <ArrowIcon className="h-3.5 w-3.5 rotate-180 transition-transform duration-300 ease-[var(--ease-out-strong)] group-hover:-translate-x-0.5" />
        ) : null}
        {label}
        {direction === "older" ? (
          <ArrowIcon className="h-3.5 w-3.5 transition-transform duration-300 ease-[var(--ease-out-strong)] group-hover:translate-x-0.5" />
        ) : null}
      </span>
      <span className="mt-2 text-[17px] leading-[1.35] font-[560] text-ink">{shortTitle(entry)}</span>
      <span className="mt-1 font-mono text-[13px] text-ink-2">{formatDate(entry.date)}</span>
    </Link>
  )
}
