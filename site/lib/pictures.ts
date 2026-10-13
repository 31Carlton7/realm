import type { ScreenImage } from "@/components/realms/Screen"
import { CAPTURE_DENSITY, sceneFile, sceneSrcSet, WINDOW } from "@/lib/frames"
import parts from "@/public/product/parts.json"

type Part = { width: number; height: number; radius: number; cutout: boolean }

/** The corner of Realm's window, drawn by the app itself round the rail and the panes. */
const WINDOW_RADIUS = 16

/** A part of the window photographed on its own (`parts.json`), or null when it was never taken. */
export function partImage(name: string): ScreenImage | null {
  const part = (parts as Record<string, Part>)[name]
  if (!part) return null
  return { src: `/product/parts/${name}.webp`, width: part.width, height: part.height, radius: part.radius, cutout: part.cutout }
}

/** A whole-window scene. The caller checks it is in the manifest. */
export function sceneImage(slug: string): ScreenImage {
  return { src: sceneFile(slug, WINDOW.width * CAPTURE_DENSITY), srcSet: sceneSrcSet(slug), width: WINDOW.width, height: WINDOW.height, radius: WINDOW_RADIUS }
}
