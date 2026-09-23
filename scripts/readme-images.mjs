#!/usr/bin/env node
/**
 * Flatten the captures the root README shows onto Realm's page colour.
 *
 * `capture-product.mjs` writes RGBA, because the window it photographs is made of translucent
 * material — `workspace.png` is only about a fifth fully opaque. The site never notices: it lays
 * every capture on `--color-page`, which is what the translucency was composited against when the
 * shot was framed. A README has no such ground. GitHub serves it on white to half its readers, and
 * there the sidebar composites to a mid grey with its own light-grey labels on top, which is a
 * screenshot of the product with its text no longer readable.
 *
 * So the README reads from `docs/images/` instead: the same frames with that ground painted in.
 * They are derived files and will go stale behind a re-capture — rerun this after one.
 *
 *   pnpm --filter realm-site capture:product   # retake the captures
 *   node scripts/readme-images.mjs             # then repaint the README's copies
 */
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** `--color-page` from `site/app/globals.css`, in the sRGB ffmpeg wants. Keep the two in step. */
const PAGE = "#17181a"

/** Only what the README actually shows — this is not a second copy of the whole manifest. */
const SHOWN = ["workspace", "models", "connections", "sandbox"]

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const from = join(root, "site/public/product")
const to = join(root, "docs/images")

mkdirSync(to, { recursive: true })
for (const name of SHOWN) {
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=${PAGE}:s=2880x1800`,
    "-i", join(from, `${name}.png`),
    "-filter_complex", "[0][1]overlay=format=auto",
    "-frames:v", "1", "-pix_fmt", "rgb24",
    join(to, `${name}.png`),
  ])
  console.log(`painted ${name}.png onto ${PAGE}`)
}
