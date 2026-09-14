import Link from "next/link"

import { AppleIcon } from "@/components/icons"
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
export async function SiteHeader({ width = "max-w-5xl" }: { width?: string }) {
  const download = await macDownload()

  return (
    <header
      className={`mx-auto flex w-full items-center justify-between gap-4 px-6 py-4 sm:px-10 ${width}`}
    >
      <Link href="/" className="text-ink transition-opacity duration-150 hover:opacity-75">
        <Wordmark />
      </Link>
      {/* The two places worth going, between the name and the action. Quiet: the download is the
          page's one primary, and a row of equal-weight controls is what design.md refuses. */}
      <nav aria-label="Sections" className="ml-auto mr-1 hidden items-center gap-1 sm:flex">
        <HeaderLink href="/features">Features</HeaderLink>
        <HeaderLink href="/changelog">Changelog</HeaderLink>
      </nav>
      <a
        href={download.href}
        className="app-corner inline-flex min-h-11 items-center gap-2 rounded-[20px] bg-accent px-4.5 py-2.5 text-[14px] font-[500] text-white shadow-[inset_0_1px_0_oklch(1_0_0/0.16)] transition-[scale,background-color] duration-150 ease-out hover:bg-accent-ink active:scale-[0.96]"
      >
        <AppleIcon className="h-4 w-4" />
        Download for Mac
      </a>
    </header>
  )
}

function HeaderLink({ href, children }: { href: "/features" | "/changelog"; children: string }) {
  return (
    <Link
      href={href}
      className="app-corner inline-flex min-h-11 items-center rounded-[20px] px-3 text-[14px] text-ink-2 transition-colors duration-150 hover:bg-surface hover:text-ink"
    >
      {children}
    </Link>
  )
}
