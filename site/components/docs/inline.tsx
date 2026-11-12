import type { Route } from "next"
import Link from "next/link"
import type { ReactNode } from "react"

import styles from "./docs.module.css"

/** The spans a line of a docs page may carry (lib/docs-blocks.ts). Anything else is a block. A key
 *  span ends at the last of a run of closing brackets, so [[⌘[]] and [[⌘]]] are ⌘[ and ⌘]. */
const SPAN = /(`[^`]+`|\*\*[^*]+\*\*|\[\[.+?\]\](?!\])|\[[^\]]+\]\([^)\s]+\))/g

/** What each modifier glyph is called, for the key's accessible name: a screen reader reads ⌘ as
 *  "place of interest sign". */
const KEY_NAMES: Record<string, string> = {
  "⌘": "Command",
  "⇧": "Shift",
  "⌥": "Option",
  "⌃": "Control",
  "↩": "Return",
  "⌫": "Delete",
  "↑": "Up arrow",
  "↓": "Down arrow",
  "←": "Left arrow",
  "→": "Right arrow",
}
const MODIFIERS = new Set(["⌘", "⇧", "⌥", "⌃"])

/** `⌘⇧P` → ⌘, ⇧, P; `⌃ Tab` → ⌃, Tab. A modifier is its own key wherever it stands. */
export function splitKeys(chord: string): string[] {
  const keys: string[] = []
  for (const token of chord.trim().split(/\s+/)) {
    let rest = token
    while (rest.length > 1 && MODIFIERS.has(rest[0]!)) {
      keys.push(rest[0]!)
      rest = rest.slice(1)
    }
    if (rest) keys.push(rest)
  }
  return keys
}

/** A chord as keycaps, named in words for anyone not reading the glyphs. */
export function Keys({ chord }: { chord: string }) {
  const keys = splitKeys(chord)
  return (
    <kbd className={styles.chord} aria-label={keys.map((key) => KEY_NAMES[key] ?? key).join(" ")}>
      {keys.map((key, index) => (
        <kbd key={index} aria-hidden className={styles.key}>
          {key}
        </kbd>
      ))}
    </kbd>
  )
}

function DocLink({ href, children }: { href: string; children: ReactNode }) {
  if (href.startsWith("/")) {
    return (
      <Link href={href as Route} className={styles.link}>
        {children}
      </Link>
    )
  }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={styles.link}>
      {children}
    </a>
  )
}

/** The longest word of code kept whole: what the narrowest column holds in the code face, a step or a
 *  callout on a 320px phone. */
const WHOLE_WORD = 24

/** A code span's words, each kept on one line. A browser breaks after a hyphen as readily as at a space,
 *  which split `--force` into `-` and `-force`, and `[--port N]` after its dashes, at the end of a line.
 *  A word longer than a phone's column, such as a long path, may still break inside. */
function codeWords(text: string): ReactNode[] {
  return text.split(/(\s+)/).map((word, index) =>
    word.length > 0 && word.length <= WHOLE_WORD && !/\s/.test(word) ? (
      <span key={index} className={styles.word}>
        {word}
      </span>
    ) : (
      word
    ),
  )
}

/** One line of a page, its spans drawn. Spans do not nest, except that a link's words may be code. */
export function inline(text: string): ReactNode[] {
  return text.split(SPAN).map((part, index) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{codeWords(part.slice(1, -1))}</code>
    }
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>
    }
    if (part.length > 4 && part.startsWith("[[") && part.endsWith("]]")) {
      return <Keys key={index} chord={part.slice(2, -2)} />
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part)
    if (link) {
      return (
        <DocLink key={index} href={link[2]!}>
          {inline(link[1]!)}
        </DocLink>
      )
    }
    return part
  })
}
