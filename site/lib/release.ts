import { releasesUrl, site } from "@/lib/site"

export type MacDownload = {
  /** Where the button points. The disk image itself when GitHub answered, the releases page otherwise. */
  href: string
  /** `v0.6.0`, or null when the current release could not be established. Never guessed. */
  version: string | null
}

const FALLBACK: MacDownload = { href: releasesUrl, version: null }

/**
 * The current macOS build, asked of GitHub rather than pinned here.
 *
 * The disk image is named for its version (`Realm-0.6.0-arm64.dmg`), so there is no fixed URL that
 * always points at the newest one — `/releases/latest/download/<name>` needs the name. Resolving it
 * at render keeps the button from going stale a release after someone last edited this file.
 *
 * Cached for an hour: Next 16 does not cache `fetch` unless asked, and an uncached call here would
 * put every visitor against GitHub's 60-per-hour unauthenticated limit. A failure — rate limit,
 * network, a release with no disk image — falls back to the releases page, which is always true.
 */
export async function macDownload(): Promise<MacDownload> {
  const repo = new URL(site.repo).pathname.replace(/^\/|\/$/g, "")
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "force-cache",
      next: { revalidate: 3600 },
    })
    if (!response.ok) return FALLBACK

    const release = (await response.json()) as {
      tag_name?: string
      assets?: { name?: string; browser_download_url?: string }[]
    }
    const dmg = release.assets?.find((asset) => asset.name?.endsWith(".dmg"))
    if (!dmg?.browser_download_url) return FALLBACK

    return { href: dmg.browser_download_url, version: release.tag_name ?? null }
  } catch {
    return FALLBACK
  }
}
