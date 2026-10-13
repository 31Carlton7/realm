export const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x))
/** Where `x` falls between `a` and `b`, 0..1. */
export const span = (x: number, a: number, b: number) => clamp((x - a) / (b - a))

/** Leaves at rest and arrives at rest: the ease every hand-off on the page travels on. */
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/**
 * A critically damped spring toward `target`, advanced by `dt` seconds. `omega` is its stiffness in
 * radians a second: 12 settles in about half a second without overshoot. State is [value, velocity].
 */
export function spring(state: [number, number], target: number, dt: number, omega = 12): [number, number] {
  const [x, v] = state
  const f = 1 + 2 * dt * omega
  const oo = omega * omega
  const hoo = dt * oo
  const hhoo = dt * hoo
  const det = 1 / (f + hhoo)
  const nx = (f * x + dt * v + hhoo * target) * det
  const nv = (v + hoo * (target - x)) * det
  return [nx, nv]
}
