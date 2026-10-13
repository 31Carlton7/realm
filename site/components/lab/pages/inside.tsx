import type { PageDesignProps } from "@/components/lab/pages"

/** Placeholder until the Inside redesign is built. */
export default function Inside({ download }: PageDesignProps) {
  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-3xl flex-col justify-center gap-4 px-6">
      <h1 className="text-[40px] font-[580] tracking-[-0.04em] text-ink">Inside</h1>
      <p className="text-[17px] text-ink-2">This redesign is still being built.</p>
      <a href={download.href} className="text-accent-ink">Download for Mac</a>
    </main>
  )
}
