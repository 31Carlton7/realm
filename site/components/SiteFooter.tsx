import type { ReactNode } from "react"

import { GitHubIcon, GlobeIcon, LinkedInIcon, XIcon } from "@/components/icons"
import { ChangelogLink, HomeLink } from "@/components/passage/ChangelogLink"
import { Wordmark } from "@/components/Wordmark"
import { macDownload } from "@/lib/release"
import { site } from "@/lib/site"

/**
 * The site's footer, on every page: the name and the tagline, the places worth going, and who makes
 * Realm. It resolves the download link itself, as the header does, so a page only has to place it.
 *
 * `world` is what a page stands under it, and the landing page stands the black hole its flight ends
 * at there: a viewport of sky with the hole at its middle, so the page ends with the hole in the middle
 * of the view. The words keep to one band above it and `c:footer` names that band for the field, which
 * holds the hole's light off it: clean ground, with the hole's sky running on under it.
 */
const linkClass =
  "inline-flex min-h-8 items-center gap-2.5 text-ink-2 transition-colors duration-150 ease-out hover:text-ink hover:duration-220 hover:ease-spring focus-visible:text-ink"

export async function SiteFooter({ world }: { world?: ReactNode }) {
  const { href } = await macDownload()
  const { author } = site
  const socials = [
    { label: "X", ...author.x, Icon: XIcon },
    { label: "LinkedIn", ...author.linkedin, Icon: LinkedInIcon },
    { label: "GitHub", ...author.github, Icon: GitHubIcon },
    { label: "Website", ...author.site, Icon: GlobeIcon },
  ]
  return (
    <footer className="relative">
      <div className="relative z-[2] mx-auto w-full max-w-[92rem] px-6 pt-20 sm:px-10">
        <div data-field-anchor="c:footer" className="grid gap-x-10 gap-y-12 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="max-w-[26rem]">
            <HomeLink className="inline-block text-ink transition-opacity duration-150 ease-out hover:opacity-75 hover:duration-220 hover:ease-spring">
              <Wordmark />
            </HomeLink>
            <p className="mt-4 text-[16px] leading-[1.55] text-ink-2">{site.tagline}</p>
            <p className="mt-6 font-mono text-[12px] leading-[1.7] text-ink-2">
              © {new Date().getFullYear()} {author.name} · in active development
            </p>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 gap-y-10 sm:gap-x-20">
            <div>
              <h2 className="text-[13px] font-[520] text-ink">Realm</h2>
              <ul className="mt-3 space-y-1 text-[14px]">
                <li>
                  <a href={href} className={linkClass}>
                    <span className="link-line">Download for Mac</span>
                  </a>
                </li>
                <li>
                  <ChangelogLink className={linkClass}>
                    <span className="link-line">Changelog</span>
                  </ChangelogLink>
                </li>
                <li>
                  <a href={site.repo} target="_blank" rel="noreferrer noopener" className={linkClass}>
                    <span className="link-line">Source on GitHub</span>
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h2 className="text-[13px] font-[520] text-ink">Made by {author.name}</h2>
              <ul className="mt-3 space-y-1 text-[14px]">
                {socials.map(({ label, href: to, handle, Icon }) => (
                  <li key={label}>
                    <a href={to} target="_blank" rel="noreferrer noopener me" className={linkClass}>
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="link-line">
                        {handle}
                        <span className="sr-only"> on {label}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        </div>
      </div>
      {world ? <div className="relative mt-12">{world}</div> : <div className="h-24" />}
    </footer>
  )
}
