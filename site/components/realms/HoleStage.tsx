"use client"

import { FACES, MARK_CENTER, MARK_RADIUS, WALLS } from "@/lib/mark"

import { dropRealm, HOLE } from "./blackhole"

/**
 * Where the flight ends: the rect the field draws the black hole into, at the foot of the page under
 * the footer. The cube is centred across it, a little below its middle.
 *
 * Clicking the hole drops a realm in at the point clicked; its button does the same from the keyboard
 * (a key's click carries no pointer, so the realm goes in where it is easiest to follow), and while it
 * has the keyboard's focus a ring the mark's own shape stands round the cube. Under reduced motion the
 * hole is a still and the button goes, since a drop is nothing but motion. Without WebGPU the
 * stylesheet draws the hole instead, as the shader's own composition held still.
 *
 * The hexagon's size on the page follows blackhole.ts's `shadowRadius`: 7vw held to 11vh, 11vw on a
 * phone, between 34 and 104 px.
 */
export function HoleStage() {
  return (
    <div
      data-field-anchor="hole"
      className="relative h-[clamp(300px,40vh,380px)] w-full [--hex:clamp(34px,min(11vw,11vh),104px)] sm:h-[clamp(400px,56vh,540px)] sm:[--hex:clamp(34px,min(7vw,11vh),104px)]"
    >
      <FallbackHole />
      <button
        type="button"
        aria-label="Drop a realm into the black hole"
        onClick={(event) => (event.detail === 0 ? dropRealm() : dropRealm(event.clientX, event.clientY))}
        className="peer absolute top-[56%] left-1/2 h-[calc(var(--hex)*3.2)] w-[min(calc(var(--hex)*8.4),100%)] -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full focus-visible:outline-none! motion-reduce:hidden [html[data-field=off]_&]:hidden [html[data-field=pending]_&]:hidden"
      />
      <FocusRing />
      <p
        aria-hidden
        className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 text-[13px] whitespace-nowrap text-ink-2 opacity-0 transition-opacity duration-200 peer-hover:opacity-100 peer-focus-visible:opacity-100 motion-reduce:hidden"
      >
        Drop a realm in
      </p>
    </div>
  )
}

/** Every computed number is rounded, so the server and the browser write the same attribute. */
const round = (n: number) => Math.round(n * 1000) / 1000
const corner = (radius: number, i: number) => [round(radius * Math.cos((-i * Math.PI) / 3)), round(radius * Math.sin((-i * Math.PI) / 3))] as const
const through = (points: readonly (readonly [number, number])[], closed = false) =>
  `M${points.map(([x, y]) => `${x} ${y}`).join("L")}${closed ? "Z" : ""}`
/** A polygon of the mark's own box, as it stands in a drawing whose hexagon has the given radius about 0, 0. */
const markPath = (polygon: readonly (readonly [number, number])[], radius: number) => {
  const k = radius / MARK_RADIUS
  return through(polygon.map(([x, y]) => [round((x - MARK_CENTER[0]) * k), round((y - MARK_CENTER[1]) * k)] as const), true)
}

/**
 * The keyboard's focus, drawn round the cube rather than round the button's box: the mark's hexagon a
 * little larger than the hole's, in the accent, as the site draws every other focus ring.
 */
