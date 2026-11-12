import type { ReactNode } from "react"

import { outline, type Block } from "@/lib/changelog"

import { Figure } from "./Figure"
import styles from "./prose.module.css"

/** The two inline spans an entry may use. Anything else is a block. */
const SPAN = /(`[^`]+`|\*\*[^*]+\*\*)/g

export function inline(text: string): ReactNode[] {
  return text.split(SPAN).map((part, index) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>
    }
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>
    }
    return part
  })
}

/** An entry's body, block by block. Section heads carry the ids `outline` gives them, so a table of
 *  contents built from the same blocks links to them. */
export function Prose({ blocks }: { blocks: Block[] }) {
  const ids = new Map(outline(blocks).map((section) => [section.index, section.id]))
  return (
    <div className={styles.prose}>
      {blocks.map((block, key) => {
        switch (block.kind) {
          case "p":
            return <p key={key}>{inline(block.text)}</p>
          case "h": {
            const id = ids.get(key)
            return (
              <h2 key={key} id={id}>
                <a href={`#${id}`}>{inline(block.text)}</a>
              </h2>
            )
          }
          case "ul":
            return (
              <ul key={key}>
                {block.items.map((item, index) => (
                  <li key={index}>{inline(item)}</li>
                ))}
              </ul>
            )
          case "code":
            return (
              <pre key={key}>
                <code>{block.text}</code>
              </pre>
            )
          case "note":
            return (
              <div key={key} role="note" className={styles.note}>
                <span>Note</span>
                {inline(block.text)}
              </div>
            )
          case "figure":
            return <Figure key={key} image={block.image} alt={block.alt} caption={inline(block.caption)} />
        }
      })}
    </div>
  )
}
