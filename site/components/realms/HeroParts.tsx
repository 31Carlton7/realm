import type { CSSProperties } from "react"

import { DownloadButton, QuietButton } from "@/components/Buttons"
import { MiniRealm } from "@/components/home/mini/MiniRealm"
import { ArrowIcon, GitHubIcon } from "@/components/icons"
import { PassageLink } from "@/components/passage/PassageLink"
import type { Downloads } from "@/lib/release"
import { site } from "@/lib/site"

/**
 * The hero's words and its product view, as parts a concept composes in whatever layout its light
 * needs. The words are the landing page's own; a concept changes where they sit, never what they say.
 */

export type ConceptProps = { download: Downloads }

export function Announcement({ className = "" }: { className?: string }) {
  return (
    <PassageLink
      href="/changelog/v2-1-0"
      passage="warp"
      className={`inline-flex items-center gap-2.5 text-[13.5px] text-ink-2 transition-colors duration-150 ease-out hover:text-ink hover:duration-220 hover:ease-spring ${className}`}
    >
      <span className="font-mono text-[12px] text-accent-ink">2.1</span>
      <span className="h-3.5 w-px bg-line-strong" aria-hidden />
      Teams, and long sessions that open in a fifth of a second
      <ArrowIcon className="nudge h-3.5 w-3.5" />
    </PassageLink>
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
      terminals, browsers and documents they open. Every space sits in one sidebar on your computer, and it&rsquo;s all
      still there tomorrow.
    </p>
  )
}

export function Actions({ download, className = "", center = false }: ConceptProps & { className?: string; center?: boolean }) {
  return (
    <div className={className}>
      <div className={`flex flex-wrap items-center gap-2.5 ${center ? "justify-center" : ""}`}>
        <DownloadButton downloads={download} />
        <QuietButton href={site.repo} external>
          <GitHubIcon className="h-4 w-4" />
          Source
        </QuietButton>
      </div>
      <Qualifiers download={download} className={`mt-3.5 ${center ? "text-center" : ""}`} />
    </div>
  )
}

const buildLink = "text-ink-2 transition-colors duration-150 ease-out hover:text-ink hover:duration-220 hover:ease-spring focus-visible:text-ink"

/**
 * What the download is, under every download button: the version, that it is unfinished, and every
 * build by name — the button offers the reader's own system, and this line is how they reach the
 * others. The qualifiers stay on the page rather than in the small print of a store listing.
 */
export function Qualifiers({ download, className = "" }: ConceptProps & { className?: string }) {
  return (
    <div className={`font-mono text-[12px] leading-[1.7] text-ink-2 ${className}`}>
      <p>{download.version ? `${download.version} · ` : ""}in active development</p>
      <p>
        <a href={download.mac} className={buildLink}>
          <span className="link-line">Mac (Apple silicon)</span>
        </a>
        {" · "}
        <a href={download.windows} className={buildLink}>
          <span className="link-line">Windows</span>
        </a>
        {" · Linux x64: "}
        <a href={download.linux} className={buildLink}>
          <span className="link-line">AppImage</span>
        </a>
        {", "}
        <a href={download.deb} className={buildLink}>
          <span className="link-line">deb</span>
        </a>
      </p>
    </div>
  )
}

/**
 * The working sample of Realm, with the edge the pictures further down wear (Screen): Realm's own
 * window corner, the rim of the doorways' light on it, and the one-device-pixel outline with the
 * light from above catching its top. What it is stands on a tab cut from the window's top edge, as
 * each picture's caption hangs from its foot. `anchor` names the window's rect for the shader
 * (default "portal"), and `frameClassName` sizes it — the concept decides how much of the first
 * viewport the product takes.
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
      <div className="picture-edge hero-frame">
        {tab ? (
          <p data-edge="top" className="screen-tab flex items-center justify-center gap-2">
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-green" />
            <span>
              A working sample<span className="max-sm:hidden"> of Realm</span>. Click anything.
            </span>
          </p>
        ) : null}
        <div data-field-anchor={anchor} className={`hero-window relative w-full overflow-hidden rounded-[16px] bg-page ${frameClassName}`}>
          <MiniRealm />
          <span aria-hidden className="screen-light z-10" style={{ "--screen-radius": "16px" } as CSSProperties} />
        </div>
      </div>
    </div>
  )
}
