/**
 * The share cards' one layout, in CSS px of a 1200 × 630 card: where the words stand and where the
 * realm hangs. The pages the cards are photographed from (app/share) lay the field out round these
 * rects, and the changelog's cards (lib/og/card.tsx) set their type inside the same ones, so a card
 * drawn in the browser and one drawn by next/og agree to the pixel.
 */

export type Box = { left: number; top: number; width: number; height: number }

export const CARD = { width: 1200, height: 630 } as const

/** The words: the field is dimmed under them (the composite's clearance round a block of words), and
 *  the realms of the sky are kept out from behind them. Inside X's 2:1 crop with room to spare. */
export const WORDS: Box = { left: 80, top: 72, width: 560, height: 486 }

/** The realm: its middle at this box's middle, its edge half the box's height, which the changelog's
 *  sky holds to 150 px (components/changelog/stage.ts). */
export const DOOR: Box = { left: 768, top: 139, width: 360, height: 315 }

/**
 * The skies behind the changelog's cards, photographed from the live field into public/og by
 * scripts/capture-share-images.mjs: the index's walk up the row of releases, and three arrivals at a
 * release's doorway, each a different stretch of the route, so the sky behind them differs. A
 * withdrawn build's card stands at its own realm with the doorway dark, as its page shows it.
 */
export const SKIES = {
  index: { kind: "walk" },
  a: { kind: "arrival", release: 4, dark: false },
  b: { kind: "arrival", release: 5, dark: false },
  c: { kind: "arrival", release: 14, dark: false },
  dark: { kind: "arrival", release: 4, dark: true },
} as const satisfies Record<string, { kind: "walk" } | { kind: "arrival"; release: number; dark: boolean }>

export type SkyName = keyof typeof SKIES

/** A sky's file in public/og: a JPEG, since it is a photograph with no type on it, and a seventh the
 *  size of the PNG, which keeps every card drawn over it lighter too. */
export const skyFile = (name: SkyName) => `sky-${name}.jpg`

const LIT: SkyName[] = ["a", "b", "c"]

/** FNV-1a: a stable number from a slug, so an entry keeps its sky from build to build. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** The sky behind an entry's card: the dark one for a withdrawn build, otherwise one of the lit ones,
 *  picked by its slug. */
export const skyFor = (slug: string, withdrawn: boolean): SkyName => (withdrawn ? "dark" : LIT[hash(slug) % LIT.length]!)
