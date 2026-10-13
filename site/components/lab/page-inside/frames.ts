import { beforeLight } from "./scene"

/**
 * The page's one scroll reader. Everything that follows the scroll — the camera, the closing window,
 * the header's plate — subscribes here and runs once per frame, in one requestAnimationFrame, after
 * the browser has settled the scroll position. Each subscriber is also run by the light before it
 * reads a rect (scene.ts), so it must do nothing when nothing has changed since its last run.
 */
const subscribers = new Set<() => void>()
let raf = 0

const run = () => {
  raf = 0
  for (const fn of subscribers) fn()
}

const schedule = () => {
  if (!raf) raf = requestAnimationFrame(run)
}

export function onScrollFrame(fn: () => void) {
  subscribers.add(fn)
  beforeLight.add(fn)
  if (subscribers.size === 1) {
    window.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
  }
  schedule()
  return () => {
    subscribers.delete(fn)
    beforeLight.delete(fn)
    if (subscribers.size === 0) {
      window.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
      cancelAnimationFrame(raf)
      raf = 0
    }
  }
}

/** Ask for a frame without a scroll, after something a subscriber reads has changed. */
export const requestScrollFrame = schedule
