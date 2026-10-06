import Link from "next/link"
import type { ComponentType } from "react"

import { GitHubIcon, GlobeIcon, LinkedInIcon, XIcon } from "@/components/icons"
import { Wordmark } from "@/components/Wordmark"
import { macDownload } from "@/lib/release"
import { site } from "@/lib/site"

type Social = { label: string; href: string; handle: string; Icon: ComponentType<{ className?: string }> }

const linkClass =
  "inline-flex items-center gap-2.5 text-ink-2 transition-colors duration-150 hover:text-ink focus-visible:text-ink"

/**
 * The page's floor, literally: the field draws the mark's lattice laid flat to a horizon in
 * `data-dim="horizon"`, and the glass mark rising over it as the page ends. Every word sits above that
 * area, so the last thing on the page is the scene itself, uninterrupted.
 *
 * Carlton's accounts are the ones his GitHub profile lists. The page is otherwise about the product,
 * so this is the one place it says who makes it.
 */
export async function Footer() {
  const download = await macDownload()
  const { author } = site
  const socials: Social[] = [
    { label: "X", ...author.x, Icon: XIcon },
    { label: "LinkedIn", ...author.linkedin, Icon: LinkedInIcon },
    { label: "GitHub", ...author.github, Icon: GitHubIcon },
    { label: "Website", ...author.site, Icon: GlobeIcon },
  ]

  return (
    <footer data-dim-stage="footer" className="relative flex min-h-[88dvh] flex-col">
      <div className="mx-auto w-full max-w-[92rem] px-6 pt-20 sm:px-10 sm:pt-28">
        <div className="flex flex-col gap-12 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-[24rem]">
            <Link href="/" className="inline-block text-ink transition-opacity duration-150 hover:opacity-75">
              <Wordmark />
            </Link>
            <p className="mt-4 text-[15px] leading-[1.55] text-ink-2">{site.tagline}</p>
            <p className="mt-8 font-mono text-[12px] leading-[1.7] text-ink-3">
              © {new Date().getFullYear()} {author.name}
              <br />
              Realm is in active development
            </p>
          </div>

          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 gap-y-10 sm:gap-x-20">
            <div>
              <h2 className="text-[13px] font-[520] tracking-[-0.005em] text-ink">Realm</h2>
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
              <h2 className="text-[13px] font-[520] tracking-[-0.005em] text-ink">Made by {author.name}</h2>
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
      </div>

      {/* The scene. Without WebGPU the field never draws, so the plain mark stands on a CSS horizon. */}
      <div data-dim="horizon" className="relative mt-12 min-h-[20rem] flex-1 sm:mt-16" aria-hidden>
        <div className="absolute inset-x-0 top-[44%] hidden h-px bg-accent/40 shadow-[0_0_40px_6px_oklch(0.68_0.173_253.301/0.35)] [html[data-dim-field=off]_&]:block" />
        <img
          src="/realm-mark.svg"
          alt=""
          className="absolute top-[44%] left-1/2 hidden h-24 w-auto -translate-x-1/2 -translate-y-full [html[data-dim-field=off]_&]:block"
        />
      </div>

    </footer>
  )
}
