"use client"

import { useRef } from "react"

import { site } from "@/lib/site"

import { Aperture } from "./Aperture"
import s from "./portal.module.css"

const MARK =
  "M0.5196 24.9A1.8 1.8 0 0 1 0.5196 23.1L9.4804 7.5795A1.8 1.8 0 0 1 11.0392 6.6795L28.9608 6.6795A1.8 1.8 0 0 1 30.5196 7.5795L39.4804 23.1A1.8 1.8 0 0 1 39.4804 24.9L30.5196 40.4205A1.8 1.8 0 0 1 28.9608 41.3205L11.0392 41.3205A1.8 1.8 0 0 1 9.4804 40.4205ZM24.4 20.8823L28.2 14.3005L35.9 27.6373L32.1 34.2191Z"

export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 48" aria-hidden className={className} fill="currentColor">
      <path fillRule="evenodd" d={MARK} />
    </svg>
  )
}

export function Hero({ version }: { version: string }) {
  const ring = useRef<HTMLDivElement>(null)
  return (
    <section className={s.hero}>
      <Aperture realm="aperture" ring={ring} className={s.sky} />
      <header className={s.nav}>
        <a href="/" className={s.brand}>
          <Mark className={s.brandMark} />
          <span>Realm</span>
        </a>
        <nav className={s.links}>
          <a href="/docs">Docs</a>
          <a href="/changelog">Changelog</a>
          <a href={site.repo}>GitHub</a>
          <a href={`${site.repo}/releases/latest`} className={s.navDownload}>Download</a>
        </nav>
      </header>
      <div className={s.ring} ref={ring} aria-hidden>
        <Mark className={s.ringMark} />
      </div>
      <div className={s.heroCopy}>
        <h1 className={s.h1}>One workspace for every coding agent.</h1>
        <p className={s.lede}>
          Run Claude Code, Codex, Cursor and the rest side by side on your Mac, each signed in with your own
          account. Give them jobs as teammates, and keep an eye on them from your phone.
        </p>
        <div className={s.actions}>
          <a href={`${site.repo}/releases/latest`} className={s.primary}>Download for Mac</a>
          <a href={site.repo} className={s.secondary}>View on GitHub</a>
        </div>
        <p className={s.micro}>Free and open source, MIT licence. Version {version}.</p>
      </div>
    </section>
  )
}
