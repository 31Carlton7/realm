import Link from "next/link"

import { AppleIcon, GitHubIcon, XIcon } from "@/components/icons"
import { RealmCanvas } from "@/components/RealmCanvas"
import { Wordmark } from "@/components/Wordmark"
import { macDownload } from "@/lib/release"
import { site } from "@/lib/site"

/** One screen: a viewport-centred mark with the product details anchored below it. */
export default async function HomePage() {
  const download = await macDownload()

  return (
    <main className="relative flex h-[100dvh] flex-col overflow-hidden">
      <div className="hero-mark pointer-events-none absolute inset-0">
        <RealmCanvas className="h-full w-full" />
      </div>

      <div className="relative z-10 mt-auto flex shrink-0 flex-col gap-8 p-6 sm:flex-row sm:items-end sm:justify-between sm:gap-10 sm:p-10">
        <div className="min-w-0">
          {/* The mark and the name are the label; the sentence is the page's one display statement,
              so it is the h1 and it is what gets the size. */}
          <Wordmark className="text-ink" />
          <h1 className="mt-4 max-w-[19ch] text-[clamp(2.1rem,5.6vw,3.75rem)] leading-[1.02] font-[560] tracking-[-0.042em] text-balance text-ink">
            {site.tagline}
          </h1>

          <div className="mt-8 flex flex-wrap items-center gap-2.5">
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

          <p className="mt-3.5 font-mono text-[12px] text-ink-3">
            {download.version ? `${download.version} · ` : ""}Apple silicon
          </p>
        </div>

        {/* The negative margins take back each control's own padding, so the labels line up with the
            page edge rather than sitting a button's inset inside it. */}
        <nav
          aria-label="Elsewhere"
          className="-ml-3 flex shrink-0 items-center gap-1 sm:-mr-2.5 sm:ml-0"
        >
          <CornerLink href="/changelog">Changelog</CornerLink>
          <CornerLink href="/features">Features</CornerLink>
          <a
            href={site.x}
            target="_blank"
            rel="noreferrer noopener"
            title="Realm on X"
            className="app-corner grid h-11 w-11 place-items-center rounded-[20px] text-ink-2 transition-colors duration-150 hover:bg-surface hover:text-ink"
          >
            <XIcon className="h-4 w-4" />
            <span className="sr-only">Realm on X</span>
          </a>
        </nav>
      </div>
    </main>
  )
}

function CornerLink({ href, children }: { href: "/changelog" | "/features"; children: string }) {
  return (
    <Link
      href={href}
      className="app-corner inline-flex min-h-11 items-center rounded-[20px] px-3.5 py-2 text-[14px] text-ink-2 transition-colors duration-150 hover:bg-surface hover:text-ink"
    >
      {children}
    </Link>
  )
}
