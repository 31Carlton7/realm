"use client"

import Link from "next/link"
import { useEffect, useRef } from "react"

import { DownloadButton } from "@/components/Buttons"
import { Wordmark } from "@/components/Wordmark"
import type { MacDownload } from "@/lib/release"

import { onScrollFrame } from "./frames"

/**
 * The way out, on screen everywhere: the name, Features and Changelog, and the download. At the top
 * of the page it is the page's own chrome with nothing behind it; once the page moves it sits on a
 * plate of the page's colour with a hairline under it, so the window the camera moves never shows
 * through behind its words. Opaque rather than frosted: glass over the product is the thing to refuse.
 */
export function Header({ download }: { download: MacDownload }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    let scrolled: boolean | null = null
    return onScrollFrame(() => {
      const now = window.scrollY > 8
      if (now === scrolled) return
      scrolled = now
      if (now) node.dataset.scrolled = ""
      else delete node.dataset.scrolled
    })
  }, [])

  return (
    <header
      ref={ref}
      className="group/head fixed inset-x-0 top-0 z-50 transition-[background-color,box-shadow] duration-300 ease-[var(--ease-out-strong)] data-[scrolled]:bg-page data-[scrolled]:shadow-[inset_0_-1px_0_var(--color-line)]"
    >
      <div data-light-words data-light-pad="28" className="mx-auto flex h-16 w-full max-w-[1680px] items-center gap-4 px-6 sm:px-10 lg:px-14">
        <Link href="/" className="text-ink transition-opacity duration-150 hover:opacity-75">
          <Wordmark />
        </Link>
        <nav aria-label="Site" className="mr-1 ml-auto hidden items-center gap-1 sm:flex">
          <HeaderLink href="/features">Features</HeaderLink>
          <HeaderLink href="/changelog">Changelog</HeaderLink>
        </nav>
        <div className="ml-auto sm:ml-0">
          <DownloadButton href={download.href} />
        </div>
      </div>
    </header>
  )
}

function HeaderLink({ href, children }: { href: "/features" | "/changelog"; children: string }) {
  return (
    <Link
      href={href}
      className="app-corner inline-flex min-h-11 items-center rounded-[14px] px-3 text-[14px] text-ink-2 transition-colors duration-150 hover:bg-surface hover:text-ink"
    >
      {children}
    </Link>
  )
}
