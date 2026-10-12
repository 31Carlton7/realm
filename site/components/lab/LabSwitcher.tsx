"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect } from "react"

import { concepts } from "./concepts"

/**
 * The lab's own chrome: which concept is up, and the way to the others — by click, or by the digit
 * keys, so two concepts can be flicked between without the pointer leaving the hero.
 */
export function LabSwitcher({ current }: { current: string }) {
  const router = useRouter()
  const index = concepts.findIndex((c) => c.slug === current)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, [contenteditable=true], [contenteditable='']")) return
      let next = -1
      if (/^[0-9]$/.test(event.key)) next = Number(event.key)
      else if (event.key === "ArrowRight" || event.key === "]") next = (index + 1) % concepts.length
      else if (event.key === "ArrowLeft" || event.key === "[") next = (index - 1 + concepts.length) % concepts.length
      if (next < 0 || next >= concepts.length || next === index) return
      event.preventDefault()
      router.push(`/lab/hero/${concepts[next].slug}`, { scroll: false })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [index, router])

  const shown = concepts[index]

  return (
    <nav
      aria-label="Hero concepts"
      className="fixed bottom-5 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2"
    >
      {shown ? (
        <p className="max-w-[46rem] rounded-[10px] bg-[oklch(0.24_0.005_264/0.92)] px-3 py-1.5 text-center text-[12.5px] text-ink-2 text-pretty shadow-[inset_0_0_0_1px_var(--color-line)]">
          {shown.claim}
        </p>
      ) : null}
      <div className="flex items-center gap-1 overflow-x-auto rounded-[14px] bg-[oklch(0.24_0.005_264/0.92)] p-1 shadow-[inset_0_1px_0_oklch(1_0_0/0.06),inset_0_0_0_1px_var(--color-line),0_12px_32px_-12px_oklch(0_0_0/0.7)]">
        {concepts.map((concept, i) => (
          <Link
            key={concept.slug}
            href={`/lab/hero/${concept.slug}`}
            scroll={false}
            aria-current={i === index ? "page" : undefined}
            className="inline-flex h-9 items-center gap-2 rounded-[10px] px-3 text-[13px] whitespace-nowrap text-ink-2 hover:text-ink aria-[current=page]:bg-raised aria-[current=page]:text-ink"
          >
            <span className="font-mono text-[11px] text-ink-3">{i}</span>
            {concept.name}
          </Link>
        ))}
      </div>
    </nav>
  )
}
