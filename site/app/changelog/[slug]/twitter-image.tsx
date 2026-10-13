import { changelog } from "@/lib/changelog"
import { ENTRY_ALT, entryCard } from "@/lib/og/card"
import { CARD } from "@/lib/og/layout"

// An entry's share card (lib/og/card.tsx), drawn at build for every entry; its twin beside it serves the
// same picture to the other network.
export const alt = ENTRY_ALT
export const size = CARD
export const contentType = "image/png"

export function generateStaticParams() {
  return changelog.map((entry) => ({ slug: entry.slug }))
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return (await entryCard(slug)) ?? new Response("Not found", { status: 404 })
}
