import type { Stop } from "./world"

/**
 * The flight's route. The opening looks down on the field from high above, down the mark's own
 * diagonal, so every realm is the logo; each chapter is a realm further up the field, the camera
 * low and level in front of its door; the team's realms stand together near the end; then the camera
 * climbs until the field is a planet.
 *
 * The chapters swing left and right of the route in step with their screens, so the camera turns a
 * little toward each one, and the yaw keeps a little of the realm's side wall in view, as the mark does.
 */
export const OPENING = {
  /** The point of the field under the product window's top edge. */
  focus: [0, 0] as const,
  yaw: 45,
  pitch: -35.264,
  focal: 2300,
  /** A realm's edge, in CSS px, at the window's top edge. */
  edge: 21,
}

export const CHAPTERS: Record<string, Stop> = {
  space: { at: [6, 30], yaw: 82, height: 2.3, distance: 7.2, focal: 1500, orbit: 7 },
  spaces: { at: [-2, 46], yaw: 99, height: 2.5, distance: 7.6, focal: 1500, orbit: -7 },
  transcript: { at: [8, 62], yaw: 81, height: 2.2, distance: 7.0, focal: 1500, orbit: 7 },
  agents: { at: [0, 78], yaw: 100, height: 2.6, distance: 7.4, focal: 1500, orbit: -7 },
  delegation: { at: [10, 94], yaw: 82, height: 2.3, distance: 7.2, focal: 1500, orbit: 7 },
  gateway: { at: [2, 110], yaw: 98, height: 2.4, distance: 7.2, focal: 1500, orbit: -7 },
  review: { at: [12, 126], yaw: 81, height: 2.3, distance: 7.0, focal: 1500, orbit: 7 },
  sandbox: { at: [4, 142], yaw: 99, height: 2.5, distance: 7.4, focal: 1500, orbit: -7 },
  durable: { at: [14, 158], yaw: 83, height: 2.4, distance: 7.6, focal: 1500, orbit: 6 },
}

/** The team's four realms, as lattice steps from the cell nearest `at`: two in front, two behind
 *  and between them, so every doorway faces the camera with nothing in front of it. */
export const TEAM = {
  at: [8, 176] as const,
  cells: [
    [0, 0],
    [1, 1],
    [-1, 0],
    [0, 1],
  ] as const,
  yaw: 92,
  height: 4.2,
  distance: 15,
  focal: 1500,
  orbit: 6,
}

/** The climb: two calm stops over the field, higher each time, before the planet. */
export const CLIMB: Record<string, { at: readonly [number, number]; yaw: number; height: number; pitch: number; focal: number }> = {
  facts: { at: [9, 190], yaw: 92, height: 15, pitch: -22, focal: 1500 },
  faq: { at: [10, 200], yaw: 92, height: 46, pitch: -38, focal: 1500 },
}

/** Orbit, at a third of the planet's radius up. */
export const FINALE = { altitude: 0.3, focal: 1500 }
