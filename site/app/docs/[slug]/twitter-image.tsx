import { allDocs } from "@/lib/docs"
import { DOCS_ALT, docsCard } from "@/lib/og/card"
import { CARD } from "@/lib/og/layout"

// A docs page's share card (lib/og/card.tsx), drawn at build for every page; its twin beside it serves
// the same picture to the other network.
export const alt = DOCS_ALT
export const size = CARD
export const contentType = "image/png"

export function generateStaticParams() {
  return allDocs.map((doc) => ({ slug: doc.slug }))
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return (await docsCard(slug)) ?? new Response("Not found", { status: 404 })
}
