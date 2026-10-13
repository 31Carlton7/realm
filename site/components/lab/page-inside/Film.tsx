"use client"

import Link from "next/link"
import { useEffect, useRef, useState, type CSSProperties } from "react"

import { AgentMark } from "@/components/AgentMark"
import { DownloadButton, QuietButton } from "@/components/Buttons"
import { MiniRealm, type MiniScene } from "@/components/home/mini/MiniRealm"
import { ArrowIcon, GitHubIcon } from "@/components/icons"
import type { ProvenClaim } from "@/components/lab/pages"
import type { MacDownload } from "@/lib/release"
import { site } from "@/lib/site"

import { clamp, frame, mix, poseOf, ramp, smoother, viewOf, zoomPan, type Box, type Pose, type View } from "./camera"
import { captureSrc, chapters, cutStyle, stills, WINDOW, type Beat, type Frac } from "./content"
import css from "./inside.module.css"
import { onScrollFrame, requestScrollFrame } from "./frames"
import { studioScene } from "./scene"

/** Wide enough for the window and the words side by side, and motion allowed: the film runs. */
export const FILM_QUERY = "(min-width: 1024px) and (prefers-reduced-motion: no-preference)"

/* How far the reader scrolls for each part of the tour, in viewport heights. */
const INTRO = 0.18
const PUSH = 0.8
const MOVE = 0.44
const HOLD = 0.52
const SUB_MOVE = 0.32
const SUB_HOLD = 0.44
const JOIN = 0.64
const STILL = 0.46
const OUTRO = 0.34

type Flat = Beat & { chapter: number; first: boolean; at: number }

const BEATS: Flat[] = chapters.flatMap((c, ci) => c.beats.map((b, bi) => ({ ...b, chapter: ci, first: bi === 0, at: 0 })))

/** The tour laid along the scroll: each beat is a move into its framing, then a hold on it. */
const PLAN = (() => {
  let at = INTRO
  const beats = BEATS.map((b, k) => {
    const move = k === 0 ? PUSH : b.first ? MOVE : SUB_MOVE
    const hold = b.first ? HOLD : SUB_HOLD
    const seg = { move: at, hold: at + move, end: at + move + hold }
    at = seg.end
    return seg
  })
  const join = { start: at, end: at + JOIN }
  const strip = { start: join.end, end: join.end + stills.length * STILL }
  return { beats, join, strip, length: strip.end + OUTRO }
})()

const HERO_SCENE: MiniScene = { session: "crash", tab: "crash-doc", view: "session" }

/** The state the window is in for beat k: its own, or the last one the sample was put in. */
const sceneFor = (k: number): MiniScene => {
  for (let i = Math.min(k, BEATS.length - 1); i >= 0; i--) if (BEATS[i]!.scene) return BEATS[i]!.scene!
  return HERO_SCENE
}
const keyOf = (scene: MiniScene) => JSON.stringify(scene)

/** Where the reader is in the tour. */
type Place =
  | { phase: "intro" }
  | { phase: "move"; k: number; t: number }
  | { phase: "hold"; k: number; t: number }
  | { phase: "join"; t: number }
  | { phase: "strip"; q: number }

function locate(p: number): Place {
  if (p < PLAN.beats[0]!.move) return { phase: "intro" }
  for (let k = 0; k < PLAN.beats.length; k++) {
    const seg = PLAN.beats[k]!
    if (p < seg.hold) return { phase: "move", k, t: (p - seg.move) / (seg.hold - seg.move) }
    if (p < seg.end) return { phase: "hold", k, t: (p - seg.hold) / (seg.end - seg.hold) }
  }
  if (p < PLAN.join.end) return { phase: "join", t: (p - PLAN.join.start) / JOIN }
  // Each still settles at the centre for a moment: the strip eases into every stop, so a frame rests
  // where its caption can be read, and the scroll still decides where everything is.
  const raw = clamp((p - PLAN.strip.start) / STILL, 0, stills.length)
  const i = Math.floor(raw)
  const f = raw - i
  return { phase: "strip", q: Math.min(stills.length, i + mix(f, smoother(f), 0.75)) }
}

