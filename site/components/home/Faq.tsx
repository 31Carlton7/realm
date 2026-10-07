import { faq } from "@/content/home"

/**
 * The questions, answered.
 *
 * Native `<details>`, because a disclosure is a control the platform already has: it opens without
 * JavaScript, it is keyboard-reachable, it is findable by the browser's own in-page search, and it
 * prints. A hand-built accordion would have to earn all four back.
 *
 * The first is open. A row of closed rows asks the reader to guess which one is worth a click, and
 * the first question is the one most people arrive with.
 */
export function Faq() {
  return (
    <section aria-labelledby="faq-title" className="mx-auto w-full max-w-[52rem] px-6 py-16 sm:px-10 sm:py-20">
      <h2 id="faq-title" className="text-[clamp(1.6rem,2.6vw,2.1rem)] leading-[1.12] font-[560] tracking-[-0.032em] text-ink">
        Questions
      </h2>
      <dl className="mt-8">
        {faq.map((item, i) => (
          <details
            key={item.q}
            name="faq"
            open={i === 0}
            className="group border-t border-line py-4 last:border-b [&[open]_.faq-sign]:rotate-45"
          >
            <summary className="flex cursor-pointer list-none items-start justify-between gap-6 text-[16px] leading-[1.45] font-[500] text-ink [&::-webkit-details-marker]:hidden">
              <dt>{item.q}</dt>
              {/* A plus that becomes a cross. One glyph, rotated — not two icons swapped, which is a
                  second thing to keep in step for no gain. */}
              <span
                aria-hidden="true"
                className="faq-sign mt-1 shrink-0 text-ink-3 transition-transform duration-200 ease-[var(--ease-out-strong)]"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 1.5v11M1.5 7h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </span>
            </summary>
            <dd className="mt-3 max-w-[68ch] text-[15px] leading-[1.6] text-ink-2">{item.a}</dd>
          </details>
        ))}
      </dl>
    </section>
  )
}
