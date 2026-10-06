import { Fragment } from "react"

import { DimensionField } from "@/components/dimension/DimensionField"
import { ClaimSection } from "@/components/home/Claim"
import { Delegation } from "@/components/home/Delegation"
import { Faq } from "@/components/home/Faq"
import { Footer } from "@/components/home/Footer"
import { SixFaces } from "@/components/home/SixFaces"
import { AppleIcon, GitHubIcon } from "@/components/icons"
import { SiteHeader } from "@/components/SiteHeader"
import { claims, delegation, facets, facetsCoda, facetsMany } from "@/content/home"
import { sceneFile, sceneSrcSet, WINDOW } from "@/lib/frames"
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
 *   hero      "Give your agents a world to work in" — the workspace capture in a portal, with a
 *             corridor of frames receding behind it
 *   faces     a pinned track: the mark assembles face by face on its own lattice beside what a realm
 *             holds, is lit as glass, then pulls back into a hive of realms
 *   claims    one claim per section, each with the real capture that is evidence for it, framed as a
 *             window into the same realm — and halfway through them, the delegation interlude: one
 *             agent opening more, as sessions opening sessions, two levels deep and no further
 *   close     the next action, through a portal again
 *   footer    the realm rising over its own lattice, laid flat to a horizon, with who makes it
 *
 * design.md carries the rules this follows: the first viewport shows the product, every effect argues
 * a claim the copy also makes, nothing with area draws behind words, and motion is the reader's to
 * drive. The captures are real, taken by `capture-product.mjs` against the built app; the harness's
 * scripted agent stands in for Claude and Codex, so the chips name the models a real session runs.
 * Every frame is still aimed at its subject rather than at the whole window. `Claim.tsx` carries the
 * arithmetic; the short version is that the crop must come from an aspect NARROWER than the source's
 * 16/10.
 */
