"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useRef } from "react"

import { DownloadButton } from "@/components/Buttons"
import { GitHubIcon } from "@/components/icons"
import { Wordmark } from "@/components/Wordmark"
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
 * the accent's light drawn from left to right. The changelog's link says when it is the page shown.
 */
export function FloatingHeader({ width, flight, download }: { width: string; flight: boolean; download: string }) {
  const rootRef = useRef<HTMLElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const brandRef = useRef<HTMLAnchorElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const path = usePathname()
  const onChangelog = path?.startsWith("/changelog") ?? false

  useEffect(() => {
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
      // The capsule: its two ends, the plate's inset on either side, and a gap between them.
      compact = Math.min(wide, brand.offsetWidth + actions.offsetWidth + 18 + 6 + 40)
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

  return (
    <header ref={rootRef} className="sticky top-0 z-50 h-[72px] [--flight:0] [--p:0]">
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
              <div className="h-full w-full origin-left scale-x-[var(--flight)] bg-[linear-gradient(to_right,oklch(0.788_0.113_248.33/0.15),oklch(0.788_0.113_248.33/0.75))]" />
            </div>
          ) : null}
          <Link ref={brandRef} href="/" className="relative shrink-0 rounded-[8px] text-ink transition-opacity duration-150 hover:opacity-75">
            <Wordmark />
          </Link>
          <div className="min-w-0 flex-1" />
          <div ref={actionsRef} className="relative flex shrink-0 items-center gap-1">
            <nav aria-label="Site" className="flex items-center gap-1">
              <Link
                href="/changelog"
                aria-current={onChangelog ? "page" : undefined}
                className={`app-corner inline-flex min-h-11 items-center rounded-[14px] px-3.5 text-[14px] transition-colors duration-150 hover:bg-white/[0.06] hover:text-ink ${onChangelog ? "bg-white/[0.06] text-ink" : "text-ink-2"}`}
              >
                Changelog
              </Link>
              <a
                href={site.repo}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Realm on GitHub"
                className="app-corner hidden size-11 items-center justify-center rounded-[14px] text-ink-2 transition-colors duration-150 hover:bg-white/[0.06] hover:text-ink sm:inline-flex"
              >
                <GitHubIcon className="h-[18px] w-[18px]" />
              </a>
            </nav>
            <span className="ml-1 sm:hidden">
              <DownloadButton href={download} label="Download" />
            </span>
            <span className="ml-1 hidden sm:block">
              <DownloadButton href={download} />
            </span>
          </div>
        </div>
      </div>
    </header>
  )
}
