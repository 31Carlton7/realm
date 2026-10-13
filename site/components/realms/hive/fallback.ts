import { DOORWAY, TONES } from "./cube"
import { DOOR_BLUE, DOOR_LIGHT, SPACE, toLinear, toSrgb } from "./light"

/**
 * The team's realms without WebGPU: the four of them drawn once, hanging together as the live field
 * hangs them, each seen down the mark's own diagonal, so each is the logo, in the starlight the field
 * lights them with. The doorways say what the board's roles start out doing: the Researcher at work,
 * the Producer and the Editor waiting on you in Realm's blue, Ops dark for the day.
 *
 * The rest of the page's sky without WebGPU is the field's opening photographed (Flight.tsx).
 */

/** px per cube edge in the drawing. */
const SCALE = 58
export const TILE = { width: 660, height: 440 } as const

type Vec3 = readonly [number, number, number]

/** A point of a cube whose foot is centred at the origin, on the page, seen down its diagonal. */
const at = ([x, y, z]: Vec3) =>
  [SCALE * (x - y) * Math.SQRT1_2, -SCALE * ((x + y) * Math.sqrt(1 / 6) + z * Math.sqrt(2 / 3))] as const

const path = (points: readonly Vec3[]) => `M${points.map((p) => at(p).map((n) => n.toFixed(2)).join(" ")).join("L")}Z`

/** A face's colour as the field would light it, as #rrggbb. */
const shade = (tone: readonly number[], light: readonly number[]) =>
  `#${tone
    .map((c, i) => toSrgb(1 - Math.exp(-toLinear(c) * light[i]!)))
    .map((c) => Math.round(Math.min(1, c) * 255).toString(16).padStart(2, "0"))
    .join("")}`

const mean = (pair: readonly (readonly number[])[]) => pair[0]!.map((c, i) => (c + pair[1]![i]!) / 2)
const times = (light: readonly number[], k: number) => light.map((c) => c * k)

const [a0, a1] = DOORWAY.across
const [c0, c1] = DOORWAY.down
const depth = DOORWAY.depth
const x0 = -0.5 + a0
const x1 = -0.5 + a1
const zLow = 1 - c1
const zHigh = 1 - c0
const front = -0.5

const faces = {
  top: path([[-0.5, -0.5, 1], [0.5, -0.5, 1], [0.5, 0.5, 1], [-0.5, 0.5, 1]]),
  left: path([[-0.5, -0.5, 0], [-0.5, 0.5, 0], [-0.5, 0.5, 1], [-0.5, -0.5, 1]]),
  right: path([[-0.5, front, 0], [0.5, front, 0], [0.5, front, 1], [-0.5, front, 1]]),
  door: path([[x0, front, zLow], [x1, front, zLow], [x1, front, zHigh], [x0, front, zHigh]]),
  back: path([[x0, front + depth, zLow], [x1, front + depth, zLow], [x1, front + depth, zHigh], [x0, front + depth, zHigh]]),
  jamb: path([[x1, front, zLow], [x1, front + depth, zLow], [x1, front + depth, zHigh], [x1, front, zHigh]]),
  sill: path([[x0, front, zLow], [x1, front, zLow], [x1, front + depth, zLow], [x0, front + depth, zLow]]),
}

const KEY = SPACE.key
const colours = {
  top: shade(mean(TONES.top), times(KEY, 1.1)),
  left: shade(mean(TONES.left), times(KEY, 0.8)),
  right: shade(mean(TONES.right), times(KEY, 0.6)),
  dark: { back: shade(TONES.right[1], times(KEY, 0.12)), jamb: shade(TONES.left[1], times(KEY, 0.25)), sill: shade(TONES.top[1], times(KEY, 0.3)) },
  lit: (tint: readonly number[]) => ({
    back: shade(TONES.lit[0], times(tint, 2.1)),
    jamb: shade(TONES.left[1], times(tint, 0.45)),
    sill: shade(TONES.top[1], times(tint, 0.56)),
  }),
}

const realm = (id: string, inside: { back: string; jamb: string; sill: string }) => `
<g id="${id}">
<path fill="${colours.top}" d="${faces.top}"/>
<path fill="${colours.left}" d="${faces.left}"/>
<path fill="${colours.right}" fill-rule="evenodd" d="${faces.right}${faces.door}"/>
<g clip-path="url(#door)">
<path fill="${inside.back}" d="${faces.back}"/>
<path fill="${inside.jamb}" d="${faces.jamb}"/>
<path fill="${inside.sill}" d="${faces.sill}"/>
</g>
</g>`

/** Where a doorway's middle is drawn, relative to its realm's foot. */
const doorMid = at([(x0 + x1) / 2, front, (zLow + zHigh) / 2])

/** The four, two in front and two behind and between them, with their doorways' states. */
const TEAM: readonly (readonly [number, number, "white" | "blue" | "idle"])[] = [
  [300, 205, "blue"],
  [452, 222, "idle"],
  [225, 318, "white"],
  [390, 336, "blue"],
]

function tileSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE.width}" height="${TILE.height}" viewBox="0 0 ${TILE.width} ${TILE.height}">
<defs>
<clipPath id="door"><path d="${faces.door}"/></clipPath>
<radialGradient id="glow"><stop offset="0" stop-color="#cfe2ff" stop-opacity="0.32"/><stop offset="1" stop-color="#cfe2ff" stop-opacity="0"/></radialGradient>
${realm("idle", colours.dark)}
${realm("white", colours.lit(DOOR_LIGHT))}
${realm("blue", colours.lit(DOOR_BLUE))}
</defs>
${TEAM.map(([x, y, state]) => `<use href="#${state}" x="${x}" y="${y}"/>${state === "idle" ? "" : `<circle cx="${(x + doorMid[0]).toFixed(1)}" cy="${(y + doorMid[1]).toFixed(1)}" r="40" fill="url(#glow)"/>`}`).join("\n")}
</svg>`
}

/** The drawing as a CSS image. */
export const FIELD_PATTERN = `url("data:image/svg+xml,${encodeURIComponent(tileSvg())}")`
