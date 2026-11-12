"use client"

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react"
import { frame, init, surface } from "vgpu"

import { PAGE, type Rect, type StageInput } from "@/components/field/stage"
import { directedRealms } from "@/components/realms/stage"
import { Wordmark } from "@/components/Wordmark"
import { claims } from "@/content/home"
import { site } from "@/lib/site"

import { createFilm, FILM, PICTURES, type Overlay, type PictureId, type WordsId } from "./director"

declare global {
  interface Window {
    /** The film, for the script that records it (scripts/film-capture.mjs): `seek` resolves once that
     *  frame is drawn and on screen, and every frame from `still` on is the same one. */
    __film?: { duration: number; still: number; ready: Promise<void>; seek(t: number): Promise<void> }
  }
}

/** The site's own line for each stop: the claim's title, word for word. */
function title(id: string) {
  const claim = claims.find((c) => c.id === id)
  if (!claim) throw new Error(`The site has no claim "${id}" for the film to quote`)
  return claim.title
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/** A block of the film's words, hidden until the timeline brings it up. */
function Words({ id, className = "", children }: { id: WordsId; className?: string; children: ReactNode }) {
  return (
    <div data-film-words={id} className={`invisible opacity-0 ${className}`}>
      {children}
    </div>
  )
}

/**
 * The launch film: the landing page's world drawn from a timeline (director.ts) at 1920 × 1080, with the
 * app's real captures coming out of its realms' doorways and the site's own words over it.
 *
 * Opened plainly it plays on a loop, the stage scaled to the window. With `?capture` it waits, and
 * `window.__film.seek(t)` draws exactly the frame at `t`: the overlay is laid out for that moment, the
 * world is drawn for it, and the promise resolves once the GPU has finished and two frames have been
 * shown, so a screenshot taken then is that frame.
 */
export function Film() {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const root = stageRef.current
    const canvas = canvasRef.current
    if (!root || !canvas) return
    const capture = new URLSearchParams(window.location.search).has("capture")
    let disposed = false
    let teardown: (() => void) | undefined

    // The stage is always 1920 × 1080; a window of any other size sees it scaled to fit.
    const fit = () => {
      const k = Math.min(window.innerWidth / FILM.width, window.innerHeight / FILM.height)
      root.style.transform = `translate(${(window.innerWidth - FILM.width * k) / 2}px, ${(window.innerHeight - FILM.height * k) / 2}px) scale(${k})`
      return k
    }
    fit()
    window.addEventListener("resize", fit)

    const film = createFilm()
    const words = new Map<WordsId, HTMLElement>()
    for (const el of root.querySelectorAll<HTMLElement>("[data-film-words]")) words.set(el.dataset.filmWords as WordsId, el)
    const pictures = new Map<PictureId, HTMLElement>()
    for (const el of root.querySelectorAll<HTMLElement>("[data-film-picture]")) pictures.set(el.dataset.filmPicture as PictureId, el)
    const dark = root.querySelector<HTMLElement>("[data-film-dark]")!

    const lay = (overlay: Overlay) => {
      dark.style.opacity = overlay.dark.toFixed(4)
      for (const [id, el] of words) {
        const w = overlay.words[id]
        el.style.visibility = w.opacity > 0.001 ? "visible" : "hidden"
        el.style.opacity = w.opacity.toFixed(4)
        el.style.filter = w.blur > 0.01 ? `blur(${w.blur.toFixed(2)}px)` : ""
        el.style.transform = w.rise > 0.01 ? `translate3d(0, ${w.rise.toFixed(2)}px, 0)` : ""
      }
      for (const [id, el] of pictures) {
        const p = overlay.pictures[id]
        if (!p) {
          el.style.visibility = "hidden"
          continue
        }
        const [x, y, w, h] = p.rect
        el.style.visibility = "visible"
        el.style.width = `${w.toFixed(2)}px`
        el.style.height = `${h.toFixed(2)}px`
        el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`
        el.style.opacity = p.shown.toFixed(4)
      }
    }

    const input = (seconds: number): StageInput => ({ width: FILM.width, height: FILM.height, seconds, still: false, pointer: [0, 0, 0], anchors: {} })

    let resolveReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    let seekFrame: (t: number) => Promise<void> = async () => {}
    window.__film = {
      duration: FILM.duration,
      still: FILM.still,
      ready,
      seek: async (t) => {
        await ready
        await seekFrame(t)
      },
    }

    void (async () => {
      const gpu = await init({ label: "realm-film" })
      if (disposed) {
        gpu.dispose()
        return
      }
      const output = surface(gpu, canvas, { size: [FILM.width, FILM.height], clearColor: [...PAGE, 1] })
      const stage = await directedRealms(film)(gpu, output)

      // Type and pictures settled before anything is measured or drawn.
      await document.fonts.ready
      await Promise.all([...root.querySelectorAll("img")].map((img) => img.decode().catch(() => {})))
      // Where each block of words rests, in the stage's own pixels: the field is held off it.
      const k = fit()
      const origin = root.getBoundingClientRect()
      for (const [id, el] of words) {
        const r = el.getBoundingClientRect()
        const rect: Rect = [(r.left - origin.left) / k, (r.top - origin.top) / k, r.width / k, r.height / k]
        film.measure(id, rect)
      }
      if (disposed) {
        stage.dispose?.()
        gpu.dispose()
        return
      }

      const draw = (t: number) => {
        lay(film.overlay(t))
        return frame(gpu, (f) => stage.draw(f, input(t)))
      }
      seekFrame = async (t: number) => {
        await draw(t).done
        await nextFrame()
        await nextFrame()
      }
      await seekFrame(0)
      resolveReady()

      let raf = 0
      if (!capture) {
        const start = performance.now()
        const play = () => {
          draw(((performance.now() - start) / 1000) % FILM.duration)
          raf = requestAnimationFrame(play)
        }
        raf = requestAnimationFrame(play)
      }
      teardown = () => {
        cancelAnimationFrame(raf)
        stage.dispose?.()
        gpu.dispose()
      }
    })()

    return () => {
      disposed = true
      window.removeEventListener("resize", fit)
      teardown?.()
      delete window.__film
    }
  }, [])

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <div ref={stageRef} className="absolute top-0 left-0 origin-top-left overflow-hidden bg-[#03050b]" style={{ width: FILM.width, height: FILM.height }}>
        <canvas ref={canvasRef} aria-hidden className="absolute inset-0 block h-full w-full" />
        <div data-film-dark aria-hidden className="absolute inset-0 bg-[#03050b]" />

        {(Object.keys(PICTURES) as PictureId[]).map((id) => {
          const picture = PICTURES[id]
          return (
            <div
              key={id}
              data-film-picture={id}
              data-kind={picture.kind}
              className="screen invisible"
              // Placed inline: the site's `.screen` rule lays a picture out in the page's flow.
              style={{ "--share-wide": picture.radius / picture.width, position: "absolute", top: 0, left: 0, maxWidth: "none" } as CSSProperties}
            >
              <figure className="screen-figure @container">
                <div className="picture-edge screen-frame">
                  <img src={picture.src} alt="" width={picture.width} height={picture.height} decoding="sync" className="screen-image" />
                  <span aria-hidden className="screen-light" />
                </div>
              </figure>
            </div>
          )
        })}

        <div className="absolute inset-x-0 top-[540px] flex justify-center text-ink">
          <Words id="wordmark">
            <Wordmark size="title" />
          </Words>
        </div>
        <div className="absolute inset-x-0 top-[660px] flex justify-center">
          <Words id="tagline">
            <h1 className="max-w-[1180px] text-center text-[64px] leading-[1.06] font-[580] tracking-[-0.04em] text-balance text-ink">One workspace for every coding agent, on any computer.</h1>
          </Words>
        </div>

        {(["agents", "delegation", "gateway"] as const).map((id) => (
          <div key={id} className="absolute inset-y-0 left-[168px] flex w-[700px] items-center">
            <Words id={id} className="w-full">
              <h2 className="text-[76px] leading-[1.02] font-[580] tracking-[-0.045em] text-balance text-ink">{title(id)}</h2>
            </Words>
          </div>
        ))}

        <div className="absolute inset-x-0 top-[376px] flex justify-center text-ink">
          <Words id="endmark">
            <Wordmark size="end" />
          </Words>
        </div>
        <div className="absolute inset-x-0 top-[558px] flex justify-center">
          <Words id="domain">
            <p className="text-[52px] leading-none font-[520] tracking-[-0.02em] text-ink">{site.domain}</p>
          </Words>
        </div>
        <div className="absolute inset-x-0 top-[646px] flex justify-center">
          <Words id="download">
            <p className="text-[40px] leading-none font-[450] tracking-[-0.01em] text-ink-2">Download for Mac, Windows and Linux</p>
          </Words>
        </div>
      </div>
    </div>
  )
}
