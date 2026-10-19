import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { ImageResponse } from "next/og"

import { DOCS_SUMMARY } from "@/content/docs"
import { entryBySlug, formatDate, isWithdrawn, releases, type Entry } from "@/lib/changelog"
import { docBySlug, docs, groupOf, plainText } from "@/lib/docs"
import metrics from "@/lib/og/fonts/metrics.json"
import { CARD, WORDS, skyFile, skyFor, type SkyName } from "@/lib/og/layout"

/**
 * The changelog's and the docs' share cards, drawn by next/og at build: the words set over a sky photographed from
 * the live field (lib/og/layout.ts, public/og), in the site's own faces (lib/og/fonts, derived by
 * scripts/og-fonts.py) and its own inks. The layout is the site card's (app/share): the wordmark at
 * the head of the words' box, and at its foot the entry as the changelog sets it, the date over the
 * version or title over the summary.
 */

/** The site's inks (app/globals.css), in hex: Satori reads no oklch. */
const INK = "#f2f3f4"
const INK_2 = "#a5a8ad"
const GROUND = "#03050b"

/** The headings' weight on the site is 580; Satori takes weights in hundreds, so that cut is 600 here. */
const HEADING = 600

// Every path below is spelled out from the site's root, so the build traces only these files into the
// server's output rather than the whole project.
let fonts: Promise<NonNullable<ConstructorParameters<typeof ImageResponse>[1]>["fonts"]> | undefined
const loadFonts = () =>
  (fonts ??= Promise.all([
    readFile(join(process.cwd(), "lib/og/fonts/Inter-400.ttf")),
    readFile(join(process.cwd(), "lib/og/fonts/Inter-580.ttf")),
    readFile(join(process.cwd(), "lib/og/fonts/JetBrainsMono-400.ttf")),
  ]).then(([regular, heading, mono]) => [
    { name: "Inter", data: regular, weight: 400, style: "normal" },
    { name: "Inter", data: heading, weight: HEADING, style: "normal" },
    { name: "JetBrains Mono", data: mono, weight: 400, style: "normal" },
  ]))

const dataUri = (type: string) => (bytes: Buffer) => `data:${type};base64,${bytes.toString("base64")}`
const skies = new Map<SkyName, Promise<string>>()
const loadSky = (name: SkyName) => {
  if (!skies.has(name)) skies.set(name, readFile(join(process.cwd(), "public/og", skyFile(name))).then(dataUri("image/jpeg")))
  return skies.get(name)!
}
let mark: Promise<string> | undefined
const loadMark = () => (mark ??= readFile(join(process.cwd(), "public/realm-mark.svg")).then(dataUri("image/svg+xml")))

/** The two Inter cuts' advances (scripts/og-fonts.py), which the words are measured by before Satori
 *  sets them, so a title takes the size that fits and a summary is cut where it fits. */
type Cut = "400" | "580"
const advance = (cut: Cut) => metrics[cut] as Record<string, number>

/** A line's width in px as Satori sets it: each character's advance at this size and the tracking after
 *  it. Kerning is left out: Inter's mostly tightens a line, and the box keeps 8 px in hand for the rest. */
function width(text: string, size: number, cut: Cut, tracking = 0): number {
  const table = advance(cut)
  let units = 0
  let count = 0
  for (const char of text) {
    units += table[char] ?? table["M"]!
    count++
  }
  return (units * size) / metrics.unitsPerEm + tracking * count
}

/** How many lines `text` takes in the words' box, broken at spaces the way Satori breaks them. */
function lineCount(text: string, size: number, cut: Cut, tracking = 0): number {
  const room = WORDS.width - 8
  let count = 1
  let line = ""
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word
    if (line && width(next, size, cut, tracking) > room) {
      count++
      line = word
    } else line = next
  }
  return count
}

const TITLE_LINE = 1.06
const TITLE_TRACKING = -0.045
/** The title's share of the words' box, under the wordmark, the date and two lines of summary. */
const TITLE_ROOM = 250
const LADDER = [96, 88, 80, 72, 66, 60, 56, 52, 48, 44, 40]

