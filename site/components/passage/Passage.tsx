"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef } from "react"

import { begin, canPass, passageBetween, rememberScroll, restoreOnArrival, scrollOf, shownPath, startPoint } from "./state"
import { createVeil } from "./veil"

type Navigation = EventTarget & { currentEntry?: { key?: string } | null }

/**
 * What every passage shares (state.ts), in the root layout so it outlives the pages it carries the
 * reader between: the veil the flight is drawn on (veil.ts), and the passages the browser's own back
 * and forward take.
 *
 * Back and forward arrive as `popstate`, with the new address in place and the old page still on show,
 * so the passage is read from the two pages, deeper or shallower, and set off from the page being left:
 * back from an entry surfaces out of its doorway, forward into one dives through it, and the landing
 * page and the changelog warp and unwarp between them, whichever button it was.
 *
 * The router answers `popstate` itself, and React finishes a navigation started inside that event at
 * once, in the same task, which leaves no room for a view transition. So where a passage is to run, this
 * listener, heard first, keeps the event from the router and makes the same navigation a frame later as
 * an ordinary one: a `replace` to the address the browser has moved to, which leaves the history as it
 * is, and which React runs in a view transition like any other. The router would have left the scroll
 * to the browser, which puts it onto the page still on show and cuts it short on a shorter one; so each
 * page's scroll is kept as the reader leaves it, by the Navigation API's key for its place in the
 * history, and given back to it as it arrives, after the page being left has been pictured where it was.
 */
export function Passage() {
  const veilRef = useRef<HTMLCanvasElement>(null)
  const router = useRouter()
  const routerRef = useRef(router)

  useEffect(() => {
    routerRef.current = router
  }, [router])

  useEffect(() => {
    const canvas = veilRef.current
    return canvas ? createVeil(canvas) : undefined
  }, [])

  useEffect(() => {
    const navigation = (window as Window & { navigation?: Navigation }).navigation
    // The scroll of the page being left, taken as a navigation starts, before the browser moves
    // anything (the Navigation API); without it, at `popstate`, which comes before the browser scrolls.
    let leaving: number | null = null
    const onNavigate = (event: Event) => {
      const type = (event as Event & { navigationType?: string }).navigationType
      if (type === "replace") return
      rememberScroll(navigation?.currentEntry?.key, window.scrollY)
      if (type === "traverse") leaving = window.scrollY
    }
    const onPop = (event: PopStateEvent) => {
      const leftAt = leaving ?? window.scrollY
      leaving = null
      const to = window.location.pathname
      const kind = passageBetween(shownPath(), to)
      // Only the router's own entries: anything else it reloads or leaves alone, and so do we.
      if (!kind || !canPass() || !(event.state as { __NA?: boolean } | null)?.__NA) return
      event.stopImmediatePropagation()
      const release = kind === "surface" ? releaseLeft() : kind === "dive" ? releaseOf(to) : undefined
      const link = kind === "dive" ? document.querySelector(`a[href="${to}"]`) : null
      begin({ kind, release, ...startPoint(kind, release, link) }, leftAt)
      const kept = scrollOf(navigation?.currentEntry?.key)
      const address = `${window.location.pathname}${window.location.search}${window.location.hash}`
      requestAnimationFrame(() => {
        // The browser has put the arriving page's scroll onto the page still on show: the page being
        // left has its own back for its picture, and the arriving one gets its own as it comes in.
        restoreOnArrival(kept ?? window.scrollY)
        if (window.scrollY !== leftAt) window.scrollTo(0, leftAt)
        routerRef.current.replace(address as Parameters<typeof router.replace>[0], { scroll: false })
      })
    }
    navigation?.addEventListener("navigate", onNavigate)
    // Captured, so it is heard before the router's own listener on the window.
    window.addEventListener("popstate", onPop, { capture: true })
    return () => {
      navigation?.removeEventListener("navigate", onNavigate)
      window.removeEventListener("popstate", onPop, { capture: true })
    }
  }, [])

  return <canvas ref={veilRef} aria-hidden className="passage-veil" />
}

/** The release of the entry on show, from its band (`data-release` on the doorway's place). */
function releaseLeft(): number | undefined {
  const release = document.querySelector<HTMLElement>('[data-field-anchor="s:door"]')?.dataset.release
  return release === undefined ? undefined : Number(release)
}

/** The release an entry belongs to on the changelog on show: the card its link is listed in. */
function releaseOf(path: string): number | undefined {
  const card = document.querySelector(`a[href="${path}"]`)?.closest<HTMLElement>('[data-field-anchor^="r:"]')
  const r = card?.dataset.fieldAnchor?.slice(2)
  return r === undefined ? undefined : Number(r)
}
