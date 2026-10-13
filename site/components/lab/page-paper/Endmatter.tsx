import Link from "next/link"
import type { ComponentType } from "react"

import { AppleIcon, GitHubIcon, GlobeIcon, LinkedInIcon, XIcon } from "@/components/icons"
import { Wordmark } from "@/components/Wordmark"
import type { MacDownload } from "@/lib/release"
import { site } from "@/lib/site"

import { Ink, Seam } from "./kinetic"
import s from "./paper.module.css"

/**
 * The last page before the colophon: one action, set large, with the qualifiers beside it rather
 * than in small print somewhere else.
 */
export function Close({ download }: { download: MacDownload }) {
  return (
    <section data-running-head="Download" aria-labelledby="close-title" className={`${s.section} !pb-[clamp(96px,12vw,180px)]`}>
      <Seam />
      <div className={`${s.measure} ${s.grid} items-end gap-y-10`}>
        <div className="col-span-12 lg:col-span-8">
          {/* The last statement inks in a word at a time, settling at the display weight as it rises. */}
          <h2
            id="close-title"
            className={`${s.display} ${s.inkScope} !text-[clamp(3rem,6.4vw,7.5rem)] text-ink`}
            style={{ ["--set-weight" as string]: 640, ["--set-tracking" as string]: "-0.046em", ["--step" as string]: "4.5%" }}
          >
            {["Open", "your", "first", "realm."].map((word, i) => (
              <span key={word}>
                <Ink index={i}>{word}</Ink>{" "}
              </span>
            ))}
          </h2>
        </div>
        <div className="col-span-12 lg:col-span-4 lg:pb-3">
          <p className={s.lede}>
            Point it at a checkout, start a session with an agent you already have, and leave the window open all day.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a href={download.href} className={s.download}>
              <AppleIcon className="h-4 w-4 -translate-y-px" />
              Download for Mac
            </a>
            <a href={site.repo} target="_blank" rel="noreferrer noopener" className={s.quiet}>
              <GitHubIcon className="h-4 w-4" />
              Read the source
            </a>
          </div>
          <p className={`${s.note} mt-4`}>
            {download.version ? `${download.version} · ` : ""}macOS on Apple silicon · in active development
          </p>
        </div>
      </div>
    </section>
  )
}

type Social = { label: string; href: string; handle: string; Icon: ComponentType<{ className?: string }> }

const linkClass = "inline-flex min-h-8 items-center gap-2.5 text-ink-2 transition-colors duration-150 hover:text-ink"

/**
 * The colophon: how the page was made, set the way a book sets its own, with the site's links and
 * who makes it. Every sentence in it is a fact about this page or the captures on it.
 */
export function Colophon({ download }: { download: MacDownload }) {
  const { author } = site
  const socials: Social[] = [
    { label: "X", ...author.x, Icon: XIcon },
    { label: "LinkedIn", ...author.linkedin, Icon: LinkedInIcon },
    { label: "GitHub", ...author.github, Icon: GitHubIcon },
    { label: "Website", ...author.site, Icon: GlobeIcon },
  ]
  return (
    <footer data-running-head="Colophon" className="pb-24">
      <Seam />
      <div className={`${s.measure} ${s.grid} gap-y-12`}>
        <div className="col-span-12 lg:col-span-4">
          <Link href="/" className="inline-block text-ink transition-opacity duration-150 hover:opacity-70">
            <Wordmark />
          </Link>
          <p className="mt-4 max-w-[30ch] text-[15px] leading-[1.55] text-ink-2">{site.tagline}</p>
        </div>

        <div className="col-span-12 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-5 sm:col-span-6 lg:col-span-4">
          {/* The printer's device: the glass mark from the first page, as a still. */}
          <img
            src="/lab/paper/glass-device.webp"
            alt=""
            aria-hidden
            width={180}
            height={180}
            loading="lazy"
            decoding="async"
            className="row-span-2 -mt-3 h-[5.5rem] w-[5.5rem] [mask-image:radial-gradient(closest-side,#000_62%,transparent)]"
          />
          <h2 className="text-[13px] font-[560] text-ink">Colophon</h2>
          <p className="mt-3 max-w-[42ch] text-[14px] leading-[1.6] text-ink-2">
            Set in Inter and JetBrains Mono, the two faces the app itself uses. Every plate is a capture of the shipped
            app, taken on a scratch home by the same script each release. The glass mark on the first page is drawn as you
            look at it, from the mark&rsquo;s own vector.
          </p>
        </div>

        <nav aria-label="Footer" className="col-span-12 grid grid-cols-2 gap-x-8 gap-y-10 sm:col-span-6 lg:col-span-4">
          <div>
            <h2 className="text-[13px] font-[560] text-ink">Realm</h2>
            <ul className="mt-3 space-y-1 text-[14px]">
              <li>
                <a href={download.href} className={linkClass}>
                  Download for Mac
                </a>
              </li>
              <li>
                <Link href="/features" className={linkClass}>
                  Features
                </Link>
              </li>
              <li>
                <Link href="/changelog" className={linkClass}>
                  Changelog
                </Link>
              </li>
              <li>
                <a href={site.repo} target="_blank" rel="noreferrer noopener" className={linkClass}>
                  Source on GitHub
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h2 className="text-[13px] font-[560] text-ink">Made by {author.name}</h2>
            <ul className="mt-3 space-y-1 text-[14px]">
              {socials.map(({ label, href, handle, Icon }) => (
                <li key={label}>
                  <a href={href} target="_blank" rel="noreferrer noopener me" className={linkClass}>
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span>
                      {handle}
                      <span className="sr-only"> on {label}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>

        <p className={`${s.note} col-span-12 border-t border-line pt-5`}>
          © {new Date().getFullYear()} {author.name} · Realm is in active development
          {download.version ? ` · ${download.version}` : ""}
        </p>
      </div>
    </footer>
  )
}
