import { Fragment, type CSSProperties, type ElementType, type ReactNode } from "react"

import s from "./paper.module.css"

/** How far each word starts from its place, in em: alternating sides, never the same twice running. */
const OFFSETS = [-0.42, 0.3, -0.18, 0.5, -0.34, 0.22, -0.48, 0.14]

/**
 * A line of type whose words slide into register as it rises to where it is read: set slightly off,
 * each word to its own side, and in place by the time the line is a little above the middle of the
 * screen. The words are separate inline boxes, so the line wraps exactly as the plain text would.
 */
export function Register({
  as: Tag = "h2",
  text,
  className = "",
  id,
}: {
  as?: ElementType
  text: string
  className?: string
  id?: string
}) {
  const words = text.split(" ")
  return (
    <Tag id={id} className={`${s.register} ${className}`}>
      {words.map((word, i) => (
        <Fragment key={`${word}-${i}`}>
          <span style={{ "--dx": `${OFFSETS[i % OFFSETS.length]}em` } as CSSProperties}>{word}</span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </Tag>
  )
}

/**
 * A word that inks in: light and loosely spaced until the scroll reaches it, then set at its weight.
 * Two hidden copies hold the wider of its two states, so nothing around it moves while it changes.
 * `index` orders the words of one statement (the `inkScope` around them sets the pace).
 */
export function Ink({ children, index, className = "" }: { children: ReactNode; index: number; className?: string }) {
  return (
    <span className={`${s.ink} ${className}`} style={{ "--i": index } as CSSProperties}>
      <span data-reserve="light" aria-hidden>
        {children}
      </span>
      <span data-reserve="set" aria-hidden className="[font-weight:var(--set-weight,640)] [letter-spacing:var(--set-tracking,-0.045em)]">
        {children}
      </span>
      <span data-word>{children}</span>
    </span>
  )
}
