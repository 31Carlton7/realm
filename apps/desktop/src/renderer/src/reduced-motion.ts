/** Whether the window reports `prefers-reduced-motion: reduce` — the Mac's setting, or Realm's own
 *  Reduce motion, which main applies to the same media feature (`@realm/contracts` motion). */
export const prefersReducedMotion = (): boolean =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
