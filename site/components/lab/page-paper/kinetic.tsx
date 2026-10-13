import { Fragment, type CSSProperties, type ElementType, type ReactNode } from "react"

import s from "./paper.module.css"

/** How far apart the words start, per word from the middle of the line, in em. */
const SPREAD = 0.15

/**
 * A line of type whose words slide into register as it rises to where it is read: the words start
 * spaced out from the middle of the line and close up to the set line by the time it is a little
 * above the middle of the screen. Each word only ever moves away from its neighbours, never over
 * them, so the line reads at every point of the scroll. The words are separate inline boxes with
 * real spaces between them, so the line wraps exactly as the plain text would.
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
  const middle = (words.length - 1) / 2
  return (
    <Tag id={id} className={`${s.register} ${className}`}>
      {words.map((word, i) => (
        <Fragment key={`${word}-${i}`}>
          <span style={{ "--dx": `${((i - middle) * SPREAD).toFixed(3)}em` } as CSSProperties}>{word}</span>
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
