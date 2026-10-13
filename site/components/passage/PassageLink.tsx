"use client"

import type { Route } from "next"
import Link from "next/link"
import { useRef, type ComponentProps } from "react"

import { begin, canPass, doorways, type PassageKind } from "./state"

type Props<T extends string> = Omit<ComponentProps<typeof Link>, "href"> & {
  href: Route<T>
  /** The passage this link takes (state.ts); none, and it is a plain link. */
  passage?: PassageKind
  /** The release whose doorway a dive goes through, or a surface comes back out of. */
  release?: number
}

/**
 * A link that takes the reader along a passage: it hands the navigation the passage's type, which the
 * stylesheet animates the two pages by, and sets the passage off from where its light is.
 *
 *   warp     from the vanishing point the changelog's row of realms will stand at
 *   dive     from the release's doorway, as the changelog's field drew it, or from the link itself
 *            when the doorway is not on screen
 *   surface  from the doorway in the entry's band
 */
export function PassageLink<T extends string>({ passage, release, onNavigate, ...props }: Props<T>) {
  const ref = useRef<HTMLAnchorElement>(null)
  if (!passage) return <Link {...props} onNavigate={onNavigate} />
  return (
    <Link
      {...props}
      ref={ref}
      transitionTypes={[passage]}
      onNavigate={(event) => {
        onNavigate?.(event)
        if (canPass()) begin({ kind: passage, release, ...where(passage, release, ref.current) })
      }}
    />
  )
}

function where(passage: PassageKind, release: number | undefined, link: HTMLElement | null): { x: number; y: number; size: number } {
  const width = window.innerWidth
  const height = window.innerHeight
  if (passage === "warp") {
    // The changelog's realms stand right of its list on a wide screen and over its title on a narrow
    // one (components/changelog/stage.ts); the passage lands exactly there once the page is in.
    return width >= 1024 ? { x: width * 0.78, y: height * 0.56, size: 0 } : { x: width * 0.62, y: Math.min(220, height * 0.26), size: 0 }
  }
  if (passage === "dive" && release !== undefined) {
    const door = doorways.get(release)
    if (door && door.x > 0 && door.x < width && door.y > 0 && door.y < height) return door
  }
  const anchor = passage === "surface" ? document.querySelector('[data-field-anchor="s:door"]') : link
  const r = anchor?.getBoundingClientRect()
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, size: Math.min(r.width, r.height) } : { x: width / 2, y: height / 2, size: 0 }
}
