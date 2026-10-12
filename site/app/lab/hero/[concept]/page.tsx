import type { Metadata } from "next"
import { notFound } from "next/navigation"
import type { ComponentType } from "react"

import Current from "@/components/lab/concepts/current"
import Doorway from "@/components/lab/concepts/doorway"
import Hive from "@/components/lab/concepts/hive"
import Streams from "@/components/lab/concepts/streams"
import World from "@/components/lab/concepts/world"
import { concepts, type ConceptSlug } from "@/components/lab/concepts"
import type { ConceptProps } from "@/components/lab/HeroParts"
import { LabSwitcher } from "@/components/lab/LabSwitcher"
import { SiteHeader } from "@/components/SiteHeader"
import { macDownload } from "@/lib/release"

/**
 * One hero concept at a time, under the site's real header and over a stretch of empty page, so the
 * way each one leaves as the page scrolls can be judged too. Not linked from anywhere, and not indexed.
 */
const views: Record<ConceptSlug, ComponentType<ConceptProps>> = {
  current: Current,
  doorway: Doorway,
  hive: Hive,
  streams: Streams,
  world: World,
}

export const metadata: Metadata = { title: "Hero lab", robots: { index: false, follow: false } }

export function generateStaticParams() {
  return concepts.map((concept) => ({ concept: concept.slug }))
}

export default async function HeroLabPage({ params }: { params: Promise<{ concept: string }> }) {
  const { concept } = await params
  const View = views[concept as ConceptSlug]
  if (!View) notFound()
  const download = await macDownload()

  return (
    <div className="min-h-[100dvh]">
      <SiteHeader width="max-w-[92rem]" floating />
      <main>
        <View download={download} />
        <div aria-hidden className="h-[70vh]" />
      </main>
      <LabSwitcher current={concept} />
    </div>
  )
}
