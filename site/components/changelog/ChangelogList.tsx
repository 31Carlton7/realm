"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"

import { ArrowIcon } from "@/components/icons"

/** What the list needs. Deliberately not the whole entry — the bodies would ride along in the payload. */
export type ListItem = {
  slug: string
  title: string
  area: string
  version?: string
  summary: string
  /** Already formatted on the server, so the list does not ship a date formatter to the client. */
  displayDate: string
  /** The machine-readable date, for `<time datetime>`. */
  date: string
}

const STEP = 8

/**
 * The entries, revealed a page at a time, under one date marker per day.
 *
 * The date is a property of the day, not of each entry: eleven cards from the 8th used to repeat the
 * 8th eleven times down the left margin, which reads as noise rather than as a timeline. Grouping
 * puts it on the rail once and lets the rail carry the sequence.
 *
 * All of them are in the payload already — they are static content, not a query — so "load more" is
 * a slice rather than a fetch, and there is no spinner to design. Focus moves to the first newly
 * revealed entry: the button sits below the list, so leaving focus on it would strand a keyboard
 * reader underneath everything that just appeared.
 */
export function ChangelogList({ items }: { items: ListItem[] }) {
  const [count, setCount] = useState(STEP)
  const anchors = useRef(new Map<number, HTMLAnchorElement | null>())
  const pendingFocus = useRef<number | null>(null)

  useEffect(() => {
    const index = pendingFocus.current
    if (index === null) return
    pendingFocus.current = null
    anchors.current.get(index)?.focus()
  }, [count])

  const visible = items.slice(0, count)
  const remaining = items.length - visible.length

  // Grouped after slicing, so a day the reader has only half of still gets its marker.
  const groups: { date: string; displayDate: string; entries: { item: ListItem; index: number }[] }[] = []
  visible.forEach((item, index) => {
    const last = groups.at(-1)
    if (last?.date === item.date) last.entries.push({ item, index })
    else groups.push({ date: item.date, displayDate: item.displayDate, entries: [{ item, index }] })
  })

  return (
    <>
      <ol className="mt-14 border-l border-line pl-6 sm:pl-10">
        {groups.map((group) => (
          <li key={group.date} className="relative pb-10 last:pb-0">
            <span
              aria-hidden
              className="absolute top-[0.6rem] -left-6 h-px w-4 bg-line-strong sm:-left-10 sm:w-7"
            />
            <time dateTime={group.date} className="font-mono text-[13px] text-ink-3">
              {group.displayDate}
            </time>

            <div className="mt-4 flex flex-col gap-3">
              {group.entries.map(({ item, index }) => (
                <article
                  key={item.slug}
                  className="group relative rounded-xl bg-canvas p-6 transition-colors duration-200 hover:bg-surface sm:p-7"
                >
                  <p className="font-mono text-[12px] text-ink-3">
                    {item.version ? `${item.area} · ${item.version}` : item.area}
                  </p>
                  <h2 className="mt-2.5 text-[20px] leading-[1.3] font-[560] tracking-[-0.022em] text-ink">
                    <Link
                      href={`/changelog/${item.slug}`}
                      ref={(node) => {
                        anchors.current.set(index, node)
                      }}
                      className="after:absolute after:inset-0 after:rounded-xl after:content-['']"
                    >
                      {item.title}
                    </Link>
                  </h2>
                  <p className="mt-2 max-w-[46rem] text-[15px] leading-[1.6] text-ink-2">
                    {item.summary}
                  </p>
                  <span className="mt-4 inline-flex items-center gap-1.5 text-[13px] text-accent-ink">
                    Read more
                    <ArrowIcon className="h-3.5 w-3.5 transition-transform duration-300 ease-[var(--ease-out-strong)] group-hover:translate-x-0.5" />
                  </span>
                </article>
              ))}
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-12 pl-6 sm:pl-10">
        {remaining > 0 ? (
          <button
            type="button"
            onClick={() => {
              pendingFocus.current = count
              setCount((shown) => shown + STEP)
            }}
            className="app-corner inline-flex min-h-11 items-center rounded-[20px] bg-surface px-4.5 py-2.5 text-[14px] text-ink-2 shadow-[inset_0_1px_0_oklch(1_0_0/0.07)] transition-[scale,background-color,color] duration-150 ease-out hover:bg-raised hover:text-ink active:scale-[0.96]"
          >
            Load more
          </button>
        ) : null}
        <p aria-live="polite" className="mt-4 font-mono text-[12px] text-ink-3">
          {visible.length} of {items.length} entries
        </p>
      </div>
    </>
  )
}
