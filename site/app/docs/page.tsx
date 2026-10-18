import type { Metadata } from "next"
import type { Route } from "next"
import Link from "next/link"

import { ArrowIcon } from "@/components/icons"
import { Screen } from "@/components/realms/Screen"
import { DOCS_SUMMARY } from "@/content/docs"
import { docs, groups, plainText } from "@/lib/docs"
import { sceneImage } from "@/lib/pictures"

export const metadata: Metadata = {
  title: "Docs",
  description: DOCS_SUMMARY,
  alternates: { canonical: "/docs" },
  openGraph: { title: "Realm docs", description: DOCS_SUMMARY, url: "/docs" },
  twitter: { card: "summary_large_image", title: "Realm docs", description: DOCS_SUMMARY },
}

/** The four parts of the window, as the picture above them shows them, left to right. */
const REGIONS = [
  { name: "The rail", text: "Home, the Library, Connections, Scheduled tasks and Code review, with your profile and Settings at its foot." },
  { name: "The sidebar", text: "Needs you at the top, then every space with its sessions. A space is one project." },
  { name: "A session", text: "One conversation with one agent, and the prompter you talk to it through." },
  { name: "The side panel", text: "What the session works with: documents, a terminal, a browser, its sub-agents, a device." },
]

/**
 * The docs' front page. It explains, so its first view shows the product (design.md): the whole
 * window, with its four parts named under it. Then every page, under its group, each with the
 * sentence that says what it covers.
 */
export default function DocsHome() {
  const first = docs[0]
  return (
    <div className="max-w-[60rem]">
      <header>
        <h1 className="text-[clamp(2.5rem,4.4vw,3.5rem)] leading-[1] font-[580] tracking-[-0.045em] text-ink">Docs</h1>
        <p className="mt-5 max-w-[40rem] text-[18px] leading-[1.6] text-pretty text-ink-2">{DOCS_SUMMARY}</p>
        {first ? (
          <Link
            href={`/docs/${first.slug}` as Route}
            className="group mt-6 inline-flex min-h-11 items-center gap-2 text-[16px] font-[520] text-accent-ink"
          >
            <span className="link-line">New to Realm? {first.title}</span>
            <ArrowIcon className="nudge h-3.5 w-3.5" />
          </Link>
        ) : null}
      </header>

      <section aria-labelledby="window-title" className="mt-14">
        <h2 id="window-title" className="sr-only">
          The window
        </h2>
        <Screen
          kind="window"
          image={sceneImage("workspace")}
          alt="Realm's window. On the left, the rail of icons and the sidebar, with two sessions under Needs you and the Realm, Dashboard, Site and School spaces below. In the middle, a session whose answer explains a fix and lists the two files it edited, above the prompter. On the right, the side panel's Documents tab with orgs.ts open at line 83."
          caption="A session that fixed a crash, beside the file its answer named."
          zoom={1}
          priority
          sizes="(min-width: 1024px) 960px, 100vw"
        />
        <dl className="mt-20 grid gap-x-10 gap-y-6 sm:grid-cols-2">
          {REGIONS.map((region) => (
            <div key={region.name}>
              <dt className="text-[15px] font-[560] text-ink">{region.name}</dt>
              <dd className="mt-1 text-[16px] leading-[1.55] text-ink-2">{region.text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="mt-20 space-y-14">
        {groups.map((group) => (
          <section key={group.title} aria-labelledby={`group-${group.pages[0]?.slug}`}>
            <h2 id={`group-${group.pages[0]?.slug}`} className="text-[1.375rem] leading-[1.3] font-[560] tracking-[-0.022em] text-ink">
              {group.title}
            </h2>
            <ul className="mt-5 grid gap-3 sm:grid-cols-2">
              {group.pages.map((doc) => (
                <li key={doc.slug} className="flex">
                  <Link
                    href={`/docs/${doc.slug}` as Route}
                    className="row-link group flex w-full flex-col rounded-[12px] bg-canvas p-5 [--row-hover:var(--color-surface)]"
                  >
                    <span className="flex items-center gap-2 text-[17px] leading-[1.35] font-[560] text-ink">
                      {doc.title}
                      <ArrowIcon className="nudge h-3.5 w-3.5 text-ink-2" />
                    </span>
                    <span className="mt-1.5 text-[15px] leading-[1.55] text-ink-2">{plainText(doc.summary)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
