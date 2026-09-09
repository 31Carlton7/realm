/**
 * The standalone vector mark at nav size. The app icon has a shell; the wordmark does not.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-3 ${className ?? ""}`}>
      <img src="/realm-mark.svg" alt="" aria-hidden width={22} height={26} className="h-[26px] w-auto" />
      <span className="text-[17px] font-semibold tracking-[-0.02em]">Realm</span>
    </span>
  )
}
