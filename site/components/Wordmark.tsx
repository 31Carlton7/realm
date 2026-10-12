/**
 * The mark beside the name. The app icon has a tile; the wordmark does not.
 *
 * Two sizes: `nav` for the landing page and header, `display` for the share card, where the whole
 * image is read at thumbnail size and a nav-sized mark would be a smudge.
 *
 * In the header and footer the mark is one colour, drawn inline so it takes the text's colour. The
 * share card stands in for the app, so it carries the app icon's three flat planes instead.
 * scripts/render-icons.mjs draws both from the same silhouette and doorway.
 */
const sizes = {
  nav: { mark: "h-[26px]", name: "text-[17px]", gap: "gap-3" },
  display: { mark: "h-[64px]", name: "text-[42px]", gap: "gap-5" },
} as const

const MARK =
  "M0.5196 24.9A1.8 1.8 0 0 1 0.5196 23.1L9.4804 7.5795A1.8 1.8 0 0 1 11.0392 6.6795L28.9608 6.6795A1.8 1.8 0 0 1 30.5196 7.5795L39.4804 23.1A1.8 1.8 0 0 1 39.4804 24.9L30.5196 40.4205A1.8 1.8 0 0 1 28.9608 41.3205L11.0392 41.3205A1.8 1.8 0 0 1 9.4804 40.4205ZM24.4 20.8823L28.2 14.3005L35.9 27.6373L32.1 34.2191Z"

export function Wordmark({ className, size = "nav" }: { className?: string; size?: keyof typeof sizes }) {
  const s = sizes[size]
  return (
    <span className={`inline-flex items-center ${s.gap} ${className ?? ""}`}>
      {size === "display" ? (
        <img src="/realm-mark.svg" alt="" aria-hidden width={40} height={48} className={`${s.mark} w-auto`} />
      ) : (
        <svg viewBox="0 0 40 48" aria-hidden className={`${s.mark} w-auto`} fill="currentColor">
          <path fillRule="evenodd" d={MARK} />
        </svg>
      )}
      <span className={`${s.name} font-semibold tracking-[-0.02em]`}>Realm</span>
    </span>
  )
}
