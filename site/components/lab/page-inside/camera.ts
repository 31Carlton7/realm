/**
 * The camera that frames the window: pure arithmetic, no DOM.
 *
 * A view is what the camera sees, written in the window's own pixels: the point of the window at the
 * centre of the set (the lit area the camera frames into) and how much of the window's width spans the
 * set. A pose is the same thing as the transform the window is drawn with. Moving between two views
 * follows van Wijk and Nuij's path ("Smooth and efficient zooming and panning", 2003, the curve
 * d3-zoom uses): a long move eases back a little while it travels and pushes in as it arrives, the
 * way a camera operator would rather than a straight slide.
 */

export type Box = { x: number; y: number; w: number; h: number }
export type View = { cx: number; cy: number; w: number }
export type Pose = { tx: number; ty: number; s: number }

export const clamp = (value: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, value))
export const mix = (a: number, b: number, t: number) => a + (b - a) * t

/** 0 → 1 with zero velocity and acceleration at both ends: a dolly that starts and stops gently. */
export const smoother = (t: number) => {
  const x = clamp(t)
  return x * x * x * (x * (x * 6 - 15) + 10)
}

/** 0 → 1 over [a, b], eased; the shader's smoothstep. */
export const ramp = (a: number, b: number, t: number) => {
  const x = clamp((t - a) / (b - a))
  return x * x * (3 - 2 * x)
}

export function poseOf(view: View, set: Box): Pose {
  const s = set.w / view.w
  return { s, tx: set.x + set.w / 2 - s * view.cx, ty: set.y + set.h / 2 - s * view.cy }
}

export function viewOf(pose: Pose, set: Box): View {
  return { w: set.w / pose.s, cx: (set.x + set.w / 2 - pose.tx) / pose.s, cy: (set.y + set.h / 2 - pose.ty) / pose.s }
}

/**
 * The view that frames `focus` (window pixels) in the set: as large as fits with a margin, never past
 * `max`, and centred on it. `fill` is how much of the set the focus may take.
 */
export function frame(focus: Box, set: Box, max: number, fill = 0.86): View {
  const s = Math.min((set.w * fill) / focus.w, (set.h * fill) / focus.h, max)
  return { cx: focus.x + focus.w / 2, cy: focus.y + focus.h / 2, w: set.w / s }
}

/** How far a long move pulls back while it travels: van Wijk and Nuij's ρ, lowered from d3's √2 so a
 *  move between two close-ups is a gentle arc and a push-in never starts by backing away. */
const RHO = 0.7
const RHO2 = RHO * RHO

/** The path from view a to view b, as a function of 0..1. */
export function zoomPan(a: View, b: View): (t: number) => View {
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy
  const d2 = dx * dx + dy * dy
  if (d2 < 1e-6) {
    const k = Math.log(b.w / a.w)
    return (t) => ({ cx: a.cx + t * dx, cy: a.cy + t * dy, w: a.w * Math.exp(k * t) })
  }
  const d = Math.sqrt(d2)
  const b0 = (b.w * b.w - a.w * a.w + RHO2 * RHO2 * d2) / (2 * a.w * RHO2 * d)
  const b1 = (b.w * b.w - a.w * a.w - RHO2 * RHO2 * d2) / (2 * b.w * RHO2 * d)
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0)
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1)
  const S = (r1 - r0) / RHO
  return (t) => {
    const s = t * S
    const u = (a.w / (RHO2 * d)) * (Math.cosh(r0) * Math.tanh(RHO * s + r0) - Math.sinh(r0))
    return { cx: a.cx + u * dx, cy: a.cy + u * dy, w: (a.w * Math.cosh(r0)) / Math.cosh(RHO * s + r0) }
  }
}
