/**
 * The standalone vector mark beside the name. The app icon has a shell; the wordmark does not.
 *
 * Two sizes: `nav` for the landing page and header, `display` for the share card, where the whole
 * image is read at thumbnail size and a nav-sized mark would be a smudge.
 */
const sizes = {
  nav: { mark: "h-[26px]", name: "text-[17px]", gap: "gap-3" },
  display: { mark: "h-[64px]", name: "text-[42px]", gap: "gap-5" },
} as const

export function Wordmark({ className, size = "nav" }: { className?: string; size?: keyof typeof sizes }) {
  const s = sizes[size]
  return (
    <span className={`inline-flex items-center ${s.gap} ${className ?? ""}`}>
      <img src="/realm-mark.svg" alt="" aria-hidden width={22} height={26} className={`${s.mark} w-auto`} />
      <span className={`${s.name} font-semibold tracking-[-0.02em]`}>Realm</span>
    </span>
  )
}
