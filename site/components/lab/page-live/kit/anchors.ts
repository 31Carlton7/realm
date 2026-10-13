"use client"

import { useLayoutEffect, useState, type RefObject } from "react"

export type Rect = { x: number; y: number; w: number; h: number }
export type Anchors = { width: number; height: number; at: Record<string, Rect> }

const EMPTY: Anchors = { width: 0, height: 0, at: {} }

/**
 * The instruments are laid out by CSS — grids that recompose on a phone — and wired by SVG drawn over
 * that layout. This measures every `[data-anchor]` inside `ref`, relative to it, whenever its size
 * changes or the fonts arrive, so a wire always meets the element it belongs to.
 */
export function useAnchors(ref: RefObject<HTMLElement | null>, deps: readonly unknown[] = []): Anchors {
  const [anchors, setAnchors] = useState<Anchors>(EMPTY)
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    let frame = 0
    const measure = () => {
      frame = 0
      const box = root.getBoundingClientRect()
      const at: Record<string, Rect> = {}
      for (const node of root.querySelectorAll<HTMLElement>("[data-anchor]")) {
        const r = node.getBoundingClientRect()
        at[node.dataset.anchor!] = { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height }
      }
      setAnchors({ width: box.width, height: box.height, at })
    }
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    const observer = new ResizeObserver(queue)
    observer.observe(root)
    void document.fonts?.ready.then(queue)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps])
  return anchors
}

/** The middle of a measured rect, its left/right edge at mid-height, and friends. */
export const centre = (r: Rect): [number, number] => [r.x + r.w / 2, r.y + r.h / 2]
export const leftMid = (r: Rect): [number, number] => [r.x, r.y + r.h / 2]
export const rightMid = (r: Rect): [number, number] => [r.x + r.w, r.y + r.h / 2]
