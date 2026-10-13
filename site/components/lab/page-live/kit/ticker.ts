/**
 * One frame loop for the whole page. Every live part of it — the map's movers, the light behind
 * them, an instrument's ambient work — subscribes here instead of running its own
 * requestAnimationFrame, so there is one loop to stop.
 *
 * It runs only while something is subscribed and the tab is visible, and stops (rather than
 * throttles) otherwise: a part subscribes while it is on screen and unsubscribes when it leaves, and
 * under reduced motion nothing subscribes at all. `window.__labFrames` counts the frames it paints,
 * which is what the lab's screenshot script reads as the page's frame rate.
 */
export type Tick = (now: number, dt: number) => void

declare global {
  interface Window {
    __labFrames?: number
  }
}

const subscribers = new Set<Tick>()
let raf = 0
let last = 0
let listening = false

function frame(now: number) {
  raf = 0
  // Seconds since the last frame, capped so a tab coming back does not jump everything forward.
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60
  last = now
  for (const tick of subscribers) tick(now, dt)
  window.__labFrames = (window.__labFrames ?? 0) + 1
  schedule()
}

function schedule() {
  if (raf || !subscribers.size || document.visibilityState !== "visible") {
    if (!subscribers.size || document.visibilityState !== "visible") last = 0
    return
  }
  raf = requestAnimationFrame(frame)
}

function onVisibility() {
  if (document.visibilityState === "visible") schedule()
  else if (raf) {
    cancelAnimationFrame(raf)
    raf = 0
    last = 0
  }
}

export function subscribe(tick: Tick): () => void {
  if (!listening && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility)
    listening = true
  }
  subscribers.add(tick)
  schedule()
  return () => {
    subscribers.delete(tick)
    if (!subscribers.size && raf) {
      cancelAnimationFrame(raf)
      raf = 0
      last = 0
    }
  }
}
