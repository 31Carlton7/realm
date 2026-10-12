"use client"

import { useEffect, useRef, type ReactNode } from "react"

/**
 * Keeps the header on screen over a long page. At the top it is the page's own chrome, with no plate
 * behind it; once the page has moved it settles onto a plate of the page's colour with a hairline,
 * inset from the window's edges, so words scrolling under it stay out of the way of its links.
 */
export function FloatingHeader({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const update = () => {
      if (window.scrollY > 8) node.dataset.scrolled = ""
      else delete node.dataset.scrolled
    }
    update()
    window.addEventListener("scroll", update, { passive: true })
    return () => window.removeEventListener("scroll", update)
  }, [])
  return (
    <div ref={ref} className="group/head sticky top-0 z-50 px-2 pt-2 sm:px-4">
      <div className="mx-auto max-w-[94rem] rounded-[18px] transition-[background-color,box-shadow,backdrop-filter] duration-300 ease-[var(--ease-out-strong)] group-data-[scrolled]/head:bg-page/80 group-data-[scrolled]/head:shadow-[inset_0_0_0_1px_var(--color-line),0_8px_30px_-12px_oklch(0_0_0/0.6)] group-data-[scrolled]/head:backdrop-blur-xl group-data-[scrolled]/head:backdrop-saturate-150">
        {children}
      </div>
    </div>
  )
}
