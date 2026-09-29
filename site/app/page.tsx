import Image from "next/image"

import { DimensionField } from "@/components/dimension/DimensionField"
import { ClaimSection } from "@/components/home/Claim"
import { Faq } from "@/components/home/Faq"
import { SixFaces } from "@/components/home/SixFaces"
import { AppleIcon, GitHubIcon } from "@/components/icons"
import { SiteHeader } from "@/components/SiteHeader"
import { claims, facets, facetsCoda } from "@/content/home"
import { macDownload } from "@/lib/release"
import { site } from "@/lib/site"
import captured from "@/public/product/manifest.json"

/**
 * The landing page.
 *
 * It used to be one screen that only ROUTED — the mark, the name, the download, two links out — and
 * it showed no product on purpose, because it made no argument a screenshot would have to support.
 * It argues now, so it owes the evidence: design.md's rule is that the first viewport of a page that
 * explains shows the product or its central working relationship, and every claim below it carries
 * the capture that supports THAT claim rather than a picture of the app in general.
 *
 * The shape is a sequence, not a grid. One claim per section, one large product view each, sides
 * alternating. A three-up of small mock cards is the mosaic design.md refuses — and mock cards would
 * be the wrong evidence anyway, since these are real captures of a real space taken by
 * `capture-product.mjs` against the built app.
 *
 * Every frame here is anchored to the top and cropped at the bottom, losing the prompter band whose
 * model chip reads "Fake" — the capture harness's scripted agent, not Realm. `Claim.tsx` carries the
 * arithmetic; the short version is that the crop must come from an aspect NARROWER than the source's
 * 16/10, which the hero's old 16/9 was not by enough and the claims' old 16/10 was not at all.
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
                Bring any coding agent. Every space in Realm is a realm of its own — a checkout, the
                agents working in it, and the terminals, browsers, documents and tools they use — side
                by side on your Mac, and still there tomorrow.
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
              <Image
                src="/product/workspace.png"
                alt="A Realm space: the sidebar, a document open beside an agent session, and the session working through a plan."
                width={2880}
                height={1800}
                priority
                sizes="(max-width: 640px) 180vw, (max-width: 1024px) 100vw, 82rem"
                className="h-auto w-[180%] max-w-none sm:w-full"
              />
            </div>
          </figure>
        </section>

        <SixFaces facets={facets} coda={facetsCoda} />

        {/* Where "Skip" lands: the first thing after the pinned track. */}
        <div id="after-faces" className="scroll-mt-8" />

        {sections.map((claim, i) => (
          <ClaimSection key={claim.id} claim={claim} index={i} />
        ))}

        <Rule />

        <Faq />

        {/* End with the one concrete next action. */}
        <section className="mx-auto w-full max-w-[52rem] px-6 pb-20 sm:px-10 sm:pb-28">
          <div className="app-corner rounded-[20px] bg-surface p-8 shadow-[inset_0_1px_0_oklch(1_0_0/0.07)] sm:p-10">
            <h2 className="text-[clamp(1.4rem,2.2vw,1.8rem)] leading-[1.15] font-[560] tracking-[-0.03em] text-ink">
              Run it on your own work.
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
