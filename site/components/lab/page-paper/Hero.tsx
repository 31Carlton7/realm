import Link from "next/link"

import { MiniRealm } from "@/components/home/mini/MiniRealm"
import { AppleIcon, ArrowIcon, GitHubIcon } from "@/components/icons"
import type { MacDownload } from "@/lib/release"
import { site } from "@/lib/site"

import { GlassLight } from "./glass/GlassLight"
import { GlassStill } from "./glass/GlassStill"
import s from "./paper.module.css"

/**
 * The title spread. The headline is set at display size on the left; on the right, on the same paper,
 * the mark stands as a block of glass and bends the light that falls on it. Under both, the first
 * plate: a working sample of the app, which is the product the page is about, in its own dark face.
 */
export function Hero({ download }: { download: MacDownload }) {
  return (
    <section aria-labelledby="paper-title" className="relative pt-10 sm:pt-14 lg:pt-12">
      <div className={`${s.measure} ${s.grid} relative`}>
        <div className="col-span-12 lg:col-span-8 lg:pt-10">
          <Link
            href="/changelog/v2-1-0"
            className={`${s.note} group inline-flex items-baseline gap-3 text-ink-2 transition-colors duration-150 hover:text-ink`}
          >
            <span className="text-accent-ink">2.1</span>
            <span>A team in every space, and long sessions that open in a fifth of a second</span>
            <ArrowIcon className="h-3 w-3 translate-y-[1px] transition-transform duration-200 ease-[var(--ease-out-strong)] group-hover:translate-x-0.5" />
          </Link>

          <h1 id="paper-title" className={`${s.display} mt-7 max-w-[10.5ch] text-ink sm:mt-9`}>
            Give your agents a world to work in.
          </h1>

          <div className="mt-9 grid gap-8 sm:mt-11 md:grid-cols-[minmax(0,26rem)_auto] md:items-end md:gap-10">
            <p className={s.lede}>
              Bring the coding agent you already use. Each space holds a checkout, the agents working on it, and the
              terminals, browsers and documents they open. Every space sits in one sidebar on your Mac, and it&rsquo;s all
              still there tomorrow.
            </p>
            <div className="md:pb-1">
              <div className="flex flex-wrap items-center gap-3">
                <a href={download.href} className={s.download}>
                  <AppleIcon className="h-4 w-4 -translate-y-px" />
                  Download for Mac
                </a>
                <a href={site.repo} target="_blank" rel="noreferrer noopener" className={s.quiet}>
                  <GitHubIcon className="h-4 w-4" />
                  Source
                </a>
              </div>
              <p className={`${s.note} mt-4 text-ink-2`}>
                {download.version ? `${download.version} · ` : ""}macOS on Apple silicon · in active development
              </p>
            </div>
          </div>
        </div>

        {/* The glass. The canvas sits in the page under it, so the light scrolls with the paper; it holds
            no words, and the shadow and the caustic are kept inside it by the lamp's reach. */}
        <div
          aria-hidden
          data-paper-glass
          className="relative col-span-12 mt-6 aspect-square w-full max-w-[34rem] justify-self-center sm:mt-2 lg:col-span-4 lg:mt-0 lg:mr-[calc(-1*var(--margin))] lg:max-w-none lg:self-start lg:justify-self-stretch"
        >
          <GlassStill />
          <GlassLight />
        </div>
      </div>

      <figure className={`${s.measure} mt-14 sm:mt-16 lg:mt-14`}>
        <div className={`${s.dark} ${s.plate} h-[620px] sm:h-[640px] lg:h-[min(700px,calc(100dvh-6rem))] lg:min-h-[560px]`}>
          <MiniRealm />
        </div>
        <figcaption className="mt-4 grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-6">
          <span className={s.caption}>
            <span className="text-ink">A working sample of Realm, drawn in the page.</span> Click anything: pick a session,
            answer what&rsquo;s waiting from its row, follow a file link to the line it names. It runs no agent.
          </span>
          <span className={`${s.note} sm:text-right`}>Sample · not a capture</span>
        </figcaption>
      </figure>
    </section>
  )
}
