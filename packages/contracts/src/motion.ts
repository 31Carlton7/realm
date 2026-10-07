/**
 * Whether Realm holds its motion still: the system's answer, or the user's own.
 *
 * "On" and "Off" do not add a second switch beside the system's. The app already governs motion with
 * one mechanism — `prefers-reduced-motion`, read by the stylesheet's media queries and by the few
 * places that ask `matchMedia` — so the override is applied to THAT: main tells the window's renderer
 * to report the chosen value for the media feature (`main/reduced-motion.ts`), and every rule and
 * every listener that already answers the system's preference answers this one, with nothing of its
 * own to keep in step. "System" lifts the override and the Mac's own setting is the answer again.
 */
export const REDUCED_MOTION_KEY = "ui.reduceMotion";
export const REDUCED_MOTION_PREFS = ["system", "on", "off"] as const;
export type ReducedMotionPref = (typeof REDUCED_MOTION_PREFS)[number];
export const REDUCED_MOTION_DEFAULT: ReducedMotionPref = "system";

export const isReducedMotionPref = (x: unknown): x is ReducedMotionPref =>
  (REDUCED_MOTION_PREFS as readonly unknown[]).includes(x);

/** The value the window reports for `prefers-reduced-motion` under a preference. The empty string
 *  is DevTools' own "no override": the renderer goes back to asking the system. */
export function reducedMotionFeature(pref: ReducedMotionPref): "reduce" | "no-preference" | "" {
  return pref === "on" ? "reduce" : pref === "off" ? "no-preference" : "";
}
