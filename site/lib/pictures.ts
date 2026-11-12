import type { ScreenImage } from "@/components/realms/Screen"
import { CAPTURE_DENSITY, sceneFile, sceneSrcSet, WINDOW } from "@/lib/frames"
import parts from "@/public/product/parts.json"

type Part = { width: number; height: number; radius: number }

/** The corner of Realm's window, drawn by the app itself round the rail and the panes. */
const WINDOW_RADIUS = 16

/**
 * The colour a capture ends on along its foot where that is not the app's canvas, sampled from the
 * files: a caption's tab is cut from it (Screen), so the picture runs on into the tab. By the file's
 * place under public/product, for the parts and for the crops the changelog's entries show.
 */
const FEET: Record<string, string> = {
  "parts/models": "rgb(35 36 39)",
  "parts/sidebar": "rgb(23 24 26)",
  "parts/schedules-phone": "rgb(23 24 26)",
  "details/model-picker": "rgb(19 20 22)",
  "details/track": "rgb(24 25 26)",
}

/** Screen's `foot` for the capture at public/product/<file>.webp, or nothing where it is the canvas's. */
export const footOf = (file: string): string | undefined => FEET[file]

/** A part of the window photographed on its own (`parts.json`), or null when it was never taken. */
export function partImage(name: string): ScreenImage | null {
  const part = (parts as Record<string, Part>)[name]
  if (!part) return null
  return { src: `/product/parts/${name}.webp`, width: part.width, height: part.height, radius: part.radius, foot: footOf(`parts/${name}`) }
}

/** A whole-window scene. The caller checks it is in the manifest. */
export function sceneImage(slug: string): ScreenImage {
  return { src: sceneFile(slug, WINDOW.width * CAPTURE_DENSITY), srcSet: sceneSrcSet(slug), width: WINDOW.width, height: WINDOW.height, radius: WINDOW_RADIUS }
}
