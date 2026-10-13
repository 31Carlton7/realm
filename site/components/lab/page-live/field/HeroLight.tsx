"use client"

import { useEffect, useRef } from "react"
import { effect, frame, init, surface } from "vgpu"

import { PAGE } from "@/components/lab/stage"

import { useOnScreen, useReducedMotion } from "../kit/hooks"
import { subscribe } from "../kit/ticker"
import { onLight, readLight } from "./lights"
import { lightShader, MAX_POINTS, MAX_RIM, MAX_SEGMENTS } from "./shader"

type V4 = [number, number, number, number]
const ZERO: V4 = [0, 0, 0, 0]

/** How far past the plate the light may reach, CSS px: the sides and foot, and the head, which sits
 *  just under the map's title and must not reach it. */
export const LIGHT_MARGIN = 56
const HEAD_MARGIN = 10

/**
 * The hero's one WebGPU canvas: the light of the map, under its hairlines, sized to the plate the map
 * and the window share and scrolling with it, so the light can never lag the lines it belongs to.
 *
 * Soft light needs no more than one device pixel per CSS pixel, so the canvas is drawn at a density
 * of at most 1 and the crisp work — every hairline, ring and word — stays in the SVG and the DOM over
 * it. It draws while the hero is on screen and the tab is visible; under reduced motion it draws only
 * when the map publishes a change. Without WebGPU it never appears, and the map is complete without it.
 */
export function HeroLight() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onScreen = useOnScreen(canvasRef, "80px")
  const reduced = useReducedMotion()
  const drawRef = useRef<((seconds: number) => void) | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let disposed = false
    let teardown: (() => void) | undefined
    const host = canvas.parentElement
    host?.setAttribute("data-live-light", "pending")

    void (async () => {
      try {
        const gpu = await init({ label: "realm-live-hero-light" })
        if (disposed) {
          gpu.dispose()
          return
        }
        const output = surface(gpu, canvas, { dpr: [0.75, 1], clearColor: [...PAGE, 1] })
        const fx = effect(gpu, lightShader, {
          label: "realm-live-hero-light",
          set: {
            light: {
              view: [1, 1, 0, LIGHT_MARGIN],
              origin: [LIGHT_MARGIN, HEAD_MARGIN, 0, 0],
              win: ZERO,
              info: ZERO,
              seg: Array.from({ length: MAX_SEGMENTS }, () => ZERO),
              segk: Array.from({ length: MAX_SEGMENTS }, () => ZERO),
              pt: Array.from({ length: MAX_POINTS }, () => ZERO),
              rim: Array.from({ length: MAX_RIM }, () => ZERO),
            },
          },
        })

        drawRef.current = (seconds: number) => {
          const f = readLight()
          const seg: V4[] = []
          const segk: V4[] = []
          for (const s of f.segments.slice(0, MAX_SEGMENTS)) {
            seg.push([s.a[0], s.a[1], s.b[0], s.b[1]])
            segk.push([s.ia, s.ib, s.width, 0])
          }
          const pt: V4[] = f.points.slice(0, MAX_POINTS).map((q) => [q.at[0], q.at[1], q.reach, q.i])
          const rim: V4[] = f.rim.slice(0, MAX_RIM).map((r) => [r.y, r.i, r.spread, 0])
          const pad = <T,>(list: T[], n: number, fill: T) => [...list, ...Array.from({ length: n - list.length }, () => fill)]
          fx.set({
            light: {
              view: [canvas.clientWidth, canvas.clientHeight, seconds, LIGHT_MARGIN],
              origin: [LIGHT_MARGIN, HEAD_MARGIN, 0, 0],
              win: f.win ? [f.win.x, f.win.y, f.win.w, f.win.h] : ZERO,
              info: [seg.length, pt.length, rim.length, f.edge === "top" ? 1 : 0],
              seg: pad(seg, MAX_SEGMENTS, ZERO),
              segk: pad(segk, MAX_SEGMENTS, ZERO),
              pt: pad(pt, MAX_POINTS, ZERO),
              rim: pad(rim, MAX_RIM, ZERO),
            },
          })
          frame(gpu, (fr) => fr.pass(output, fx))
        }
        drawRef.current(0)
        host?.setAttribute("data-live-light", "on")
        teardown = () => {
          drawRef.current = null
          gpu.dispose()
        }
      } catch {
        // No WebGPU: the map is complete without its light, and says so on its host.
        if (!disposed) host?.setAttribute("data-live-light", "off")
      }
    })()

    return () => {
      disposed = true
      teardown?.()
    }
  }, [])

  // Live: a frame for every frame of the page's loop while the hero is on screen.
  useEffect(() => {
    if (reduced || !onScreen) return
    const start = performance.now()
    return subscribe((now) => drawRef.current?.((now - start) / 1000))
  }, [reduced, onScreen])

  // Still: a frame whenever the map has published something new.
  useEffect(() => {
    if (!reduced) return
    let queued = 0
    const off = onLight(() => {
      if (queued) return
      queued = requestAnimationFrame(() => {
        queued = 0
        drawRef.current?.(6)
      })
    })
    return () => {
      off()
      cancelAnimationFrame(queued)
    }
  }, [reduced])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ left: -LIGHT_MARGIN, top: -HEAD_MARGIN, width: `calc(100% + ${LIGHT_MARGIN * 2}px)`, height: `calc(100% + ${LIGHT_MARGIN + HEAD_MARGIN}px)` }}
      className="pointer-events-none absolute -z-10 block opacity-0 transition-opacity duration-700 [[data-live-light=on]>&]:opacity-100"
    />
  )
}
