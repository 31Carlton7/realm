"use client"

import type { Route } from "next"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"

/** The nav's shape, which the server hands over: titles and slugs only, never a page's body. */
export type NavGroup = { title: string; pages: { slug: string; title: string }[] }

/**
 * The docs' own map: every page under its group, in reading order, with the one being read marked.
 *
 * Beside the page from 1024px, in a column that stays put while the page scrolls. Below that there is
 * no column to give it, so it folds into one control at the head of the page that names where the
 * reader is and opens the whole map in place; following a link folds it again.
 *
 * The marking is the changelog's rail (components/changelog/Rail): a hairline down the list with the
 * accent's tick against the current row, so the site has one way of saying "you are here".
 */
export function DocsNav({ groups }: { groups: NavGroup[] }) {
  const path = usePathname() ?? ""
  const current = path.replace(/^\/docs\/?/, "")
  // Open on the page it was opened on, so a link followed from it lands on a page with it folded.
  const [openOn, setOpenOn] = useState<string | null>(null)
  const open = openOn === path
  const here = groups.flatMap((group) => group.pages).find((doc) => doc.slug === current)

  return (
    <nav aria-label="Docs" className="min-w-0">
      <div className="lg:hidden">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="docs-map"
          onClick={() => setOpenOn(open ? null : path)}
          className="row-link flex min-h-12 w-full items-center justify-between gap-4 rounded-[12px] bg-canvas px-4 text-left [--row-hover:var(--color-surface)]"
        >
          <span className="min-w-0">
            <span className="block text-[13px] text-ink-2">Docs</span>
            <span className="block truncate text-[15px] text-ink">{here?.title ?? "Overview"}</span>
          </span>
          <Chevron open={open} />
        </button>
      </div>
      <div id="docs-map" className={`${open ? "block" : "hidden"} mt-3 pb-4 lg:mt-0 lg:block lg:pb-0`}>
        <Map groups={groups} current={current} />
      </div>
    </nav>
  )
}

function Map({ groups, current }: { groups: NavGroup[]; current: string }) {
  return (
    <div className="space-y-6">
      <ol className="relative border-l border-line">
        <Row href="/docs" label="Overview" here={current === ""} />
      </ol>
      {groups.map((group) => (
        <div key={group.title}>
          <h2 className="mb-1.5 text-[13px] font-[520] text-ink">{group.title}</h2>
          <ol className="relative border-l border-line">
            {group.pages.map((doc) => (
              <Row key={doc.slug} href={`/docs/${doc.slug}`} label={doc.title} here={doc.slug === current} />
            ))}
          </ol>
        </div>
      ))}
    </div>
  )
}

function Row({ href, label, here }: { href: string; label: string; here: boolean }) {
  return (
    <li className="relative">
      <span aria-hidden className={`absolute top-1/2 -left-px h-4 w-px -translate-y-1/2 bg-accent ${here ? "opacity-100" : "opacity-0"}`} />
      <Link
        href={href as Route}
        aria-current={here ? "page" : undefined}
        className={`flex min-h-11 items-center py-1.5 pl-4 text-[15px] leading-[1.35] transition-colors duration-150 ease-out hover:text-ink hover:duration-220 hover:ease-spring lg:min-h-9 lg:text-[14px] ${here ? "text-ink" : "text-ink-2"}`}
      >
        <span className="min-w-0 text-pretty">{label}</span>
      </Link>
    </li>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={`h-4 w-4 shrink-0 text-ink-2 transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}
