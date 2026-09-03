/**
 * The mark, drawn from the same idea as the hero: a lit core inside a ring of panes. Inline SVG so
 * it inherits `currentColor` and needs no network request in the nav.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <svg viewBox="0 0 24 24" aria-hidden className="h-[22px] w-[22px]" fill="none">
        <circle cx="12" cy="12" r="3.4" fill="currentColor" />
        <ellipse
          cx="12"
          cy="12"
          rx="10"
          ry="5.4"
          stroke="currentColor"
          strokeOpacity="0.5"
          strokeWidth="1.3"
          transform="rotate(-32 12 12)"
        />
        <rect x="2.6" y="8.4" width="3" height="4.6" rx="0.9" fill="currentColor" fillOpacity="0.55" />
        <rect x="18.4" y="11" width="3" height="4.6" rx="0.9" fill="currentColor" fillOpacity="0.55" />
      </svg>
      <span className="text-[15px] font-semibold tracking-[-0.02em]">Realm</span>
    </span>
  )
}
