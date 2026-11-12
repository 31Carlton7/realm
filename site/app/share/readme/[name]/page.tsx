import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { Screen } from "@/components/realms/Screen"
import { partImage } from "@/lib/pictures"

export const metadata: Metadata = {
  title: "README picture",
  robots: { index: false, follow: false },
}

/** The parts of the window the repository README shows beside its feature list. */
const SHOWN = ["sidebar", "models", "connections", "sandbox"]

export const dynamicParams = false

export function generateStaticParams() {
  return SHOWN.map((name) => ({ name }))
}

/**
 * A part of the window on the plate the landing page stands it on, alone on the field's own dark,
 * photographed at 1440 × 900 and twice the density for the repository README: as large as the frame
 * takes without enlarging the capture past its own density (3×, so half that zoom at 2×). The dark is
 * solid, since a README is read on GitHub's white theme as well as its dark one. Nothing links here.
 */
export default async function ReadmePart({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  const image = SHOWN.includes(name) ? partImage(name) : null
  if (!image) notFound()
  return (
    <main className="flex h-[100dvh] items-center justify-center bg-[#03050b] px-16">
      <Screen image={image} alt="" kind="part" zoom={1.5} maxHeight="820px" priority className="w-full" />
    </main>
  )
}
