"use client"

import { useEffect, useRef } from "react"
import { draw, effect, frame, init, sampler, surface, target } from "vgpu"

import { PAPER_LINEAR, PAPER_SRGB } from "../palette"
import { SHAPE } from "./geometry"
import { causticWgsl, compositeWgsl, DOMAIN, WALL_AROUND, WALL_ROWS } from "./shader"

declare global {
  interface Window {
    /** Frames painted since load — the lab's screenshot script reads it to estimate the frame rate. */
    __labFrames?: number
  }
}

/** Grid cells per side of the light traced through the block: 150² patches, three wavelengths. */
const GRID = 150
/** The caustic map's texels per side. */
const MAP = 640
/** The mark's width as a share of the canvas's width. GlassStill draws to the same share. */
export const MARK_SHARE = 0.46
/** The lamp's height over the paper, and the nearest and farthest it may stand off from the mark,
 *  in mark units: overhead enough that the shadow stays inside the canvas, low enough to have one. */
const LAMP_HEIGHT = 52
const LAMP_NEAR = 30
const LAMP_FAR = 64
/** Where the lamp rests with no pointer: up and to the left of the mark, as a window would be. */
const REST = { angle: (-128 * Math.PI) / 180, reach: 46 }
/** The lamp's angular radius: a shade at arm's length, which sets the shadow's penumbra. */
const LAMP_SIZE = 0.06
/** The registration mark printed where the block stands: off its centre so the block refracts some
 *  of it and leaves the rest plain beside it, for comparison (mark units, and the ink's strength). */
const PRINT = { x: 7, y: 5, radius: 25, ink: 0.34 }
/** The room's share of the paper's light; the lamp gives the rest. */
const AMBIENT = 0.62
/** Seconds for the lamp to follow the pointer: slow, a hand moving a lamp rather than a cursor. */
const FOLLOW = 0.42
/** Without a pointer, how far the lamp swings round the block as the block crosses the screen. */
const SCROLL_SWING = (120 * Math.PI) / 180

type Lamp = { x: number; y: number; z: number }

/** Development only: `?paper-glass=k:4.2,az:-120` overrides the block's proportions and the light. */
const tuning = (): Record<string, number> => {
  const raw = new URLSearchParams(window.location.search).get("paper-glass")
  if (!raw) return {}
  return Object.fromEntries(
    raw
      .split(",")
      .map((pair) => pair.split(":"))
      .filter(([key, value]) => key && value && Number.isFinite(Number(value)))
      .map(([key, value]) => [key, Number(value)]),
  )
}


/**
 * The glass mark on the paper, and the light it bends.
 *
 * One canvas, laid in the page under the block, so it scrolls with the paper for nothing and only
 * paints when the light moves: the pointer is the lamp, and the light follows it slowly. Under
 * reduced motion the lamp stays where it rests and the canvas paints once. Without WebGPU,
 * `data-lab-field="off"` lands on <html> and the still drawing under the canvas stands in.
 */
