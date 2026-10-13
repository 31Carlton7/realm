import type { PageDesignProps } from "@/components/lab/pages"
import { Agents } from "@/components/lab/page-paper/Agents"
import { Anatomy } from "@/components/lab/page-paper/Anatomy"
import { ContactSheet } from "@/components/lab/page-paper/ContactSheet"
import { Close, Colophon } from "@/components/lab/page-paper/Endmatter"
import { Facts } from "@/components/lab/page-paper/Facts"
import { paperInter } from "@/components/lab/page-paper/fonts"
import { Header } from "@/components/lab/page-paper/Header"
import { Hero } from "@/components/lab/page-paper/Hero"
import { Register, Seam } from "@/components/lab/page-paper/kinetic"
import { Lineage } from "@/components/lab/page-paper/Lineage"
import { Masthead } from "@/components/lab/page-paper/Masthead"
import s from "@/components/lab/page-paper/paper.module.css"
import { ClaimSpread } from "@/components/lab/page-paper/Plates"
import { Questions } from "@/components/lab/page-paper/Questions"
import { features } from "@/content/features"
import { delegation, facets, facetsCoda } from "@/content/home"
import captured from "@/public/product/manifest.json"

/** Notes for the margin of a claim's spread: the machine's own names for what the claim is about. */
const NOTES: Record<string, string> = {
  gateway: "Linear · Notion · Slack · GitHub · Jira · Figma · Sentry",
  review: "Through your own gh",
  sandbox: "macOS Seatbelt · off by default, per space",
  durable: "realm-server keeps running after the window closes",
}

/** The claims that are plates in the sequence; the agents and the delegation have spreads of their own. */
const PLATED = ["spaces", "transcript", "gateway", "review", "sandbox", "durable"]

/**
 * Paper: Realm's light face, set as a printed monograph.
 *
 * The ground and the ink are the app's own light theme; the type is Inter at display size on a
 * twelve-column grid with wide margins, with JetBrains Mono for the notes in the margin. The product
 * appears the way a monograph shows its subject: as plates, the real captures in their own dark face,
 * each captioned with what is in the frame, and as the live sample on the first spread.
 *
 * The one live light is physical: the mark stands on the paper as a block of glass, and the pointer
 * is the lamp. Everything else moves with the reader's scroll, and only then.
 */
export default function Paper({ download, claims }: PageDesignProps) {
  const claim = (id: string) => claims.find((c) => c.id === id)
  const plated = PLATED.map(claim).filter((c) => c !== undefined)
  const taken = new Set(captured as string[])
  const frames = features.filter((feature) => taken.has(feature.slug))

  return (
    <div className={`${s.root} ${paperInter.variable}`}>
      <Header href={download.href} />
      <main>
        <Hero download={download} />
        <Agents claim={claim("agents")} />
        <Anatomy facets={facets} coda={facetsCoda} />
        <Lineage claim={claim("delegation")} beats={delegation} />

        <section data-running-head="Shown in the app" aria-labelledby="plates-title" className={s.section}>
          <Seam />
          <div className={`${s.measure} ${s.grid} gap-y-6`}>
            <div className="col-span-12 lg:col-span-8">
              <Register id="plates-title" text="Shown in the app, plate by plate." className={`${s.statement} text-ink`} />
            </div>
            <p className={`${s.body} col-span-12 max-w-[46ch] lg:col-span-4 lg:pt-3`}>
              Every plate is a capture of the shipped app, cut to the part its claim is about.
            </p>
          </div>
          <div className="mt-20 flex flex-col gap-[clamp(88px,11vw,168px)] sm:mt-28">
            {plated.map((c, i) => (
              <ClaimSpread key={c.id} claim={c} flip={i % 2 === 1} note={NOTES[c.id]} />
            ))}
          </div>
        </section>

        <ContactSheet frames={frames} />
        <Masthead />
        <Facts />
        <Questions />
        <Close download={download} />
      </main>
      <Colophon download={download} />
    </div>
  )
}
