import { AgentMark, type AgentId } from "@/components/AgentMark"
import { DownloadButton, QuietButton } from "@/components/Buttons"
import { Actions, Announcement, Lede, ProductWindow } from "@/components/realms/HeroParts"
import { GitHubIcon } from "@/components/icons"
import { FIELD_PATTERN, TILE } from "@/components/realms/hive/fallback"
import { Chapter } from "@/components/realms/Chapter"
import { Flight } from "@/components/realms/Flight"
import { HoleStage } from "@/components/realms/HoleStage"
import { Team } from "@/components/realms/Team"
import { SiteFooter } from "@/components/SiteFooter"
import { SiteHeader } from "@/components/SiteHeader"
import { delegation, facets, facetsCoda, faq, type Claim } from "@/content/home"
import type { MacDownload } from "@/lib/release"
import { site } from "@/lib/site"

/** What the landing page hands the home: the current download, and the claims intersected with the
 *  capture manifest. */
export type HomeProps = { download: MacDownload; claims: Claim[] }

const AGENTS: { id: AgentId; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "openai", name: "Codex" },
  { id: "cursor", name: "Cursor" },
  { id: "gemini", name: "Gemini" },
  { id: "opencode", name: "OpenCode" },
  { id: "githubCopilot", name: "GitHub Copilot" },
  { id: "goose", name: "goose" },
  { id: "qwen", name: "Qwen Code" },
  { id: "grok", name: "Grok" },
]

const FACTS: { title: string; body: string }[] = [
  { title: "On your Mac", body: "Transcripts, documents, skills and checkpoints are files and a SQLite database under ~/Realm." },
  { title: "No account", body: "There is nothing to sign up for, and nothing you make in Realm is uploaded." },
  { title: "No API key", body: "Realm drives the agent CLIs you already have, on the plan you already pay for." },
  { title: "Signed and notarized", body: "Builds for Apple silicon, updated from a public release feed. The source is on GitHub." },
]

/** The order the flight visits the claims in, and which side each one's screen stands on. */
const ROUTE: { id: string; side: "left" | "right" }[] = [
  { id: "spaces", side: "left" },
  { id: "transcript", side: "right" },
  { id: "agents", side: "left" },
  { id: "delegation", side: "right" },
  { id: "gateway", side: "left" },
  { id: "review", side: "right" },
  { id: "sandbox", side: "left" },
  { id: "durable", side: "right" },
]

/**
 * Realms: the whole page is one flight across a world built from Realm's mark, drawn live behind it.
 *
 *   opening    dusk over a field of realms, the working sample of Realm floating over it
 *   a realm    the camera comes down to one realm; its doorway opens into a capture of a space
 *   chapters   one realm per claim, further up the field: the doorway lights, opens into the claim's
 *              real capture as a lit screen standing on the ground, and the claim sits beside it on
 *              clean ground; between them the camera lifts over the realm it leaves and turns
 *   teams      a team's four realms together, a Realmite at each door, the board beside them
 *   the climb  where the work lives, and the questions, as the camera rises off the field
 *   finale     the camera lifts its eyes from the field to the night, and the page ends on a black
 *              hole under the footer, drawing a disk of realms in (blackhole.ts)
 *
 * Every picture is a capture of the shipped app or the working sample, labelled as one. The flight is
 * scrubbed by the scroll and nothing else; the pointer is a lamp over the field.
 */
