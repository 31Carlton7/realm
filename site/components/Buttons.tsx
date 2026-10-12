import type { ReactNode } from "react"

import { AppleIcon } from "@/components/icons"

/**
 * The site's two button weights. The primary is the download and nothing else, so a page never has
 * two equal calls to action (design.md, Reject these defaults). Its face is the accent with light
 * from above — a top highlight and a rim a shade lighter than the fill — rather than a glow. The
 * gradient runs from L 0.56 to 0.5 so even its lightest band holds white at 4.7 : 1 (the old
 * 0.72 top read 2.6); hover deepens it a step. scripts/check-contrast.mjs measures both stops.
 */
const base =
  "app-corner inline-flex min-h-11 items-center gap-2 rounded-[14px] px-4.5 py-2.5 text-[14px] transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.97]"

export function DownloadButton({ href, label = "Download for Mac", size = "md" }: { href: string; label?: string; size?: "md" | "lg" }) {
  return (
    <a
      href={href}
      className={`${base} ${size === "lg" ? "min-h-12 px-5.5 text-[15px]" : ""} bg-[linear-gradient(to_bottom,oklch(0.56_0.175_254),oklch(0.5_0.175_254))] hover:bg-[linear-gradient(to_bottom,oklch(0.52_0.175_254),oklch(0.46_0.175_254))] font-[520] text-white shadow-[inset_0_1px_0_oklch(1_0_0/0.28),inset_0_0_0_1px_oklch(0.78_0.12_250/0.5),0_1px_2px_oklch(0_0_0/0.4),0_8px_24px_-8px_oklch(0.68_0.173_253.301/0.6)] hover:shadow-[inset_0_1px_0_oklch(1_0_0/0.34),inset_0_0_0_1px_oklch(0.84_0.1_250/0.7),0_1px_2px_oklch(0_0_0/0.4),0_10px_30px_-8px_oklch(0.68_0.173_253.301/0.8)]`}
    >
      <AppleIcon className="h-4 w-4 -translate-y-px" />
      {label}
    </a>
  )
}

export function QuietButton({ href, children, external = false }: { href: string; children: ReactNode; external?: boolean }) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
      className={`${base} bg-surface text-ink-2 shadow-[inset_0_1px_0_oklch(1_0_0/0.07),inset_0_0_0_1px_var(--color-line)] hover:bg-raised hover:text-ink`}
    >
      {children}
    </a>
  )
}
