#!/usr/bin/env node
/**
 * Copy the captures the root README shows into `docs/images/`, flattened onto Realm's page colour.
 *
 * The window `capture-product.mjs` photographs is made of translucent material that is not in the
 * DOM, so a capture composites its grounds over nothing. The capture lays each frame on
 * `--color-page` before it is taken, which is what the site shows it on; this flattens onto the same
 * colour again, so a frame that still carries alpha cannot reach a README GitHub serves on white —
 * where the sidebar would composite to a mid grey under its own light-grey labels.
 *
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
const SHOWN = ["workspace", "sidebar", "models", "connections", "sandbox"]

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
