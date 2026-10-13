import { Ink } from "./kinetic"
import s from "./paper.module.css"

/** Where things live, from the landing page's four facts (components/home/LocalFacts.tsx). */
const FACTS: { title: string; body: string }[] = [
  { title: "On your Mac", body: "Transcripts, documents, skills and checkpoints are files and a SQLite database under ~/Realm." },
  { title: "No account", body: "There is nothing to sign up for, and nothing you make in Realm is uploaded." },
  { title: "No API key", body: "Realm drives the agent CLIs you already have, on the plan you already pay for." },
  { title: "Signed and notarized", body: "Builds for Apple silicon, updated from a public release feed. The source is on GitHub." },
]

const STATEMENT = ["It", "all", "stays", "on", "your", "Mac,", "under"]

/**
 * Where the work lives: one statement that inks in word by word, the path in the machine's own type,
 * and the four facts under it as a ruled table, the fast path through what the questions answer at
 * length.
 */
export function Facts() {
  return (
    <section data-running-head="Where the work lives" aria-labelledby="facts-title" className={s.section}>
      <div className={s.measure}>
        <h2
          id="facts-title"
          className={`${s.statement} ${s.inkScope} max-w-[16ch] text-ink`}
          style={{ ["--step" as string]: "3.2%", ["--set-weight" as string]: 620 }}
        >
          {STATEMENT.map((word, i) => (
            <span key={word}>
              <Ink index={i}>{word}</Ink>{" "}
            </span>
          ))}
          <span className="font-mono text-[0.86em] font-[500] tracking-[-0.02em] text-accent-ink">~/Realm</span>
        </h2>
        <dl className="mt-14 grid border-t border-ink/70 sm:grid-cols-2 lg:mt-20 lg:grid-cols-4">
          {FACTS.map((fact, i) => (
            <div
              key={fact.title}
              className={`border-line py-6 sm:pr-8 sm:pb-8 lg:pt-5 ${i > 0 ? "border-t sm:border-t-0" : ""} ${i % 2 === 1 ? "sm:border-l sm:pl-8" : ""} ${i >= 2 ? "sm:border-t lg:border-t-0" : ""} ${i === 2 ? "lg:border-l lg:pl-8" : ""}`}
            >
              <dt className="text-[17px] leading-[1.3] font-[580] tracking-[-0.014em] text-ink">{fact.title}</dt>
              <dd className="mt-2 text-[15px] leading-[1.55] text-ink-2">{fact.body}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
