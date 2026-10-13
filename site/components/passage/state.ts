/**
 * A passage: how the site carries the reader from one page to another, as one flight through the same
 * sky (the owner, 10-13: "Add a cool transition when selecting the changelog button and it navigates
 * to that screen, and another for when a user selects a changelog entry"; then "I want a transition
 * when navigating back from changelog entry and from changelog to homepage").
 *
 *   warp     the landing page to the changelog: the stars stretch as the view rushes forward into the
 *            row of realms the changelog shows, and the changelog settles in
 *   unwarp   the changelog back to the landing page: the warp run backwards, the changelog's sky drawn
 *            away into the distance as the landing comes back round it
 *   dive     the changelog to an entry: the release's doorway opens and the view dives through it
 *            into the entry, whose band shows that doorway still open
 *   surface  an entry back up to the changelog: the dive run backwards, the entry closing into its
 *            doorway and the changelog's camera drawn back out of that release's doorway
 *
 * Each is a view transition, which React's <ViewTransition> starts on every navigation (PageTransition).
 * Which one runs is marked on the root (`data-passage`) for the stylesheet: by the link that set it off,
 * and for the browser's own back and forward by the two pages it goes between, deeper or shallower, so
 * either button takes the passage that goes where the reader is going. The mark lasts until the view
 * transition finishes. This module also keeps what the stylesheet cannot: where the passage's light is,
 * when it began and when the pages swapped, and which doorway it goes through, for the veil drawn over
 * both pages and the fields that pick the flight up on the far side. None of it runs where the browser
 * has no view transitions, or under reduced motion; both get the plain crossfade.
 */

export type PassageKind = "warp" | "unwarp" | "dive" | "surface"

export type Passage = {
  kind: PassageKind
  /** `performance.now()` when the navigation began. */
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
/** The longest a mark may wait for a view transition that never comes (a navigation that failed). */
const UNMARK = 3200

let current: Passage | null = null
const watchers = new Set<(passage: Passage) => void>()
let unmark = 0

/** Whether a passage can be drawn here: the browser has view transitions and motion is welcome. */
export function canPass(): boolean {
  return "startViewTransition" in document && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** The view's width in CSS px less any classic scroll bar: what a layer fixed to the view fills. */
export const viewWidth = () => document.documentElement.clientWidth || window.innerWidth

/** Set a passage off as its navigation begins, from a page scrolled to `scroll`. */
export function begin(passage: Omit<Passage, "at" | "landed" | "arrive">, scroll = window.scrollY) {
  current = { ...passage, at: performance.now() }
  setPoint("--passage", passage.x, passage.y, scroll)
  const root = document.documentElement
  root.dataset.passage = passage.kind
  window.clearTimeout(unmark)
  const mine = current
  unmark = window.setTimeout(() => ended(mine), UNMARK)
  for (const watch of watchers) watch(current)
}

/**
 * The pages have swapped. `at` is where the new page says a passage arrives (`arriveAt`). A passage
 * back arrives where it left from: the page before comes back round the very point the page being left
 * went into, and the changelog's camera surfaces from a doorway standing exactly there. Returns the
 * passage that landed, if one did.
 */
export function land(at: { x: number; y: number } | null): Passage | null {
  if (!current || current.landed !== undefined || performance.now() - current.at > FRESH) return null
  const back = current.kind === "unwarp" || current.kind === "surface"
  const point = back ? { x: current.x, y: current.y } : (at ?? { x: viewWidth() / 2, y: window.innerHeight / 2 })
  current.landed = performance.now()
  current.arrive = point
  setPoint("--arrive", point.x, point.y, window.scrollY)
  for (const watch of watchers) watch(current)
  return current
}

/** The view transition `passage` ran in has finished: the stylesheet's mark comes off, unless a newer
 *  passage has put its own on. */
export function ended(passage: Passage | null) {
  if (!passage || passage !== current) return
  window.clearTimeout(unmark)
  delete document.documentElement.dataset.passage
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
const setPoint = (name: string, x: number, y: number, scroll: number) => {
  const root = document.documentElement
  root.style.setProperty(`${name}-x`, `${x.toFixed(1)}px`)
  root.style.setProperty(`${name}-y`, `${(y + scroll).toFixed(1)}px`)
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

/**
 * Where each page in the history was scrolled to as the reader left it, by its Navigation API key, for
 * the browser's own back and forward (Passage): the browser's own memory of it is put back onto the page
 * still on show, and cut short by a page shorter than the one coming.
 */
const scrolls = new Map<string, number>()

export function rememberScroll(key: string | undefined, y: number) {
  if (key) scrolls.set(key, y)
}

export const scrollOf = (key: string | undefined) => (key ? scrolls.get(key) : undefined)

/** The scroll the page arriving by back or forward is to be given, once, as it comes in (PageTransition). */
let restore: number | null = null

export function restoreOnArrival(y: number) {
  restore = y
}

export function restored(): number | null {
  const to = restore
  restore = null
  return to
}

/** The path of the page on show, kept by PageTransition, for the browser's own back and forward. */
let shown = ""

export const showing = (path: string) => {
  shown = path
}

export const shownPath = () => shown

/**
 * The passage between two pages, by where they stand: the landing page above the changelog, the
 * changelog above its entries. Nothing between two entries, or a page and itself.
 */
export function passageBetween(from: string, to: string): PassageKind | null {
  const depth = (path: string) => (path === "/" ? 0 : path === "/changelog" ? 1 : path.startsWith("/changelog/") ? 2 : -1)
  const a = depth(from)
  const b = depth(to)
  if (a < 0 || b < 0 || a === b) return null
  if (a === 0) return "warp"
  if (b === 0) return "unwarp"
  return a < b ? "dive" : "surface"
}

/**
 * Where a passage's light starts, on the page it leaves:
 *
 *   warp     the vanishing point the changelog's row of realms will stand at: right of its list on a
 *            wide screen, over its title on a narrow one (components/changelog/stage.ts)
 *   dive     the release's doorway as the changelog's field drew it, or the link itself where that
 *            doorway is not on screen
 *   surface  the doorway in the entry's band, held inside the view
 *   unwarp   the changelog's own realm, where the page says a passage would arrive
 */
export function startPoint(kind: PassageKind, release?: number, link?: Element | null): { x: number; y: number; size: number } {
  const width = viewWidth()
  const height = window.innerHeight
  const inside = (x: number, y: number, size = 0) => ({ x: Math.min(Math.max(x, 0), width), y: Math.min(Math.max(y, height * 0.12), height * 0.88), size })
  if (kind === "warp") return width >= 1024 ? { x: width * 0.78, y: height * 0.56, size: 0 } : { x: width * 0.62, y: Math.min(220, height * 0.26), size: 0 }
  if (kind === "dive" && release !== undefined) {
    const door = doorways.get(release)
    if (door && door.x > 0 && door.x < width && door.y > 0 && door.y < height) return door
  }
  if (kind === "unwarp") {
    const at = arrivalPoint()
    if (at) return inside(at.x, at.y)
  }
  const anchor = kind === "surface" ? document.querySelector('[data-field-anchor="s:door"]') : link
  const r = anchor?.getBoundingClientRect()
  return r ? inside(r.left + r.width / 2, r.top + r.height / 2, Math.min(r.width, r.height)) : { x: width / 2, y: height / 2, size: 0 }
}
