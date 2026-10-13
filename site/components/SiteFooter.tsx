import Link from "next/link"

import { GitHubIcon, GlobeIcon, LinkedInIcon, XIcon } from "@/components/icons"
import { Wordmark } from "@/components/Wordmark"
import { macDownload } from "@/lib/release"
import { site } from "@/lib/site"

/**
 * The site's footer, on every page: the name and the tagline, the places worth going, and who makes
 * Realm. It resolves the download link itself, as the header does, so a page only has to place it.
 * `c:footer` names its block for a live field behind it, which keeps area light off its words.
 */
const linkClass = "inline-flex items-center gap-2.5 text-ink-2 transition-colors duration-150 hover:text-ink focus-visible:text-ink"

export async function SiteFooter() {
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
      <div className="relative z-[2] mx-auto w-full max-w-[92rem] px-6 pt-16 pb-44 sm:px-10">
        <div data-field-anchor="c:footer" className="flex flex-col gap-12 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-[24rem]">
          <Link href="/" className="inline-block text-ink transition-opacity duration-150 hover:opacity-75">
            <Wordmark />
          </Link>
          <p className="mt-4 text-[15px] leading-[1.55] text-ink-2">{site.tagline}</p>
          <p className="mt-8 font-mono text-[12px] leading-[1.7] text-ink-2">
            © {new Date().getFullYear()} {author.name}
            <br />
            Realm is in active development
          </p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 gap-y-10 sm:gap-x-20">
          <div>
            <h2 className="text-[13px] font-[520] text-ink">Realm</h2>
            <ul className="mt-4 space-y-3 text-[14px]">
              <li>
                <a href={href} className={linkClass}>
                  Download for Mac
                </a>
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
              {socials.map(({ label, href: to, handle, Icon }) => (
                <li key={label}>
                  <a href={to} target="_blank" rel="noreferrer noopener me" className={linkClass}>
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
      </div>
    </footer>
  )
}