function FocusRing() {
  const r = 26
  return (
    <svg
      aria-hidden
      viewBox={`${-r - 2} ${-r - 2} ${2 * r + 4} ${2 * r + 4}`}
      className="pointer-events-none absolute top-[56%] left-1/2 h-[calc(var(--hex)*2.85)] w-[calc(var(--hex)*2.85)] -translate-x-1/2 -translate-y-1/2 overflow-visible opacity-0 peer-focus-visible:opacity-100"
    >
      <path
        d={through([0, 1, 2, 3, 4, 5].map((i) => corner(r, i)), true)}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={2}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/** The hexagon's radius in the drawing's units, and the inflow's slant and tilt as the shader draws it. */
const HEX = 100
const UNIT = HEX / HOLE.hexagon
const SLANT = round(Math.cos((HOLE.inclination[1] * Math.PI) / 180))
/**
 * The streams' threads as the shader lays them: spirals down the lines matter follows (turning
 * HOLE.wind radians per e-fold of radius), on the tilted plane, cut into short pieces so each can take
 * its own light — brighter inward and on the side coming at the camera, fading at the plane's edge —
 * and sorted into the far side, drawn behind the cube, and the near side, drawn in front of it.
 */
const THREADS = (() => {
  const pieces: { d: string; o: number; w: number; near: boolean }[] = []
  const steps = 96
  const [outer, inner] = [HOLE.outer, 1.3]
  for (let k = 0; k < 22; k++) {
    // Every other thread a fainter one between, so the streams have body without crowding.
    const faint = k % 2 === 1
    const psi = (Math.floor(k / 2) / 11) * Math.PI * 2 + 0.4 + (faint ? 0.29 : 0)
    const width = round(faint ? 0.9 : k % 6 === 0 ? 1.6 : 1.15)
    const strength = faint ? 0.45 : 0.95
    let run: string[] = []
    let near = false
    let light = 0
    const flush = () => {
      if (run.length > 1) pieces.push({ d: `M${run.join("L")}`, o: round(Math.min(light / (run.length - 1), 1)), w: width, near })
      run = []
      light = 0
    }
    for (let i = 0; i <= steps; i++) {
      const lr = Math.log(outer) + (Math.log(inner) - Math.log(outer)) * (i / steps)
      const r = Math.exp(lr)
      const phi = psi - HOLE.wind * lr
      const front = Math.cos(phi) > 0
      if (run.length > 0 && (front !== near || run.length >= 9)) {
        const last = run[run.length - 1]!
        flush()
        run.push(last)
      }
      near = front
      run.push(`${round(r * Math.sin(phi) * UNIT)} ${round(r * Math.cos(phi) * SLANT * UNIT)}`)
      const fade = Math.min(1, (outer - r) / 2.4)
      if (run.length > 1) light += strength * Math.min(1, (HOLE.inner / r) ** 1.3) * fade * (1 - 0.4 * Math.sin(phi))
    }
    flush()
  }
  return pieces
})()

/** The silhouette's corner radius in the drawing, the mark's own (1.8 of its 20), and the hexagon its
 *  rounded outline is grown from. */
const ROUND = HEX * 0.09
const CORE = HEX - ROUND / Math.cos(Math.PI / 6)

/**
 * The silhouette's outline grown by `grow`, through the corners `from` in order, as an open path (or a
 * closed one round all six): its edges pushed out and its corners arcs, as growing a rounded hexagon
 * rounds them. `sweep` is 1 when the corners run clockwise on the page.
 */
function grown(grow: number, from: readonly number[], sweep: 0 | 1, closed = false) {
  const v = from.map((i) => corner(CORE, i))
  const r = ROUND + grow
  const edges = closed ? v.length : v.length - 1
  let d = ""
  for (let j = 0; j < edges; j++) {
    const a = v[j]!
    const b = v[(j + 1) % v.length]!
    const mx = (a[0] + b[0]) / 2
    const my = (a[1] + b[1]) / 2
    const l = Math.hypot(mx, my)
    const [nx, ny] = [(mx / l) * r, (my / l) * r]
    const start = `${round(a[0] + nx)} ${round(a[1] + ny)}`
    d += j === 0 ? `M${start}` : `A${round(r)} ${round(r)} 0 0 ${sweep} ${start}`
    d += `L${round(b[0] + nx)} ${round(b[1] + ny)}`
  }
  if (closed) d += `A${round(r)} ${round(r)} 0 0 ${sweep} ${d.slice(1, d.indexOf("L"))}Z`
  return d
}

/** The far side bent over the cube's top and under it, as how far out, opacity and width. */
const HAT = [5, 10, 16, 23].map((grow, i) => [grow, round(0.85 * Math.exp(-i / 1.5)), round(1.9 - i * 0.2)] as const)
const UNDER = [5, 11].map((grow, i) => [grow, round(0.42 * Math.exp(-i / 1.2)), 1.2] as const)
/** The doorway's light streaming out to the right as the shader's jet does: threads from across the
 *  opening, as where each starts, how far it runs and how it climbs, its opacity and width (the last
 *  is the jet's soft core); then a few sparks riding it, as where they are and how long a streak. */
const JET = [
  [46, -20, 230, -10, 0.85, 1.1],
  [54, -6, 290, -3, 0.95, 1.2],
  [60, 9, 250, 6, 0.8, 1.1],
  [50, 24, 200, 12, 0.6, 1],
  [64, -30, 180, -16, 0.5, 1],
  [52, 0, 320, 0, 0.3, 9],
] as const
const SPARKS = [
  [150, -8, 14, 0.9],
  [196, 4, 18, 0.7],
  [252, -5, 22, 0.45],
] as const

/**
 * The hole without WebGPU: the shader's composition drawn once. The cube is the mark's silhouette in
 * black with its doorway's lit back, jamb and floor from lib/mark.ts; a fine rim traces it; the
 * inflow's threads spiral in on the tilted plane, the far side's bent over the top and under the
 * bottom along the hexagon's own outline, the near side's crossing in front and dimming over the faces;
 * and the doorway's light streams out to the right with a few sparks on it. A drawing, not a simulation.
 */
function FallbackHole() {
  const silhouette = grown(0, [0, 1, 2, 3, 4, 5], 0, true)
  const door = (name: string) => markPath(FACES.find((face) => face.name === name)?.polygon ?? [], HEX)
  return (
    <svg
      aria-hidden
      viewBox="-520 -250 1040 480"
      preserveAspectRatio="xMidYMid meet"
      className="pointer-events-none absolute inset-x-0 top-[56%] mx-auto hidden h-[min(100%,72vw)] w-full max-w-[1100px] -translate-y-[52%] [html[data-field=off]_&]:block"
    >
      <defs>
        <linearGradient id="hole-hat" gradientUnits="userSpaceOnUse" x1="-160" x2="160" y1="0" y2="0">
          <stop offset="0" stopColor="oklch(0.96 0.025 250)" />
          <stop offset="0.55" stopColor="oklch(0.8 0.08 252)" />
          <stop offset="1" stopColor="oklch(0.64 0.12 255)" />
        </linearGradient>
        <linearGradient id="hole-jet" gradientUnits="userSpaceOnUse" x1="40" x2="360" y1="0" y2="0">
          <stop offset="0" stopColor="oklch(0.97 0.02 250)" />
          <stop offset="0.35" stopColor="oklch(0.84 0.07 251)" stopOpacity="0.6" />
          <stop offset="1" stopColor="oklch(0.7 0.11 254)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="hole-lit" gradientUnits="userSpaceOnUse" x1="0" y1="-60" x2="0" y2="60">
          <stop offset="0" stopColor="oklch(0.99 0.01 250)" />
          <stop offset="1" stopColor="oklch(0.9 0.04 250)" />
        </linearGradient>
        <filter id="hole-soft" x="-20%" y="-60%" width="140%" height="220%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
        <filter id="hole-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        {/* Over the cube's faces the near strands are mostly taken in. */}
        <mask id="hole-faces" maskUnits="userSpaceOnUse" x="-520" y="-250" width="1040" height="480">
          <rect x="-520" y="-250" width="1040" height="480" fill="white" />
          <path d={silhouette} fill="oklch(0.32 0 0)" />
        </mask>
      </defs>
      {/* The far side of the inflow, behind the cube. */}
      <g fill="none" stroke="oklch(0.84 0.07 251)" strokeLinecap="round" transform={`rotate(${HOLE.roll})`} filter="url(#hole-soft)">
        {THREADS.filter((piece) => !piece.near).map((piece) => (
          <path key={piece.d} d={piece.d} strokeWidth={piece.w} strokeOpacity={round(piece.o * 0.75)} />
        ))}
      </g>
      {/* The far side bent over the top of the cube and under it. */}
      <g fill="none" stroke="url(#hole-hat)" strokeLinecap="round">
        {HAT.map(([grow, o, w]) => (
          <path key={`hat-${grow}`} d={grown(grow, [3, 2, 1, 0], 1)} strokeWidth={w} strokeOpacity={o} />
        ))}
        {UNDER.map(([grow, o, w]) => (
          <path key={`under-${grow}`} d={grown(grow, [3, 4, 5, 0], 0)} strokeWidth={w} strokeOpacity={o} />
        ))}
      </g>
      {/* The cube: its three walls in black (together they are the mark's silhouette), its rim, and its
          doorway lit from within. */}
      <g fill="oklch(0.07 0.004 264)" stroke="oklch(0.07 0.004 264)" strokeWidth={0.6} strokeLinejoin="round">
        {WALLS.map((wall, i) => (
          <path key={i} d={markPath(wall, HEX)} />
        ))}
      </g>
      <path d={grown(2.2, [0, 1, 2, 3, 4, 5], 0, true)} fill="none" stroke="oklch(0.95 0.03 250)" strokeOpacity={0.8} strokeWidth={1.3} />
      <path d={door("lit")} fill="oklch(0.88 0.06 250)" filter="url(#hole-glow)" opacity={0.7} />
      <path d={door("lit")} fill="url(#hole-lit)" />
      <path d={door("jamb")} fill="oklch(0.6 0.07 252)" />
      <path d={door("floor")} fill="oklch(0.76 0.05 250)" />
      {/* The near side of the inflow, crossing in front. */}
      <g mask="url(#hole-faces)">
        <g fill="none" stroke="oklch(0.88 0.06 250)" strokeLinecap="round" transform={`rotate(${HOLE.roll})`}>
          {THREADS.filter((piece) => piece.near).map((piece) => (
            <path key={piece.d} d={piece.d} strokeWidth={piece.w} strokeOpacity={piece.o} />
          ))}
        </g>
      </g>
      {/* What comes back out of the doorway: its light, and the sparks riding it. */}
      <g fill="none" stroke="url(#hole-jet)" strokeLinecap="round">
        {JET.map(([x, y, length, climb, o, w]) => (
          <path key={`${x} ${y}`} d={`M${x} ${y}L${x + length} ${y + climb}`} strokeWidth={w} strokeOpacity={o} filter={w > 2 ? "url(#hole-glow)" : undefined} />
        ))}
      </g>
      <g stroke="oklch(0.95 0.03 250)" strokeLinecap="round" filter="url(#hole-soft)">
        {SPARKS.map(([x, y, length, o]) => (
          <path key={x} d={`M${x - length} ${y}L${x} ${y}`} strokeWidth={2.2} strokeOpacity={o} />
        ))}
      </g>
    </svg>
  )
}
