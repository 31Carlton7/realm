import type { Metadata } from "next"

import { RealmCanvas } from "@/components/RealmCanvas"
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
 * It is the landing page with the controls taken off: a card cannot be clicked, so the download
 * button and the corner links would only be clutter at thumbnail size. The canvas is drawn taller
 * than the viewport so the mark, which sizes itself from the viewport height, fills a card the way
 * it fills a window, and shifted right so the tagline's long line clears it.
 */
export default function SharePage() {
  return (
    <main className="relative h-[100dvh] overflow-hidden">
      <div className="pointer-events-none absolute top-[-28%] right-[-24%] left-[24%] h-[156%]">
        <RealmCanvas className="h-full w-full" />
      </div>

      <div className="absolute inset-x-0 bottom-0 p-14">
        <Wordmark className="text-ink" />
        <p className="mt-5 max-w-[19ch] text-[64px] leading-[1.02] font-[560] tracking-[-0.042em] text-balance text-ink">
          {site.tagline}
        </p>
      </div>
    </main>
  )
}
