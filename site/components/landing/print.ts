/**
 * A world printed the way Realm prints it behind a new session: the colour-kept dither from the
 * desktop app (`panes/session/hero-backdrop-color.ts`). The picture goes through a 4×4 Bayer screen
 * over 2×2 device-pixel cells, each cell its own colour at full strength or a step darker, so it reads
 * as the app's screen and not as a photograph pasted on the page.
 *
 * It is worked out once per picture and size and never in a loop.
 */

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
const CELL = 2
const DEPTH = 0.22

function ditherColor(px: Uint8ClampedArray, w: number, h: number) {
  const keep = 1 - DEPTH
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const l = (0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!) / 255
      const cover = 0.04 + 0.6 * (1 - l) ** 1.4
      if ((BAYER4[(y & 3) * 4 + (x & 3)]! + 0.5) / 16 < cover) {
        px[i] = px[i]! * keep
        px[i + 1] = px[i + 1]! * keep
        px[i + 2] = px[i + 2]! * keep
      }
    }
  }
}

const pictures = new Map<string, Promise<HTMLImageElement>>()

function load(url: string) {
  let picture = pictures.get(url)
  if (!picture) {
    const img = new Image()
    img.src = url
    picture = img.decode().then(() => img)
    pictures.set(url, picture)
  }
  return picture
}

/**
 * Prints `url` onto `canvas`, covering its CSS box at the device's density. `focus` is where the
 * picture's subject sits (0 to 1 across and down), kept in the box as its shape changes.
 */
export async function print(canvas: HTMLCanvasElement, url: string, focus: [number, number] = [0.5, 0.5]) {
  const img = await load(url)
  const box = canvas.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.max(1, Math.round(box.width * dpr))
  const h = Math.max(1, Math.round(box.height * dpr))
  const cols = Math.ceil(w / CELL)
  const rows = Math.ceil(h / CELL)
  const cells = document.createElement("canvas")
  cells.width = cols
  cells.height = rows
  const g = cells.getContext("2d", { willReadFrequently: true })!
  const scale = Math.max(cols / img.naturalWidth, rows / img.naturalHeight)
  const dw = img.naturalWidth * scale
  const dh = img.naturalHeight * scale
  g.imageSmoothingQuality = "high"
  g.drawImage(img, (cols - dw) * focus[0], (rows - dh) * focus[1], dw, dh)
  const data = g.getImageData(0, 0, cols, rows)
  ditherColor(data.data, cols, rows)
  g.putImageData(data, 0, 0)
  canvas.width = w
  canvas.height = h
  const out = canvas.getContext("2d")!
  out.imageSmoothingEnabled = false
  out.drawImage(cells, 0, 0, cols * CELL, rows * CELL)
}
