import type { StaticImageData } from "next/image"

import { entries } from "@/content/changelog"

/**
 * The blocks a changelog entry is built from.
 *
 * A closed set rather than Markdown: the entries are written in this repository, by hand, and a
 * union the compiler checks is worth more here than a parser nobody can test — the site sits
 * outside the workspace's vitest projects, so a hand-rolled Markdown reader would ship unverified.
 * Inline `code` and **bold** are the two spans that survive, handled in `Prose`.
 *
 * A figure is a capture of the app, imported rather than named by path: the import carries the
 * picture's own size, and a picture that is not there fails the build instead of shipping a hole in
 * a release note. The caption says what is IN the frame, and the alt says it to someone who cannot
 * see the frame.
 */
export type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "note"; text: string }
  | { kind: "figure"; image: StaticImageData; alt: string; caption: string }

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

const shortFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

/** `2026-09-08` → `Sep 8`, for a rail of dates that all fall in one year. */
export function formatShortDate(date: string): string {
  return shortFormatter.format(new Date(`${date}T00:00:00Z`))
}

/**
 * A release, with the entries that shipped in it.
 *
 * Which release a change shipped in is read from reading order: a change belongs to the nearest
 * release above it in `changelog`, the first one tagged on or after the day it landed, with the
 * content file's own order deciding a day that holds both (v0.4.0 and the eight changes it lists all
 * landed on Sep 1). Every release body that names its changes agrees with this. A change newer than
 * the newest release has no release yet, and is listed on its own.
 */
export type Release = Entry & { version: string; changes: Entry[] }

function group(): { releases: Release[]; unreleased: Entry[] } {
  const list: Release[] = []
  const unreleased: Entry[] = []
  for (const entry of changelog) {
    if (entry.version) list.push({ ...entry, version: entry.version, changes: [] })
    else if (list.length > 0) list.at(-1)!.changes.push(entry)
    else unreleased.push(entry)
  }
  return { releases: list, unreleased }
}

const grouped = group()

/** Every release, newest first, each with its changes newest first; and any change not yet released. */
export const releases: Release[] = grouped.releases
export const unreleased: Entry[] = grouped.unreleased

/** The release an entry shipped in: itself for a release, the release above it for a change. */
export function releaseOf(slug: string): Release | undefined {
  return releases.find((release) => release.slug === slug || release.changes.some((change) => change.slug === slug))
}

/** The releases either side of one in reading order: newer first, so `newer` is the one above. */
export function releaseNeighbours(slug: string): { newer?: Release; older?: Release } {
  const index = releases.findIndex((release) => release.slug === slug)
  if (index < 0) return {}
  return { newer: releases[index - 1], older: releases[index + 1] }
}

/** A release's name on a page that is already Realm's: `Realm v0.5.1: signed and notarized` → `v0.5.1: signed and notarized`. */
export function shortTitle(entry: Entry): string {
  return entry.version ? entry.title.replace(/^Realm\s+/, "") : entry.title
}

/** A release that was pulled says so in a note that opens with the word; its realm stands dark. */
export function isWithdrawn(entry: Entry): boolean {
  return entry.body.some((block) => block.kind === "note" && /^Withdrawn\b/.test(block.text))
}

/** The plain words of a line that may carry `code` and **bold** spans. */
export const plainText = (text: string) => text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1")

/**
 * An entry's sections: one per heading, each with an id unique in the entry, so a heading can be
 * linked to and listed. `Fixed` twice in one entry becomes `fixed` and `fixed-2`.
 */
export function outline(blocks: Block[]): { index: number; id: string; text: string }[] {
  const seen = new Map<string, number>()
  const out: { index: number; id: string; text: string }[] = []
  blocks.forEach((block, index) => {
    if (block.kind !== "h") return
    const text = plainText(block.text)
    const base =
      text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "section"
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    out.push({ index, id: count === 1 ? base : `${base}-${count}`, text })
  })
  return out
}
