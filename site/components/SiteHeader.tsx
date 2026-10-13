import Link from "next/link"

import { DownloadButton } from "@/components/Buttons"
import { FloatingHeader } from "@/components/FloatingHeader"
import { Wordmark } from "@/components/Wordmark"
import { macDownload } from "@/lib/release"

/**
 * The site's chrome, on every page including the landing one.
 *
 * The landing page used to carry its own corner links instead, which worked while it was a single
 * screen: there was nowhere to scroll away to. It is a sequence of sections now, so the way out has
 * to stay reachable from anywhere in it rather than sit at the bottom of the first viewport.
 *
 * `width` takes the container of whatever it is sitting above: the index is a wide list, an entry is
 * a reading column, and a wordmark that does not start on the same edge as the content under it
 * reads as a second, misaligned page.
 */
export async function SiteHeader({ width = "max-w-5xl", floating = false }: { width?: string; floating?: boolean }) {
  const download = await macDownload()

  const header = (
    <header
      className={`mx-auto flex w-full items-center justify-between gap-4 ${floating ? "px-4 py-2 sm:px-6" : "px-6 py-4 sm:px-10"} ${width}`}
    >
      <Link href="/" className="text-ink transition-opacity duration-150 hover:opacity-75">
        <Wordmark />
      </Link>
      {/* The one place worth going besides the download, between the name and the action. Quiet: the
          download is the page's one primary, and a row of equal-weight controls is what design.md refuses. */}
      <nav aria-label="Sections" className="ml-auto mr-1 hidden items-center gap-1 sm:flex">
        <HeaderLink href="/changelog">Changelog</HeaderLink>
      </nav>
      <DownloadButton href={download.href} />
    </header>
  )
  // The landing page is long enough to need its way out on screen everywhere; the other pages are not.
  return floating ? <FloatingHeader>{header}</FloatingHeader> : header
}

function HeaderLink({ href, children }: { href: "/changelog"| "/changelog"; children: string }) {
  return (
    <Link
      href={href}
      className="app-corner inline-flex min-h-11 items-center rounded-[14px] px-3 text-[14px] text-ink-2 transition-colors duration-150 hover:bg-surface hover:text-ink"
    >
      {children}
    </Link>
  )
}
