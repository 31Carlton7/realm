"use client"

import { useEffect, useRef, useState } from "react"

import { realmShader } from "@/lib/realm-shader"

/** Frozen frame used when the visitor asked for reduced motion — the head of the ring sits top-left. */
const STILL_TIME = 0

type Status = "pending" | "running" | "unsupported"

/**
 * The hero: the Realm app icon, drawn live on the GPU through vgpu and set in motion.
 *
 * Three things this has to get right beyond drawing:
 *
 * - **Never block the page.** vgpu is imported dynamically, so WebGPU never enters the initial bundle
 *   and nothing here runs during SSR.
 * - **Never burn a laptop.** The loop is stopped outright when the canvas scrolls away or the tab is
 *   hidden, not merely skipped — a shader left running behind another tab is the difference between
 *   a warm fan and a cold one.
 * - **Always render something.** Firefox still ships WebGPU off by default, and `init()` can fail on a
 *   machine that reports `navigator.gpu` but has no usable adapter. Both land on the CSS fallback.
 */
export function RealmCanvas({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState<Status>("pending")

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (typeof navigator === "undefined" || !("gpu" in navigator)) {
      setStatus("unsupported")
      return
    }

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    let disposed = false
    let teardown: (() => void) | undefined

    void (async () => {
      try {
        const { clock, effect, frameLoop, init, surface } = await import("vgpu")
        if (disposed) return

        const gpu = await init({ label: "realm-hero" })
        if (disposed) {
          gpu.dispose()
          return
        }

        // The shader is a handful of gaussians per pixel, so it can afford full retina density —
        // and the ring's core is thin enough that it needs it.
        const output = surface(gpu, canvas, { dpr: [1, 2], clearColor: [0.039, 0.043, 0.055, 1] })
        const scene = effect(gpu, realmShader, {
          set: {
            params: { resolution: output.size, pointer: [0, 0], time: reduceMotion ? STILL_TIME : 0 },
          },
        })
        const unResize = output.onResize((event) => {
          scene.set({ params: { resolution: [event.width, event.height] } })
        })

        // Pointer target vs. smoothed value: the shader gets the smoothed one, so a fast flick
        // eases the icon round instead of snapping it.
        const target = { x: 0, y: 0 }
        const smooth = { x: 0, y: 0 }
        const onPointerMove = (event: PointerEvent) => {
          if (event.pointerType === "touch") return
          const rect = canvas.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) return
          target.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
          target.y = ((event.clientY - rect.top) / rect.height) * 2 - 1
        }
        const onPointerLeave = () => {
          target.x = 0
          target.y = 0
        }
        window.addEventListener("pointermove", onPointerMove, { passive: true })
        canvas.addEventListener("pointerleave", onPointerLeave)

        const time = clock(gpu)
        let elapsed = reduceMotion ? STILL_TIME : 0
        let loop: { stop(): void } | undefined

        const tick = () => {
          // Clamped so a tab that was backgrounded for a minute resumes where it paused rather than
          // teleporting the animation forward by the whole gap.
          const dt = Math.min(time.deltaTime, 1 / 30)
          if (!reduceMotion) elapsed += dt
          const ease = 1 - Math.exp(-dt * 6)
          smooth.x += (target.x - smooth.x) * ease
          smooth.y += (target.y - smooth.y) * ease
          scene.set({ params: { time: elapsed, pointer: [smooth.x, smooth.y] } })
        }

        const start = () => {
          if (disposed || loop) return
          loop = frameLoop(gpu, (f) => {
            tick()
            f.pass(output, scene)
          })
        }
        const stop = () => {
          loop?.stop()
          loop = undefined
        }

        if (reduceMotion) {
          // One frame, then nothing: the icon is there, it simply does not move.
          const { frame } = await import("vgpu")
          if (disposed) {
            gpu.dispose()
            return
          }
          frame(gpu, (f) => f.pass(output, scene))
        } else {
          start()
        }

        // Stop whenever the canvas is not actually being looked at.
        const observer = new IntersectionObserver(
          ([entry]) => {
            if (reduceMotion) return
            if (entry.isIntersecting && document.visibilityState === "visible") start()
            else stop()
          },
          { threshold: 0 },
        )
        observer.observe(canvas)
        const onVisibility = () => {
          if (reduceMotion) return
          if (document.visibilityState === "visible") start()
          else stop()
        }
        document.addEventListener("visibilitychange", onVisibility)

        setStatus("running")
        teardown = () => {
          observer.disconnect()
          document.removeEventListener("visibilitychange", onVisibility)
          window.removeEventListener("pointermove", onPointerMove)
          canvas.removeEventListener("pointerleave", onPointerLeave)
          unResize()
          // gpu.dispose() stops any live frame loop first — its scheduler phase runs before the
          // resources the loop would encode against are torn down.
          gpu.dispose()
        }
      } catch {
        // No adapter, a device that refused to initialize, a driver that rejected the pipeline —
        // whatever the reason, the page still has a hero.
        if (!disposed) setStatus("unsupported")
      }
    })()

    return () => {
      disposed = true
      teardown?.()
    }
  }, [])

  return (
    <div className={className}>
      <div className="relative h-full w-full">
        <canvas
          ref={canvasRef}
          aria-hidden
          className={`block h-full w-full touch-none transition-opacity duration-1000 ease-[var(--ease-out-strong)] ${
            status === "running" ? "opacity-100" : "opacity-0"
          }`}
        />
        {status !== "running" ? <CanvasFallback /> : null}
      </div>
      <span className="sr-only">
        The Realm app icon, animated: a glowing ring of shifting colour set into a dark rounded square.
      </span>
    </div>
  )
}

/**
 * Shown until WebGPU is up, and permanently where it never will be: the real icon, at the same size
 * and position the shader draws it, with its glow approximated by a shadow — so nothing shifts when
 * the live version fades in over it.
 */
function CanvasFallback() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
      <img
        src="/app-icon.png"
        alt=""
        className="w-[60%] max-w-none drop-shadow-[0_0_48px_rgba(120,110,255,0.22)]"
      />
    </div>
  )
}
