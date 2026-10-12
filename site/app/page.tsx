import Link from "next/link"

import { DownloadButton, QuietButton } from "@/components/Buttons"
import { DimensionField } from "@/components/dimension/DimensionField"
import { AgentStrip } from "@/components/home/AgentStrip"
import { Bento } from "@/components/home/Bento"
import { CloseCta } from "@/components/home/CloseCta"
import { Delegation } from "@/components/home/Delegation"
import { Faq } from "@/components/home/Faq"
import { Footer } from "@/components/home/Footer"
import { LocalFacts } from "@/components/home/LocalFacts"
import { MiniRealm } from "@/components/home/mini/MiniRealm"
import { Proof } from "@/components/home/Proof"
import { SixFaces } from "@/components/home/SixFaces"
import { Teams } from "@/components/home/Teams"
import { ArrowIcon, GitHubIcon } from "@/components/icons"
import { SiteHeader } from "@/components/SiteHeader"
import { claims, delegation, facets, facetsCoda, facetsMany } from "@/content/home"
import { macDownload } from "@/lib/release"
import { site } from "@/lib/site"
import captured from "@/public/product/manifest.json"

/**
 * The landing page: a journey through dimensions, with the product at both ends.
 *
 * One WebGPU field sits behind all of it (`DimensionField`), and each section is a region of that
 * field rather than an owner of a canvas. Sections say where they are with `data-dim-stage`; the
 * elements light belongs to say so with `data-dim`, and the field reads their rects every frame.
 *
 *   hero       "Give your agents a world to work in" — a working sample of Realm in the portal, the
 *              corridor of frames receding behind it. Click through it; it is the page's first proof.
 *   agents     the agents it runs, as one still row of their marks
 *   faces      a pinned track: the mark assembles face by face beside what a realm holds, is lit,
 *              then pulls back into a hive of realms
 *   beside it  a slab cut at the mark's angle, holding a spotlit grid of what a session can open
 *   delegation the interlude: one agent opening more, sessions opening sessions, two levels deep
 *   proof      the claims as one tabbed viewer, each with the real capture that is evidence for it
 *   teams      2.1's teams: Realmites, handoffs and Review, clickable
 *   facts      where the work lives, in four lines
 *   close      the questions, then the next action, through a portal again
 *   footer     the realm rising over its own lattice, laid flat to a horizon
 *
 * design.md carries the rules this follows: every effect argues a claim the copy also makes, nothing
 * with area draws behind words, motion is the reader's to drive, and the captures are real. The one
 * thing drawn rather than captured is labelled as such: the hero's sample, and the bento's pictures of
 * native views a renderer screenshot cannot see.
 */
export default async function HomePage() {
  const download = await macDownload()
  const taken = new Set(captured as string[])
  /* The manifest is the authority on what exists, never the copy: a capture that failed to record
     drops its picture rather than rendering a broken image or borrowing another section's. */
  const proven = claims.map((claim) => ({
    ...claim,
    capture: claim.capture && taken.has(claim.capture) ? claim.capture : null,
  }))

  return (
    <div className="min-h-[100dvh]">
      <DimensionField />
      <SiteHeader width="max-w-[92rem]" floating />

      <main>
        <section data-dim-stage="hero" className="relative pb-24 sm:pb-32">
          <div className="mx-auto w-full max-w-[92rem] px-6 pt-12 sm:px-10 sm:pt-16 lg:pt-20">
            <Link
              href="/changelog/v2-0-0"
              className="group inline-flex items-center gap-2.5 text-[13.5px] text-ink-2 transition-colors duration-150 hover:text-ink"
            >
              <span className="font-mono text-[12px] text-accent-ink">2.0</span>
              <span className="h-3.5 w-px bg-line-strong" aria-hidden />
              Every space in one sidebar, and a side panel for what agents open
              <ArrowIcon className="h-3.5 w-3.5 transition-transform duration-200 ease-[var(--ease-out-strong)] group-hover:translate-x-0.5" />
            </Link>

            <div className="mt-8 grid gap-8 lg:mt-10 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-end lg:gap-12">
              <h1 className="max-w-[12ch] text-[clamp(3rem,7vw,6rem)] leading-[0.94] font-[580] tracking-[-0.055em] text-balance text-ink">
                Give your agents a world to work in.
              </h1>

              <div className="lg:pb-2.5">
                <p className="text-[17px] leading-[1.55] text-ink-2">
                  Bring the coding agent you already use. Each space holds a checkout, the agents working on it,
                  and the terminals, browsers and documents they open. Every space sits in one sidebar on your
                  Mac, and it&rsquo;s all still there tomorrow.
                </p>
                <div className="mt-7 flex flex-wrap items-center gap-2.5">
                  <DownloadButton href={download.href} />
                  <QuietButton href={site.repo} external>
                    <GitHubIcon className="h-4 w-4" />
                    Source
                  </QuietButton>
                </div>
                {/* The qualifiers stay on the page rather than in the small print of a store listing. */}
                <p className="mt-3.5 font-mono text-[12px] text-ink-3">
                  {download.version ? `${download.version} · ` : ""}macOS on Apple silicon · in active development
                </p>
              </div>
            </div>
          </div>

          <div className="mx-auto mt-14 w-full max-w-[82rem] px-4 sm:mt-16 sm:px-10">
            {/* A tab on the window's shoulder, cut at the mark's 60 degrees, that says what this is
                before anyone clicks it: a sample the page draws, not a picture of the app. */}
            <p className="hero-tab relative z-10 ml-5 inline-flex h-8 items-center gap-2 bg-surface pr-7 pl-4 text-[12.5px] text-ink-2">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-green" />
              A working sample of Realm. Click anything.
            </p>
            {/* No drop shadow: the light here is the field's, and a resting object casts none. Where
                WebGPU is unavailable the field never draws, so the edge carries a CSS glow instead. */}
            <div
              data-dim="portal"
              className="app-corner relative h-[620px] w-full overflow-hidden rounded-[20px] bg-page shadow-[0_0_0_1px_oklch(1_0_0/0.09)] sm:h-[640px] lg:h-[min(680px,calc(100dvh-7rem))] lg:min-h-[560px] [html[data-dim-field=off]_&]:shadow-[0_0_0_1px_oklch(1_0_0/0.12),0_0_90px_-18px_oklch(0.68_0.173_253.301/0.55)]"
            >
              <MiniRealm />
            </div>
          </div>
        </section>

        <AgentStrip />

        <SixFaces facets={facets} coda={facetsCoda} many={facetsMany} />

        {/* Where "Skip" lands: the first thing after the pinned track. */}
        <div id="after-faces" className="scroll-mt-8" />

        <Bento />

        <Delegation beats={delegation} />
        <div id="after-delegation" className="scroll-mt-8" />

        <Proof claims={proven} />

        <Teams />

        <LocalFacts />

        <Faq />

        <CloseCta href={download.href} version={download.version} repo={site.repo} />
      </main>

      <Footer />
    </div>
  )
}
