import { DOORWAY } from "@/components/realms/hive/cube"

/**
 * The world the page flies through: Realm's mark as a solid, floating in deep space. Every realm
 * turns slowly about its own tilted axis and bobs where it hangs; some stand in hives, all turning in
 * unison, a few are enormous and far off. The camera's route runs up the middle of them (+y).
 *
 * World units are the cube's edge. z is up, so the camera's level views stay level. A realm's own frame
 * is the mark's: its left wall faces -x, its dark wall faces -y with the doorway cut in it, its top
 * faces +z, and its middle is its origin.
 *
 * The population is drawn from a fixed seed, so the page (picking a realm under the pointer, the
 * beams, the Realmites) and the shader (drawing it) agree on every realm without the shader handing
 * anything back. Where a realm is and how it is turned at a moment is the same arithmetic in both:
 * `realmAt` here, `vs_realm` in shaders.ts.
 */

export type Vec3 = [number, number, number]

/** The doorway, in the cube's own terms (read out of the mark by the Hive's cube.ts). */
export const DOOR = {
  across: DOORWAY.across,
  down: DOORWAY.down,
  depth: DOORWAY.depth,
} as const

/** The doorway in the realm's own frame (edge 1, middle at the origin): x across it, z up it, and the
 *  wall it is cut in at y = -0.5. */
export const DOOR_BOX = {
  x0: -0.5 + DOOR.across[0],
  x1: -0.5 + DOOR.across[1],
  z0: 0.5 - DOOR.down[1],
  z1: 0.5 - DOOR.down[0],
  back: -0.5 + DOOR.depth,
} as const

/** A realm as it is uploaded: where it hangs, its size, and how it turns. */
export type Realm = {
  at: Vec3
  /** Its edge in world units; 0 is a realm cleared off the route, which is not drawn. */
  size: number
  /** Its turn about its own axis at time 0, and how fast it turns (rad/s). */
  yaw: number
  spin: number
  /** How far its axis leans from the vertical, and toward which way (radians). */
  tilt: number
  lean: number
}

/** Realms the scene is told about at once: the uniform holding them is 2 vec4 each, under 64 KB. */
export const MAX_REALMS = 1100

// ---- the hash the shader shares -------------------------------------------------------------

/** PCG, as the shader writes it (u32 arithmetic, wrapping). */
export function pcg(v: number): number {
  const state = (Math.imul(v, 747796405) + 2891336453) >>> 0
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0
  return ((word >>> 22) ^ word) >>> 0
}

/** Four numbers in 0..1 for a realm and a purpose, as the shader's `seed4`. */
export function seed4(index: number, salt: number): [number, number, number, number] {
  const h = pcg((Math.imul(index, 2654435761) + salt) >>> 0)
  return [(h & 255) / 255, ((h >>> 8) & 255) / 255, ((h >>> 16) & 255) / 255, (h >>> 24) / 255]
}

const SALT_BOB = 101

// ---- a realm at a moment ----------------------------------------------------------------------

/** A realm's frame at a moment: its middle, and its three axes in the world (x, y, z), each its edge long. */
export type Pose = { at: Vec3; x: Vec3; y: Vec3; z: Vec3 }

const TAU = Math.PI * 2

/** Where a realm's bob has carried it at `t`: a slow drift, mostly up and down, a few tenths of an edge. */
export function bob(index: number, size: number, t: number): Vec3 {
  const [a, b, c] = seed4(index, SALT_BOB)
  const amp = (0.08 + 0.3 * a) * Math.sqrt(Math.max(size, 0.2))
  const w = TAU / (10 + 14 * b)
  const phase = TAU * c
  return [0.35 * amp * Math.sin(w * t + phase + 1.7), 0.35 * amp * Math.cos(0.8 * w * t + phase), amp * Math.sin(w * t + phase)]
}

/** The rotation that turns a realm by `yaw` about its own axis, then leans that axis by `tilt` toward `lean`. */
export function turn(yaw: number, tilt: number, lean: number): [Vec3, Vec3, Vec3] {
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  // The spin about z.
  const sx: Vec3 = [cy, sy, 0]
  const syv: Vec3 = [-sy, cy, 0]
  const sz: Vec3 = [0, 0, 1]
  if (tilt === 0) return [sx, syv, sz]
  // Then the lean: Rodrigues about the horizontal axis (cos lean, sin lean, 0).
  const k: Vec3 = [Math.cos(lean), Math.sin(lean), 0]
  const c = Math.cos(tilt)
  const s = Math.sin(tilt)
  const rot = (v: Vec3): Vec3 => {
    const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2]
    const cross: Vec3 = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]]
    return [v[0] * c + cross[0] * s + k[0] * kv * (1 - c), v[1] * c + cross[1] * s + k[1] * kv * (1 - c), v[2] * c + cross[2] * s + k[2] * kv * (1 - c)]
  }
  return [rot(sx), rot(syv), rot(sz)]
}

