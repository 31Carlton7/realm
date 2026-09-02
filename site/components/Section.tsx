export function SectionHeading({
  eyebrow,
  title,
  lede,
  className,
}: {
  eyebrow: string
  title: React.ReactNode
  lede?: React.ReactNode
  className?: string
}) {
  return (
    <div className={`max-w-2xl ${className ?? ""}`}>
      <p className="text-[12px] font-medium tracking-[0.1em] text-accent-ink uppercase">{eyebrow}</p>
      <h2 className="display-tight mt-4 text-[clamp(2rem,3.6vw,3rem)] font-semibold text-ink">{title}</h2>
      {lede ? <p className="mt-5 text-[17px] leading-relaxed text-ink-2">{lede}</p> : null}
    </div>
  )
}
