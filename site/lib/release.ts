import { releasesUrl, site } from "@/lib/site"

/** The systems a release has a build for, in the order the page lists them. */
export type Platform = "mac" | "windows" | "linux"

export type Downloads = {
  /** `v2.4.0`, or null when the current release could not be established. Never guessed. */
  version: string | null
  /** Each build's file when GitHub answered and the release has one, the releases page otherwise. */
  mac: string
  windows: string
  /** The AppImage: one file that runs on any distribution, so it is what Linux's button gets. */
  linux: string
  /** The Debian package, for those who would rather install through apt. */
  deb: string
}

const FALLBACK: Downloads = { version: null, mac: releasesUrl, windows: releasesUrl, linux: releasesUrl, deb: releasesUrl }

/**
 * The current release's builds, asked of GitHub rather than pinned here.
 *
 * Every file is named for its version (`Realm-2.4.0-arm64.dmg`, `Realm-Setup-2.4.0.exe`), so there is
 * no fixed URL that always points at the newest one — `/releases/latest/download/<name>` needs the
 * name. Resolving them at render keeps the buttons from going stale a release after someone last
 * edited this file.
 *
 * Cached for an hour: Next 16 does not cache `fetch` unless asked, and an uncached call here would
 * put every visitor against GitHub's 60-per-hour unauthenticated limit. A failure — rate limit,
 * network — falls back to the releases page for every build, and a release missing one build sends
 * only that build there, which is always true.
 */
export async function downloads(): Promise<Downloads> {
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
    const asset = (suffix: string) =>
      release.assets?.find((file) => file.name?.endsWith(suffix))?.browser_download_url ?? releasesUrl

    return {
      version: release.tag_name ?? null,
      mac: asset(".dmg"),
      windows: asset(".exe"),
      linux: asset(".AppImage"),
      deb: asset(".deb"),
    }
  } catch {
    return FALLBACK
  }
}