/** A background realm's pose at `t`, exactly as vs_realm draws it. */
export function realmAt(realm: Realm, index: number, t: number): Pose {
  const [x, y, z] = turn(realm.yaw + realm.spin * t, realm.tilt, realm.lean)
  const d = bob(index, realm.size, t)
  const s = realm.size
  return {
    at: [realm.at[0] + d[0], realm.at[1] + d[1], realm.at[2] + d[2]],
    x: [x[0] * s, x[1] * s, x[2] * s],
    y: [y[0] * s, y[1] * s, y[2] * s],
    z: [z[0] * s, z[1] * s, z[2] * s],
  }
}

/** A point of a realm's own frame, in the world. */
export const inWorld = (pose: Pose, p: Vec3): Vec3 => [
  pose.at[0] + pose.x[0] * p[0] + pose.y[0] * p[1] + pose.z[0] * p[2],
  pose.at[1] + pose.x[1] * p[0] + pose.y[1] * p[1] + pose.z[1] * p[2],
  pose.at[2] + pose.x[2] * p[0] + pose.y[2] * p[1] + pose.z[2] * p[2],
]

/** The doorway's four corners in the world, bottom left, bottom right, top right, top left (seen from in front). */
export function doorCorners(pose: Pose): [Vec3, Vec3, Vec3, Vec3] {
  const { x0, x1, z0, z1 } = DOOR_BOX
  return [inWorld(pose, [x0, -0.5, z0]), inWorld(pose, [x1, -0.5, z0]), inWorld(pose, [x1, -0.5, z1]), inWorld(pose, [x0, -0.5, z1])]
}

/** The point on a doorway's sill, just outside it: where a Realmite stands. */
export const doorSill = (pose: Pose): Vec3 => inWorld(pose, [(DOOR_BOX.x0 + DOOR_BOX.x1) / 2, -0.62, DOOR_BOX.z0])

const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** The pose that turns a realm's doorway to face `toward` (a direction), its top as near up as that
 *  allows, at `at`. */
export function facing(at: Vec3, toward: Vec3, size: number): Pose {
  // The doorway faces -y.
  const y = normalize([-toward[0], -toward[1], -toward[2]])
  const up = y[2]
  const z = normalize([-up * y[0], -up * y[1], 1 - up * y[2]])
  const x: Vec3 = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]]
  return { at, x: x.map((c) => c * size) as Vec3, y: y.map((c) => c * size) as Vec3, z: z.map((c) => c * size) as Vec3 }
}

/** A pose turned between two others by `k` (0..1): its axes eased across and held square. */
export function between(a: Pose, b: Pose, k: number): Pose {
  if (k <= 0) return a
  if (k >= 1) return b
  const mix = (p: Vec3, q: Vec3): Vec3 => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k]
  const size = Math.hypot(...a.z)
  const z = normalize(mix(a.z, b.z))
  const y0 = mix(a.y, b.y)
  const d = y0[0] * z[0] + y0[1] * z[1] + y0[2] * z[2]
  const y = normalize([y0[0] - d * z[0], y0[1] - d * z[1], y0[2] - d * z[2]])
  const x: Vec3 = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]]
  const s = (v: Vec3): Vec3 => [v[0] * size, v[1] * size, v[2] * size]
  return { at: mix(a.at, b.at), x: s(x), y: s(y), z: s(z) }
}

// ---- the population ----------------------------------------------------------------------------

/** A small seeded generator (mulberry32), so the population is the same on every load. */
function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** How far a point is from the route's own line (x about 5, z about 0, any y). */
const offRoute = (x: number, z: number) => Math.hypot(x - 5, z * 1.3)

/**
 * Every realm in the sky. Most hang alone, round the route rather than on it, so the flight passes
 * between them: few within a dozen edges of its line, thickest a few dozen out, thinning past that;
 * at sizes from a little under the mark's to three times it. Some stand in hives, a lattice of the
 * mark's hexagons tilted in space, turning together; and a few giants hang far off, the size of moons.
 */
