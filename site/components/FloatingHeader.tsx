"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useLayoutEffect, useRef, type FocusEvent, type PointerEvent } from "react"

import { DownloadButton } from "@/components/Buttons"
import { GitHubIcon } from "@/components/icons"
import { ChangelogLink, HomeLink } from "@/components/passage/ChangelogLink"
import { Wordmark } from "@/components/Wordmark"
import type { Downloads } from "@/lib/release"
import { site } from "@/lib/site"

/** How far the page scrolls while the bar draws in, in CSS px. */
const CONDENSE = 140

/**
 * The header as one object that changes with the scroll and never with the clock.
 *
 * At the top of a page it is the page's own chrome: no plate, the wordmark on the content's left edge
 * and the download on its right. Over the first 140px of scroll it draws in to a capsule of its own
 * width, centred, on a plate of frosted page colour with a hairline and light from above, a little
 * shorter, so what scrolls under it stays out of the way of its words. Every value is read from the
 * scroll position by one rAF-throttled reader; under reduced motion it is either state, never between.
 *
 * On the landing page the capsule's lower edge also carries the flight's progress, as a hairline of
 * the accent's light drawn from left to right. The docs' and the changelog's links say when theirs is
 * the page shown.
 *
 * The bar's links share one highlight (globals.css, `.nav-pill`) that glides to the link under the
 * pointer, or the one the keyboard is on; where it was hidden, it lands under that link and fades in.
 */
