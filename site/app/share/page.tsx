import type { Metadata } from "next"

import { ShareCard } from "@/components/landing/ShareCard"
import worlds from "@/content/worlds.json"

export const metadata: Metadata = {
  title: "Share image",
  robots: { index: false, follow: false },
}

function webb() {
  const found = worlds.find((w) => w.id === "webb")
  if (!found) throw new Error('no world "webb" in content/worlds.json')
  return found
}

/**
 * The source for the site's share images. scripts/capture-share-images.mjs opens this at 1200 × 630
 * and saves the frame as app/opengraph-image.png and app/twitter-image.png; nothing links here. It is
 * the landing page's first screen at a card's size: the hero's ring onto Cosmic Cliffs, its headline
 * and the mark.
 */
export default function SharePage() {
  return <ShareCard world={webb()} />
}
