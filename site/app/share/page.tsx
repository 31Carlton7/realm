import type { Metadata } from "next"
import type { CSSProperties } from "react"

import { Flight } from "@/components/realms/Flight"
import { Wordmark } from "@/components/Wordmark"
import { partImage, sceneImage } from "@/lib/pictures"
import { site } from "@/lib/site"

export const metadata: Metadata = {
  title: "Share image",
  robots: { index: false, follow: false },
}

/**
 * The source for the site's share images. scripts/capture-share-images.mjs opens this at 1200 × 630
 * and saves the frame as app/opengraph-image.png and app/twitter-image.png; nothing links here.
 *
 * It is the landing page's opening at card size: the field of realms drawn by the same flight, the
 * headline over it, and Realm's window rising under the words, framed as the page frames its
 * pictures. The window is a capture of the app rather than the working sample, which a card cannot
 * click. The wordmark stands in for the header, which a card does not have; the prose and the buttons
 * are left out, since at thumbnail size they would only be clutter.
 */
export default function SharePage() {
  const image = partImage("realm") ?? sceneImage("terminal")
  return (
    <main className="relative h-[100dvh] overflow-hidden">
      <Flight />
      <div data-field-anchor="copy" className="relative z-[2] flex flex-col items-center px-14 pt-11 text-center">
        <Wordmark size="display" className="text-ink" />
        <h1 className="mt-6 max-w-[20ch] text-[60px] leading-[1] font-[580] tracking-[-0.05em] text-balance text-ink">{site.tagline}</h1>
      </div>
      {/* Fixed before the picture loads: under reduced motion the field reads the rect for one frame. */}
      <div
        data-field-anchor="portal"
        className="absolute inset-x-[110px] top-[318px] overflow-hidden rounded-[16px] bg-page shadow-[0_0_0_1px_oklch(0_0_0/0.5),0_30px_70px_-20px_oklch(0_0_0/0.65)]"
        style={{ aspectRatio: `${image.width} / ${image.height}` }}
      >
        <img src={image.src} alt="" width={image.width} height={image.height} className="block h-full w-full" />
        <span aria-hidden className="screen-light" style={{ "--screen-radius": "16px" } as CSSProperties} />
      </div>
    </main>
  )
}
