/**
 * Turn the raw captures into the files the site serves.
 *
 *   pnpm --filter realm-site capture:encode     # capture:product runs it at the end of every capture
 *
 * `capture-product.mjs` shoots the window at CAPTURE_DENSITY (3×) into `site/.captures/`, untouched
 * PNGs that stay out of git. This writes, into `public/product/`:
 *
 *   <scene>-1440.webp, <scene>-4320.webp   every whole-window scene, at the window's 1× and as shot
 *   claims/<claim>.webp                    each landing claim's own cut of its scene, as shot
 *   details/<crop>.webp                    the changelog's crops, as shot
 *
 * Every file is lossless WebP, which came out smaller than the PNGs it replaces and smaller than a
 * lossy WebP at a quality that keeps text clean. Only the phone's copy of a scene is scaled; the rest
 * are the captured pixels, which also compress best (see SCENE_WIDTHS). Lossy is what the site used to serve — Next's
 * optimiser at its default quality, with the colour halved in resolution — and it is what turned the
 * edges of a capture's small text soft. The pages serve these as written rather than through Next's
 * optimiser for the same reason.
 *
 * The claims are cut by `cropPixels` in lib/frames.ts, the same function the page lays them out with,
 * so a claim's `focus` in content/home.ts is the one number to change.
 */
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { claims } from "../content/home.ts"
import { CAPTURE_DENSITY, cropPixels, SCENE_WIDTHS, WINDOW } from "../lib/frames.ts"

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

/**
 * Encode every raw capture present. `only` limits it to some scene and crop names, as
 * REALM_CAPTURE_ONLY limits the capture. Resolves to the scene slugs written.
 */
export async function encode({ only = [] } = {}) {
  const wanted = (name) => !only.length || only.includes(name)
  const written = []
  const sceneDir = path.join(rawDir, "scenes")
  const scenes = fs.existsSync(sceneDir) ? fs.readdirSync(sceneDir).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4)) : []

  for (const slug of scenes.filter(wanted)) {
    const file = await raw(path.join(sceneDir, `${slug}.png`))
    for (const width of SCENE_WIDTHS) {
      // Lanczos down from 3×: each output pixel is built from several drawn ones, which keeps a stroke
      // the width it was drawn rather than rounding it to whichever pixel it fell nearest.
      const image = width === WINDOW.width * CAPTURE_DENSITY ? sharp(file) : sharp(file).resize({ width, kernel: "lanczos3" })
      await lossless(image).toFile(path.join(outputDir, `${slug}-${width}.webp`))
    }
    written.push(slug)
  }

  fs.mkdirSync(path.join(outputDir, "claims"), { recursive: true })
  for (const claim of claims) {
    if (!claim.capture || !scenes.includes(claim.capture) || !(wanted(claim.capture) || wanted(claim.id))) continue
    const file = await raw(path.join(sceneDir, `${claim.capture}.png`))
    const crop = cropPixels(claim.focus ?? { x: 0.5, y: 0, span: 1 })
    await lossless(sharp(file).extract(crop)).toFile(path.join(outputDir, "claims", `${claim.id}.webp`))
  }

  const detailDir = path.join(rawDir, "details")
  if (fs.existsSync(detailDir)) {
    fs.mkdirSync(path.join(outputDir, "details"), { recursive: true })
    for (const name of fs.readdirSync(detailDir).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4)).filter(wanted)) {
      await lossless(sharp(path.join(detailDir, `${name}.png`))).toFile(path.join(outputDir, "details", `${name}.webp`))
    }
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
