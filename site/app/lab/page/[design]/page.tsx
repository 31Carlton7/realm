import type { Metadata } from "next"
import { notFound } from "next/navigation"
import type { ComponentType } from "react"

import HomePage from "@/app/page"
import { LabSwitcher } from "@/components/lab/LabSwitcher"
import { pageDesigns, type PageDesignProps, type PageDesignSlug } from "@/components/lab/pages"
import Inside from "@/components/lab/pages/inside"
import Live from "@/components/lab/pages/live"
import Paper from "@/components/lab/pages/paper"
import Realms from "@/components/lab/pages/realms"
import { claims } from "@/content/home"
import { macDownload } from "@/lib/release"
import captured from "@/public/product/manifest.json"

/**
 * One whole landing page at a time. Each redesign owns everything from its header to its footer;
 * "current" is the landing page itself, rendered from app/page.tsx. Not linked from anywhere, and
 * not indexed.
 */
const designs: Record<Exclude<PageDesignSlug, "current">, ComponentType<PageDesignProps>> = {
  inside: Inside,
  realms: Realms,
  paper: Paper,
  live: Live,
}

export const metadata: Metadata = { title: "Page lab", robots: { index: false, follow: false } }

export function generateStaticParams() {
  return pageDesigns.map((design) => ({ design: design.slug }))
}

export default async function PageLabPage({ params }: { params: Promise<{ design: string }> }) {
  const { design } = await params
  const switcher = <LabSwitcher items={pageDesigns} base="/lab/page" current={design} label="Page designs" />
  if (design === "current") {
    return (
      <>
        <HomePage />
        {switcher}
      </>
    )
  }
  const Design = designs[design as Exclude<PageDesignSlug, "current">]
  if (!Design) notFound()

  const download = await macDownload()
  const taken = new Set(captured as string[])
  // The landing page's own rule: the manifest is the authority on what exists, never the copy.
  const proven = claims.map((claim) => ({ ...claim, capture: claim.capture && taken.has(claim.capture) ? claim.capture : null }))

  return (
    <>
      <Design download={download} claims={proven} />
      {switcher}
    </>
  )
}
