import { DOCS_ALT, docsIndexCard } from "@/lib/og/card"
import { CARD } from "@/lib/og/layout"

// The docs home's share card (lib/og/card.tsx); its twin beside it serves the same picture to the other network.
export const alt = DOCS_ALT
export const size = CARD
export const contentType = "image/png"

export default function Image() {
  return docsIndexCard()
}
