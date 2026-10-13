import { faq } from "@/content/home"

/** The landing page's four facts about where things live (components/home/LocalFacts.tsx). */
const FACTS: { title: string; body: string }[] = [
  { title: "On your Mac", body: "Transcripts, documents, skills and checkpoints are files and a SQLite database under ~/Realm." },
  { title: "No account", body: "There is nothing to sign up for, and nothing you make in Realm is uploaded." },
  { title: "No API key", body: "Realm drives the agent CLIs you already have, on the plan you already pay for." },
  { title: "Signed and notarized", body: "Builds for Apple silicon, updated from a public release feed. The source is on GitHub." },
]

/**
 * Where the work lives, and the questions a reader arrives with: the page's plain ground after the
 * tour. Set on the same two columns as everything above it, the words' column on the left, so the
 * eye keeps its line from the stage down to the end.
 */
export function Ground() {
  return (
    <>
      <section aria-labelledby="where-title" className="mx-auto w-full max-w-[1680px] px-6 pt-20 sm:px-10 sm:pt-28 lg:px-14">
        <div className="grid gap-10 border-t border-line pt-14 lg:grid-cols-[clamp(360px,30vw,488px)_minmax(0,1fr)] lg:gap-[132px] lg:pt-20">
          <div>
            <h2 id="where-title" className="text-[clamp(1.9rem,3.2vw,2.75rem)] leading-[1.04] font-[580] tracking-[-0.04em] text-balance text-ink">
              Where the work lives.
            </h2>
            <p className="mt-5 font-mono text-[clamp(1.5rem,2.6vw,2.25rem)] leading-none tracking-[-0.02em] text-ink-2">~/Realm</p>
          </div>
          <dl className="grid gap-x-12 gap-y-9 sm:grid-cols-2">
            {FACTS.map((fact) => (
              <div key={fact.title}>
                <dt className="text-[16px] font-[560] tracking-[-0.01em] text-ink">{fact.title}</dt>
                <dd className="mt-2 max-w-[44ch] text-[16px] leading-[1.6] text-ink-2">{fact.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section aria-labelledby="faq-title" className="mx-auto w-full max-w-[1680px] px-6 pt-24 pb-8 sm:px-10 sm:pt-32 lg:px-14">
        <div className="grid gap-8 lg:grid-cols-[clamp(360px,30vw,488px)_minmax(0,1fr)] lg:gap-[132px]">
          <h2 id="faq-title" className="text-[clamp(1.9rem,3.2vw,2.75rem)] leading-[1.04] font-[580] tracking-[-0.04em] text-ink">
            Questions
          </h2>
          <div className="max-w-[46rem]">
            {faq.map((item, i) => (
              <details key={item.q} name="inside-faq" open={i === 0} className="group border-b border-line py-5 first:pt-0 [&[open]_.sign]:rotate-45">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-6 text-[17px] leading-[1.45] font-[500] text-ink [&::-webkit-details-marker]:hidden">
                  {item.q}
                  <span aria-hidden className="sign mt-1 shrink-0 text-ink-3 transition-transform duration-200 ease-[var(--ease-out-strong)] group-hover:text-ink-2">
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
      </section>
    </>
  )
}
