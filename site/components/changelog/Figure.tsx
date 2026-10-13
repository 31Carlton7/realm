import type { StaticImageData } from "next/image"
import type { ReactNode } from "react"

import { Screen } from "@/components/realms/Screen"
import { CAPTURE_DENSITY, WINDOW } from "@/lib/frames"
import { sceneImage } from "@/lib/pictures"

/** The corner a crop of the window is drawn with: the app's card corner, on the window's own ground. */
const CROP_RADIUS = 12

/**
 * A capture of the app in an entry, shown as the landing page shows its pictures (components/realms/
 * Screen): on a plate of the realm it comes from, its caption hanging from the plate's foot.
 *
 * An entry's figure is either a whole window (a scene, shot at the window's size, which also has a 1×
 * copy for phones) or a crop of one, written at the capture's density (lib/frames.ts), so its size in
 * the app is a third of its pixels.
 */
export function Figure({ image, alt, caption }: { image: StaticImageData; alt: string; caption: ReactNode }) {
  const scene = image.width === WINDOW.width * CAPTURE_DENSITY ? /\/([a-z-]+)-\d+\.[^/]*$/.exec(image.src)?.[1] : undefined
  if (scene) {
    return <Screen kind="window" image={sceneImage(scene)} alt={alt} caption={caption} zoom={1} sizes="(min-width: 1024px) 928px, 100vw" />
  }
  return (
    <Screen
      kind="part"
      image={{ src: image.src, width: Math.round(image.width / CAPTURE_DENSITY), height: Math.round(image.height / CAPTURE_DENSITY), radius: CROP_RADIUS }}
      alt={alt}
      caption={caption}
    />
  )
}
