import type { Metadata } from "next"

import { RealmsHome } from "@/components/realms/RealmsHome"
import { claims } from "@/content/home"
import { downloads } from "@/lib/release"
import captured from "@/public/product/manifest.json"

/**
 * The landing page before the round-three redesign, kept for a week so going back is one change:
 * point app/page.tsx at this again. Linked from nowhere, and kept out of search.
 */
export const metadata: Metadata = { robots: { index: false, follow: false } }

export default async function PreviousHomePage() {
  const download = await downloads()
  const taken = new Set(captured as string[])
  const proven = claims.map((claim) => ({ ...claim, capture: claim.capture && taken.has(claim.capture) ? claim.capture : null }))
  return <RealmsHome download={download} claims={proven} />
}
