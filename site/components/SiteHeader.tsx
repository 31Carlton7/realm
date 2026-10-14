import { FloatingHeader } from "@/components/FloatingHeader"
import { macDownload } from "@/lib/release"

/**
 * The site's chrome, on every page including the landing one.
 *
 * `width` takes the container of whatever it is sitting above: the index is a wide list, an entry is
 * a reading column, and at the top of a page the wordmark starts on the same edge as the content
 * under it, or it reads as a second, misaligned page. Scrolled, the bar draws in to a capsule of its
 * own width, which belongs to no column. `floating` marks the landing page, whose flight is long
 * enough that the capsule also says how far through it the reader is.
 */
export async function SiteHeader({ width = "max-w-5xl", floating = false }: { width?: string; floating?: boolean }) {
  const download = await macDownload()
  return <FloatingHeader width={width} flight={floating} download={download.href} />
}
