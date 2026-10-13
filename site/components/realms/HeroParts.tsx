import type { CSSProperties } from "react"
import Link from "next/link"

import { DownloadButton, QuietButton } from "@/components/Buttons"
import { MiniRealm } from "@/components/home/mini/MiniRealm"
import { ArrowIcon, GitHubIcon } from "@/components/icons"
import type { MacDownload } from "@/lib/release"
import { site } from "@/lib/site"

/**
 * The hero's words and its product view, as parts a concept composes in whatever layout its light
 * needs. The words are the landing page's own; a concept changes where they sit, never what they say.
 */

export type ConceptProps = { download: MacDownload }

export function Announcement({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/changelog/v2-1-0"
      className={`group inline-flex items-center gap-2.5 text-[13.5px] text-ink-2 transition-colors duration-150 hover:text-ink ${className}`}
    >
      <span className="font-mono text-[12px] text-accent-ink">2.1</span>
      <span className="h-3.5 w-px bg-line-strong" aria-hidden />
      Teams, and long sessions that open in a fifth of a second
      <ArrowIcon className="h-3.5 w-3.5 transition-transform duration-200 ease-[var(--ease-out-strong)] group-hover:translate-x-0.5" />
    </Link>
  )
}

export function Headline({ className = "" }: { className?: string }) {
  return (
    <h1 className={`text-[clamp(3rem,7vw,6rem)] leading-[0.94] font-[580] tracking-[-0.055em] text-balance text-ink ${className}`}>
      Give your agents a world to work in.
    </h1>
  )
}

export function Lede({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[17px] leading-[1.55] text-ink-2 ${className}`}>
      Bring the coding agent you already use. Each space holds a checkout, the agents working on it, and the
      terminals, browsers and documents they open. Every space sits in one sidebar on your Mac, and it&rsquo;s all
      still there tomorrow.
    </p>
  )
}

export function Actions({ download, className = "", center = false }: ConceptProps & { className?: string; center?: boolean }) {
  return (
    <div className={className}>
      <div className={`flex flex-wrap items-center gap-2.5 ${center ? "justify-center" : ""}`}>
        <DownloadButton href={download.href} />
        <QuietButton href={site.repo} external>
          <GitHubIcon className="h-4 w-4" />
          Source
        </QuietButton>
      </div>
      {/* The qualifiers stay on the page rather than in the small print of a store listing. */}
      <p className={`mt-3.5 font-mono text-[12px] text-ink-3 ${center ? "text-center" : ""}`}>
        {download.version ? `${download.version} · ` : ""}macOS on Apple silicon · in active development
      </p>
    </div>
  )
}

/**
 * The working sample of Realm, framed as the pictures further down are (Screen): Realm's own window
 * corner, a window's shadow, and on its edge the one-device-pixel outline with the light from above
 * catching its top. `anchor` names its rect for the shader (default "portal"), and `frameClassName`
 * sizes it — the concept decides how much of the first viewport the product takes.
 */
export function ProductWindow({
  className = "",
  frameClassName = "h-[620px] sm:h-[640px] lg:h-[min(680px,calc(100dvh-7rem))] lg:min-h-[560px]",
  anchor = "portal",
  tab = true,
}: {
  className?: string
  frameClassName?: string
  anchor?: string
  tab?: boolean
}) {
  return (
    <div className={className}>
      {tab ? (
        <p className="hero-tab relative z-10 ml-5 inline-flex h-8 items-center gap-2 bg-surface pr-7 pl-4 text-[12.5px] text-ink-2">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-green" />
          A working sample of Realm. Click anything.
        </p>
      ) : null}
      <div
        data-field-anchor={anchor}
        className={`relative w-full overflow-hidden rounded-[16px] bg-page shadow-[0_0_0_1px_oklch(0_0_0/0.5),0_30px_70px_-20px_oklch(0_0_0/0.65),0_80px_140px_-60px_oklch(0_0_0/0.5)] ${frameClassName}`}
      >
        <MiniRealm />
        <span aria-hidden className="screen-light z-10" style={{ "--screen-radius": "16px" } as CSSProperties} />
      </div>
    </div>
  )
}
