import Image from "next/image"
import type { ReactNode } from "react"

import type { Block } from "@/lib/changelog"
import { CAPTURE_DENSITY } from "@/lib/frames"

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
    case "figure":
      // Laid out at its natural size and never wider than the reading column, so a narrow crop is
      // not blown up to fill it. Natural is a third of its pixels, because the crops are cut from the
      // window drawn at three times its density (lib/frames.ts), which keeps them sharp on a 3× phone;
      // a whole window is wider than the column whichever density it is. Each is served as written,
      // lossless, because Next's optimiser would re-encode it lossy.
      return (
        <figure key={key}>
          <Image
            src={item.image}
            alt={item.alt}
            width={Math.round(item.image.width / CAPTURE_DENSITY)}
            height={Math.round(item.image.height / CAPTURE_DENSITY)}
            unoptimized
          />
          <figcaption>{inline(item.caption)}</figcaption>
        </figure>
      )
  }
}

export function Prose({ blocks }: { blocks: Block[] }) {
  return <div className="prose">{blocks.map(block)}</div>
}