export function GlassLight({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const root = document.documentElement
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const fine = window.matchMedia("(pointer: fine)")
    let disposed = false
    let teardown: (() => void) | undefined
    window.__labFrames = window.__labFrames ?? 0
    root.dataset.labField = "pending"

    void (async () => {
      try {
        const tune = tuning()
        const shape = {
          ...SHAPE,
          ...Object.fromEntries(Object.keys(SHAPE).filter((key) => key in tune).map((key) => [key, tune[key]])),
        }
        const gpu = await init({ label: "paper-glass" })
        if (disposed) {
          gpu.dispose()
          return
        }
        const output = surface(gpu, canvas, { dpr: [1, 2], clearColor: [...PAPER_SRGB, 1] })
        const map = target(gpu, { size: [MAP, MAP], format: "rgba16float", clearColor: [0, 0, 0, 0] })
        const half = DOMAIN
        const texel = ((2 * half) / MAP) ** 2

        const lightSet = { caustic: { lamp: [0, 0, 1, 1], domain: [half, texel, GRID, WALL_AROUND], ior: [1.497, 1.504, 1.513, 0] } }
        const causticSource = causticWgsl(shape)
        const top = draw(gpu, {
          shader: causticSource,
          label: "paper-caustic-top",
          entry: { vertex: "vs_top" },
          vertices: GRID * GRID * 6,
          instances: 3,
          blend: "additive",
          set: lightSet,
        })
        const walls = draw(gpu, {
          shader: causticSource,
          label: "paper-caustic-walls",
          entry: { vertex: "vs_wall" },
          vertices: WALL_AROUND * WALL_ROWS * 6,
          instances: 3,
          blend: "additive",
          set: lightSet,
        })
        const composite = effect(gpu, compositeWgsl(shape), {
          label: "paper-composite",
          set: {
            scene: {
              view: [1, 1, 1, 1],
              centre: [0, 0, half, 22],
              lamp: [0, 0, 1, LAMP_SIZE],
              // The room's share and the lamp's always make 1, which is the paper's own colour.
              light: [tune.amb ?? AMBIENT, 1 - (tune.amb ?? AMBIENT), tune.gain ?? 1, 0.37],
              paper: [...PAPER_LINEAR, new URLSearchParams(window.location.search).get("paper-debug") === "caustic" ? 2 : 1],
              print: [tune.px ?? PRINT.x, tune.py ?? PRINT.y, tune.pr ?? PRINT.radius, tune.pink ?? PRINT.ink],
            },
            causticMap: map,
            causticSampler: sampler(gpu, { minFilter: "linear", magFilter: "linear" }),
          },
        })

        let still = motion.matches
        const height = tune.h ?? LAMP_HEIGHT
        const lampAt = (angle: number, reach: number): Lamp => ({ x: Math.cos(angle) * reach, y: Math.sin(angle) * reach, z: height })
        const rest = lampAt(tune.az !== undefined ? (tune.az * Math.PI) / 180 : REST.angle, tune.reach ?? REST.reach)
        // Where the lamp starts: already where it would be aimed, so the first frame is not a swing.
        const lamp: Lamp = { ...rest }
        let goal: Lamp = { ...rest }
        let last = performance.now()
        let raf = 0
        let onScreen = true
        let rect = canvas.getBoundingClientRect()
        const pointer = { x: 0, y: 0, here: false }

        const markScale = () => (rect.width * (tune.share ?? MARK_SHARE)) / 40
        const markCentre = () => [rect.width / 2, rect.height / 2] as const

        const restAngle = tune.az !== undefined ? (tune.az * Math.PI) / 180 : REST.angle
        const aim = () => {
          if (still) {
            goal = { ...rest }
            return
          }
          if (!pointer.here) {
            // On a touch screen the reader's scroll is the only hand there is: the lamp swings round
            // the block as it crosses the screen, and rests where it would with a mouse at the top.
            if (fine.matches) {
              goal = { ...rest }
              return
            }
            const travel = Math.min(1, Math.max(0, (window.innerHeight - rect.top) / (window.innerHeight + rect.height)))
            goal = lampAt(restAngle + (travel - 0.35) * SCROLL_SWING, tune.reach ?? REST.reach)
            return
          }
          const [cx, cy] = markCentre()
          const s = markScale()
          const dx = (pointer.x - rect.left - cx) / s
          const dy = (pointer.y - rect.top - cy) / s
          const reach = Math.min(LAMP_FAR, Math.max(LAMP_NEAR, Math.hypot(dx, dy) * 0.55))
          goal = lampAt(Math.atan2(dy, dx), reach)
        }

        const paint = () => {
          const s = markScale()
          const [cx, cy] = markCentre()
          const d = Math.hypot(lamp.x, lamp.y, lamp.z)
          const open = lamp.z / d / (d * d)
          top.set({ caustic: { lamp: [lamp.x, lamp.y, lamp.z, open] } })
          walls.set({ caustic: { lamp: [lamp.x, lamp.y, lamp.z, open] } })
          composite.set({
            scene: {
              view: [rect.width, rect.height, s, output.dpr],
              centre: [cx, cy, half, 22],
              lamp: [lamp.x, lamp.y, lamp.z, tune.size ?? LAMP_SIZE],
            },
          })
          frame(gpu, (f) => {
            f.pass({ target: map, clear: [0, 0, 0, 0] }, (pass) => {
              pass.draw(top)
              pass.draw(walls)
            })
            f.pass(output, composite)
          })
          window.__labFrames = (window.__labFrames ?? 0) + 1
        }

        const tick = (now: number) => {
          raf = 0
          const dt = Math.min(0.1, (now - last) / 1000)
          last = now
          const k = still ? 1 : 1 - Math.exp(-dt / FOLLOW)
          lamp.x += (goal.x - lamp.x) * k
          lamp.y += (goal.y - lamp.y) * k
          lamp.z += (goal.z - lamp.z) * k
          paint()
          const moving = Math.hypot(goal.x - lamp.x, goal.y - lamp.y, goal.z - lamp.z) > 0.02
          if (moving) wake()
        }

        function wake() {
          if (raf || !onScreen || document.visibilityState !== "visible") return
          last = performance.now()
          raf = requestAnimationFrame(tick)
        }

        const onPointerMove = (event: PointerEvent) => {
          if (event.pointerType !== "mouse") return
          pointer.x = event.clientX
          pointer.y = event.clientY
          pointer.here = true
          if (still) return
          aim()
          wake()
        }
        const onPointerLeave = () => {
          pointer.here = false
          aim()
          wake()
        }
        const remeasure = () => {
          rect = canvas.getBoundingClientRect()
          aim()
          wake()
        }
        const onScroll = () => {
          // The canvas moves with the page, so a scroll needs no repaint, only a new place for the lamp.
          rect = canvas.getBoundingClientRect()
          if (!still && (pointer.here || !fine.matches)) {
            aim()
            wake()
          }
        }
        const onVisibility = () => {
          if (document.visibilityState === "visible") wake()
        }
        const onMotion = () => {
          still = motion.matches
          aim()
          wake()
        }
        const seen = new IntersectionObserver(([entry]) => {
          onScreen = Boolean(entry?.isIntersecting)
          if (onScreen) wake()
        })
        seen.observe(canvas)
        const resized = output.onResize(() => {
          rect = canvas.getBoundingClientRect()
          // A resize changes the drawing even when nothing else does.
          if (!raf) requestAnimationFrame(() => paint())
        })

        window.addEventListener("pointermove", onPointerMove, { passive: true })
        root.addEventListener("pointerleave", onPointerLeave)
        window.addEventListener("scroll", onScroll, { passive: true })
        window.addEventListener("resize", remeasure)
        document.addEventListener("visibilitychange", onVisibility)
        motion.addEventListener("change", onMotion)

        aim()
        Object.assign(lamp, goal)
        paint()
        root.dataset.labField = "on"

        teardown = () => {
          cancelAnimationFrame(raf)
          seen.disconnect()
          resized()
          window.removeEventListener("pointermove", onPointerMove)
          root.removeEventListener("pointerleave", onPointerLeave)
          window.removeEventListener("scroll", onScroll)
          window.removeEventListener("resize", remeasure)
          document.removeEventListener("visibilitychange", onVisibility)
          motion.removeEventListener("change", onMotion)
          gpu.dispose()
        }
      } catch (error) {
        console.warn("The glass light is unavailable here; showing its still drawing.", error)
        if (!disposed) root.dataset.labField = "off"
      }
    })()

    return () => {
      disposed = true
      teardown?.()
      delete root.dataset.labField
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`pointer-events-none absolute inset-0 block h-full w-full opacity-0 transition-opacity duration-700 ease-[var(--ease-out-strong)] [html[data-lab-field=on]_&]:opacity-100 ${className}`}
    />
  )
}
