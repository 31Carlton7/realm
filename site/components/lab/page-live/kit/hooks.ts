"use client"

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react"

import { subscribe, type Tick } from "./ticker"

const motionQuery = "(prefers-reduced-motion: reduce)"

/** The reader's reduced-motion preference, live. Server renders assume motion is fine. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(motionQuery)
      query.addEventListener("change", onChange)
      return () => query.removeEventListener("change", onChange)
    },
    () => window.matchMedia(motionQuery).matches,
    () => false,
  )
}

/** Whether an element is within `margin` of the viewport. */
export function useOnScreen(ref: RefObject<Element | null>, margin = "120px"): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new IntersectionObserver(([entry]) => setOn(Boolean(entry?.isIntersecting)), { rootMargin: margin })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref, margin])
  return on
}

/**
 * Runs `tick` every frame while the element is on screen, the tab is visible and motion is allowed.
 * The callback is read through a ref, so it may close over fresh state without resubscribing.
 */
export function useFrames(ref: RefObject<Element | null>, tick: Tick, enabled = true) {
  const on = useOnScreen(ref)
  const reduced = useReducedMotion()
  const latest = useRef(tick)
  latest.current = tick
  useEffect(() => {
    if (!on || reduced || !enabled) return
    return subscribe((now, dt) => latest.current(now, dt))
  }, [on, reduced, enabled])
}

/* ── Scroll ─────────────────────────────────────────────────────────────────────────────────────── */

type ScrollReader = () => void
const readers = new Set<ScrollReader>()
let queued = 0

function flush() {
  queued = 0
  for (const read of readers) read()
}

function onScroll() {
  if (!queued) queued = requestAnimationFrame(flush)
}

/** One rAF-throttled scroll listener for the page; every scrubbed part reads its rect from here. */
function addReader(read: ScrollReader) {
  if (!readers.size) {
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
  }
  readers.add(read)
  read()
  return () => {
    readers.delete(read)
    if (!readers.size) {
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
    }
  }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/**
 * How far the reader has scrolled an element through the viewport, 0..1: 0 while its top is still
 * below `from` (a fraction of the viewport's height from its top), 1 once its top has risen to `to`.
 * Under reduced motion it is always 1: every scrubbed drawing rests at its end state.
 *
 * `onProgress` runs on the scroll frame with the raw value; the returned value is the same, held in
 * state and rounded so a re-render happens only when it moves by a thousandth.
 */
export function useScrollProgress(
  ref: RefObject<Element | null>,
  { from = 0.9, to = 0.3 }: { from?: number; to?: number } = {},
  onProgress?: (progress: number) => void,
): number {
  const reduced = useReducedMotion()
  const [progress, setProgress] = useState(reduced ? 1 : 0)
  const latest = useRef(onProgress)
  latest.current = onProgress

  useEffect(() => {
    if (reduced) {
      setProgress(1)
      latest.current?.(1)
      return
    }
    return addReader(() => {
      const node = ref.current
      if (!node) return
      const top = node.getBoundingClientRect().top
      const vh = window.innerHeight
      const p = clamp01((vh * from - top) / Math.max(1, vh * (from - to)))
      latest.current?.(p)
      setProgress((current) => (Math.abs(current - p) < 0.001 && p !== 0 && p !== 1 ? current : Math.round(p * 1000) / 1000))
    })
  }, [ref, from, to, reduced])

  return progress
}
