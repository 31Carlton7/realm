/**
 * Headless proof for the hero shader.
 *
 * Compiles `lib/realm-shader.ts` through vgpu's Dawn-backed Node entrypoint and renders frames to
 * PNG. A WGSL compile error, a NaN, or a ring that drifts off the icon all show up here
 * instead of in a browser, and the string it renders is the exact string the browser gets.
 *
 * This file is excluded from the site's tsconfig: it runs under `node --experimental-strip-types`,
 * whose `.ts` import specifiers and bare `pngjs` require are not what the Next build typechecks
 * against. Running it is the check.
 *
 * Dawn ships as a native postinstall in `@vgpu/adapter-node`, which the site deliberately does not
 * build (Vercel has no use for it). Run this from a scratch project that does:
 *
 *   mkdir -p /tmp/shader-lab && cd /tmp/shader-lab
 *   printf '{"name":"lab","private":true,"type":"module","pnpm":{"onlyBuiltDependencies":["@vgpu/adapter-node","webgpu"]}}' > package.json
 *   pnpm add vgpu@0.3.1 pngjs --ignore-workspace
 *   node --experimental-strip-types <path-to-realm>/site/scripts/render-shader.ts
 */
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { effect, frame, init, target } from "vgpu/node"
import { PNG } from "pngjs"

import { realmShader } from "../lib/realm-shader.ts"

const WIDTH = 1200
const HEIGHT = 750
/** Seconds to sample. Spread wide enough to catch the ring's head at different positions. */
const TIMES = [0, 2.5, 7, 15]

const outDir = dirname(fileURLToPath(import.meta.url))

const gpu = await init()
try {
  const color = target(gpu, { size: [WIDTH, HEIGHT], format: "rgba8unorm" })
  const scene = effect(gpu, realmShader, {
    set: { params: { resolution: [WIDTH, HEIGHT], pointer: [0, 0], time: 0 } },
  })

  for (const time of TIMES) {
    scene.set({ params: { time } })
    frame(gpu, (f) => f.pass(color, scene))

    const pixels = await color.read()
    const png = new PNG({ width: WIDTH, height: HEIGHT })
    png.data = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength)
    const file = join(outDir, `realm-t${String(time).replace(".", "_")}.png`)
    writeFileSync(file, PNG.sync.write(png))

    console.log(`${file}  ${describe(pixels)}`)
  }
} finally {
  gpu.dispose()
}

/** A one-line read on the frame, so a black or blown-out render is obvious without opening it. */
function describe(pixels: Uint8Array): string {
  let sum = 0
  let max = 0
  let lit = 0
  const px = pixels.length / 4
  for (let i = 0; i < pixels.length; i += 4) {
    const luma = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]
    sum += luma
    if (luma > max) max = luma
    if (luma > 24) lit += 1
  }
  return `mean=${(sum / px).toFixed(1)} max=${max} lit=${((lit / px) * 100).toFixed(1)}%`
}
