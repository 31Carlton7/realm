import { faq } from "@/content/home"

/**
 * The questions a reader arrives with, answered with the limit as plainly as the capability. Native
 * <details>, so they open without script, are reached by the keyboard and found by the browser's own
 * search; the first is open.
 */
export function Questions() {
  return (
    <section aria-labelledby="faq-title" className="mx-auto w-full max-w-[85rem] px-5 py-20 sm:px-10 sm:py-28">
      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <h2 id="faq-title" data-station className="text-[clamp(1.9rem,3.2vw,2.75rem)] leading-[1.04] font-[580] tracking-[-0.042em] text-ink">
            Questions
          </h2>
          <p className="mt-4 max-w-[34ch] text-[16.5px] leading-[1.6] text-ink-2">The ones people ask first, with the limits stated.</p>
        </div>
        <div className="lg:col-span-8">
          {faq.map((item, i) => (
            <details key={item.q} name="live-faq" open={i === 0} className="group border-t border-line py-5 last:border-b">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-6 text-[16.5px] leading-[1.45] font-[520] text-ink [&::-webkit-details-marker]:hidden">
                <span>{item.q}</span>
                <span aria-hidden className="mt-1.5 shrink-0 text-ink-3 transition-transform duration-200 ease-[var(--ease-out-strong)] group-open:rotate-45">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 1.5v11M1.5 7h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                </span>
              </summary>
              <p className="mt-3 max-w-[68ch] text-[16px] leading-[1.6] text-ink-2">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}
