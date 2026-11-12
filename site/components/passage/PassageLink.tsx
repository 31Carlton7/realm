"use client"

import type { Route } from "next"
import Link from "next/link"
import { useRef, type ComponentProps } from "react"

import { begin, canPass, startPoint, type PassageKind } from "./state"

type Props<T extends string> = Omit<ComponentProps<typeof Link>, "href"> & {
  href: Route<T>
  /** The passage this link takes (state.ts); none, and it is a plain link. */
  passage?: PassageKind
  /** The release whose doorway a dive goes through, or a surface comes back out of. */
  release?: number
}

/**
 * A link that takes the reader along a passage: as it is followed it marks the passage for the
 * stylesheet and sets it off from where its light starts (state.ts, `startPoint`).
 */
export function PassageLink<T extends string>({ passage, release, onNavigate, ref, ...props }: Props<T>) {
  const own = useRef<HTMLAnchorElement | null>(null)
  if (!passage) return <Link {...props} ref={ref} onNavigate={onNavigate} />
  // The link's own element, and the ref the caller asked for, both kept.
  const both = (node: HTMLAnchorElement | null) => {
    own.current = node
    if (typeof ref === "function") ref(node)
    else if (ref) ref.current = node
  }
  return (
    <Link
      {...props}
      ref={both}
      onNavigate={(event) => {
        onNavigate?.(event)
        if (canPass()) begin({ kind: passage, release, ...startPoint(passage, release, own.current) })
      }}
    />
  )
}
