"use client"

import { useEffect, useState } from "react"

export type RailItem = { id: string; label: string; detail?: string }

/**
 * A page's own map, pinned beside its column: every release on the index, every section of a long
 * entry. The item whose part of the page is at the reading line is marked, and each is a link to it.
 *
 * Which one is current is asked of one IntersectionObserver watching a thin line two fifths down the
 * view, so nothing reads layout while the page scrolls. Between two parts the last one crossed stays
 * marked, which is where the reader still is.
 */
export function Rail({ items, label, className = "" }: { items: RailItem[]; label: string; className?: string }) {
  const [current, setCurrent] = useState(items[0]?.id)

  useEffect(() => {
    const nodes = items.map((item) => document.getElementById(item.id)).filter((node): node is HTMLElement => Boolean(node))
    if (nodes.length === 0) return
    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) if (record.isIntersecting) setCurrent(record.target.id)
      },
      { rootMargin: "-40% 0px -59% 0px" },
    )
    for (const node of nodes) observer.observe(node)
    return () => observer.disconnect()
  }, [items])

  return (
    <nav aria-label={label} className={className}>
      <ol className="relative border-l border-line">
        {items.map((item) => {
          const here = item.id === current
          return (
            <li key={item.id} className="relative">
              <span
                aria-hidden
                className={`absolute top-1/2 -left-px h-4 w-px -translate-y-1/2 bg-accent transition-opacity duration-200 ${here ? "opacity-100" : "opacity-0"}`}
              />
              <a
                href={`#${item.id}`}
                aria-current={here ? "location" : undefined}
                className={`flex min-h-10 items-center justify-between gap-4 py-2 pl-4 text-[13px] leading-[1.4] transition-colors duration-150 ease-out hover:text-ink hover:duration-220 hover:ease-spring ${here ? "text-ink" : "text-ink-2"}`}
              >
                <span className="min-w-0 text-pretty">{item.label}</span>
                {item.detail ? <span className="shrink-0 font-mono text-[12px] text-ink-2 tabular-nums">{item.detail}</span> : null}
              </a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
