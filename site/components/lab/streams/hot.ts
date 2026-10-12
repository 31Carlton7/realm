/**
 * Which agent's mark is under the pointer or holding focus, for the stage to light its stream. The
 * stage reads it every frame; under reduced motion there is no frame loop, so a change asks the canvas
 * for one more frame the way a scroll would.
 */
let hot = -1

export const hotStream = () => hot

const repaintIfStill = () => {
  if (typeof window === "undefined") return
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) window.dispatchEvent(new Event("scroll"))
}

export function lightStream(index: number) {
  if (hot === index) return
  hot = index
  repaintIfStill()
}

export function dimStream(index: number) {
  if (hot !== index) return
  hot = -1
  repaintIfStill()
}
