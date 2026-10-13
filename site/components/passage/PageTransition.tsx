"use client"

import type { ReactNode } from "react"
import { useReducer, ViewTransition } from "react"

import { arrivalPoint, land } from "./state"

/**
 * A page as the view transition sees it (state.ts). Wrapped round every page by the templates, which
 * Next remounts on each navigation, so a navigation is this page leaving and the next one arriving,
 * each animated by the kind of passage the link gave it (globals.css): a warp, a dive, a surface, or
 * for a navigation no link typed (back, forward), a short crossfade. Anything that changes inside a page
 * while it stays is not animated here.
 *
 * When the new page arrives the pages have swapped, and the passage lands where that page says it
 * arrives. React holds the arriving page's effects until the passage ends, so nothing it starts weighs
 * on the animation; but the page's field is one of them, and held, the reader would arrive in a
 * photograph of the sky and see the field only once the passage was over. One render as the page
 * arrives (`settle`) lets them run, so the field starts under the passage, its first frames carried in
 * through the opening the passage makes.
 */
const ENTER = { warp: "warp-in", dive: "dive-in", surface: "surface-in", default: "fade-in" }
const EXIT = { warp: "warp-out", dive: "dive-out", surface: "surface-out", default: "fade-out" }

export function PageTransition({ children }: { children: ReactNode }) {
  const [, settle] = useReducer((renders: number) => renders + 1, 0)
  const arrived = () => {
    const at = arrivalPoint()
    land(at?.x ?? window.innerWidth / 2, at?.y ?? window.innerHeight / 2)
    settle()
  }
  return (
    <ViewTransition enter={ENTER} exit={EXIT} default="none" onEnter={arrived}>
      {children}
    </ViewTransition>
  )
}
