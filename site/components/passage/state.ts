/**
 * A passage: how the site carries the reader from one page to another, as one flight through the same
 * sky (the owner, 10-13: "Add a cool transition when selecting the changelog button and it navigates
 * to that screen, and another for when a user selects a changelog entry").
 *
 *   warp     the landing page to the changelog: the stars stretch as the view rushes forward into the
 *            row of realms the changelog shows, and the changelog settles in
 *   dive     the changelog to an entry: the release's doorway opens and the view dives through it
 *            into the entry, whose band shows that doorway still open
 *   surface  an entry back up to the changelog: the reverse, the view drawn back out of the doorway
 *
 * Each is a view transition, which React's <ViewTransition> starts on every navigation (PageTransition),
 * typed by the link that set it off, so the stylesheet animates the two pages by kind. This module keeps
 * what the stylesheet cannot: where the passage's light is, when it began and when the pages swapped,
 * and which doorway it goes through, for the veil drawn over both pages and the fields that pick the
 * flight up on the far side. None of it runs where the browser has no view transitions, or under reduced
 * motion, which gets a plain crossfade.
 */

export type PassageKind = "warp" | "dive" | "surface"

export type Passage = {
  kind: PassageKind
  /** `performance.now()` when the link was followed. */
  at: number
  /** When the browser swapped the pages and the animation began, once it has, and where on the new
   *  page the passage arrives. */
  landed?: number
  arrive?: { x: number; y: number }
  /** Where the passage's light is, in CSS px of the viewport: the vanishing point, or the doorway. */
  x: number
  y: number
  /** The doorway's size there, in CSS px. */
  size: number
  /** The release whose doorway it goes through. */
  release?: number
}

/** How long a passage counts as under way for the pages it lands on. */
const FRESH = 2600

let current: Passage | null = null
const watchers = new Set<(passage: Passage) => void>()

/** Whether a passage can be drawn here: the browser has view transitions and motion is welcome. */
export function canPass(): boolean {
  return "startViewTransition" in document && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Set a passage off as its link is followed. */
export function begin(passage: Omit<Passage, "at" | "landed" | "arrive">) {
  current = { ...passage, at: performance.now() }
  setPoint("--passage", passage.x, passage.y)
  for (const watch of watchers) watch(current)
}

/** The pages have swapped: `x`, `y` is where the passage arrives on the new one. */
export function land(x: number, y: number) {
  if (!current || current.landed !== undefined || performance.now() - current.at > FRESH) return
  current.landed = performance.now()
  current.arrive = { x, y }
  setPoint("--arrive", x, y)
  for (const watch of watchers) watch(current)
}

/** The passage under way, if it is of `kind` and began within `within` ms. */
export function underway(kind: PassageKind, within = FRESH): Passage | null {
  if (!current || current.kind !== kind || performance.now() - current.at > within) return null
  return current
}

/** Be told when a passage begins and when it lands. */
export function watch(fn: (passage: Passage) => void): () => void {
  watchers.add(fn)
  return () => watchers.delete(fn)
}

/** A point of the view as the stylesheet's transform-origin for a page's picture: in the page's own
 *  box, which runs from the top of the document, so a point in the view is the scroll further down it. */
const setPoint = (name: string, x: number, y: number) => {
  const root = document.documentElement
  root.style.setProperty(`${name}-x`, `${x.toFixed(1)}px`)
  root.style.setProperty(`${name}-y`, `${(y + window.scrollY).toFixed(1)}px`)
}

/**
 * Where a page wants a passage to arrive: the realm its field stands where the reader lands, as the
 * page lays it out. A page with a field says so while it is mounted (`arriveAt`).
 */
let arrival: (() => { x: number; y: number } | null) | null = null

export function arriveAt(where: () => { x: number; y: number } | null): () => void {
  arrival = where
  return () => {
    if (arrival === where) arrival = null
  }
}

export const arrivalPoint = (): { x: number; y: number } | null => arrival?.() ?? null

/**
 * The changelog's doorways as its field last drew them, by release: each one's middle on the page and
 * its size, in CSS px of the viewport. A link into a release dives through the one it can see.
 */
export const doorways = new Map<number, { x: number; y: number; size: number }>()