export function FloatingHeader({ width, flight, downloads }: { width: string; flight: boolean; downloads: Downloads }) {
  const rootRef = useRef<HTMLElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const brandRef = useRef<HTMLAnchorElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLSpanElement>(null)
  const path = usePathname()
  const onChangelog = path?.startsWith("/changelog") ?? false
  const onDocs = path?.startsWith("/docs") ?? false

  // Measured before the bar is first painted: a view transition captures a page arriving before its
  // passive effects run, and the bar would cross the view at its unmeasured width.
  useLayoutEffect(() => {
    const root = rootRef.current
    const frame = frameRef.current
    const bar = barRef.current
    const brand = brandRef.current
    const actions = actionsRef.current
    if (!root || !frame || !bar || !brand || !actions) return
    const still = window.matchMedia("(prefers-reduced-motion: reduce)")
    let wide = 0
    let compact = 0
    let queued = false

    const measure = () => {
      const style = getComputedStyle(frame)
      wide = frame.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      // The capsule: its two ends, the plate's inset on either side, and a gap between them. On a phone
      // that is wider than the column, and the capsule takes the room up to the window's inset.
      compact = Math.min(window.innerWidth - 16, brand.offsetWidth + actions.offsetWidth + 18 + 6 + 40)
    }
    const update = () => {
      queued = false
      const y = window.scrollY
      const t = Math.min(1, Math.max(0, y / CONDENSE))
      const p = still.matches ? (y > 8 ? 1 : 0) : t * t * (3 - 2 * t)
      root.style.setProperty("--p", p.toFixed(4))
      bar.style.width = `${(wide + (compact - wide) * p).toFixed(2)}px`
      if (flight) {
        const end = document.documentElement.scrollHeight - window.innerHeight
        root.style.setProperty("--flight", Math.min(1, Math.max(0, y / Math.max(end, 1))).toFixed(4))
      }
    }
    const onScroll = () => {
      if (queued) return
      queued = true
      requestAnimationFrame(update)
    }
    const onResize = () => {
      measure()
      update()
    }
    onResize()
    // The fonts arriving change the wordmark's width.
    void document.fonts?.ready.then(onResize)
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onResize)
    still.addEventListener("change", update)
    return () => {
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onResize)
      still.removeEventListener("change", update)
    }
  }, [flight])

  const light = (item: Element | null) => {
    const pill = pillRef.current
    if (!pill) return
    if (!(item instanceof HTMLElement)) {
      delete pill.dataset.on
      return
    }
    const arriving = pill.dataset.on === undefined
    if (arriving) pill.dataset.landing = ""
    pill.style.setProperty("--x", `${item.offsetLeft}px`)
    pill.style.setProperty("--w", `${item.offsetWidth}px`)
    if (arriving) {
      void pill.offsetWidth
      delete pill.dataset.landing
    }
    pill.dataset.on = ""
  }
  const onOver = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse") light((event.target as Element).closest("a"))
  }
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if (event.target.matches(":focus-visible")) light(event.target)
  }

  return (
    <header ref={rootRef} className="sticky top-0 z-50 h-[72px] [--flight:0] [--p:0] [view-transition-name:site-header]">
      <div ref={frameRef} className={`mx-auto h-full w-full px-6 sm:px-10 ${width}`}>
        <div
          ref={barRef}
          className="absolute top-1/2 left-1/2 flex h-[calc(64px-8px*var(--p))] max-w-[calc(100vw-16px)] -translate-x-1/2 -translate-y-1/2 items-center pr-[calc(6px*var(--p))] pl-[calc(18px*var(--p))]"
        >
          {/* The plate: frosted page colour, a hairline, light from above. Faded in, never cut in. */}
          <div
            aria-hidden
            className="app-corner pointer-events-none absolute inset-0 rounded-[20px] bg-page/72 opacity-[var(--p)] shadow-[inset_0_0_0_1px_oklch(1_0_0/0.085),inset_0_1px_0_oklch(1_0_0/0.07),0_10px_30px_-12px_oklch(0_0_0/0.7),0_2px_6px_-2px_oklch(0_0_0/0.4)] backdrop-blur-[22px] backdrop-saturate-[1.6] [@media(prefers-reduced-transparency:reduce)]:bg-page [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none"
          />
          {flight ? (
            <div aria-hidden className="pointer-events-none absolute inset-x-5 bottom-0 h-px overflow-hidden opacity-[var(--p)]">
              <div className="h-full w-full origin-left scale-x-[var(--flight)] bg-[linear-gradient(to_right,oklch(0.788_0.113_248.33/0.2),oklch(0.788_0.113_248.33/0.95))]" />
            </div>
          ) : null}
          <HomeLink
            ref={brandRef}
            className="relative flex shrink-0 items-center rounded-[8px] text-ink transition-opacity duration-150 ease-out hover:opacity-75 hover:duration-220 hover:ease-spring"
          >
            {/* On a phone narrower than 400px the bar cannot hold the name, two links and the download
                at the column's width, so the name gives way to the mark alone; it stays the link's name. */}
            <Wordmark nameClassName="max-[399px]:sr-only" />
          </HomeLink>
          <div className="min-w-0 flex-1" />
          <div ref={actionsRef} className="relative flex shrink-0 items-center gap-1">
            <nav
              aria-label="Site"
              onPointerOver={onOver}
              onPointerLeave={() => light(null)}
              onFocus={onFocus}
              onBlur={() => light(null)}
              className="relative flex items-center gap-1"
            >
              <span ref={pillRef} aria-hidden className="nav-pill" />
              <Link
                href="/docs"
                aria-current={onDocs ? "page" : undefined}
                className={`nav-link app-corner relative inline-flex min-h-11 items-center rounded-[14px] px-3 text-[14px] sm:px-3.5 ${onDocs ? "bg-white/[0.06] text-ink" : "text-ink-2"}`}
              >
                Docs
              </Link>
              <ChangelogLink
                aria-current={onChangelog ? "page" : undefined}
                className={`nav-link app-corner relative inline-flex min-h-11 items-center rounded-[14px] px-3 text-[14px] sm:px-3.5 ${onChangelog ? "bg-white/[0.06] text-ink" : "text-ink-2"}`}
              >
                Changelog
              </ChangelogLink>
              <a
                href={site.repo}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Realm on GitHub"
                className="nav-link app-corner relative hidden size-11 items-center justify-center rounded-[14px] text-ink-2 sm:inline-flex"
              >
                <GitHubIcon className="h-[18px] w-[18px]" />
              </a>
            </nav>
            <span className="ml-1 sm:hidden">
              <DownloadButton downloads={downloads} compact />
            </span>
            <span className="ml-1 hidden sm:block">
              <DownloadButton downloads={downloads} />
            </span>
          </div>
        </div>
      </div>
    </header>
  )
}
