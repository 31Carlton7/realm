import Link from "next/link"

import { AppleIcon } from "@/components/icons"
import { Wordmark } from "@/components/Wordmark"
import { macDownload } from "@/lib/release"

/**
 * The only chrome on the site, and only on the changelog. The landing page has none — it is one
 * screen with its own corners — so this exists to answer "where am I" and "how do I get back".
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
