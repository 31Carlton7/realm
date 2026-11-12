import type { Metadata } from "next"
import type { CSSProperties } from "react"
import { notFound } from "next/navigation"

import { Arrival, Walk } from "@/components/changelog/Field"
import { isWithdrawn, releases } from "@/lib/changelog"
import { DOOR, SKIES, WORDS, type Box, type SkyName } from "@/lib/og/layout"

export const metadata: Metadata = {
  title: "Share sky",
  robots: { index: false, follow: false },
}

export const dynamicParams = false

export function generateStaticParams() {
  return Object.keys(SKIES).map((name) => ({ name }))
}

const place = (box: Box): CSSProperties => ({ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height })

/**
 * A sky behind the changelog's share cards, with nothing on it: scripts/capture-share-images.mjs opens
 * this at 1200 × 630 and saves the frame as public/og/sky-<name>.png, and the card routes set their
 * words over it. It is the changelog's own field, composed as the cards lay out (lib/og/layout.ts):
 * the words' block, empty here, keeps the sky's realms out and the field dimmed where the type will
 * stand, and the realm hangs in the door's box. Nothing links here.
 */
export default async function SkyPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  if (!(name in SKIES)) notFound()
  const sky = SKIES[name as SkyName]
  return (
    <main className="relative h-[100dvh] overflow-hidden">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-20 bg-[#03050b]" />
      {sky.kind === "walk" ? (
        <>
          <Walk releases={releases.map((release) => ({ slug: release.slug, dark: isWithdrawn(release) }))} />
          {/* The walk hangs the releases right of the list it is read beside: here, the words. */}
          <div aria-hidden data-field-anchor="c:list" style={place(WORDS)} />
          <div aria-hidden data-field-anchor="c:hero" style={place(WORDS)} />
        </>
      ) : (
        <>
          <Arrival release={sky.release} total={releases.length} dark={sky.dark} />
          <div aria-hidden data-field-anchor="s:door" style={place(DOOR)} />
          <div aria-hidden data-field-anchor="c:title" style={place(WORDS)} />
        </>
      )}
    </main>
  )
}
