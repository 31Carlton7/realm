import type { StaticImageData } from "next/image"

/**
 * What a docs page is made of, and the small constructors content/docs/ writes pages with, so a page
 * reads close to the prose it holds. Kept apart from lib/docs.ts, which reads content/docs: the pages
 * import these, and a module that both imported the pages and was imported by them would hand each
 * page its constructors before they existed.
 *
 * Inline spans, in any text: `code`, **bold**, [a link](/docs/sessions), and keys as [[⌘⇧P]] (each
 * modifier its own key; a space separates keys, as in [[⌃ Tab]]).
 */

/**
 * What a figure shows: a whole-window scene of the capture manifest, a part of the window
 * (public/product/parts.json), one of the docs' own crops (public/docs/crops.json, cut by
 * scripts/docs-crops.mjs), or one of the changelog's crops, imported from public/product/details.
 */
export type Shot = { scene: string } | { part: string } | { crop: string } | { detail: StaticImageData }

export type Block =
  | { kind: "p"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "steps"; items: string[] }
  | { kind: "code"; text: string; label?: string }
  | { kind: "callout"; tone: "note" | "tip" | "careful"; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "figure"; shot: Shot; alt: string; caption: string }

export type DocPage = {
  /** URL segment under /docs. Stable once published: these are linked to. */
  slug: string
  title: string
  /** One or two sentences: the page's lede, its share card and the docs home's row. */
  summary: string
  body: Block[]
}

export type DocGroup = { title: string; pages: DocPage[] }

/* ───────────────────────────── constructors, for content/docs ───────────────────────────── */

export const page = (doc: DocPage): DocPage => doc
export const p = (text: string): Block => ({ kind: "p", text })
export const h2 = (text: string): Block => ({ kind: "h2", text })
export const h3 = (text: string): Block => ({ kind: "h3", text })
export const ul = (...items: string[]): Block => ({ kind: "ul", items })
export const steps = (...items: string[]): Block => ({ kind: "steps", items })
export const code = (text: string, label?: string): Block => ({ kind: "code", text, label })
export const note = (text: string): Block => ({ kind: "callout", tone: "note", text })
export const tip = (text: string): Block => ({ kind: "callout", tone: "tip", text })
export const careful = (text: string): Block => ({ kind: "callout", tone: "careful", text })
export const table = (head: string[], ...rows: string[][]): Block => ({ kind: "table", head, rows })
export const figure = (shot: Shot, alt: string, caption: string): Block => ({ kind: "figure", shot, alt, caption })
