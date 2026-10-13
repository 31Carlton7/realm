"use client"

import { useEffect, useRef } from "react"

import { DownloadButton, QuietButton } from "@/components/Buttons"
import { GitHubIcon } from "@/components/icons"
import type { MacDownload } from "@/lib/release"
import { site } from "@/lib/site"

import { mix, ramp, smoother } from "./camera"
import { captureSrc } from "./content"
import { FILM_QUERY } from "./Film"
import { onScrollFrame } from "./frames"
import css from "./inside.module.css"
import { studioScene } from "./scene"

/** The icon's body inside its 1024 canvas (resources/icon-src/icons.mjs): 824 square, centred. */
const BODY = 824 / 1024

/**
 * The page's one next action, and its last picture: the window, shrinking as the reader scrolls
 * into the app icon it ships as, standing on the same floor in the same light. The icon is the
 * download, and so is the button beside it.
 *
 * The window is a capture of the app; as it shrinks it squares off and rounds its corners into the
 * icon's body, and the capture gives way to the icon itself. Where the tour does not run, the icon
 * simply stands there, lit.
 */
export function Close({ download }: { download: MacDownload }) {
  const trackRef = useRef<HTMLElement>(null)
  const setRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLAnchorElement>(null)
  const shotRef = useRef<HTMLImageElement>(null)
  const iconRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    const track = trackRef.current
    const set = setRef.current
    const frame = frameRef.current
    const shot = shotRef.current
    const icon = iconRef.current
    if (!track || !set || !frame || !shot || !icon) return
    const query = window.matchMedia(FILM_QUERY)
    let last = ""

    const place = (x: number, y: number, w: number, h: number, r: number, mixIcon: number) => {
      frame.style.transform = `translate3d(${(x - w / 2).toFixed(2)}px, ${(y - h / 2).toFixed(2)}px, 0)`
      frame.style.width = `${w.toFixed(2)}px`
      frame.style.height = `${h.toFixed(2)}px`
      frame.style.borderRadius = `${r.toFixed(2)}px`
      frame.dataset.lightR = r.toFixed(2)
      frame.dataset.lightShape = mixIcon > 0.5 ? "squircle" : "round"
      frame.dataset.lightFace = mix(0.07, 0.22, mixIcon).toFixed(3)
      shot.style.opacity = (1 - mixIcon).toFixed(3)
      const size = w / BODY
      icon.style.width = `${size.toFixed(2)}px`
      icon.style.height = `${size.toFixed(2)}px`
      icon.style.transform = `translate3d(${(x - size / 2).toFixed(2)}px, ${(y - size / 2).toFixed(2)}px, 0)`
      icon.style.opacity = mixIcon.toFixed(3)
      frame.tabIndex = mixIcon > 0.9 ? 0 : -1
    }

    const sync = () => {
      const film = query.matches
      const box = set.getBoundingClientRect()
      const onScreen = box.bottom > -200 && box.top < window.innerHeight + 200
      const t = track.getBoundingClientRect()
      const p = film ? Math.min(1, Math.max(0, -t.top / Math.max(t.height - window.innerHeight, 1))) : 1
      const key = `${film}|${p.toFixed(4)}|${box.left}|${box.top}|${box.width}|${box.height}`
      if (onScreen) {
        // The light is aimed at the icon, from above it and to the key side, with the floor at its foot.
        studioScene.key = [box.left + box.width * 0.55, box.top + box.height * 0.35, Math.max(260, box.width * 0.6), 1]
        studioScene.floor = null
        studioScene.dark = null
      }
      if (key === last) return
      last = key
      const iconSize = Math.min(176, Math.max(124, box.width * 0.2))
      const cx = box.left + box.width / 2
      const cy = box.top + box.height * (film ? 0.44 : 0.5)
      const w0 = Math.min(box.width * 0.94, 980)
      const h0 = w0 * 0.625
      const shrink = smoother(ramp(0.04, 0.8, p))
      const square = smoother(ramp(0.3, 0.86, p))
      const w = Math.exp(mix(Math.log(w0), Math.log(iconSize), shrink))
      const h = Math.exp(mix(Math.log(h0), Math.log(iconSize), Math.min(shrink, square)))
      const r = mix(14, iconSize * 0.24, smoother(ramp(0.35, 0.9, p)))
      place(cx - box.left, cy - box.top, w, h, r, ramp(0.62, 0.92, p))
    }
    return onScrollFrame(sync)
  }, [])

  return (
    <section ref={trackRef} aria-labelledby="close-title" className={css.closeTrack} data-light-stage>
      <div className={css.closeStage}>
        <div className={css.closeCopy} data-light-words data-light-pad="72">
          <h2 id="close-title" className="text-[clamp(2.2rem,4.6vw,3.6rem)] leading-[1] font-[580] tracking-[-0.05em] text-balance text-ink">
            Open your first realm.
          </h2>
          <p className="mt-5 max-w-[44ch] text-[17px] leading-[1.55] text-ink-2">
            Point it at a checkout, start a session with an agent you already have, and leave the window open all day.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-2.5">
            <DownloadButton href={download.href} size="lg" />
            <QuietButton href={site.repo} external>
              <GitHubIcon className="h-4 w-4" />
              Read the source
            </QuietButton>
          </div>
          <p className="mt-4 font-mono text-[12px] text-ink-3">{download.version ? `${download.version} · ` : ""}macOS on Apple silicon</p>
        </div>

        <div ref={setRef} className={css.closeSet}>
          <a
            ref={frameRef}
            href={download.href}
            aria-label="Download Realm for Mac"
            tabIndex={-1}
            className={css.morph}
            data-light-object
            data-light-r="14"
            data-light-face="0.07"
          >
            <img ref={shotRef} src={captureSrc("workspace", 1440)} alt="" width={1440} height={900} loading="lazy" decoding="async" className={css.morphShot} />
            <span aria-hidden className={css.edge} />
          </a>
          <img ref={iconRef} src="/lab/inside/realm-icon.svg" alt="" aria-hidden width={1024} height={1024} className={css.morphIcon} />
        </div>
      </div>
    </section>
  )
}
