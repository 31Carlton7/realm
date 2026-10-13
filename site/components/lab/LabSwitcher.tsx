"use client"

import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect } from "react"

export type LabItem = { readonly slug: string; readonly name: string; readonly claim: string }

/**
 * The lab's own chrome: which design is up, and the way to the others — by click, or by the digit
 * keys and ←/→ (or [ and ]), so two designs can be flicked between without the pointer leaving them.
 */
export function LabSwitcher({ items, base, current, label }: { items: readonly LabItem[]; base: string; current: string; label: string }) {
  const router = useRouter()
  const index = items.findIndex((c) => c.slug === current)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, [contenteditable=true], [contenteditable='']")) return
      let next = -1
      if (/^[0-9]$/.test(event.key)) next = Number(event.key)
      else if (event.key === "ArrowRight" || event.key === "]") next = (index + 1) % items.length
      else if (event.key === "ArrowLeft" || event.key === "[") next = (index - 1 + items.length) % items.length
      if (next < 0 || next >= items.length || next === index) return
      event.preventDefault()
      router.push(`${base}/${items[next].slug}` as Route, { scroll: false })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [base, index, items, router])

  const shown = items[index]

  return (
    <nav
      aria-label={label}
      data-lab-switcher
      className="fixed bottom-5 left-1/2 z-[100] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2"
    >
      {shown ? (
        <p className="max-w-[46rem] rounded-[10px] bg-[oklch(0.24_0.005_264/0.92)] px-3 py-1.5 text-center text-[12.5px] text-[oklch(0.731_0.008_260.731)] text-pretty shadow-[inset_0_0_0_1px_oklch(1_0_0/0.08)]">
          {shown.claim}
        </p>
      ) : null}
      <div className="flex items-center gap-1 overflow-x-auto rounded-[14px] bg-[oklch(0.24_0.005_264/0.92)] p-1 shadow-[inset_0_1px_0_oklch(1_0_0/0.06),inset_0_0_0_1px_oklch(1_0_0/0.08),0_12px_32px_-12px_oklch(0_0_0/0.7)]">
        {items.map((item, i) => (
          <Link
            key={item.slug}
            href={`${base}/${item.slug}` as Route}
            scroll={false}
            aria-current={i === index ? "page" : undefined}
            className="inline-flex h-9 items-center gap-2 rounded-[10px] px-3 text-[13px] whitespace-nowrap text-[oklch(0.731_0.008_260.731)] hover:text-[oklch(0.964_0.002_247.839)] aria-[current=page]:bg-[oklch(0.289_0.006_271.22)] aria-[current=page]:text-[oklch(0.964_0.002_247.839)]"
          >
            <span className="font-mono text-[11px] text-[oklch(0.541_0.01_264.484)]">{i}</span>
            {item.name}
          </Link>
        ))}
      </div>
    </nav>
  )
}
