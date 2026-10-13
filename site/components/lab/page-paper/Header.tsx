"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"

import { AppleIcon } from "@/components/icons"
import { Wordmark } from "@/components/Wordmark"

import s from "./paper.module.css"

/**
 * The running head. A book carries the chapter's name at the top of every page; this one carries the
 * section the reader is in, beside the way out (Features, Changelog, Download), which stays on screen
 * the whole length of the page. At the top it is just the page's head; once the page moves it settles
 * on the paper with a rule under it.
 */
export function Header({ href }: { href: string }) {
  const ref = useRef<HTMLElement>(null)
  const [section, setSection] = useState<string | null>(null)
  const [moved, setMoved] = useState(false)

  useEffect(() => {
    let frame = 0
    const read = () => {
      frame = 0
      setMoved(window.scrollY > 8)
      // The running head is the last section whose top has passed under the bar.
      const line = (ref.current?.offsetHeight ?? 64) + 24
      let current: string | null = null
      for (const node of document.querySelectorAll<HTMLElement>("[data-running-head]")) {
        if (node.getBoundingClientRect().top <= line) current = node.dataset.runningHead ?? null
      }
      setSection(current)
    }
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    window.addEventListener("scroll", queue, { passive: true })
    window.addEventListener("resize", queue)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", queue)
      window.removeEventListener("resize", queue)
    }
  }, [])

  return (
    <header
      ref={ref}
      data-moved={moved ? "" : undefined}
      className="group/head sticky top-0 z-50 transition-[background-color,box-shadow] duration-300 ease-[var(--ease-out-strong)] data-[moved]:bg-page/90 data-[moved]:shadow-[0_1px_0_var(--color-line)] data-[moved]:backdrop-blur-md"
    >
      <div className={`${s.measure} flex h-16 items-center gap-6`}>
        <Link href="/" className="shrink-0 text-ink transition-opacity duration-150 hover:opacity-70">
          <Wordmark />
        </Link>
        <p aria-live="off" className={`${s.note} hidden min-w-0 truncate text-ink-2 md:block`}>
          {section ? (
            <>
              <span aria-hidden className="mr-3 inline-block h-px w-6 translate-y-[-3px] bg-line-strong" />
              {section}
            </>
          ) : null}
        </p>
        <nav aria-label="Site" className="ml-auto flex items-center gap-1">
          <Link
            href="/features"
            className="hidden min-h-11 items-center rounded-[10px] px-3 text-[14px] text-ink-2 transition-colors duration-150 hover:text-ink sm:inline-flex"
          >
            Features
          </Link>
          <Link
            href="/changelog"
            className="hidden min-h-11 items-center rounded-[10px] px-3 text-[14px] text-ink-2 transition-colors duration-150 hover:text-ink sm:inline-flex"
          >
            Changelog
          </Link>
          <a href={href} className={`${s.download} ml-2 !min-h-10 !px-4 !text-[14px]`}>
            <AppleIcon className="h-3.5 w-3.5 -translate-y-px" />
            Download
          </a>
        </nav>
      </div>
    </header>
  )
}
