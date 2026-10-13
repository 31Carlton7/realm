/**
 * Turn the raw captures into the files the site serves.
 *
 *   pnpm --filter realm-site capture:encode     # capture:product runs it at the end of every capture
 *
 * `capture-product.mjs` shoots the window at CAPTURE_DENSITY (3×) into `site/.captures/`, untouched
 * PNGs that stay out of git. This writes, into `public/product/`:
 *
 *   <scene>-1440.webp, <scene>-4320.webp   every whole-window scene, at the window's 1× and as shot
 *   parts/<part>.webp                      each part of the window the landing page shows, as shot
 *   parts.json                             each part's size in points and its corner radius
 *   details/<crop>.webp                    the changelog's crops, as shot
 *
 * Every file is lossless WebP, which came out smaller than the PNGs it replaces and smaller than a
 * lossy WebP at a quality that keeps text clean. Only the phone's copy of a scene is scaled; the rest
 * are the captured pixels, which also compress best (see SCENE_WIDTHS). Lossy is what the site used to serve — Next's
 * optimiser at its default quality, with the colour halved in resolution — and it is what turned the
 * edges of a capture's small text soft. The pages serve these as written rather than through Next's
 * optimiser for the same reason.
 *
 * `parts.json` is a union, like the scene manifest: a part this run did not take keeps its file and its
 * entry, and an entry whose file is gone is dropped.
 */
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { CAPTURE_DENSITY, SCENE_WIDTHS, WINDOW } from "../lib/frames.ts"

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const rawDir = path.join(siteDir, ".captures")
const outputDir = path.join(siteDir, "public/product")

/* sharp comes with Next, which uses it for the optimiser; the site does not depend on it directly. */
const sharp = createRequire(fs.realpathSync(path.join(siteDir, "node_modules/next/package.json")))("sharp")

const lossless = (image) => image.webp({ lossless: true, effort: 6 })

/** One scene's raw capture, checked to be what this script expects before anything is cut from it. */
async function raw(file) {
  const meta = await sharp(file).metadata()
  const expected = [WINDOW.width * CAPTURE_DENSITY, WINDOW.height * CAPTURE_DENSITY]
  if (meta.width !== expected[0] || meta.height !== expected[1]) {
    throw new Error(`${path.relative(siteDir, file)} is ${meta.width}×${meta.height}, not ${expected.join("×")}: was it shot at ${CAPTURE_DENSITY}×?`)
  }
  return file
}

const pngs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4)) : [])

/**
 * Encode every raw capture present. `only` limits it to some scene and crop names, as
 * REALM_CAPTURE_ONLY limits the capture; parts are always encoded, since only a run that took them
 * leaves them. Resolves to the scene slugs written.
 */
export async function encode({ only = [] } = {}) {
  const wanted = (name) => !only.length || only.includes(name)
  const written = []
  const sceneDir = path.join(rawDir, "scenes")

  for (const slug of pngs(sceneDir).filter(wanted)) {
    const file = await raw(path.join(sceneDir, `${slug}.png`))
    for (const width of SCENE_WIDTHS) {
      // Lanczos down from 3×: each output pixel is built from several drawn ones, which keeps a stroke
      // the width it was drawn rather than rounding it to whichever pixel it fell nearest.
      const image = width === WINDOW.width * CAPTURE_DENSITY ? sharp(file) : sharp(file).resize({ width, kernel: "lanczos3" })
      await lossless(image).toFile(path.join(outputDir, `${slug}-${width}.webp`))
    }
    written.push(slug)
  }

  const partDir = path.join(rawDir, "parts")
  const partsPath = path.join(outputDir, "parts.json")
  const parts = fs.existsSync(partsPath) ? JSON.parse(fs.readFileSync(partsPath, "utf8")) : {}
  fs.mkdirSync(path.join(outputDir, "parts"), { recursive: true })
  for (const name of pngs(partDir)) {
    const file = path.join(partDir, `${name}.png`)
    const meta = JSON.parse(fs.readFileSync(path.join(partDir, `${name}.json`), "utf8"))
    const { width, height } = await sharp(file).metadata()
    if (width !== meta.width * CAPTURE_DENSITY || height !== meta.height * CAPTURE_DENSITY) {
      throw new Error(`parts/${name}.png is ${width}×${height}, not ${meta.width * CAPTURE_DENSITY}×${meta.height * CAPTURE_DENSITY}`)
    }
    await lossless(sharp(file)).toFile(path.join(outputDir, "parts", `${name}.webp`))
    parts[name] = { width: meta.width, height: meta.height, radius: meta.radius, cutout: meta.cutout }
  }
  const kept = Object.fromEntries(Object.entries(parts).filter(([name]) => fs.existsSync(path.join(outputDir, "parts", `${name}.webp`))).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(partsPath, `${JSON.stringify(kept, null, 2)}\n`)

  const detailDir = path.join(rawDir, "details")
  fs.mkdirSync(path.join(outputDir, "details"), { recursive: true })
  for (const name of pngs(detailDir).filter(wanted)) {
    await lossless(sharp(path.join(detailDir, `${name}.png`))).toFile(path.join(outputDir, "details", `${name}.webp`))
  }
  return written
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const only = (process.env.REALM_CAPTURE_ONLY ?? "").split(",").map((n) => n.trim()).filter(Boolean)
  encode({ only })
    .then((written) => console.log(`${written.length} scenes encoded into ${path.relative(siteDir, outputDir)}`))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
