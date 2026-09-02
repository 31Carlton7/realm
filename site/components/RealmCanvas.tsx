"use client"

import { useEffect, useRef, useState } from "react"

import { realmShader } from "@/lib/realm-shader"

/** Frozen frame used when the visitor asked for reduced motion — chosen because the shell is open. */
const STILL_TIME = 7

type Status = "pending" | "running" | "unsupported"

/**
 * The hero: Realm's shape, raymarched on the GPU through vgpu.
 *
 * Three things this has to get right beyond drawing:
 *
 * - **Never block the page.** vgpu is imported dynamically, so WebGPU never enters the initial bundle
 *   and nothing here runs during SSR.
 * - **Never burn a laptop.** The loop is stopped outright when the canvas scrolls away or the tab is
 *   hidden, not merely skipped — a raymarcher left running behind another tab is the difference
 *   between a warm fan and a cold one.
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

        // dpr is capped at 1.5 rather than the usual 2: this shader is ~100 distance-field
        // evaluations per pixel, and the extra samples buy nothing on a hero that is mostly
        // smooth gradient.
        const output = surface(gpu, canvas, { dpr: [1, 1.5], clearColor: [0.039, 0.043, 0.055, 1] })
        const scene = effect(gpu, realmShader, {
          set: {
            params: { resolution: output.size, pointer: [0, 0], time: reduceMotion ? STILL_TIME : 0 },
          },
        })
        const unResize = output.onResize((event) => {
          scene.set({ params: { resolution: [event.width, event.height] } })
        })

        // Pointer target vs. smoothed value: the shader gets the smoothed one, so a fast flick
        // eases the camera around instead of snapping it.
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
          // One frame, then nothing: the shape is there, it simply does not move.
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
        An animated rendering of a Realm: a glowing core wrapped in a shell of orbiting panes, circled
        by a single ring.
      </span>
    </div>
  )
}

/**
 * Shown until WebGPU is up, and permanently where it never will be. It is the same composition in
 * CSS — a lit core, a ring, a suggestion of panes — so the section's balance does not change when the
 * real thing fades in over it.
 */
function CanvasFallback() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
      <div className="relative aspect-square w-[74%]">
        {/* halo → core → ring → panes, in the order the shader stacks them */}
        <div className="absolute inset-[8%] rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--color-accent)_30%,transparent)_0%,transparent_66%)] blur-2xl" />
        <div className="absolute inset-[37%] rounded-full bg-[radial-gradient(circle_at_36%_30%,#eaf3ff_0%,#8fc0fb_30%,#2f7fe8_58%,#12356f_85%,#0d2247_100%)] shadow-[0_0_60px_12px_color-mix(in_srgb,var(--color-accent)_28%,transparent)]" />
        <div className="absolute inset-[2%] rotate-[18deg] rounded-[50%] border border-white/30 [transform:rotate3d(1,0.4,0,62deg)]" />
        <div className="absolute top-[15%] left-[16%] h-[19%] w-[13%] -rotate-12 rounded-md border border-white/15 bg-white/8 backdrop-blur-[2px]" />
        <div className="absolute top-[26%] right-[13%] h-[21%] w-[14%] rotate-[14deg] rounded-md border border-white/10 bg-white/5 backdrop-blur-[2px]" />
        <div className="absolute bottom-[16%] left-[30%] h-[18%] w-[13%] rotate-[7deg] rounded-md border border-white/15 bg-white/8 backdrop-blur-[2px]" />
      </div>
    </div>
  )
}
