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
  space: { at: [6, 30], yaw: 82, height: 4.4, distance: 10.6, focal: 1700, orbit: 7 },
  spaces: { at: [-2, 47], yaw: 99, height: 5.4, distance: 11.5, focal: 1700, orbit: -8 },
  transcript: { at: [8, 64], yaw: 81, height: 4.6, distance: 10.8, focal: 1700, orbit: 7 },
  agents: { at: [0, 81], yaw: 100, height: 5.2, distance: 11.4, focal: 1700, orbit: -7 },
  delegation: { at: [10, 98], yaw: 82, height: 4.5, distance: 10.6, focal: 1700, orbit: 7 },
  gateway: { at: [2, 115], yaw: 98, height: 5.0, distance: 11.2, focal: 1700, orbit: -7 },
  review: { at: [12, 132], yaw: 81, height: 4.6, distance: 10.8, focal: 1700, orbit: 7 },
  sandbox: { at: [4, 149], yaw: 99, height: 5.6, distance: 11.8, focal: 1700, orbit: -6 },
  durable: { at: [14, 166], yaw: 83, height: 4.8, distance: 11.4, focal: 1700, orbit: 7 },
}

/** The team's four realms, as lattice steps from the cell nearest `at`: two in front, two behind
 *  and between them, so every doorway faces the camera with nothing in front of it. */
export const TEAM = {
  at: [8, 184] as const,
  cells: [
    [0, 0],
    [1, 1],
    [-1, 0],
    [0, 1],
  ] as const,
  yaw: 92,
  height: 3.6,
  /** How much wider than the four realms the camera frames the slot. */
  frame: 1.04,
  focal: 1500,
  orbit: 6,
}

/** The climb: two calm stops over the field, higher each time, before the planet. */
export const CLIMB: Record<string, { at: readonly [number, number]; yaw: number; height: number; pitch: number; focal: number }> = {
  facts: { at: [9, 196], yaw: 92, height: 15, pitch: -22, focal: 1500 },
  faq: { at: [10, 206], yaw: 92, height: 46, pitch: -38, focal: 1500 },
}

/** The finale: lifted a little over the climb's last stop and looking out level over the field into the
 *  night, with the lens shifted so the horizon sits this share of the view's height down the page:
 *  under its bottom edge, so the whole view is sky for the black hole to come up into. */
export const FINALE = { height: 60, pitch: 6, focal: 1500, horizon: 1.12 }
