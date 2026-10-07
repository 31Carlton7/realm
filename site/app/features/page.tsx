import type { Metadata } from "next"

import { Carousel } from "@/components/features/Carousel"
import { SiteHeader } from "@/components/SiteHeader"
import { features } from "@/content/features"
import captured from "@/public/product/manifest.json"

export const metadata: Metadata = {
  title: "Features",
  description: "Realm's workspace, captured from the app.",
}

export default function FeaturesPage() {
  // The intersection, in authored order: a scene that failed to capture drops out of the carousel
  // rather than leaving a broken image in it.
  const shown = features.filter((feature) => (captured as string[]).includes(feature.slug))

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <SiteHeader width="max-w-[92rem]" />
      <main className="mx-auto flex w-full max-w-[92rem] min-h-0 flex-1 flex-col px-6 pt-2 pb-7 sm:px-10 sm:pb-9">
        <Carousel features={shown} />
      </main>
      {/* The page's own side inset: without it the line ran edge to edge on a phone, the only
          text on the site touching the glass. */}
      <p className="px-6 pb-5 text-center font-mono text-[11px] text-ink-3 sm:px-10">
        Captured from the app. The agent&rsquo;s answers are scripted, so the runs reproduce.
      </p>
    </div>
  )
}