export async function RealmsHome({ download, claims }: HomeProps) {
  const byId = new Map(claims.map((claim) => [claim.id, claim]))
  const chapters = ROUTE.map((stop) => ({ ...stop, claim: byId.get(stop.id) })).filter(
    (stop): stop is { id: string; side: "left" | "right"; claim: Claim } => Boolean(stop.claim?.capture),
  )

  return (
    <div className="relative min-h-[100dvh]">
      <Flight />
      <SiteHeader width="max-w-[92rem]" floating />

      <main>
        {/* Opening: the words on the evening sky, the field under them, the sample over the field. */}
        <section aria-labelledby="realms-title" className="relative pb-28">
          <div className="mx-auto w-full max-w-[92rem] px-6 pt-10 sm:px-10 sm:pt-14">
            <div data-field-anchor="copy" className="mx-auto flex max-w-[52rem] flex-col items-center text-center">
              <Announcement />
              <h1
                id="realms-title"
                className="mt-6 max-w-[24ch] text-[clamp(2.5rem,4.4vw,4rem)] leading-[0.98] font-[580] tracking-[-0.05em] text-balance text-ink"
              >
                {site.tagline}
              </h1>
              <Lede className="mt-5 max-w-[72ch]" />
              <Actions download={download} className="mt-7" center />
            </div>
          </div>
          <div className="relative mt-[clamp(3.5rem,calc(100dvh-50rem),7rem)]">
            {/* Without WebGPU, the field as the Hive draws it still: the same realms in the same light,
                hazing out toward the words and gone before the section ends. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -top-28 bottom-[-4rem] -z-10 hidden [mask-image:linear-gradient(to_bottom,transparent,rgb(0_0_0/0.55)_8rem,black_18rem,black_calc(100%-10rem),transparent)] [html[data-field=off]_&]:block"
              style={{ backgroundImage: FIELD_PATTERN, backgroundSize: `${TILE.width}px ${TILE.height}px`, backgroundPosition: "center top" }}
            />
            <ProductWindow className="mx-auto w-full max-w-[76rem] px-4 sm:px-10 [html[data-field=off]_&]:bg-page [html[data-field=off]_&]:shadow-[0_0_40px_24px_var(--color-page)]" />
          </div>
        </section>

        <Chapter
          id="space"
          side="right"
          tall
          title="What a realm holds."
          caption="A session in the Dashboard space, and the file its turn edited open in vim in a terminal beside it."
          picture={{
            kind: "scene",
            slug: "terminal",
            alt: "Realm's window: the sidebar with every space, a session in the Dashboard space that edited two files, and a terminal beside it with vim open on web/lib/orgs.ts.",
          }}
        >
          <p>A realm is one space in Realm: a project, with everything its work needs kept beside it.</p>
          <dl className="space-y-3.5 pt-1">
            {facets.map((facet) => (
              <div key={facet.title}>
                <dt className="text-[16px] font-[560] text-ink">{facet.title}</dt>
                <dd className="mt-0.5 text-[16px] leading-[1.55]">{facet.body}</dd>
              </div>
            ))}
          </dl>
          <p className="text-ink">
            {facetsCoda.title} <span className="text-ink-2">{facetsCoda.body}</span>
          </p>
        </Chapter>

        {chapters.map(({ id, side, claim }) => (
          <Chapter
            key={id}
            id={id}
            side={side}
            tall={id === "delegation"}
            title={claim.title}
            caption={claim.caption ?? ""}
            picture={{ kind: "claim", id: claim.id, focus: claim.focus, alt: claim.caption ?? claim.title }}
          >
            {id === "delegation" ? (
              <>
                <p>
                  Ask in plain words (&ldquo;have GPT-6 Luna build this&rdquo;) or pick models in a session&rsquo;s Agents tab and
                  say what to build. The session&rsquo;s agent splits up the work, starts a sub-agent on each model through
                  whichever harness runs it, and waits for the reports.
                </p>
                <dl className="space-y-3 pt-1">
                  {delegation.map((beat) => (
                    <div key={beat.title}>
                      <dt className="text-[16px] font-[560] text-ink">{beat.title}</dt>
                      <dd className="mt-0.5 text-[16px] leading-[1.55]">{beat.body}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <p>{claim.body}</p>
            )}
            {id === "agents" ? (
              <ul aria-label="Agents Realm runs" className="grid grid-cols-3 gap-x-4 gap-y-3 pt-2">
                {AGENTS.map(({ id: agent, name }) => (
                  <li key={agent} className="flex items-center gap-2.5 text-[14px] text-ink">
                    <AgentMark id={agent} className="h-[18px] w-[18px] shrink-0 text-ink-2" />
                    {name}
                  </li>
                ))}
              </ul>
            ) : null}
          </Chapter>
        ))}

        <Team side="left" />

        {/* The climb: the field falls away under where the work lives and the questions. */}
        <section aria-labelledby="facts-title" className="relative">
          <div className="mx-auto flex w-full max-w-[92rem] flex-col justify-center px-6 py-24 sm:px-10 lg:min-h-[110vh]">
            <div data-field-anchor="k:facts" className="relative z-[2]">
              <h2 id="facts-title" className="text-[clamp(1.6rem,2.4vw,2.1rem)] leading-[1.1] font-[580] tracking-[-0.035em] text-ink">
                Where the work lives.
              </h2>
              <dl className="mt-8 grid border-y border-line sm:grid-cols-2 lg:grid-cols-4">
                {FACTS.map((fact, i) => (
                  <div
                    key={fact.title}
                    className={`py-7 sm:px-7 sm:py-9 ${i > 0 ? "max-sm:border-t" : ""} border-line sm:first:pl-0 sm:[&:nth-child(2n)]:border-l lg:[&:nth-child(n+2)]:border-l sm:[&:nth-child(n+3)]:max-lg:border-t lg:[&:nth-child(3)]:pl-7`}
                  >
                    <dt className="text-[16px] font-[560] tracking-[-0.01em] text-ink">{fact.title}</dt>
                    <dd className="mt-2 text-[16px] leading-[1.55] text-ink-2">{fact.body}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        <section aria-labelledby="faq-title" className="relative">
          <div className="mx-auto w-full max-w-[52rem] px-6 py-24 sm:px-10 lg:min-h-[120vh] lg:py-40">
            <div data-field-anchor="k:faq" className="relative z-[2]">
              <h2 id="faq-title" className="text-[clamp(1.6rem,2.4vw,2.1rem)] leading-[1.1] font-[580] tracking-[-0.035em] text-ink">
                Questions
              </h2>
              <div className="mt-8">
                {faq.map((item, i) => (
                  <details key={item.q} name="realms-faq" open={i === 0} className="group border-t border-line py-4 last:border-b">
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-6 text-[16px] leading-[1.45] font-[500] text-ink [&::-webkit-details-marker]:hidden">
                      <span>{item.q}</span>
                      <span aria-hidden className="mt-1 shrink-0 text-ink-2 transition-transform duration-200 ease-[var(--ease-out-strong)] group-open:rotate-45">
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <path d="M7 1.5v11M1.5 7h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                        </svg>
                      </span>
                    </summary>
                    <p className="mt-3 max-w-[68ch] text-[16px] leading-[1.6] text-ink-2">{item.a}</p>
                  </details>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* The night over the field, under the call; the black hole comes up under the footer. */}
        <section aria-labelledby="finale-title" className="relative">
          <div className="mx-auto flex w-full max-w-[92rem] flex-col items-center px-6 pt-40 pb-16 text-center sm:px-10 lg:min-h-[115vh] lg:justify-center lg:pt-0 lg:pb-0">
            <div data-field-anchor="k:finale" className="relative z-[2] flex flex-col items-center">
              <h2 id="finale-title" className="max-w-[16ch] text-[clamp(2.4rem,5vw,4.25rem)] leading-[1] font-[580] tracking-[-0.05em] text-balance text-ink">
                Give your agents a world to work in.
              </h2>
              <p className="mt-6 max-w-[44ch] text-[17px] leading-[1.6] text-ink-2">
                Point it at a checkout, start a session with an agent you already have, and leave the window open all day.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
                <DownloadButton href={download.href} size="lg" />
                <QuietButton href={site.repo} external>
                  <GitHubIcon className="h-4 w-4" />
                  Read the source
                </QuietButton>
              </div>
              <p className="mt-4 font-mono text-[12px] text-ink-2">
                {download.version ? `${download.version} · ` : ""}macOS on Apple silicon · in active development
              </p>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter world={<HoleStage />} />
    </div>
  )
}