const ZERO_BOX: Box = { x: 0, y: 0, w: 1, h: 1 }

export function Film({ download, claims }: { download: MacDownload; claims: ProvenClaim[] }) {
  const [film, setFilm] = useState(false)
  // Which beat the window's state, the words and the strip's caption belong to. -1 is the opening.
  const [sceneBeat, setSceneBeat] = useState(-1)
  const [copyBeat, setCopyBeat] = useState(-1)
  const [still, setStill] = useState(-1)
  const [loadTo, setLoadTo] = useState(-1)

  const trackRef = useRef<HTMLElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const rigRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const captureRefs = useRef<(HTMLImageElement | null)[]>([])
  const stillRefs = useRef<(HTMLElement | null)[]>([])
  const titleRefs = useRef<(HTMLHeadingElement | null)[]>([])
  const lineRef = useRef<SVGPathElement>(null)
  const bracketRef = useRef<SVGPathElement>(null)
  const dotRef = useRef<SVGCircleElement>(null)
  const ringRef = useRef<SVGCircleElement>(null)
  const playheadRef = useRef<HTMLSpanElement>(null)
  /** The part of the window each beat frames, measured from the sample once it is in that state. */
  const measured = useRef(new Map<number, Frac>())
  const remeasure = useRef<() => void>(() => {})

  const caption = (id?: string) => claims.find((c) => c.id === id)

  useEffect(() => {
    const query = window.matchMedia(FILM_QUERY)
    const update = () => setFilm(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  // Once the sample has taken a beat's state, measure what that beat (and any beat sharing the state)
  // frames. Two frames: one for the sample's own effect to apply the state, one for it to lay out.
  useEffect(() => {
    if (!film) return
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const frameEl = frameRef.current
        if (!frameEl) return
        const box = frameEl.getBoundingClientRect()
        if (box.width < 1) return
        const scene = keyOf(sceneFor(sceneBeat))
        BEATS.forEach((beat, k) => {
          if (!beat.target || !beat.scene || keyOf(beat.scene) !== scene) return
          const node = frameEl.querySelector(beat.target.selector)
          if (!node) return
          const r = node.getBoundingClientRect()
          if (r.width < 1 || r.height < 1) return
          const [px, py, pw, ph] = beat.target.part ?? [0, 0, 1, 1]
          measured.current.set(k, [
            (r.left - box.left + px * r.width) / box.width,
            (r.top - box.top + py * r.height) / box.height,
            (pw * r.width) / box.width,
            (ph * r.height) / box.height,
          ])
        })
        remeasure.current()
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [film, sceneBeat])

  useEffect(() => {
    if (!film) return
    const track = trackRef.current
    const column = columnRef.current
    const layer = layerRef.current
    const rig = rigRef.current
    const frameEl = frameRef.current
    if (!track || !column || !layer || !rig || !frameEl) return

    const g = {
      vw: 0,
      vh: 0,
      top: 0,
      set: ZERO_BOX,
      F: 640,
      Fh: 400,
      gap: 64,
      cy: 0,
      starts: [] as [number, number][],
      dark: [0, 0] as [number, number],
    }
    let hero: View = { cx: 600, cy: 375, w: 1200 }
    let views: View[] = []
    let slot: View = hero

    const focusBox = (k: number): Box => {
      const [fx, fy, fw, fh] = measured.current.get(k) ?? BEATS[k]!.focus
      const pad = 14
      return { x: fx * WINDOW.width - pad, y: fy * WINDOW.height - pad, w: fw * WINDOW.width + pad * 2, h: fh * WINDOW.height + pad * 2 }
    }

    const build = () => {
      const set = g.set
      const fit = Math.min((set.w * 0.97) / WINDOW.width, (set.h - 132) / WINDOW.height)
      hero = viewOf(
        { s: fit, tx: set.x + (set.w - fit * WINDOW.width) / 2, ty: set.y + (set.h - 132 - fit * WINDOW.height) / 2 + 12 },
        set,
      )
      views = BEATS.map((beat, k) => frame(focusBox(k), set, beat.zoom ?? 1.3, beat.capture ? 0.9 : 0.86))
      const s = g.F / WINDOW.width
      slot = viewOf({ s, tx: set.x + set.w / 2 - g.F / 2, ty: g.cy - g.Fh / 2 }, set)
    }

    const measure = () => {
      g.vw = window.innerWidth
      g.vh = window.innerHeight
      g.top = track.getBoundingClientRect().top + window.scrollY
      const col = column.getBoundingClientRect()
      const darkA = col.right + 24
      const darkB = col.right + 132
      layer.style.setProperty("--dark-a", `${darkA}px`)
      layer.style.setProperty("--dark-b", `${darkB}px`)
      g.dark = [darkA, darkB]
      const right = Math.min(g.vw, (g.vw - 1680) / 2 + 1680) - 40
      g.set = { x: darkB, y: 92, w: Math.max(320, right - darkB), h: g.vh - 92 - 36 }
      g.F = Math.min(g.set.w * 0.86, 820)
      g.Fh = (g.F * WINDOW.height) / WINDOW.width
      g.gap = Math.max(48, g.F * 0.1)
      g.cy = g.set.y + g.set.h * 0.44
      for (const node of stillRefs.current) {
        if (!node) continue
        node.style.width = `${g.F}px`
        node.style.height = `${g.Fh}px`
      }
      // Where each chapter's callout starts: just past the end of its title's last line.
      g.starts = titleRefs.current.map((title) => {
        if (!title) return [col.right, g.vh / 2]
        const range = document.createRange()
        range.selectNodeContents(title)
        const lines = range.getClientRects()
        const last = lines[lines.length - 1]
        return last ? [last.right + 14, last.top + last.height / 2] : [col.right, g.vh / 2]
      })
      build()
    }

    let lastY = Number.NaN
    let dirty = true
    let placed = false

    // While the camera moves, the window is its own layer and the compositor scales it, which is what
    // keeps a dolly smooth; that layer is painted at the scale it had when it was made, so a close-up
    // reached that way is soft. A moment after the scroll stops, the window is painted again at
    // exactly the scale it is shown at, so whatever the reader stops on is sharp.
    let rest = 0
    let resting = false
    let lastPose: Pose = { tx: 0, ty: 0, s: 1 }
    const transformOf = (pose: Pose, flat: boolean) =>
      flat
        ? `translate(${pose.tx.toFixed(2)}px, ${pose.ty.toFixed(2)}px) scale(${pose.s.toFixed(5)})`
        : `translate3d(${pose.tx.toFixed(2)}px, ${pose.ty.toFixed(2)}px, 0) scale(${pose.s.toFixed(5)})`
    const place3d = (pose: Pose) => {
      const moved = pose.tx !== lastPose.tx || pose.ty !== lastPose.ty || pose.s !== lastPose.s
      lastPose = pose
      if (!moved && resting) return
      if (resting) {
        resting = false
        rig.style.willChange = "transform"
      }
      rig.style.transform = transformOf(pose, false)
      window.clearTimeout(rest)
      rest = window.setTimeout(() => {
        resting = true
        rig.style.willChange = "auto"
        rig.style.transform = transformOf(lastPose, true)
      }, 160)
    }
    const state = { scene: -2, copy: -2, still: -2, load: -1 }

    const sync = () => {
      if (window.innerWidth !== g.vw || window.innerHeight !== g.vh) {
        measure()
        dirty = true
      }
      const y = window.scrollY
      if (y === lastY && !dirty) return
      lastY = y
      dirty = false
      const p = (y - g.top) / g.vh
      const place = locate(p)
      const set = g.set
      const K = BEATS.length

      // The camera.
      let view: View
      let q = 0
      if (place.phase === "intro") view = hero
      else if (place.phase === "hold") view = views[place.k]!
      else if (place.phase === "move") view = zoomPan(place.k === 0 ? hero : views[place.k - 1]!, views[place.k]!)(smoother(place.t))
      else if (place.phase === "join") {
        view = zoomPan(views[K - 1]!, slot)(smoother(place.t))
        q = -1.7 * (1 - smoother(place.t))
      } else {
        view = slot
        q = place.q
      }
      const step = g.F + g.gap
      let pose: Pose = poseOf(view, set)
      if (place.phase === "strip") pose = { ...pose, tx: pose.tx - q * step }
      place3d(pose)
      if (!placed) {
        placed = true
        rig.dataset.placed = ""
      }

      // What the frame shows: the sample, or a capture laid over it, crossfading as the camera moves.
      const k = place.phase === "move" || place.phase === "hold" ? place.k : place.phase === "intro" ? -1 : K
      const fade = place.phase === "move" ? ramp(0.12, 0.62, place.t) : place.phase === "join" ? ramp(0.05, 0.5, place.t) : 1
      BEATS.forEach((beat, j) => {
        const img = captureRefs.current[j]
        if (!img) return
        let o = 0
        if (j === k) o = place.phase === "move" ? fade : 1
        else if (j === k - 1 || (k === K && j === K - 1)) {
          const next = BEATS[j + 1]
          // A capture stays under the next one while that fades in, and fades out under the sample.
          o = next?.capture && k < K ? 1 : place.phase === "move" || place.phase === "join" ? 1 - fade : 0
          if (place.phase === "hold" || place.phase === "strip") o = 0
        }
        img.style.opacity = o.toFixed(3)
      })

      // The strip of stills, in the same light, the window first among them.
      const stripOn = place.phase === "join" || place.phase === "strip"
      const keyX = set.x + set.w / 2
      const litOf = (cx: number) => Math.exp(-(((cx - keyX) / (g.F * 0.95)) ** 2))
      stillRefs.current.forEach((node, i) => {
        if (!node) return
        if (!stripOn) {
          node.style.visibility = "hidden"
          node.dataset.lightLit = "0"
          return
        }
        const cx = keyX + (i + 1 - q) * step
        node.style.visibility = "visible"
        node.style.transform = `translate3d(${(cx - g.F / 2).toFixed(2)}px, ${(g.cy - g.Fh / 2).toFixed(2)}px, 0)`
        node.dataset.lightLit = litOf(cx).toFixed(3)
      })
      frameEl.dataset.lightLit = stripOn ? litOf(pose.tx + (pose.s * WINDOW.width) / 2).toFixed(3) : "1"

      // The key light, aimed into the set; the floor is wherever the window (or the strip) stands.
      studioScene.key = stripOn
        ? [keyX, g.cy - g.Fh * 0.35, g.F * 1.25, 1]
        : [set.x + set.w * 0.58, set.y + set.h * 0.3, set.w * 0.95, 1]
      studioScene.floor = stripOn ? g.cy + g.Fh / 2 : pose.ty + pose.s * WINDOW.height
      studioScene.hot = null
      studioScene.dark = g.dark

      // The callout: from the end of the chapter's title to the part of the window it is about.
      let shownBeat = -1
      let draw = 0
      if (place.phase === "hold") {
        shownBeat = place.k
        draw = ramp(0.02, 0.42, place.t)
      } else if (place.phase === "move" && place.k > 0) {
        shownBeat = place.k - 1
        draw = 1 - ramp(0, 0.22, place.t)
      }
      const line = lineRef.current
      const brackets = bracketRef.current
      const dot = dotRef.current
      const ring = ringRef.current
      if (line && brackets && dot && ring) {
        if (shownBeat < 0 || draw <= 0.001) {
          line.style.opacity = "0"
          brackets.style.opacity = "0"
          dot.style.opacity = "0"
          ring.style.opacity = "0"
        } else {
          const box = focusBox(shownBeat)
          const tx = pose.tx + pose.s * box.x
          const ty = pose.ty + pose.s * box.y
          const tw = pose.s * box.w
          const th = pose.s * box.h
          const [sx, sy] = g.starts[BEATS[shownBeat]!.chapter] ?? [set.x - 132, g.vh / 2]
          const ex = Math.max(tx, set.x - 40)
          const ey = clamp(sy, ty + 18, ty + th - 18)
          const run = Math.abs(ey - sy) * Math.tan(Math.PI / 6)
          const bend = ex - 12 - run
          const d = bend > sx + 12 ? `M${sx} ${sy}H${bend.toFixed(1)}L${(ex - 12).toFixed(1)} ${ey.toFixed(1)}H${ex.toFixed(1)}` : `M${sx} ${sy}L${ex.toFixed(1)} ${ey.toFixed(1)}`
          line.setAttribute("d", d)
          const length = (bend > sx + 12 ? bend - sx + Math.hypot(run, ey - sy) + 12 : Math.hypot(ex - sx, ey - sy)) + 1
          line.style.strokeDasharray = `${length}`
          line.style.strokeDashoffset = `${(length * (1 - smoother(draw))).toFixed(1)}`
          line.style.opacity = "1"
          dot.setAttribute("cx", `${sx}`)
          dot.setAttribute("cy", `${sy}`)
          dot.style.opacity = `${ramp(0, 0.25, draw)}`
          ring.setAttribute("cx", ex.toFixed(1))
          ring.setAttribute("cy", ey.toFixed(1))
          ring.style.opacity = `${ramp(0.75, 1, draw)}`
          // The camera's focus marks round the part, closing on it as the line arrives.
          const pad = 8 + 16 * (1 - smoother(ramp(0.4, 1, draw)))
          const x0 = tx - pad
          const y0 = ty - pad
          const x1 = tx + tw + pad
          const y1 = ty + th + pad
          const a = Math.min(16, tw / 4, th / 4)
          brackets.setAttribute(
            "d",
            `M${x0} ${y0 + a}V${y0}H${x0 + a}M${x1 - a} ${y0}H${x1}V${y0 + a}M${x1} ${y1 - a}V${y1}H${x1 - a}M${x0 + a} ${y1}H${x0}V${y1 - a}`,
          )
          brackets.style.opacity = `${ramp(0.4, 1, draw)}`
        }
      }

      // The timeline under the words.
      const playhead = playheadRef.current
      if (playhead) playhead.style.transform = `translateX(${(clamp(p / PLAN.length) * 100).toFixed(3)}%)`

      // The window's state and the words change together, a third of the way into the camera's move:
      // the camera sets off, the new sentence arrives, and the window is in its state as it lands.
      const copyAt =
        place.phase === "intro"
          ? -1
          : place.phase === "move"
            ? place.t < 0.34
              ? place.k - 1
              : place.k
            : place.phase === "hold"
              ? place.k
              : place.phase === "join" && place.t < 0.34
                ? K - 1
                : K
      const sceneAt = Math.min(copyAt, K - 1)
      const stillAt = place.phase === "strip" ? Math.round(q) - 1 : -1
      if (state.scene !== sceneAt) setSceneBeat((state.scene = sceneAt))
      if (state.copy !== copyAt) setCopyBeat((state.copy = copyAt))
      if (state.still !== stillAt) setStill((state.still = stillAt))
      const load = Math.min(K, Math.max(state.load, sceneAt + 3))
      if (load > state.load) setLoadTo((state.load = load))
    }

    remeasure.current = () => {
      build()
      dirty = true
      sync()
    }

    measure()
    sync()
    const unsubscribe = onScrollFrame(sync)
    // Fonts arriving move the titles the callouts start from.
    void document.fonts?.ready.then(() => {
      measure()
      dirty = true
      requestScrollFrame()
    })
    return () => {
      unsubscribe()
      window.clearTimeout(rest)
      studioScene.key = null
      studioScene.floor = null
      studioScene.hot = null
      studioScene.dark = null
      remeasure.current = () => {}
      rig.style.transform = ""
      rig.style.willChange = ""
      delete rig.dataset.placed
    }
  }, [film])

  const scene = film ? sceneFor(sceneBeat) : undefined
  const showsCapture = film && copyBeat >= 0 && copyBeat < BEATS.length && Boolean(BEATS[copyBeat]!.capture)
  const activeChapter = copyBeat >= 0 && copyBeat < BEATS.length ? BEATS[copyBeat]!.chapter : -1

  return (
    <section
      ref={trackRef}
      aria-label="Realm, inside the window"
      className={css.track}
      style={{ "--film": PLAN.length.toFixed(3) } as CSSProperties}
    >
      {/* Where each chapter's hold begins, for the timeline's links. */}
      {chapters.map((chapter) => {
        const k = BEATS.findIndex((b) => b.chapter === chapters.indexOf(chapter))
        return (
          <span
            key={chapter.id}
            id={`at-${chapter.id}`}
            aria-hidden
            className={`${css.filmOnly} pointer-events-none absolute left-0 h-px w-px`}
            style={{ top: `${(PLAN.beats[k]!.hold * 100).toFixed(2)}vh` }}
          />
        )
      })}
      {PLAN.beats.map((seg, k) => (
        <span
          key={k}
          data-beat-hold={k}
          aria-hidden
          className={`${css.filmOnly} pointer-events-none absolute left-0 h-px w-px`}
          style={{ top: `${(((seg.hold + seg.end) / 2) * 100).toFixed(2)}vh` }}
        />
      ))}
      <span
        id="at-captures"
        aria-hidden
        className={`${css.filmOnly} pointer-events-none absolute left-0 h-px w-px`}
        style={{ top: `${(PLAN.strip.start * 100).toFixed(2)}vh` }}
      />

      <div className={css.stage} data-light-stage>
        <div ref={columnRef} className={css.column} data-light-words data-light-pad="96">
          <div aria-hidden className={css.shield} />
          <div className={css.copyGrid}>
            <Opening download={download} shown={copyBeat < 0} />

            {chapters.map((chapter, ci) => {
              const beats = BEATS.filter((b) => b.chapter === ci)
              const first = BEATS.indexOf(beats[0]!)
              const local = copyBeat - first
              const beat = beats[clamp(local, 0, beats.length - 1)]!
              const claim = caption(chapter.claim)
              return (
                <article
                  key={chapter.id}
                  aria-labelledby={`chapter-${chapter.id}`}
                  data-shown={activeChapter === ci}
                  className={`${css.copy} ${css.filmOnly}`}
                >
                  <h2
                    id={`chapter-${chapter.id}`}
                    ref={(node) => {
                      titleRefs.current[ci] = node
                    }}
                    className="text-[clamp(1.75rem,2.4vw,2.35rem)] leading-[1.08] font-[560] tracking-[-0.034em] text-balance text-ink"
                  >
                    {chapter.title}
                  </h2>
                  <p className="mt-5 text-[17px] leading-[1.55] text-ink-2">{chapter.body}</p>
                  {chapter.marks ? (
                    <ul aria-label="Agents" className="mt-5 flex flex-wrap items-center gap-x-3.5 gap-y-2 text-ink-2">
                      {chapter.marks.map((id) => (
                        <li key={id}>
                          <AgentMark id={id} className="h-[18px] w-[18px]" />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {beats.some((b) => b.line) ? (
                    <div className="mt-5 grid">
                      {beats.map((b, bi) =>
                        b.line ? (
                          <p
                            key={bi}
                            data-shown={activeChapter === ci && beat === b}
                            className={`${css.line} border-l border-accent/70 pl-4 text-[16px] leading-[1.5] text-ink`}
                          >
                            {b.line}
                          </p>
                        ) : null,
                      )}
                    </div>
                  ) : null}
                  <Source capture={Boolean(beat.capture)} caption={beat.capture ? claim?.caption : undefined} hint={chapter.try} />
                </article>
              )
            })}

            <article aria-labelledby="captures-title" data-shown={copyBeat >= BEATS.length} className={`${css.copy} ${css.filmOnly}`}>
              <h2 id="captures-title" className="text-[clamp(1.75rem,2.4vw,2.35rem)] leading-[1.08] font-[560] tracking-[-0.034em] text-balance text-ink">
                More of the app, captured.
              </h2>
              <p className="mt-5 text-[17px] leading-[1.55] text-ink-2">
                Every picture here is a capture of the shipped app, taken on a scratch home by the same script each release.
              </p>
              <div className="mt-6 grid">
                {stills.map((s, i) => (
                  <div key={s.slug} data-shown={still === i} className={css.line}>
                    <h3 className="text-[16px] leading-[1.4] font-[560] text-ink">{s.title}</h3>
                    <p className="mt-1.5 text-[15px] leading-[1.55] text-ink-2">{s.blurb}</p>
                    <p className="mt-3 font-mono text-[12px] text-ink-3">
                      {i + 1} of {stills.length}
                    </p>
                  </div>
                ))}
              </div>
            </article>
          </div>

          <Timeline playheadRef={playheadRef} current={activeChapter >= 0 ? chapters[activeChapter]!.short : copyBeat >= BEATS.length ? "Captures" : "Opening"} />
        </div>

        <div ref={layerRef} className={css.windowLayer}>
          <div ref={rigRef} className={css.rig}>
            <div ref={frameRef} className={css.frame} data-light-object data-light-r={WINDOW.radius} data-light-face="0.07">
              <div className={css.screen} inert={showsCapture}>
                <MiniRealm scene={scene} sceneRow={!film} />
              </div>
              {BEATS.map((beat, k) =>
                beat.capture ? (
                  <img
                    key={k}
                    ref={(node) => {
                      captureRefs.current[k] = node
                    }}
                    src={film && k <= loadTo ? captureSrc(beat.capture, 4320) : undefined}
                    alt={caption(chapters[beat.chapter]!.claim)?.caption ?? chapters[beat.chapter]!.title}
                    aria-hidden={copyBeat !== k}
                    width={1440}
                    height={900}
                    decoding="async"
                    className={css.capture}
                  />
                ) : null,
              )}
              <div aria-hidden className={css.edge} />
            </div>
          </div>

          <div className={css.stills} aria-label="More captures of the app">
            {stills.map((s, i) => (
              <figure
                key={s.slug}
                ref={(node) => {
                  stillRefs.current[i] = node
                }}
                className={css.still}
                data-light-object
                data-light-lit="0"
                data-light-r="12"
                data-light-face="0.08"
              >
                <img
                  src={film && loadTo >= BEATS.length - 2 ? captureSrc(s.slug, 1440) : undefined}
                  srcSet={film && loadTo >= BEATS.length - 2 ? `${captureSrc(s.slug, 1440)} 1440w, ${captureSrc(s.slug, 4320)} 4320w` : undefined}
                  sizes={`${Math.round(820 / s.cut[2])}px`}
                  alt={`${s.title}. ${s.blurb}`}
                  width={1440}
                  height={900}
                  decoding="async"
                  style={cutStyle(s.cut)}
                />
                <span aria-hidden className={css.edge} />
              </figure>
            ))}
          </div>
        </div>

        <svg aria-hidden className={css.callout}>
          <path ref={lineRef} fill="none" stroke="oklch(0.788 0.113 248.33 / 0.8)" strokeWidth={1} style={{ opacity: 0 }} />
          <path ref={bracketRef} fill="none" stroke="oklch(0.788 0.113 248.33 / 0.9)" strokeWidth={1.25} strokeLinecap="round" style={{ opacity: 0 }} />
          <circle ref={dotRef} r={2.5} fill="oklch(0.788 0.113 248.33)" style={{ opacity: 0 }} />
          <circle ref={ringRef} r={3.5} fill="var(--color-page)" stroke="oklch(0.788 0.113 248.33)" strokeWidth={1.25} style={{ opacity: 0 }} />
        </svg>
      </div>
      <div id="after-film" className="scroll-mt-16" />
    </section>
  )
}

/** The opening words: the page's one statement, and the way to get the app. */
function Opening({ download, shown }: { download: MacDownload; shown: boolean }) {
  // Once the tour has taken the column, the opening's links leave the tab order; the header still
  // carries the download.
  return (
    <div data-shown={shown} className={css.copy}>
      <Link
        href="/changelog/v2-1-0"
        inert={!shown}
        className="group inline-flex items-center gap-2.5 text-[13.5px] text-ink-2 transition-colors duration-150 hover:text-ink"
      >
        <span className="font-mono text-[12px] text-accent-ink">2.1</span>
        <span className="h-3.5 w-px bg-line-strong" aria-hidden />
        A team in every space
        <ArrowIcon className="h-3.5 w-3.5 transition-transform duration-200 ease-[var(--ease-out-strong)] group-hover:translate-x-0.5" />
      </Link>
      <h1 className="mt-6 text-[clamp(2.6rem,9.5vw,3.4rem)] leading-[0.98] font-[580] tracking-[-0.05em] text-balance text-ink lg:text-[clamp(2.75rem,3.7vw,3.6rem)]">
        Give your agents a world to work in.
      </h1>
      <p className="mt-6 text-[17px] leading-[1.55] text-ink-2">
        Bring the coding agent you already use. Each space holds a checkout, the agents working on it, and the terminals,
        browsers and documents they open. Every space sits in one sidebar on your Mac, and it&rsquo;s all still there tomorrow.
      </p>
      <div inert={!shown} className="mt-8 flex flex-wrap items-center gap-2.5">
        <DownloadButton href={download.href} />
        <QuietButton href={site.repo} external>
          <GitHubIcon className="h-4 w-4" />
          Source
        </QuietButton>
      </div>
      <p className="mt-3.5 font-mono text-[12px] text-ink-3">
        {download.version ? `${download.version} · ` : ""}macOS on Apple silicon · in active development
      </p>
      <p className="mt-8 flex items-center gap-2 text-[13px] text-ink-2">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-green" />
        The window is a working sample of Realm. Click anything in it.
      </p>
    </div>
  )
}

/** What the frame is showing: the sample, or a capture, and what is in it. */
function Source({ capture, caption, hint }: { capture: boolean; caption?: string; hint?: string }) {
  if (capture) {
    return (
      <p className="mt-6 flex gap-2.5 text-[14px] leading-[1.5] text-ink-2">
        <svg aria-hidden viewBox="0 0 14 12" className="mt-[4px] h-3 w-3.5 shrink-0 text-ink-3" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="0.6" y="0.6" width="12.8" height="10.8" rx="2" />
          <path d="M0.6 3.6h12.8" />
        </svg>
        <span>
          <span className="text-ink">A capture of the app.</span> {caption}
        </span>
      </p>
    )
  }
  return (
    <p className="mt-6 flex items-center gap-2.5 text-[14px] leading-[1.5] text-ink-2">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-green" />
      <span>
        <span className="text-ink">The working sample.</span> {hint ?? "Click anything in it."}
      </span>
    </p>
  )
}

function Timeline({ playheadRef, current }: { playheadRef: React.RefObject<HTMLSpanElement | null>; current: string }) {
  return (
    <nav aria-label="Chapters" className={`${css.timeline} pb-7`}>
      <div className="relative h-5">
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
        <ol className="absolute inset-0">
          {chapters.map((chapter, ci) => {
            const k = BEATS.findIndex((b) => b.chapter === ci)
            return (
              <li key={chapter.id} className="absolute top-0 h-full -translate-x-1/2" style={{ left: `${(PLAN.beats[k]!.hold / PLAN.length) * 100}%` }}>
                <a
                  href={`#at-${chapter.id}`}
                  className="group grid h-full w-3 place-items-center"
                  title={chapter.short}
                >
                  <span className="sr-only">{chapter.short}</span>
                  <span aria-hidden className="h-2 w-px bg-ink-3 transition-[height,background-color] duration-150 group-hover:h-3 group-hover:bg-ink" />
                </a>
              </li>
            )
          })}
          <li className="absolute top-0 h-full -translate-x-1/2" style={{ left: `${(PLAN.strip.start / PLAN.length) * 100}%` }}>
            <a href="#at-captures" className="group grid h-full w-3 place-items-center" title="Captures">
              <span className="sr-only">Captures</span>
              <span aria-hidden className="h-2 w-px bg-ink-3 transition-[height,background-color] duration-150 group-hover:h-3 group-hover:bg-ink" />
            </a>
          </li>
        </ol>
        <span ref={playheadRef} aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-full">
          <span className="absolute top-1/2 left-0 h-3.5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent" />
        </span>
      </div>
      <div className="mt-2.5 flex items-center justify-between text-[13px]">
        <span className="text-ink-2" aria-live="polite">
          {current}
        </span>
        <a href="#after-film" className="text-ink-3 transition-colors hover:text-ink">
          Skip the tour
        </a>
      </div>
    </nav>
  )
}
