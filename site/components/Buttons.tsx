import type { ReactNode } from "react"

import { AppleIcon, LinuxIcon, WindowsIcon } from "@/components/icons"
import type { Downloads, Platform } from "@/lib/release"

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

export const PLATFORMS: { id: Platform; name: string; Icon: typeof AppleIcon; icon: string }[] = [
  { id: "mac", name: "Mac", Icon: AppleIcon, icon: "h-4 w-4 -translate-y-px" },
  { id: "windows", name: "Windows", Icon: WindowsIcon, icon: "h-3.5 w-3.5" },
  { id: "linux", name: "Linux", Icon: LinuxIcon, icon: "h-4 w-4" },
]

/**
 * The download, for the reader's own system. All three builds are in the markup and globals.css shows
 * the one `data-os` names — set before the first paint by app/layout.tsx — so the button is right in
 * its first frame, with no swap once the page wakes. Without the script, or on a system Realm has no
 * build for, it is the Mac's.
 */
export function DownloadButton({ downloads, compact = false, size = "md" }: { downloads: Downloads; compact?: boolean; size?: "md" | "lg" }) {
  return PLATFORMS.map(({ id, name, Icon, icon }) => (
    <a
      key={id}
      href={downloads[id]}
      data-platform={id}
      className={`${base} btn-primary ${size === "lg" ? "min-h-12 px-5.5 text-[15px]" : ""} bg-[linear-gradient(to_bottom,oklch(0.56_0.175_254),oklch(0.5_0.175_254))] [--shade:linear-gradient(to_bottom,oklch(0.5_0.175_254),oklch(0.44_0.175_254))] [--shade-press:linear-gradient(to_bottom,oklch(0.45_0.175_254),oklch(0.4_0.175_254))] font-[520]`}
    >
      <Icon className={icon} />
      {compact ? "Download" : `Download for ${name}`}
    </a>
  ))
}

export function QuietButton({ href, children, external = false }: { href: string; children: ReactNode; external?: boolean }) {
  return (
    <a href={href} {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})} className={`${base} btn-quiet`}>
      {children}
    </a>
  )
}
