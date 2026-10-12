/**
 * Where Clerk lists its certifications in a row of four, Realm lists where things live. Each is a fact
 * the FAQ answers at length; this is the fast path through them.
 */
const FACTS: { title: string; body: string }[] = [
  { title: "On your Mac", body: "Transcripts, documents, skills and checkpoints are files and a SQLite database under ~/Realm." },
  { title: "No account", body: "There is nothing to sign up for, and nothing you make in Realm is uploaded." },
  { title: "No API key", body: "Realm drives the agent CLIs you already have, on the plan you already pay for." },
  { title: "Signed and notarized", body: "Builds for Apple silicon, updated from a public release feed. The source is on GitHub." },
]

export function LocalFacts() {
  return (
    <section aria-label="Where your work lives" className="mx-auto w-full max-w-[92rem] px-6 sm:px-10">
      <dl className="grid border-y border-line sm:grid-cols-2 lg:grid-cols-4">
        {FACTS.map((fact, i) => (
          <div
            key={fact.title}
            className={`px-1 py-8 sm:px-7 sm:py-10 ${i > 0 ? "max-sm:border-t" : ""} border-line sm:[&:nth-child(2n)]:border-l lg:[&:nth-child(n+2)]:border-l sm:[&:nth-child(n+3)]:max-lg:border-t`}
          >
            <dt className="text-[15px] font-[560] tracking-[-0.01em] text-ink">{fact.title}</dt>
            <dd className="mt-2 text-[14.5px] leading-[1.55] text-ink-2">{fact.body}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
