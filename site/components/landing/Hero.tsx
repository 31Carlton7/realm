"use client"

import { useRef } from "react"

import { DownloadButton, QuietButton } from "@/components/Buttons"
import type { Downloads } from "@/lib/release"
import { site } from "@/lib/site"

import { Aperture } from "./Aperture"
import { Crop, type Shot } from "./Crop"
import { Header } from "./Header"
import { World } from "./World"
import s from "./landing.module.css"

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
      <Header />
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
