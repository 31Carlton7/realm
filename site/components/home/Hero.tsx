import Link from "next/link"

import { ArrowIcon, GitHubIcon } from "@/components/icons"
import { RealmCanvas } from "@/components/RealmCanvas"
import { site } from "@/lib/site"

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-line">
      {/* Two washes of accent behind everything: a wide one anchored where the icon sits, and a narrow
          one under the headline, so the copy reads out of a lit ground rather than a flat one. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(1100px_620px_at_72%_46%,color-mix(in_srgb,var(--color-accent)_15%,transparent),transparent_70%),radial-gradient(700px_420px_at_18%_18%,color-mix(in_srgb,var(--color-accent)_7%,transparent),transparent_72%)]"
      />
      <div
        aria-hidden
        className="grid-backdrop pointer-events-none absolute inset-0 opacity-[0.35] [mask-image:radial-gradient(900px_520px_at_50%_40%,black,transparent_78%)]"
      />

      <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-6 pt-32 pb-20 lg:grid-cols-12 lg:gap-6 lg:pt-40 lg:pb-28">
        <div className="lg:col-span-6">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3 py-1 text-[12px] tracking-[0.02em] text-ink-2 backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            Local-first · macOS
          </span>

          <h1 className="display-tight mt-6 text-[clamp(2.75rem,6.2vw,4.75rem)] font-semibold text-ink">
            A control plane
            <br />
            for your coding
            <br />
            agents.
          </h1>

          <p className="mt-6 max-w-lg text-[17px] leading-relaxed text-ink-2">
            Realm gives every agent a space on your Mac — split panes for sessions, terminals, browsers
            and artifacts, one shared context pool, and an MCP gateway that keeps your credentials out
            of the agent.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href="/docs"
              className="group inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-[14px] font-medium text-page transition-opacity hover:opacity-90"
            >
              Read the docs
              <ArrowIcon className="h-3.5 w-3.5 transition-transform duration-300 ease-[var(--ease-out-strong)] group-hover:translate-x-0.5" />
            </Link>
            <a
              href={site.repo}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/50 px-5 py-2.5 text-[14px] text-ink-2 backdrop-blur transition-colors hover:border-line-strong hover:text-ink"
            >
              <GitHubIcon className="h-4 w-4" />
              View on GitHub
            </a>
          </div>

          <p className="mt-5 text-[13px] text-ink-3">
            Sessions, transcripts and keys stay in <code className="font-mono text-ink-2">~/Realm</code>.
            Nothing leaves the machine.
          </p>
        </div>

        {/* The shader paints the page colour around the icon and lets the ring's light leak onto it, so
            the canvas has no edge to hide and needs no mask. */}
        <div className="lg:col-span-6">
          <RealmCanvas className="relative mx-auto aspect-square w-full max-w-[560px] lg:-mr-10 lg:max-w-none" />
        </div>
      </div>
    </section>
  )
}