export function populate(): Realm[] {
  const rand = random(0x5eed)
  const gauss = () => {
    const u = Math.max(rand(), 1e-9)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rand())
  }
  const out: Realm[] = []
  const loner = (at: Vec3, size: number) => {
    const slow = rand() < 0.3
    out.push({
      at,
      size,
      yaw: TAU * rand(),
      spin: (slow ? 0.012 : 0.03 + 0.09 * rand()) * (rand() < 0.5 ? -1 : 1),
      // Nearly half stand close to upright, the mark's own pose; the rest lean every way.
      tilt: rand() < 0.45 ? rand() * 0.22 : 0.2 + rand() * 1.0,
      lean: TAU * rand(),
    })
  }

  // Where a realm may hang: kept off the route's line, as likely a few dozen edges out as anywhere.
  const place = (spread: number): Vec3 => {
    for (;;) {
      const at: Vec3 = [5 + gauss() * 48 * spread, -110 + rand() * 470, gauss() * 22 * spread]
      const r = offRoute(at[0], at[2])
      const keep = (0.06 + 0.94 * Math.min(1, Math.max(0, (r - 7) / 16))) * Math.exp(-Math.max(r - 40, 0) / 60)
      if (rand() < keep) return at
    }
  }

  // The hives: hexagons of the lattice in a plane, turning together.
  for (let h = 0; h < 22; h++) {
    const centre = place(1.1)
    const rings = rand() < 0.5 ? 1 : rand() < 0.6 ? 2 : 2
    const count = rings === 1 ? 7 : rand() < 0.6 ? 12 : 19
    const yaw = TAU * rand()
    const spin = (0.02 + 0.05 * rand()) * (rand() < 0.5 ? -1 : 1)
    const tilt = 0.15 + rand() * 0.9
    const lean = TAU * rand()
    const [ax, ay] = turn(yaw * 0.37, tilt, lean)
    const step = 1.95
    const cells: [number, number][] = [[0, 0]]
    for (let r = 1; r <= 2; r++) {
      for (let side = 0; side < 6; side++) {
        for (let k = 0; k < r; k++) {
          const a0 = (side * Math.PI) / 3
          const a1 = ((side + 1) * Math.PI) / 3
          const u = k / r
          cells.push([r * ((1 - u) * Math.cos(a0) + u * Math.cos(a1)), r * ((1 - u) * Math.sin(a0) + u * Math.sin(a1))])
        }
      }
    }
    for (const [cx, cy] of cells.slice(0, count)) {
      out.push({
        at: [centre[0] + (ax[0] * cx + ay[0] * cy) * step, centre[1] + (ax[1] * cx + ay[1] * cy) * step, centre[2] + (ax[2] * cx + ay[2] * cy) * step],
        size: 1,
        yaw,
        spin,
        tilt,
        lean,
      })
    }
  }

  // The giants, far out round the route, at its own level and above and below it.
  const giants: [number, number, number, number][] = [
    [-230, 260, 40, 26],
    [260, 380, -60, 34],
    [-120, 520, 120, 30],
    [150, -40, 90, 16],
    [-260, 40, -90, 22],
    [90, 600, -150, 40],
    [320, 160, 140, 20],
    [-60, 330, -170, 18],
    [40, 760, 60, 48],
    [-330, 600, -20, 28],
  ]
  for (const [x, y, z, size] of giants) {
    out.push({ at: [x, y, z], size, yaw: TAU * rand(), spin: 0.006 * (rand() < 0.5 ? -1 : 1), tilt: 0.2 + rand() * 0.5, lean: TAU * rand() })
  }

  // The rest, alone: as many as the uniform holds.
  while (out.length < MAX_REALMS) {
    const at = place(1)
    const r = rand()
    const size = r < 0.7 ? 0.85 + 0.3 * rand() : r < 0.93 ? 1.25 + 0.65 * rand() : 2 + 1.4 * rand()
    loner(at, size)
  }
  return out
}

/** Clears realms out of the way of what the page shows: `keep(at, size)` false means cleared. */
export function clearOff(realms: Realm[], keep: (at: Vec3, size: number) => boolean): Realm[] {
  return realms.map((realm) => (keep(realm.at, realm.size) ? realm : { ...realm, size: 0 }))
}

/** The population as the shader's uniform: per realm, its middle and size, then yaw, spin, tilt, lean. */
export function packRealms(realms: Realm[]): number[][] {
  const out: number[][] = []
  for (const r of realms) {
    out.push([r.at[0], r.at[1], r.at[2], r.size], [r.yaw, r.spin, r.tilt, r.lean])
  }
  while (out.length < MAX_REALMS * 2) out.push([0, 0, 0, 0])
  return out
}

/**
 * The flight's stops. Each chapter's screen hangs in space with its foot (the middle of its bottom
 * edge) at `at`; the camera stands `distance` back from it facing `yaw`, `height` above the foot, and
 * the chapter's realm hangs beside the screen with its doorway turned to it.
 */
export type Stop = {
  /** The screen's foot, in the world. */
  at: readonly [number, number, number]
  /** Which way the camera faces, in degrees from +x (90 looks straight up the route). */
  yaw: number
  /** The camera's height over the foot and how far back it stands, in edges. */
  height: number
  distance: number
  /** The lens, in CSS px of focal length. */
  focal: number
  /** How far the camera turns about the screen while the reader is in the chapter, in degrees. */
  orbit: number
}
