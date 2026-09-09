import type { ReactNode } from "react"

import type { Block } from "@/lib/changelog"

/** The two inline spans an entry may use. Anything else is a block. */
const SPAN = /(`[^`]+`|\*\*[^*]+\*\*)/g

function inline(text: string): ReactNode[] {
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

function block(item: Block, key: number): ReactNode {
  switch (item.kind) {
    case "p":
      return <p key={key}>{inline(item.text)}</p>
    case "h":
      return <h2 key={key}>{inline(item.text)}</h2>
    case "ul":
      return (
        <ul key={key}>
          {item.items.map((entry, index) => (
            <li key={index}>{inline(entry)}</li>
          ))}
        </ul>
      )
    case "code":
      return (
        <pre key={key}>
          <code>{item.text}</code>
        </pre>
      )
    case "note":
      return <blockquote key={key}>{inline(item.text)}</blockquote>
  }
}

export function Prose({ blocks }: { blocks: Block[] }) {
  return <div className="prose">{blocks.map(block)}</div>
}
