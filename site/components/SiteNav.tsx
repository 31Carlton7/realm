"use client"

import Link from "next/link"
import { useEffect, useState } from "react"

import { GitHubIcon } from "@/components/icons"
import { Wordmark } from "@/components/Wordmark"
import { nav, site } from "@/lib/site"

/**
 * Sticky nav. Transparent over the hero and backed once the page scrolls, so the hero's canvas runs
 * edge to edge but the links stay legible over whatever section is behind them.
 */
export function SiteNav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  // A menu left open while the viewport widens into the desktop layout would otherwise stay mounted
  // and unreachable, trapping the page's scroll lock with it.
  useEffect(() => {
    if (!open) return
    const media = window.matchMedia("(min-width: 768px)")
    const close = () => setOpen(false)
    media.addEventListener("change", close)
    return () => media.removeEventListener("change", close)
  }, [open])

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-colors duration-300 ${
        scrolled || open ? "border-b border-line bg-page/80 backdrop-blur-xl" : "border-b border-transparent"
      }`}
    >
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6" aria-label="Main">
        <Link href="/" className="text-ink transition-opacity hover:opacity-80">
          <Wordmark />
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-[14px] text-ink-2 transition-colors hover:text-ink"
            >
              {item.label}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <a
            href={site.repo}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-2 rounded-full border border-line px-3.5 py-1.5 text-[13px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
          >
            <GitHubIcon className="h-3.5 w-3.5" />
            GitHub
          </a>
          <Link
            href="/docs"
            className="rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-page transition-opacity hover:opacity-90"
          >
            Read the docs
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
          className="-mr-2 grid h-10 w-10 place-items-center rounded-lg text-ink-2 transition-colors hover:text-ink md:hidden"
        >
          <svg viewBox="0 0 20 20" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5">
            {open ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3 6h14M3 13h14" />}
          </svg>
        </button>
      </nav>

      {open ? (
        <div className="border-t border-line px-6 py-4 md:hidden">
          <div className="flex flex-col gap-1">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-2 py-2.5 text-[15px] text-ink-2 transition-colors hover:bg-surface hover:text-ink"
              >
                {item.label}
              </Link>
            ))}
            <a
              href={site.repo}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-lg px-2 py-2.5 text-[15px] text-ink-2 transition-colors hover:bg-surface hover:text-ink"
            >
              GitHub
            </a>
          </div>
        </div>
      ) : null}
    </header>
  )
}
