import Link from "next/link"

import { DownloadButton } from "@/components/Buttons"
import { FloatingHeader } from "@/components/FloatingHeader"
import { Wordmark } from "@/components/Wordmark"

/**
 * The page's chrome: the name, the two ways out, and the download, kept on screen over a long page
 * (the site's own floating plate, which sits clear of the words under it once the page has moved).
 */
export function Header({ href }: { href: string }) {
  return (
    <FloatingHeader>
      <header className="mx-auto flex w-full max-w-[90rem] items-center justify-between gap-4 px-4 py-2 sm:px-6">
        <Link href="/" className="text-ink transition-opacity duration-150 hover:opacity-75">
          <Wordmark />
        </Link>
        <nav aria-label="Sections" className="mr-1 ml-auto hidden items-center gap-1 sm:flex">
          <Link
            href="/features"
            className="app-corner inline-flex min-h-11 items-center rounded-[14px] px-3 text-[14px] text-ink-2 transition-colors duration-150 hover:bg-surface hover:text-ink"
          >
            Features
          </Link>
          <Link
            href="/changelog"
            className="app-corner inline-flex min-h-11 items-center rounded-[14px] px-3 text-[14px] text-ink-2 transition-colors duration-150 hover:bg-surface hover:text-ink"
          >
            Changelog
          </Link>
        </nav>
        <DownloadButton href={href} />
      </header>
    </FloatingHeader>
  )
}
