import { RealmsHome } from "@/components/realms/RealmsHome"
import { claims } from "@/content/home"
import { downloads } from "@/lib/release"
import captured from "@/public/product/manifest.json"

/**
 * The landing page: one flight across a world built from Realm's mark, drawn live behind the page
 * (components/realms). The flight is scrubbed by the reader's scroll and nothing else.
 *
 * The capture manifest is the authority on what exists, never the copy: a claim whose capture failed
 * to record drops its picture rather than rendering a broken image or borrowing another section's.
 */
export default async function HomePage() {
  const download = await downloads()
  const taken = new Set(captured as string[])
  const proven = claims.map((claim) => ({ ...claim, capture: claim.capture && taken.has(claim.capture) ? claim.capture : null }))
  return <RealmsHome download={download} claims={proven} />
}
