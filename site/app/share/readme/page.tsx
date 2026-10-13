import type { Metadata } from "next"
import type { CSSProperties } from "react"

import { Arrival } from "@/components/changelog/Field"
import { sceneImage } from "@/lib/pictures"

export const metadata: Metadata = {
  title: "README picture",
  robots: { index: false, follow: false },
}

/** The stretch of the route the realm hangs at: its sky is the calmest round the window. */
const REALM = 5
/** The window's width in CSS px of the 1600 × 900 frame, and the gap either side of the realm. */
const WINDOW = 1080
const MARGIN = 64
const GAP = 48

/**
 * The picture under the repository README's title, photographed at 1600 × 900 and twice the density:
 * Realm's whole window, a real capture rather than the landing page's working sample (a README cannot
 * be clicked), on the plate the landing page stands its pictures on, and beside it one of the realms
 * with its doorway lit, the share card's composition with the window where the words are. The field is
 * the changelog's arrival at a doorway: the window is its block of words, so the sky's realms keep off
 * its side of the frame and the field dims a little round it. Opaque, so it reads the same on GitHub's
 * white theme and its dark one. Nothing links here.
 */
export default function ReadmePicture() {
  const image = sceneImage("workspace")
  return (
    <main className="relative h-[100dvh] overflow-hidden">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-20 bg-[#03050b]" />
      {/* The one realm: the older releases that go away behind it in the changelog would peek out from
          behind the window here, and a README has no releases to show. */}
      <Arrival release={REALM} total={REALM + 1} dark={false} />
      <div aria-hidden data-field-anchor="s:door" className="absolute top-[28%] h-[40%]" style={{ left: MARGIN + WINDOW + 32 + GAP, right: GAP }} />
      <div data-field-anchor="c:title" className="plate hero-plate absolute top-1/2 -translate-y-1/2" style={{ left: MARGIN, width: WINDOW + 32 }}>
        <div className="hero-window relative w-full overflow-hidden rounded-[16px] bg-page" style={{ aspectRatio: `${image.width} / ${image.height}` }}>
          <img src={image.src} srcSet={image.srcSet} sizes={`${WINDOW}px`} alt="" width={image.width} height={image.height} className="block h-full w-full" />
          <span aria-hidden className="screen-light z-10" style={{ "--screen-radius": "16px" } as CSSProperties} />
        </div>
      </div>
    </main>
  )
}
