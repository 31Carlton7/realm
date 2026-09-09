import type { Metadata } from "next"

import { Wordmark } from "@/components/Wordmark"
import { site } from "@/lib/site"

export const metadata: Metadata = {
  title: "Share image",
  robots: { index: false, follow: false },
}

/**
 * The source for the site's share images. scripts/capture-share-images.mjs opens this at 1200 × 630
 * and saves the frame as app/opengraph-image.png and app/twitter-image.png; nothing links here.
 *
 * It is the wordmark and the tagline on the page colour, and nothing else. A card cannot be clicked,
 * so the landing page's controls would only be clutter at thumbnail size, and the glass mark was
 * taken off too: at card size it read as a crystal rather than the mark.
 */
export default function SharePage() {
  return (
    <main className="relative h-[100dvh] overflow-hidden">
      <div className="absolute inset-x-0 bottom-0 p-14">
        <Wordmark className="text-ink" />
        <p className="mt-5 max-w-[19ch] text-[64px] leading-[1.02] font-[560] tracking-[-0.042em] text-balance text-ink">
          {site.tagline}
        </p>
      </div>
    </main>
  )
}
