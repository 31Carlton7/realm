/**
 * Fails the build when the landing page names any release but the newest one in the changelog.
 *
 * `pnpm build` runs this after `next build`, and `vercel deploy` runs `pnpm build`, so a page that has
 * drifted never ships. It reads the page Next rendered rather than its source, so it catches a version
 * typed anywhere on the page, not only in the badge, and it asks nothing of the network.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** The changelog's newest release, by the rule `lib/changelog.ts` sorts by: date, then authored order. */
export function newestRelease(source) {
  const entries = source.split(/^ {2}\{$/m).slice(1)
  const releases = entries.flatMap((entry) => {
    const field = (name) => entry.match(new RegExp(`^ {4}${name}: "([^"]+)"`, "m"))?.[1]
    const version = field("version")
    return version ? [{ version, slug: field("slug"), date: field("date") }] : []
  })
  return releases.reduce((newest, release) => (release.date > newest.date ? release : newest))
}

/** Every release the page's words name: `v2.8.3`, or `Realm 2.1`. Scripts and attributes aren't words. */
export function namedVersions(html) {
  const words = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")
  return [...words.matchAll(/\bv(\d+\.\d+(?:\.\d+)?)\b|\bRealm (\d+\.\d+(?:\.\d+)?)\b/g)].map((m) => m[1] ?? m[2])
}

export function driftIn(html, newest) {
  const version = newest.version.replace(/^v/, "")
  const problems = []
  if (!html.includes(`href="/changelog/${newest.slug}"`)) problems.push(`no link to /changelog/${newest.slug}`)
  const badge = html.match(/font-mono text-\[12px\] text-accent-ink[^>]*>([^<]+)</)?.[1]
  if (badge !== version) problems.push(`the badge says ${badge ?? "nothing"}`)
  for (const named of namedVersions(html)) if (named !== version) problems.push(`the page names ${named}`)
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const newest = newestRelease(fs.readFileSync(path.join(site, "content/changelog.ts"), "utf8"))
  const problems = driftIn(fs.readFileSync(path.join(site, ".next/server/app/index.html"), "utf8"), newest)
  if (problems.length > 0) {
    console.error(`The landing page has drifted from the changelog's newest release, ${newest.version}:`)
    for (const problem of new Set(problems)) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`The landing page says ${newest.version}, the changelog's newest release.`)
}
