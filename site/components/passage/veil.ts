import { watch, type Passage } from "./state"

/**
 * The veil: one canvas over both pages while a passage runs, drawing what the flight passes through.
 * The view transition holds it apart from the two pages (`view-transition-name: passage-veil`) and
 * shows it live above them, so it runs on unbroken while the old page leaves and the new one arrives.
 *
 *   warp   stars on every side of the vanishing point, stretched into streaks by the view's speed: a
 *          short rush up to speed as the link is followed, held until the pages swap, then easing out
 *          as the changelog settles, by which time its own field has the sky
 *   dive   the doorway's light pouring out and filling the view, and a few stars streaking past it
 *
 * Plain arithmetic on a 2D canvas: a few hundred lines a frame, for under a second.
 */

type Star = { x: number; y: number; z: number; tint: number; light: number }

/** How far off the stars start, in the units of the view's depth. */
const FAR = 1.4
/** How long the eye stays open for a frame's streak, in seconds: a longer shutter, longer streaks. */
const SHUTTER = 0.05
/** Up to speed. */
const RISE = 0.24
/** From the swap to stopped: as long as the new page takes to arrive and its field to start. */
const SETTLE = 0.7

const smooth = (t: number) => {
  const k = Math.min(1, Math.max(0, t))
  return k * k * (3 - 2 * k)
}

function spawn(far: boolean): Star {
  const angle = Math.random() * Math.PI * 2
  const off = 0.05 + Math.sqrt(Math.random()) * 1.15
  return { x: Math.cos(angle) * off, y: Math.sin(angle) * off, z: far ? FAR : 0.2 + Math.random() * (FAR - 0.2), tint: Math.random(), light: Math.random() }
}

/** How fast the view is moving, 0..1, and how present the veil is, 0..1, `s` seconds into a passage. */
function pace(passage: Passage, s: number): { speed: number; shown: number } {
  const landed = passage.landed === undefined ? Infinity : (passage.landed - passage.at) / 1000
  // A swap that never comes (a navigation that failed or was left) lets the veil go after three seconds.
  const settleFrom = Math.min(Math.max(RISE, landed + 0.05), 3)
  const settled = (s - settleFrom) / SETTLE
  const speed = s < RISE ? smooth(s / RISE) ** 1.5 : 1 - smooth(settled)
  const shown = smooth(s / 0.1) * (1 - smooth((s - settleFrom - 0.12) / (SETTLE - 0.12)))
  return { speed, shown }
}

export function createVeil(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext("2d")
  if (!context) return () => {}
  const ctx = context
  let passage: Passage | null = null
  let stars: Star[] = []
  let frame = 0
  let last = 0
  let point = { x: 0, y: 0 }
  let width = 0
  let height = 0
  let dpr = 1

  const stop = () => {
    cancelAnimationFrame(frame)
    frame = 0
    passage = null
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    canvas.style.visibility = "hidden"
    canvas.style.viewTransitionName = ""
  }

  const drawStars = (speed: number, shown: number, dt: number, focal: number, count: number) => {
    const v = speed * 3.1
    ctx.lineCap = "round"
    for (let i = 0; i < count; i++) {
      const star = stars[i]!
      const z = star.z - v * dt
      const sx = point.x + (star.x / Math.max(z, 0.02)) * focal
      const sy = point.y + (star.y / Math.max(z, 0.02)) * focal
      if (z < 0.04 || sx < -80 || sx > width + 80 || sy < -80 || sy > height + 80) {
        stars[i] = spawn(true)
        continue
      }
      star.z = z
      const tz = z + v * SHUTTER
      const tx = point.x + (star.x / tz) * focal
      const ty = point.y + (star.y / tz) * focal
      const near = 1 - z / FAR
      const alpha = (0.3 + 0.7 * star.light) * smooth((FAR - z) / 0.5) * shown * (0.35 + 0.65 * speed)
      if (alpha < 0.01) continue
      const r = Math.round(176 + 79 * star.tint)
      const g = Math.round(206 + 49 * star.tint)
      ctx.lineWidth = (0.55 + 1.35 * near * near) * dpr
      // The tail fainter than the head: two strokes, the tail's half first.
      const mx = (tx + sx) / 2
      const my = (ty + sy) / 2
      ctx.strokeStyle = `rgba(${r},${g},255,${(alpha * 0.32).toFixed(3)})`
      ctx.beginPath()
      ctx.moveTo(tx * dpr, ty * dpr)
      ctx.lineTo(mx * dpr, my * dpr)
      ctx.stroke()
      ctx.strokeStyle = `rgba(${r},${g},255,${alpha.toFixed(3)})`
      ctx.beginPath()
      ctx.moveTo(mx * dpr, my * dpr)
      ctx.lineTo(sx * dpr, sy * dpr)
      ctx.stroke()
    }
  }

  /** The doorway's light: a bloom from the door that opens out over the whole view and dies away. */
  const drawDoor = (p: Passage, s: number, shown: number) => {
    const landed = p.landed === undefined ? Infinity : (p.landed - p.at) / 1000
    const peak = Math.min(Math.max(0.26, landed + 0.06), 3)
    const rise = smooth(s / peak) ** 1.6
    const fall = 1 - smooth((s - peak) / 0.7)
    const light = rise * fall * shown
    if (light < 0.005) return
    const reach = Math.hypot(width, height)
    const radius = p.size * 0.7 + (reach * 1.15 - p.size * 0.7) * smooth(s / (peak + 0.25)) ** 1.4
    const glow = ctx.createRadialGradient(point.x * dpr, point.y * dpr, 0, point.x * dpr, point.y * dpr, radius * dpr)
    glow.addColorStop(0, `rgba(236,244,255,${(0.85 * light).toFixed(3)})`)
    glow.addColorStop(0.16, `rgba(206,224,255,${(0.55 * light).toFixed(3)})`)
    glow.addColorStop(0.5, `rgba(150,186,255,${(0.2 * light).toFixed(3)})`)
    glow.addColorStop(1, "rgba(120,160,255,0)")
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  const tick = (now: number) => {
    frame = 0
    const p = passage
    if (!p) return
    const s = (now - p.at) / 1000
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
    last = now
    const { speed, shown } = pace(p, s)
    // Once the pages have swapped, the vanishing point glides to where the new page wants the reader.
    const arrive = p.arrive
    if (arrive) {
      const k = 1 - Math.exp(-dt / 0.09)
      point = { x: point.x + (arrive.x - point.x) * k, y: point.y + (arrive.y - point.y) * k }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.globalCompositeOperation = "lighter"
    const focal = 0.42 * Math.max(width, height)
    if (p.kind === "warp") drawStars(speed, shown, dt, focal, stars.length)
    else if (p.kind === "dive") {
      drawDoor(p, s, shown)
      drawStars(speed * 0.7, shown * 0.8, dt, focal * 0.8, Math.min(110, stars.length))
    }
    if (s > 0.2 && shown <= 0.001) {
      stop()
      return
    }
    frame = requestAnimationFrame(tick)
  }

  const unwatch = watch((p) => {
    if (p.kind === "surface") return
    if (passage !== p) {
      // A passage beginning: size the canvas to the view and fill it with stars at every depth.
      passage = p
      dpr = Math.min(2, window.devicePixelRatio || 1)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      point = { x: p.x, y: p.y }
      stars = Array.from({ length: 240 }, () => spawn(false))
      last = performance.now()
      canvas.style.visibility = "visible"
      canvas.style.viewTransitionName = "passage-veil"
    }
    if (!frame) frame = requestAnimationFrame(tick)
  })

  return () => {
    unwatch()
    stop()
  }
}
