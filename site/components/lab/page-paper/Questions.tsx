import { faq } from "@/content/home"

import { Register } from "./kinetic"
import s from "./paper.module.css"

/** The term each question is filed under, as a book's index would file it. */
const TERMS: Record<string, string> = {
  "Which agents can I run?": "Agents",
  "Do I need an API key?": "API keys",
  "Where does my work live?": "Files, where they live",
  "Can an agent read my tokens?": "Tokens and credentials",
  "Which Macs does it run on?": "Macs",
  "Is it finished?": "Development, state of",
}

/**
 * The questions, set as an index: each filed under the term a reader would look it up by, the terms
 * in alphabetical order under their letters, and the answer opening in place. Native `<details>`, so
 * it opens without script, is reached by the keyboard, and is found by the browser's own search.
 */
export function Questions() {
  const entries = faq
    .map((item) => ({ ...item, term: TERMS[item.q] ?? item.q }))
    .sort((a, b) => a.term.localeCompare(b.term))
  const letters = [...new Set(entries.map((e) => e.term[0]!.toUpperCase()))]

  return (
    <section data-running-head="Questions" aria-labelledby="questions-title" className={s.section}>
      <div className={`${s.measure} ${s.grid} gap-y-10`}>
        <div className="col-span-12 lg:col-span-4">
          <Register id="questions-title" text="Questions, indexed." className={`${s.statement} text-ink`} />
          <p className={`${s.body} mt-6 max-w-[34ch] text-[16px]`}>
            What people ask before they install it, filed under what they&rsquo;d look it up by.
          </p>
        </div>
        <div className="col-span-12 lg:col-span-8">
          {letters.map((letter) => (
            <div key={letter} className="grid grid-cols-[2.5rem_minmax(0,1fr)] border-t border-ink/70 sm:grid-cols-[4rem_minmax(0,1fr)]">
              <p aria-hidden className="pt-4 text-[22px] leading-none font-[600] tracking-[-0.02em] text-ink-3">
                {letter}
              </p>
              <div>
                {entries
                  .filter((e) => e.term[0]!.toUpperCase() === letter)
                  .map((e, i) => (
                    <details key={e.q} name="paper-index" className={`group ${i > 0 ? "border-t border-line" : ""}`} open={e.term === "Agents"}>
                      <summary className="flex cursor-pointer list-none items-baseline gap-4 py-4 [&::-webkit-details-marker]:hidden">
                        <span className="min-w-0 flex-1">
                          <span className="block text-[18px] leading-[1.35] font-[580] tracking-[-0.016em] text-ink sm:inline">{e.term}</span>
                          <span className="block text-[16px] text-ink-2 sm:ml-3 sm:inline">{e.q}</span>
                        </span>
                        <span aria-hidden className="shrink-0 text-[18px] leading-none text-ink-3 transition-transform duration-200 ease-[var(--ease-out-strong)] group-open:rotate-45">
                          +
                        </span>
                      </summary>
                      <p className={`${s.body} max-w-[64ch] pb-6 text-[16px]`}>{e.a}</p>
                    </details>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
