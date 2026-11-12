"use client"

import { useRef } from "react"

import { DownloadButton, QuietButton } from "@/components/Buttons"
import type { Downloads } from "@/lib/release"
import { site } from "@/lib/site"

import { Aperture } from "./Aperture"
import { Crop, type Shot } from "./Crop"
import { World } from "./World"
import s from "./landing.module.css"

const MARK =
  "M0.5196 24.9A1.8 1.8 0 0 1 0.5196 23.1L9.4804 7.5795A1.8 1.8 0 0 1 11.0392 6.6795L28.9608 6.6795A1.8 1.8 0 0 1 30.5196 7.5795L39.4804 23.1A1.8 1.8 0 0 1 39.4804 24.9L30.5196 40.4205A1.8 1.8 0 0 1 28.9608 41.3205L11.0392 41.3205A1.8 1.8 0 0 1 9.4804 40.4205ZM24.4 20.8823L28.2 14.3005L35.9 27.6373L32.1 34.2191Z"

function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 48" aria-hidden className={className} fill="currentColor">
      <path fillRule="evenodd" d={MARK} />
    </svg>
  )
}

type Props = {
  downloads: Downloads
  version: string
  changelog: string
  world: { file: string }
  session: Shot
}

export function Hero({ downloads, version, changelog, world, session }: Props) {
  const ring = useRef<HTMLDivElement>(null)
  return (
    <section className={s.hero}>
      <div className={s.ring} ref={ring}>
        <World file={world.file} x={0.4} y={0.4} className={s.ringWorld} />
      </div>
      <Aperture ring={ring} className={s.sky} />
      <header className={s.nav}>
        <a href="/" className={s.brand} data-clear>
          <Mark className={s.brandMark} />
          <span>Realm</span>
        </a>
        <nav className={s.links} aria-label="Site" data-clear>
          <a href="/docs">Docs</a>
          <a href="/changelog">Changelog</a>
          <a href={site.repo}>Source</a>
        </nav>
      </header>
      <div className={s.heroCopy}>
        <h1 className={s.h1} data-clear>One workspace for every coding agent.</h1>
        <p className={s.lede} data-clear>
          Run Claude Code, Codex and the other agents you already use side by side on your computer. Each one signs in
          the way it already does, with your own account or key.
        </p>
        <div className={s.actions} data-clear>
          <DownloadButton downloads={downloads} size="lg" />
          <QuietButton href={site.repo}>Source</QuietButton>
        </div>
        <p className={s.micro} data-clear>
          Free and open source under the MIT licence.{" "}
          <a href={`/changelog/${changelog}`} className={s.release}>
            What&apos;s new in Realm <span className="font-mono text-[12px] text-accent-ink">{version}</span>
          </a>
        </p>
      </div>
      <figure className={s.heroShot}>
        <Crop shot={session} sizes={{ wide: "min(960px, 100vw - 56px)", phone: "calc(100vw - 40px)" }} />
        <figcaption className={s.caption} data-clear>A new session in Realm, opened onto Cosmic Cliffs.</figcaption>
      </figure>
    </section>
  )
}
