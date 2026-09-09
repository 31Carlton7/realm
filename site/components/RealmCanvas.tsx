"use client"

import { useEffect, useRef, useState } from "react"

import { createRealmLiquidGlass } from "@/lib/realm-liquid-glass"

type Status = "pending" | "running" | "unsupported"

/**
 * The hero: Realm's mark as a liquid-glass field, drawn live on the GPU.
 *
 * Beyond drawing, three things: the loop stops outright when the canvas is off screen or the tab
 * is hidden rather than burning a laptop behind another tab; reduced motion gets one still frame;
 * and a browser without usable WebGPU (Firefox by default, or an adapter that fails to init) gets
 * the plain vector mark instead of nothing.
 */
export function RealmCanvas({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState<Status>("pending")

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const controller = new AbortController()
    let disposed = false
    let teardown: (() => void) | undefined

    void (async () => {
      try {
        const renderer = await createRealmLiquidGlass(canvas, reduceMotion, controller.signal)
        if (disposed) {
          renderer.dispose()
          return
        }

        const sync = (visible: boolean) => {
          if (reduceMotion) return
          if (visible && document.visibilityState === "visible") renderer.start()
          else renderer.stop()
        }
        const observer = new IntersectionObserver(([entry]) => sync(entry.isIntersecting))
        const onVisibility = () => sync(true)

        document.addEventListener("visibilitychange", onVisibility)
        observer.observe(canvas)
        setStatus("running")

        teardown = () => {
          observer.disconnect()
          document.removeEventListener("visibilitychange", onVisibility)
          renderer.dispose()
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        console.error("Realm liquid glass failed to initialize", error)
        if (!disposed) setStatus("unsupported")
      }
    })()

    return () => {
      disposed = true
      controller.abort()
      teardown?.()
    }
  }, [])

  return (
    <div className={className}>
      <div className="relative h-full w-full">
        <canvas
          ref={canvasRef}
          aria-hidden
          className={`block h-full w-full transition-opacity duration-700 ease-[var(--ease-out-strong)] ${status === "running" ? "opacity-100" : "opacity-0"}`}
        />
        {status !== "running" && (
          <img
            src="/realm-mark.svg"
            alt=""
            aria-hidden
            className="absolute inset-1/2 h-[52%] w-auto -translate-x-1/2 -translate-y-1/2"
          />
        )}
      </div>
      <span className="sr-only">Realm&rsquo;s mark, drawn as liquid glass.</span>
    </div>
  )
}
