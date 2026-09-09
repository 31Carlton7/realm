import { entries } from "@/content/changelog"

/**
 * The blocks a changelog entry is built from.
 *
 * A closed set rather than Markdown: the entries are written in this repository, by hand, and a
 * union the compiler checks is worth more here than a parser nobody can test — the site sits
 * outside the workspace's vitest projects, so a hand-rolled Markdown reader would ship unverified.
 * Inline `code` and **bold** are the two spans that survive, handled in `Prose`.
 */
export type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "note"; text: string }

export type Entry = {
  /** URL segment. Stable once published — these are linkable. */
  slug: string
  title: string
  /** `YYYY-MM-DD`, the day the work landed on the branch it shipped from. */
  date: string
  /** Set only where the entry IS a release. A feature that shipped inside one does not claim a tag. */
  version?: string
  area: "Release" | "Agents" | "Interface" | "Workspace" | "Documents" | "Browser" | "Platform"
  /** One or two sentences. This is what the list shows, so it has to stand on its own. */
  summary: string
  body: Block[]
}

/** Newest first. The content file is authored in that order; this pins it rather than trusting it. */
export const changelog: Entry[] = [...entries].sort((a, b) => b.date.localeCompare(a.date))

export function entryBySlug(slug: string): Entry | undefined {
  return changelog.find((entry) => entry.slug === slug)
}

/** The entries either side of `slug` in reading order — newer first, so `newer` is the one above. */
export function neighbours(slug: string): { newer?: Entry; older?: Entry } {
  const index = changelog.findIndex((entry) => entry.slug === slug)
  if (index < 0) return {}
  return { newer: changelog[index - 1], older: changelog[index + 1] }
}

const formatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
})

/** `2026-09-08` → `Sep 8, 2026`. Fixed to UTC so the date never shifts under the reader's clock. */
export function formatDate(date: string): string {
  return formatter.format(new Date(`${date}T00:00:00Z`))
}
