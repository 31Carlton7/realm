"use client"

import { usePathname } from "next/navigation"
import type { ReactNode } from "react"
import { useLayoutEffect, useReducer, ViewTransition } from "react"

import { arrivalPoint, ended, land, restored, showing } from "./state"

/**
 * A page as the view transition sees it (state.ts). Wrapped round every page by the templates, which
 * Next remounts on each navigation, so a navigation is this page leaving (`page-out`) and the next one
 * arriving (`page-in`), animated by the passage marked on the root (globals.css): a warp, an unwarp, a
 * dive, a surface, or with no mark a short crossfade. Anything that changes inside a page while it stays
 * is not animated here.
 *
 * When the new page arrives the pages have swapped, and the passage lands where that page says it
 * arrives; the mark comes off when the browser's transition finishes. React holds the arriving page's
 * effects until the passage ends, so nothing it starts weighs on the animation; but the page's field is
 * one of them, and held, the reader would arrive in a photograph of the sky and see the field only once
 * the passage was over. One render as the page arrives (`settle`) lets them run, so the field starts
 * under the passage, its first frames carried in through the opening the passage makes.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const path = usePathname()
  const [, settle] = useReducer((renders: number) => renders + 1, 0)
  // The page on show, for the browser's own back and forward (Passage); arriving by one of them, the
  // scroll it had when the reader left it, before its picture is taken (state.ts).
  useLayoutEffect(() => {
    showing(path)
    const to = restored()
    if (to !== null) window.scrollTo(0, to)
  }, [path])
  const arrived = () => {
    const passage = land(arrivalPoint())
    settle()
    return () => ended(passage)
  }
  return (
    <ViewTransition enter="page-in" exit="page-out" default="none" onEnter={arrived}>
      {children}
    </ViewTransition>
  )
}