export default async function HomePage() {
  const download = await macDownload()
  const taken = new Set(captured as string[])
  /* The manifest is the authority on what exists, never the copy: a capture that failed to record
     drops its picture rather than rendering a broken image or borrowing another section's. */
  const sections = claims.map((claim) => ({
    ...claim,
    capture: claim.capture && taken.has(claim.capture) ? claim.capture : null,
  }))

  return (
    <div className="min-h-[100dvh]">
      <DimensionField />
      <SiteHeader width="max-w-[92rem]" />

      <main>
        {/* The hero. Tembo's move, read for Realm: say where agents should work, then show the place.
            The product sits in a portal the field draws around it — `data-dim="portal"` is how the
            light finds it — and source order stays claim-then-evidence, so it stacks the right way. */}
        <section data-dim-stage="hero" className="relative pb-24 sm:pb-32">
          <div className="mx-auto w-full max-w-[92rem] px-6 pt-14 sm:px-10 sm:pt-20 lg:pt-24">
            <h1 className="max-w-[15ch] text-[clamp(2.7rem,5.6vw,4.9rem)] leading-[0.98] font-[560] tracking-[-0.047em] text-balance text-ink">
              Give your agents a world to work in.
            </h1>

            <div className="mt-7 flex flex-col gap-7 lg:mt-9 lg:flex-row lg:items-end lg:justify-between lg:gap-16">
              <p className="max-w-[54ch] text-[17px] leading-[1.55] text-ink-2">
                Bring the coding agent you already use. Each space in Realm holds a checkout, the agents
                working on it, and the terminals, browsers and documents they open. Every space sits in
                one sidebar on your Mac, and it&rsquo;s all still there tomorrow.
              </p>

              <div className="flex shrink-0 flex-col items-start gap-3 lg:items-end">
                <div className="flex flex-wrap items-center gap-2.5">
                  <a
                    href={download.href}
                    className="app-corner inline-flex min-h-11 items-center gap-2 rounded-[20px] bg-accent px-4.5 py-2.5 text-[14px] font-[500] text-white shadow-[inset_0_1px_0_oklch(1_0_0/0.16)] transition-[scale,background-color] duration-150 ease-out hover:bg-accent-ink active:scale-[0.96]"
                  >
                    <AppleIcon className="h-4 w-4" />
                    Download for Mac
                  </a>
                  <a
                    href={site.repo}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="app-corner inline-flex min-h-11 items-center gap-2 rounded-[20px] bg-surface px-4.5 py-2.5 text-[14px] text-ink-2 shadow-[inset_0_1px_0_oklch(1_0_0/0.07)] transition-[scale,background-color,color] duration-150 ease-out hover:bg-raised hover:text-ink active:scale-[0.96]"
                  >
                    <GitHubIcon className="h-4 w-4" />
                    GitHub
                  </a>
                </div>
                {/* The qualifiers stay on the page rather than in the small print of a store listing. */}
                <p className="font-mono text-[12px] text-ink-3">
                  {download.version ? `${download.version} · ` : ""}Apple silicon · in active development
                </p>
              </div>
            </div>
          </div>

          <figure className="mx-auto mt-14 w-full max-w-[82rem] px-6 sm:mt-16 sm:px-10">
            {/* No drop shadow: the light here is the field's, and a resting object casts none. Where
                WebGPU is unavailable the field never draws, so the edge carries a CSS glow instead. */}
            <div
              data-dim="portal"
              className="app-corner relative aspect-4/3 w-full overflow-hidden rounded-[20px] bg-page shadow-[0_0_0_1px_oklch(1_0_0/0.09)] sm:aspect-[15/8] [html[data-dim-field=off]_&]:shadow-[0_0_0_1px_oklch(1_0_0/0.12),0_0_90px_-18px_oklch(0.68_0.173_253.301/0.55)]"
            >
              {/* Lossless, at the window's 1× and 3× (lib/frames.ts): Next's optimiser would re-encode it
                  lossy, which is what softened the text in every capture the site used to show. */}
              <img
                src={sceneFile("workspace", 4320)}
                srcSet={sceneSrcSet("workspace")}
                sizes="(max-width: 640px) calc(180vw - 5.4rem), (max-width: 82rem) calc(100vw - 5rem), 77rem"
                alt="Realm: every space in the sidebar, a session that fixed a crash and the two files it edited, and the file its answer named open in the side panel at the line it named."
                width={WINDOW.width * 2}
                height={WINDOW.height * 2}
                fetchPriority="high"
                decoding="async"
                className="h-auto w-[180%] max-w-none sm:w-full"
              />
            </div>
          </figure>
        </section>

        <SixFaces facets={facets} coda={facetsCoda} many={facetsMany} />

        {/* Where "Skip" lands: the first thing after the pinned track. */}
        <div id="after-faces" className="scroll-mt-8" />

        {sections.map((claim, i) => (
          <Fragment key={claim.id}>
            <ClaimSection claim={claim} index={i} />
            {/* Halfway through the claims, the interlude: one agent opening more. */}
            {i === 2 ? (
              <>
                <Delegation beats={delegation} />
                <div id="after-delegation" className="scroll-mt-8" />
              </>
            ) : null}
          </Fragment>
        ))}

        <Rule />

        <Faq />

        {/* End with the one concrete next action — through a portal, so the page closes where it
            opened. The field hands its corridor to this card once the hero's portal is off screen. */}
        <section className="mx-auto w-full max-w-[52rem] px-6 pt-24 pb-32 sm:px-10 sm:pt-32 sm:pb-44">
          <div
            data-dim="portal-close"
            className="app-corner rounded-[20px] bg-surface p-8 shadow-[inset_0_1px_0_oklch(1_0_0/0.07)] sm:p-10 [html[data-dim-field=off]_&]:shadow-[inset_0_1px_0_oklch(1_0_0/0.07),0_0_90px_-18px_oklch(0.68_0.173_253.301/0.5)]"
          >
            <h2 className="text-[clamp(1.4rem,2.2vw,1.8rem)] leading-[1.15] font-[560] tracking-[-0.03em] text-ink">
              Open your first realm.
            </h2>
            <p className="mt-3 max-w-[52ch] text-[16px] leading-[1.6] text-ink-2">
              Point it at a checkout, start a session with an agent you already have, and leave the
              window open all day.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a
                href={download.href}
                className="app-corner inline-flex min-h-11 items-center gap-2 rounded-[20px] bg-accent px-4.5 py-2.5 text-[14px] font-[500] text-white shadow-[inset_0_1px_0_oklch(1_0_0/0.16)] transition-[scale,background-color] duration-150 ease-out hover:bg-accent-ink active:scale-[0.96]"
              >
                <AppleIcon className="h-4 w-4" />
                Download for Mac
              </a>
              <p className="font-mono text-[12px] text-ink-3">
                {download.version ? `${download.version} · ` : ""}Apple silicon
              </p>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  )
}

function Rule() {
  return (
    <div className="mx-auto max-w-[92rem] px-6 sm:px-10">
      <hr className="border-line" />
    </div>
  )
}
