import Link from "next/link"

import { GitHubIcon } from "@/components/icons"
import { Wordmark } from "@/components/Wordmark"
import { docsNav, site } from "@/lib/site"

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-12 px-6 py-16 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <Wordmark className="text-ink" />
          <p className="mt-4 max-w-xs text-[14px] leading-relaxed text-ink-3">
            {site.tagline} Built for macOS. Your sessions, your keys, your machine.
          </p>
          <a
            href={site.repo}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-6 inline-flex items-center gap-2 text-[13px] text-ink-2 transition-colors hover:text-ink"
          >
            <GitHubIcon className="h-3.5 w-3.5" />
            GitHub
          </a>
        </div>

        {docsNav.slice(0, 2).map((group) => (
          <div key={group.title}>
            <h2 className="text-[12px] font-medium tracking-[0.08em] text-ink-3 uppercase">{group.title}</h2>
            <ul className="mt-4 space-y-2.5">
              {group.items.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="text-[14px] text-ink-2 transition-colors hover:text-ink">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-6 text-[13px] text-ink-3 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Realm</p>
          <p>
            Hero rendered with{" "}
            <a
              href="https://vgpu.sh"
              target="_blank"
              rel="noreferrer noopener"
              className="text-ink-2 underline decoration-line underline-offset-4 transition-colors hover:text-ink"
            >
              vgpu
            </a>
            .
          </p>
        </div>
      </div>
    </footer>
  )
}
