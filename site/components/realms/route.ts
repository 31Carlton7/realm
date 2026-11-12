import type { Stop } from "./world"

/**
 * The flight's route through the realms. The opening looks up the route into the thick of them; each
 * chapter is a screen hung in space a little further up it, with its realm beside it, the camera
 * level and a few edges back; the team's realms hang together near the end; then the camera climbs
 * out over the whole swarm and lifts its eyes to the deep sky, where the page ends on the black hole.
 *
 * The chapters swing left and right of the route and up and down it in step with their screens, so
 * the camera turns a little toward each one and the sky behind it changes as it goes.
 */
export const OPENING = {
  /** Where the camera hangs, and which way it looks. */
  eye: [0, -58, 3.5] as const,
  yaw: 90,
  pitch: 6,
  focal: 1500,
  /** On a phone, a longer lens on the same view. */
  phoneFocal: 1250,
}

export const CHAPTERS: Record<string, Stop> = {
  space: { at: [3, 6, -0.4], yaw: 90, height: 2.3, distance: 11.4, focal: 1700, orbit: 6 },
  spaces: { at: [-5, 31, 1.6], yaw: 100, height: 2.1, distance: 11.5, focal: 1700, orbit: -8 },
  transcript: { at: [8, 55, -2.2], yaw: 81, height: 2.2, distance: 10.8, focal: 1700, orbit: 7 },
  agents: { at: [-3, 79, 2.8], yaw: 99, height: 2.1, distance: 11.4, focal: 1700, orbit: -7 },
  delegation: { at: [10, 103, -1.2], yaw: 82, height: 2.2, distance: 10.6, focal: 1700, orbit: 7 },
  gateway: { at: [0, 127, 2.0], yaw: 98, height: 2.2, distance: 11.2, focal: 1700, orbit: -7 },
  review: { at: [12, 151, -0.4], yaw: 81, height: 2.0, distance: 10.8, focal: 1700, orbit: 7 },
  sandbox: { at: [1, 175, 3.0], yaw: 99, height: 2.0, distance: 11.8, focal: 1700, orbit: -6 },
  durable: { at: [14, 199, -1.0], yaw: 83, height: 2.1, distance: 11.4, focal: 1700, orbit: 7 },
}

/** The team's four realms, hung together where `at` is: two in front, two behind and between them,
 *  every doorway turned to the camera with nothing in front of it. Offsets are across, back, up. */
export const TEAM = {
  at: [7, 224, 0] as const,
  realms: [
    [-1.55, 0, 0],
    [1.65, 0.4, 0.15],
    [-0.1, 2.4, 0.9],
    [3.1, 2.8, 1.05],
  ] as const,
  yaw: 92,
  height: 2.6,
  /** How far back the camera stands from the front pair. */
  distance: 9.5,
  focal: 1500,
  orbit: 6,
}

/** The climb: two calm stops over the swarm, higher each time, looking down into it. */
export const CLIMB: Record<string, { at: readonly [number, number]; yaw: number; height: number; pitch: number; focal: number }> = {
  facts: { at: [9, 228], yaw: 92, height: 16, pitch: -20, focal: 1500 },
  faq: { at: [10, 238], yaw: 92, height: 44, pitch: -34, focal: 1500 },
}

/** The finale: lifted over the climb's last stop and looking up and out, away from the swarm, into the
 *  deep sky, turned this far (degrees) off the route as it lifts. Lowering its eyes from there to the
 *  black hole at the foot of the page, the camera finds it hanging in front of the nebula ahead and low,
 *  whose gas it bends round itself. */
export const FINALE = { height: 64, pitch: 14, focal: 1500, turn: 2 }
