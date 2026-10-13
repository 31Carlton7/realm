import type { ReactNode } from "react"

import { AppleIcon } from "@/components/icons"

/**
 * The site's two button weights. The primary is the download and nothing else, so a page never has
 * two equal calls to action (design.md, Reject these defaults). Its face is the accent with light
 * from above — a top highlight and a rim a shade lighter than the fill — rather than a glow. The
 * gradient runs from L 0.56 to 0.5 so even its lightest band holds white at 4.7 : 1 (the old
 * 0.72 top read 2.6); under the pointer it deepens a step (`--shade`), so the pointer's light on it
 * peaks no paler than 4.5 : 1, and a press a step more (`--shade-press`). scripts/check-contrast.mjs
 * measures every stop of all three.
 *
 * How either answers the pointer — its light, the spring it arrives on, a press that is a fill and not
 * a size — is globals.css's `.btn`.
 */
const base = "btn app-corner inline-flex min-h-11 items-center gap-2 rounded-[14px] px-4.5 py-2.5 text-[14px]"

export function DownloadButton({ href, label = "Download for Mac", size = "md" }: { href: string; label?: string; size?: "md" | "lg" }) {
  return (
    <a
      href={href}
      className={`${base} btn-primary ${size === "lg" ? "min-h-12 px-5.5 text-[15px]" : ""} bg-[linear-gradient(to_bottom,oklch(0.56_0.175_254),oklch(0.5_0.175_254))] [--shade:linear-gradient(to_bottom,oklch(0.5_0.175_254),oklch(0.44_0.175_254))] [--shade-press:linear-gradient(to_bottom,oklch(0.45_0.175_254),oklch(0.4_0.175_254))] font-[520]`}
    >
      <AppleIcon className="h-4 w-4 -translate-y-px" />
      {label}
    </a>
  )
}

export function QuietButton({ href, children, external = false }: { href: string; children: ReactNode; external?: boolean }) {
  return (
    <a href={href} {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})} className={`${base} btn-quiet`}>
      {children}
    </a>
  )
}
