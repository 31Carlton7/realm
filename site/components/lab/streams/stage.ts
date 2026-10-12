import { effect } from "vgpu"

import { anchor, type StageFactory } from "@/components/lab/stage"

import { AGENTS, STREAM_COUNT } from "./agents"
import { layoutStreams, measure, PORTAL_RADIUS, rimLength, type Curve, type Point } from "./geometry"
import { hotStream } from "./hot"
import { streamsShader } from "./shader"

type V4 = [number, number, number, number]

const ZERO: V4 = [0, 0, 0, 0]
/** A box whose far corner is before its near one: the shader skips the stream it bounds. */
const EMPTY: V4 = [1, 1, 0, 0]

/**
 * Seconds between one stream's pulses, and when its first one leaves. Unrelated periods, so the nine
 * never fall into step; each launch is also nudged by up to a quarter period, so no stream ticks.
 */
const CADENCE: readonly (readonly [number, number])[] = [
  [6.4, 0.4],
  [8.2, 3.3],
  [7.3, 5.2],
  [9.4, 1.6],
  [6.9, 4.4],
  [7.8, 2.2],
  [8.8, 0.9],
  [6.6, 3.9],
  [10.1, 5.7],
]

/**
 * Under reduced motion the stage is one held frame, so it is composed rather than sampled: three
 * pulses on their way in at different points, one landing with its light running along the frame,
 * and the rest at rest. Per stream: how far its pulse has come (or -1), and how long ago one landed.
 */
const STILL: readonly (readonly [number, number])[] = [
  [0.58, 99],
  [-1, 99],
  [-1, 0.26],
  [0.22, 99],
  [-1, 99],
  [-1, 99],
  [0.8, 99],
  [-1, 99],
  [-1, 99],
]

/** How far a stream's light reaches either side of its hairline, in CSS px: its box is padded by it. */
const REACH = 48
/** The length of a pulse's tail, CSS px. */
const TAIL = 64

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const hash = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** Mostly even speed, eased at both ends: a pulse gathers as it leaves the socket and settles as it lands. */
const travelEase = (t: number) => t + 0.55 * (t * t * (3 - 2 * t) - t)

/** Where stream `i`'s pulse is at `time`: its head (0..1 of the way, or -1), its gain, and how long
 *  ago its latest pulse left and its latest one landed. */
function schedule(i: number, time: number, travel: number) {
  const [period, offset] = CADENCE[i % CADENCE.length]!
  const k = Math.floor((time - offset) / period)
  let head = -1
  let gain = 0
  let departed = 99
  let landed = 99
  for (const cycle of [k, k - 1]) {
    const age = time - (offset + cycle * period + hash(i, cycle) * period * 0.24)
    if (age < 0) continue
    departed = Math.min(departed, age)
    if (age < travel) {
      head = travelEase(age / travel)
      gain = smoothstep(0, 0.14, age / travel)
    } else landed = Math.min(landed, age - travel)
  }
  return { head, gain, departed, landed }
}

function composed(i: number) {
  const [head, landed] = STILL[i % STILL.length]!
  return { head, gain: head < 0 ? 0 : 1, departed: 99, landed }
}

/**
 * The Streams stage: a hairline from every agent's mark to the product window, a pulse now and then
 * running each one in, and the window's rim taking the light where it lands.
 */
