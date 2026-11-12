import { groups, unlisted } from "@/content/docs"
import type { Block, DocGroup, DocPage } from "@/lib/docs-blocks"
import crops from "@/public/docs/crops.json"
import captured from "@/public/product/manifest.json"
import parts from "@/public/product/parts.json"

/**
 * The docs: pages written as typed blocks, the way the changelog's entries are (lib/changelog.ts),
 * and for the same reason. The site sits outside the workspace's test projects, so a union the
 * compiler checks is worth more than a Markdown parser nobody can test, and a page that names a
 * capture or another page that does not exist fails the build rather than shipping a hole.
 *
 * A page is a module in content/docs/, built from the constructors in lib/docs-blocks.ts; the groups
 * and their order are content/docs/index.ts.
 */

/* ───────────────────────────── reading the docs ───────────────────────────── */

/** Every page in reading order, which is the nav's order: prev and next follow it. */
export const docs: DocPage[] = groups.flatMap((group) => group.pages)

/** Every page that is built: the listed ones, then the unlisted (content/docs/index.ts). The routes
 *  prerender these and a slug resolves against them; the nav, the docs home and prev/next read `docs`. */
export const allDocs: DocPage[] = [...docs, ...unlisted]

export const isUnlisted = (slug: string): boolean => unlisted.some((doc) => doc.slug === slug)

export { groups }
export type { Block, DocGroup, DocPage, Shot } from "@/lib/docs-blocks"

export const docBySlug = (slug: string): DocPage | undefined => allDocs.find((doc) => doc.slug === slug)

export const groupOf = (slug: string): DocGroup | undefined => groups.find((group) => group.pages.some((doc) => doc.slug === slug))

/** The pages either side of one in reading order. */
export function neighbours(slug: string): { previous?: DocPage; next?: DocPage } {
  const index = docs.findIndex((doc) => doc.slug === slug)
  if (index < 0) return {}
  return { previous: docs[index - 1], next: docs[index + 1] }
}

/** The plain words of a line that may carry spans: what a heading's id and the outline are made from. */
export const plainText = (text: string) =>
  text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[\[(.+?)\]\](?!\])/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")

const slugify = (text: string) =>
  plainText(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section"

export type Heading = { index: number; id: string; text: string; level: 2 | 3 }

/** A page's headings, each with an id unique on the page, so a heading can be linked to and listed. */
export function headings(blocks: Block[]): Heading[] {
  const seen = new Map<string, number>()
  const out: Heading[] = []
  blocks.forEach((block, index) => {
    if (block.kind !== "h2" && block.kind !== "h3") return
    const base = slugify(block.text)
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    out.push({ index, id: count === 1 ? base : `${base}-${count}`, text: plainText(block.text), level: block.kind === "h2" ? 2 : 3 })
  })
  return out
}

/* ───────────────────────────── the build's checks ───────────────────────────── */

const scenes = new Set(captured as string[])
const partNames = new Set(Object.keys(parts))
const cropNames = new Set(Object.keys(crops))

/** Every string a block carries, for the link check. */
const texts = (block: Block): string[] => {
  switch (block.kind) {
    case "ul":
    case "steps":
      return block.items
    case "table":
      return [...block.head, ...block.rows.flat()]
    case "figure":
      return [block.caption]
    case "code":
      return []
    default:
      return [block.text]
  }
}

/**
 * Refuse, at build, a docs page that would ship broken: a slug used twice, a link to a docs page or
 * a heading that is not there, or a figure whose capture was never taken. Run once, when this module
 * is first read, which every docs route does.
 */
function check() {
  const slugs = new Set<string>()
  const ids = new Map<string, Set<string>>()
  for (const doc of allDocs) {
    if (slugs.has(doc.slug)) throw new Error(`docs: the slug "${doc.slug}" is used twice`)
    slugs.add(doc.slug)
    ids.set(doc.slug, new Set(headings(doc.body).map((h) => h.id)))
  }
  for (const doc of allDocs) {
    for (const block of doc.body) {
      if (block.kind === "figure") {
        const shot = block.shot
        if ("scene" in shot && !scenes.has(shot.scene)) throw new Error(`docs/${doc.slug}: no capture named "${shot.scene}" in public/product/manifest.json`)
        if ("part" in shot && !partNames.has(shot.part)) throw new Error(`docs/${doc.slug}: no part named "${shot.part}" in public/product/parts.json`)
        if ("crop" in shot && !cropNames.has(shot.crop)) throw new Error(`docs/${doc.slug}: no crop named "${shot.crop}" in public/docs/crops.json`)
      }
      for (const text of texts(block)) {
        for (const [, target] of text.matchAll(/\]\((\/docs[^)]*)\)/g)) {
          const [path, hash] = target!.split("#")
          const slug = path!.replace(/^\/docs\/?/, "")
          if (slug === "") continue
          if (!slugs.has(slug)) throw new Error(`docs/${doc.slug}: links to /docs/${slug}, which is not a page`)
          if (hash && !ids.get(slug)!.has(hash)) throw new Error(`docs/${doc.slug}: links to /docs/${slug}#${hash}, which is not a heading there`)
        }
      }
    }
  }
}

check()
