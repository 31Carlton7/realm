import { Landing } from "@/components/landing/Landing"
import { latestRelease } from "@/lib/changelog"
import { downloads } from "@/lib/release"

/**
 * The landing page: deep navy space with one opening onto a world, then each section in one of the
 * worlds Realm opens new sessions onto (components/landing). The version it names is the changelog's
 * newest, which scripts/check-release-drift.mjs holds it to.
 */
export default async function HomePage() {
  return (
    <Landing
      downloads={await downloads()}
      version={latestRelease.version.replace(/^v/, "")}
      changelog={latestRelease.slug}
    />
  )
}
