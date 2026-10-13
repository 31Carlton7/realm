import { DOORWAY, TONES } from "./cube"
import { DOOR_BLUE, DOOR_LIGHT, DUSK, OPEN_SKY, SPACING, toLinear, toSrgb } from "./light"

/**
 * The hive without WebGPU: the same field drawn once as a repeating picture. Seen straight down the
 * cube's diagonal with no perspective, the field IS a flat pattern — the mark's hexagon tiling the
 * page with streets between — so this is the shader's own view, less the fog, the lens and the hour
 * passing. Faces are shaded with the shader's light, and a few doorways are lit.
 */

/** The lattice's spacing on the page, in CSS px: 41 makes two rows 71.01 px, close enough to whole
 *  pixels that the tile repeats without a seam. */
const LATTICE = 41
const SCALE = LATTICE / (Math.SQRT2 * SPACING)
const ROW = (LATTICE * Math.sqrt(3)) / 2
const COLUMNS = 15
const ROWS = 6
export const TILE = { width: LATTICE * COLUMNS, height: Math.round(ROW * ROWS) } as const

type Vec3 = readonly [number, number, number]

/** A point of a cube whose foot is centred at the origin, on the page. */
const at = ([x, y, z]: Vec3) =>
  [SCALE * (x - y) * Math.SQRT1_2, -SCALE * ((x + y) * Math.sqrt(1 / 6) + z * Math.sqrt(2 / 3))] as const

const path = (points: readonly Vec3[]) => `M${points.map((p) => at(p).map((n) => n.toFixed(2)).join(" ")).join("L")}Z`

/** A face's colour as the shader would light it, as #rrggbb. */
const shade = (tone: readonly number[], light: readonly number[]) =>
  `#${tone
    .map((c, i) => toSrgb(1 - Math.exp(-toLinear(c) * light[i])))
    .map((c) => Math.round(Math.min(1, c) * 255).toString(16).padStart(2, "0"))
    .join("")}`

const mean = (pair: readonly (readonly number[])[]) => pair[0].map((c, i) => (c + pair[1][i]) / 2)
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

const colours = {
  top: shade(mean(TONES.top), times(DUSK, OPEN_SKY)),
  left: shade(mean(TONES.left), DUSK),
  right: shade(mean(TONES.right), DUSK),
  dark: { back: shade(TONES.right[1], times(DUSK, 0.25)), jamb: shade(TONES.left[1], times(DUSK, 0.4)), sill: shade(TONES.top[1], times(DUSK, 0.5)) },
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

/** Which realms of the tile have an agent at work, by row and column, and whose light is blue: three
 *  in ninety, as few as the live field has lit at once. */
const LIT: readonly (readonly [number, number, "white" | "blue"])[] = [
  [1, 3, "white"],
  [3, 11, "blue"],
  [5, 6, "white"],
]

function tileSvg() {
  const uses: string[] = []
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const lit = LIT.find(([r, c]) => r === row && c === column)
      const id = lit ? (lit[2] === "blue" ? "blue" : "white") : "idle"
      const x = column * LATTICE + (row % 2) * (LATTICE / 2)
      const y = row * ROW
      // Every copy that reaches into the tile, so the pattern meets itself at the edges.
      for (const dx of [-TILE.width, 0, TILE.width]) {
        for (const dy of [-TILE.height, 0, TILE.height]) {
          uses.push(`<use href="#${id}" x="${(x + dx).toFixed(2)}" y="${(y + dy).toFixed(2)}"/>`)
        }
      }
    }
  }
  // Seen down the diagonal the cubes' outlines never overlap, so the order they are drawn in is free.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE.width}" height="${TILE.height}" viewBox="0 0 ${TILE.width} ${TILE.height}">
<defs>
<clipPath id="door"><path d="${faces.door}"/></clipPath>
${realm("idle", colours.dark)}
${realm("white", colours.lit(DOOR_LIGHT))}
${realm("blue", colours.lit(DOOR_BLUE))}
</defs>
${uses.join("\n")}
</svg>`
}

/** The tile as a CSS image. */
export const FIELD_PATTERN = `url("data:image/svg+xml,${encodeURIComponent(tileSvg())}")`
