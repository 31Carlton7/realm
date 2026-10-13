"use client"

import { useEffect, useRef } from "react"

import { createVeil } from "./veil"

/**
 * The veil every passage is drawn on (veil.ts), in the root layout so it outlives the pages it carries
 * the reader between.
 */
export function Passage() {
  const veilRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = veilRef.current
    return canvas ? createVeil(canvas) : undefined
  }, [])
  return <canvas ref={veilRef} aria-hidden className="passage-veil" />
}
