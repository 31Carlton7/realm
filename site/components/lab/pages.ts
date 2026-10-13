import type { Claim } from "@/content/home"
import type { MacDownload } from "@/lib/release"

/**
 * The whole-page redesigns in the lab, in switcher order. Digit keys 0–4 go to each by its index;
 * 0 is the landing page as it ships today, rendered from app/page.tsx itself.
 */
export const pageDesigns = [
  { slug: "current", name: "Current", claim: "Today's landing page, as it ships." },
  { slug: "inside", name: "Inside", claim: "The page is the app: the live workspace stays on stage and every chapter drives it." },
  { slug: "realms", name: "Realms", claim: "A flight across a world of realms: each feature opens through a doorway." },
  { slug: "paper", name: "Paper", claim: "Realm's light face as an editorial: kinetic type, plates and a contact sheet." },
  { slug: "live", name: "Live", claim: "Realm as a live system: every feature an instrument you can play." },
] as const

export type PageDesignSlug = (typeof pageDesigns)[number]["slug"]

/** A claim whose capture is known to exist (`capture` is null where it was never recorded). */
export type ProvenClaim = Claim

/** What the lab hands every redesign: the current download, and the claims intersected with the
 *  capture manifest, exactly as the landing page computes them. */
export type PageDesignProps = { download: MacDownload; claims: ProvenClaim[] }