/**
 * A title's size: on one line if it fits there at a display size, else on two, else on three, each at
 * the largest size the box and the room under the wordmark take. Fewer lines beat a larger size: a
 * short title broken after its first word ("The / foundation") reads worse than the same words on one
 * line a step smaller. Satori balances the lines it is given (textWrap below).
 */
function titleSize(text: string): number {
  for (const [lines, smallest] of [
    [1, 64],
    [2, 56],
    [3, 40],
  ] as const) {
    for (const size of LADDER) {
      if (size < smallest) break
      if (lineCount(text, size, "580", TITLE_TRACKING * size) <= lines && lines * size * TITLE_LINE <= TITLE_ROOM) return size
    }
  }
  return LADDER.at(-1)!
}

/** A hyphen inside a word holds the word together: Satori would otherwise break "sign-in" after its
 *  hyphen, which the measuring above, breaking only at spaces, does not expect. */
const keepWords = (text: string) => text.replace(/(?<=\w)-(?=\w)/g, "\u2011")

const SUMMARY_SIZE = 26

/** Words a cut summary may not end on: "…the split glyph draws the…" stops mid-thought. */
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "its", "of", "on", "onto", "or", "the", "than", "that", "to", "with"])

/**
 * A summary short enough for two lines: whole if it fits; else its first sentences, if they fit and
 * fill a line; else cut at the latest end of a clause (a comma, a semicolon, a colon, a dash) that fits,
 * so the card stops between phrases rather than in one, unless that would leave the second line nearly
 * empty, when it is cut at the last word that fits and is not a small one.
 */
export function teaser(summary: string): string {
  const fits = (text: string) => lineCount(text, SUMMARY_SIZE, "400") <= 2
  const wide = (text: string, lines: number) => width(text, SUMMARY_SIZE, "400") > WORDS.width * lines
  if (fits(summary)) return summary
  let sentences: string | undefined
  for (const match of summary.matchAll(/[.!?](?=\s+[A-Z0-9])/g)) {
    const cut = summary.slice(0, match.index + 1)
    if (fits(cut)) sentences = cut
  }
  if (sentences && wide(sentences, 0.9)) return sentences
  const trim = (text: string) => `${text.replace(/[\s,;:.—–]+$/, "")}…`
  let clause: string | undefined
  for (const match of summary.matchAll(/[,;:](?=\s)|\s[—–](?=\s)/g)) {
    const cut = trim(summary.slice(0, match.index))
    if (fits(cut)) clause = cut
  }
  if (clause && wide(clause, 1.15)) return clause
  const words: string[] = []
  for (const word of summary.split(" ")) {
    if (!fits(trim([...words, word].join(" ")))) break
    words.push(word)
  }
  while (words.length > 1 && SMALL_WORDS.has(words.at(-1)!.toLowerCase())) words.pop()
  return trim(words.join(" "))
}

type Face = {
  sky: SkyName
  /** The word beside Realm's at the head, if any. */
  label?: string
  /** The line over the title, in mono. */
  meta: string
  title: string
  size: number
  /** A second line of title, smaller: a release's own name. */
  subtitle?: string
  summary: string
}

async function draw(input: Face) {
  const face = { ...input, title: keepWords(input.title), summary: keepWords(input.summary) }
  const [sky, markSrc, fontList] = await Promise.all([loadSky(face.sky), loadMark(), loadFonts()])
  return new ImageResponse(
    (
      <div style={{ display: "flex", position: "relative", width: CARD.width, height: CARD.height, backgroundColor: GROUND, fontFamily: "Inter", color: INK }}>
        <img src={sky} alt="" width={CARD.width} height={CARD.height} style={{ position: "absolute", left: 0, top: 0 }} />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            position: "absolute",
            left: WORDS.left,
            top: WORDS.top,
            width: WORDS.width,
            height: WORDS.height,
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <img src={markSrc} alt="" width={40} height={48} />
            <div style={{ display: "flex", marginLeft: 16, fontSize: 32, fontWeight: HEADING, letterSpacing: -0.64 }}>Realm</div>
            {face.label ? <div style={{ display: "flex", marginLeft: 12, fontSize: 32, color: INK_2, letterSpacing: -0.64 }}>{face.label}</div> : null}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontFamily: "JetBrains Mono", fontSize: 22, color: INK_2 }}>{face.meta}</div>
            <div
              style={{
                display: "flex",
                marginTop: 18,
                fontSize: face.size,
                fontWeight: HEADING,
                lineHeight: TITLE_LINE,
                letterSpacing: TITLE_TRACKING * face.size,
                textWrap: "balance",
              }}
            >
              {face.title}
            </div>
            {face.subtitle ? (
              <div style={{ display: "flex", marginTop: 10, fontSize: 40, fontWeight: HEADING, lineHeight: 1.1, letterSpacing: -1.6 }}>{face.subtitle}</div>
            ) : null}
            <div style={{ display: "block", lineClamp: 2, marginTop: 24, fontSize: SUMMARY_SIZE, lineHeight: 1.4, color: INK_2 }}>{teaser(face.summary)}</div>
          </div>
        </div>
      </div>
    ),
    { ...CARD, fonts: fontList },
  )
}

