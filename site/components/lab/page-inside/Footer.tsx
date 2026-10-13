import Link from "next/link"
import type { ComponentType } from "react"

import { GitHubIcon, GlobeIcon, LinkedInIcon, XIcon } from "@/components/icons"
import { Wordmark } from "@/components/Wordmark"
import type { MacDownload } from "@/lib/release"
import { site } from "@/lib/site"

import css from "./inside.module.css"

type Social = { label: string; href: string; handle: string; Icon: ComponentType<{ className?: string }> }

const linkClass = "inline-flex items-center gap-2.5 text-ink-2 transition-colors duration-150 hover:text-ink focus-visible:text-ink"

/**
 * The site's links, and who makes it. On a wide screen the page's last picture stays pinned while it
 * arrives, so it settles along the bottom of that same screen: the icon on its floor, the next action
 * beside it, and this under both.
 */
export function Footer({ download }: { download: MacDownload }) {
  const { author } = site
  const socials: Social[] = [
    { label: "X", ...author.x, Icon: XIcon },
    { label: "LinkedIn", ...author.linkedin, Icon: LinkedInIcon },
    { label: "GitHub", ...author.github, Icon: GitHubIcon },
    { label: "Website", ...author.site, Icon: GlobeIcon },
  ]
  return (
    <footer data-light-words data-light-pad="40" className={`${css.footer} mx-auto w-full max-w-[1680px] px-6 pt-16 pb-28 sm:px-10 lg:px-14`}>
      <div className="grid gap-12 border-t border-line pt-12 lg:grid-cols-[clamp(360px,30vw,452px)_minmax(0,1fr)] lg:gap-[132px]">
        <div>
          <Link href="/" className="inline-block text-ink transition-opacity duration-150 hover:opacity-75">
            <Wordmark />
          </Link>
          <p className="mt-4 max-w-[34ch] text-[15px] leading-[1.55] text-ink-2">{site.tagline}</p>
          <p className="mt-6 font-mono text-[12px] leading-[1.7] text-ink-3">
            © {new Date().getFullYear()} {author.name}
            <br />
            Realm is in active development
          </p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 gap-y-10 sm:max-w-[34rem]">
          <div>
            <h2 className="text-[13px] font-[520] text-ink">Realm</h2>
            <ul className="mt-4 space-y-3 text-[14px]">
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
            <h2 className="text-[13px] font-[520] text-ink">Made by {author.name}</h2>
            <ul className="mt-4 space-y-3 text-[14px]">
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
      </div>
    </footer>
  )
}
