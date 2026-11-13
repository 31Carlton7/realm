import type { Metadata } from "next"

import { ShareCard } from "@/components/landing/ShareCard"

export const metadata: Metadata = {
  title: "Share image",
  robots: { index: false, follow: false },
}

/**
 * The source for the site's share images. scripts/capture-share-images.mjs opens this at 1200 × 630
 * and saves the frame as app/opengraph-image.png and app/twitter-image.png; nothing links here. It is
 * the landing page's first screen at a card's size: the mark, the headline and the new session on
 * Aurora below them.
 */
export default function SharePage() {
  return <ShareCard />
}