export const createStreams: StageFactory = (gpu, output) => {
  const fx = effect(gpu, streamsShader, {
    label: "realm-hero-streams",
    set: {
      streams: {
        view: [1, 1, 0, 0],
        portal: ZERO,
        rim: ZERO,
        copy: [ZERO, ZERO, ZERO, ZERO],
        ctrl: Array.from({ length: STREAM_COUNT * 2 }, () => ZERO),
        box: Array.from({ length: STREAM_COUNT }, () => EMPTY),
        pulse: Array.from({ length: STREAM_COUNT }, () => ZERO),
        land: Array.from({ length: STREAM_COUNT }, () => ZERO),
        mark: Array.from({ length: STREAM_COUNT }, () => ZERO),
      },
    },
  })

  // What eases between frames, per stream: how near the pointer is, how far the stream has bent
  // toward it, and how lit it is by a hover or focus on its mark.
  const eased = AGENTS.map(() => ({ near: 0, bendX: 0, bendY: 0, hover: 0 }))
  let last: number | undefined
  const frozen = Number(new URLSearchParams(window.location.search).get("t") ?? NaN)

  return {
    draw(frame, input) {
      const still = input.still
      const seconds = Number.isFinite(frozen) ? frozen : input.seconds
      const dt = last === undefined || still ? Infinity : clamp(input.seconds - last, 0, 0.1)
      last = input.seconds
      // The share of the way an eased value closes on its target this frame; a still frame snaps.
      const close = (tau: number) => 1 - Math.exp(-dt / tau)

      const portal = anchor(input, "portal")
      const layouts = layoutStreams(
        portal,
        AGENTS.map((a) => input.anchors[`mark-${a.id}`]),
        input.width,
      )
      const [px, py, presence] = input.pointer
      const pointer: Point = [px, py]
      const hot = hotStream()

      const ctrl: V4[] = []
      const box: V4[] = []
      const pulse: V4[] = []
      const land: V4[] = []
      const mark: V4[] = []
      layouts.forEach((layout, i) => {
        const e = eased[i]!
        if (!layout) {
          ctrl.push(ZERO, ZERO)
          box.push(EMPTY)
          pulse.push(ZERO)
          land.push(ZERO)
          mark.push(ZERO)
          return
        }
        const base = layout.curve
        const near = measure(base, pointer)

        // The lens: a stream bends toward a pointer near it — most at a hand's width, not at all
        // under it or far from it — and the nearest brightens. Its ends never move: they belong to
        // the mark and the window.
        const vx = px - near.at[0]
        const vy = py - near.at[1]
        const pull = presence * 0.34 * Math.exp(-((Math.hypot(vx, vy) / 120) ** 2))
        e.bendX += (vx * pull - e.bendX) * close(0.45)
        e.bendY += (vy * pull - e.bendY) * close(0.45)
        e.near += (presence * Math.exp(-((near.distance / 70) ** 2)) - e.near) * close(0.3)
        const lit = hot === i ? 1 : 0
        e.hover += (lit - e.hover) * close(lit ? 0.16 : 0.42)

        // Moving both inner control points by the bend, weighted toward the nearer, shifts the curve
        // at that point by the bend itself (3t(1-t)((1-t)^2 + t^2) * 2.67 = 1 at the middle).
        const at = clamp(near.t, 0.15, 0.85)
        const p1: Point = [base[1][0] + e.bendX * 2.67 * (1 - at), base[1][1] + e.bendY * 2.67 * (1 - at)]
        const p2: Point = [base[2][0] + e.bendX * 2.67 * at, base[2][1] + e.bendY * 2.67 * at]
        const curve: Curve = [base[0], p1, p2, base[3]]
        const { length } = measure(curve, pointer)

        const travel = clamp(length / 230, 1.5, 3)
        const run = still ? composed(i) : schedule(i, seconds, travel)
        const resting = 0.11 + e.near * 0.32 + e.hover * 0.55
        ctrl.push([curve[0][0], curve[0][1], p1[0], p1[1]], [p2[0], p2[1], curve[3][0], curve[3][1]])
        const xs = curve.map((q) => q[0])
        const ys = curve.map((q) => q[1])
        box.push([Math.min(...xs) - REACH, Math.min(...ys) - REACH, Math.max(...xs) + REACH, Math.max(...ys) + REACH])
        pulse.push([run.head, run.gain, TAIL, resting])
        land.push([layout.landU, run.landed, 1, e.hover])
        const ring = 0.4 * Math.exp(-run.departed / 0.5) + e.hover * 0.5 + e.near * 0.12
        mark.push([layout.mark[0], layout.mark[1], layout.mark[2], ring])
      })

      fx.set({
        streams: {
          view: [input.width, input.height, seconds, still ? 1 : 0],
          portal: [...portal],
          rim: [rimLength(portal), PORTAL_RADIUS, 0, 0],
          copy: ["copy-ann", "copy-head", "copy-lede", "copy-act"].map((name) => [...anchor(input, name)] as V4),
          ctrl,
          box,
          pulse,
          land,
          mark,
        },
      })
      frame.pass(output, fx)
    },
  }
}