/** `Realm v0.5.1: signed and notarized` → the version, and the release's own name with its capital. */
function releaseName(entry: Entry & { version: string }): { title: string; subtitle?: string } {
  const named = entry.title.match(/^Realm\s+\S+:\s*(.+)$/)
  if (!named) return { title: entry.version }
  const name = named[1]!
  return { title: entry.version, subtitle: name.charAt(0).toUpperCase() + name.slice(1) }
}

/** An entry's card, or nothing for a slug the changelog does not have. */
export async function entryCard(slug: string): Promise<ImageResponse | null> {
  const entry = entryBySlug(slug)
  if (!entry) return null
  const withdrawn = isWithdrawn(entry)
  const date = formatDate(entry.date)
  if (entry.version) {
    const { title, subtitle } = releaseName({ ...entry, version: entry.version })
    return draw({ sky: skyFor(slug, withdrawn), label: "Changelog", meta: `${date} · ${withdrawn ? "Withdrawn" : "Release"}`, title, size: 136, subtitle, summary: entry.summary })
  }
  return draw({ sky: skyFor(slug, withdrawn), label: "Changelog", meta: `${date} · ${entry.area}`, title: entry.title, size: titleSize(keepWords(entry.title)), summary: entry.summary })
}

export const INDEX_SUMMARY = "Every release of Realm, newest first, with the changes that shipped in each."

/** The index's card: the changelog's own words over the row of releases. */
export function indexCard() {
  const first = releases.at(-1)
  return draw({
    sky: "index",
    meta: first ? `${releases.length} releases since ${formatDate(first.date)}` : "Releases",
    title: "Changelog",
    size: 120,
    summary: INDEX_SUMMARY,
  })
}

export const ENTRY_ALT =
  "A card from Realm's changelog: on the left, Realm's name, the entry's date and area, its version or title, and its summary; on the right, one of Realm's realms, a cube lying on its side with its doorway lit, hanging in a blue nebula with more realms going away behind it."

export const indexAlt = () => {
  const first = releases.at(-1)
  return `Realm's changelog: the word Changelog and "${releases.length} releases since ${first ? formatDate(first.date) : ""}" on the left, beside a row of Realm's realms, cubes lying on their sides with their doorways lit, going away into a blue nebula.`
}

/** A docs page's card: its group over its title and summary, at the docs' realm. */
export async function docsCard(slug: string): Promise<ImageResponse | null> {
  const doc = docBySlug(slug)
  if (!doc) return null
  return draw({ sky: skyFor(slug, false), label: "Docs", meta: groupOf(slug)?.title ?? "Docs", title: doc.title, size: titleSize(keepWords(doc.title)), summary: plainText(doc.summary) })
}

/** The docs home's card. */
export function docsIndexCard() {
  return draw({ sky: "a", meta: `${docs.length} pages · Realm 2.4`, title: "Docs", size: 120, summary: DOCS_SUMMARY })
}

export const DOCS_ALT =
  "A card from Realm's docs: on the left, Realm's name, the page's group, its title and its summary; on the right, one of Realm's realms, a cube lying on its side with its doorway lit, hanging in a blue nebula with more realms going away behind it."
