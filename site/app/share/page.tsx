import type { Metadata } from "next"

import { DimensionField } from "@/components/dimension/DimensionField"
import { Wordmark } from "@/components/Wordmark"
import { sceneFile, WINDOW } from "@/lib/frames"

export const metadata: Metadata = {
  title: "Share image",
  robots: { index: false, follow: false },
}

/**
 * The source for the site's share images. scripts/capture-share-images.mjs opens this at 1200 × 630
 * and saves the frame as app/opengraph-image.png and app/twitter-image.png; nothing links here.
 *
 * It is the landing page's hero at card size: the headline, and the workspace rising in its portal
 * under the same dimension field, so a shared link looks like the page it opens. The wordmark stands
 * in for the header, which a card does not have. The prose and the buttons are left out: a card
 * cannot be clicked, and at thumbnail size they would only be clutter.
 */
export default function SharePage() {
  return (
    <main data-dim-stage="hero" className="relative h-[100dvh] overflow-hidden">
      <DimensionField />
      <div className="px-14 pt-12">
        <Wordmark size="display" className="text-ink" />
        <h1 className="mt-9 max-w-[15ch] text-[80px] leading-[0.98] font-[560] tracking-[-0.047em] text-ink">
          Give your agents a world to work in.
        </h1>
      </div>
      {/* The rect is fixed before the capture loads, because the field reads it once: under reduced
          motion it paints a single frame. */}
      <div
        data-dim="portal"
        className="app-corner absolute inset-x-14 top-[392px] aspect-[1.6] overflow-hidden rounded-[20px] bg-page shadow-[0_0_0_1px_oklch(1_0_0/0.09)]"
      >
        <img src={sceneFile("workspace", 1440)} alt="" width={WINDOW.width * 2} height={WINDOW.height * 2} className="h-auto w-full" />
      </div>
    </main>
  )
}
