import type { Metadata } from "next"

import { Arrival } from "@/components/changelog/Field"
import { Wordmark } from "@/components/Wordmark"
import { releases } from "@/lib/changelog"
import { CARD, DOOR, WORDS } from "@/lib/og/layout"
import { site } from "@/lib/site"

export const metadata: Metadata = {
  title: "Share image",
  robots: { index: false, follow: false },
}

/** The sky's realm for this card: the newest release's, at the start of the route. */
const REALM = 0

/**
 * The source for the site's share images. scripts/capture-share-images.mjs opens this at 1200 × 630
 * and saves the frame as app/opengraph-image.png and app/twitter-image.png; nothing links here.
 *
 * One of the landing page's realms with its doorway lit, more of them going away behind it into the
 * nebula, and the words on the dark side of the sky, where the field is dimmed under them. The field
 * is the changelog's arrival at a release's doorway, which holds a realm at the size a card can carry;
 * the changelog's own cards (lib/og/card.tsx) are set on the same layout (lib/og/layout.ts). The
 * page's closing line leads, since the card has the picture it describes; the tagline says what Realm
 * is under it. The boxes are fixed in px from the left and the top and the realm is held to the right,
 * so a wider frame (GitHub's 1280 × 640) re-lays rather than stretches.
 */
export default function SharePage() {
  return (
    <main className="relative h-[100dvh] overflow-hidden">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-20 bg-[#03050b]" />
      <Arrival release={REALM} total={releases.length} dark={false} />
      <div
        aria-hidden
        data-field-anchor="s:door"
        className="absolute"
        style={{
          right: CARD.width - DOOR.left - DOOR.width,
          top: `${(DOOR.top / CARD.height) * 100}%`,
          width: DOOR.width,
          height: `${(DOOR.height / CARD.height) * 100}%`,
        }}
      />
      <div
        data-field-anchor="c:title"
        className="absolute flex flex-col justify-center"
        style={{ left: WORDS.left, top: WORDS.top, width: WORDS.width, bottom: CARD.height - WORDS.top - WORDS.height }}
      >
        <Wordmark size="display" className="text-ink" />
        <h1 className="mt-10 text-[80px] leading-[0.98] font-[580] tracking-[-0.05em] text-ink">Give your agents a world to work in.</h1>
        <p className="mt-7 max-w-[30ch] text-[27px] leading-[1.35] text-ink-2">{site.tagline}</p>
      </div>
    </main>
  )
}
