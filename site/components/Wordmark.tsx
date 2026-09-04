/**
 * The mark: the app icon itself, at nav size. A plain `img` rather than `next/image` — it is 22px,
 * shown on every page, and the 256px source in `public/` is already small.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <img src="/app-icon.png" alt="" aria-hidden width={22} height={22} className="h-[22px] w-[22px]" />
      <span className="text-[15px] font-semibold tracking-[-0.02em]">Realm</span>
    </span>
  )
}
