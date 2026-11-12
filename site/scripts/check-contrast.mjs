// A word on the accent reads at 4.5 : 1 or this fails (run by `pnpm typecheck`).
//
// Two checks. The accent-fill tokens in app/globals.css, and the two stops of the download button's
// gradient, are measured against white. And no className may put `text-white` on the bare `bg-accent`
// (or hover onto it): white on --color-accent is 2.9 : 1, which is the bug this exists to keep fixed.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => fs.readFileSync(path.join(root, p), "utf8")

function oklchToLinear(L, C, H) {
  const h = (H * Math.PI) / 180, a = C * Math.cos(h), b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((x) => Math.min(1, Math.max(0, x)))
}
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const onWhite = (L, C, H) => 1.05 / (luminance(oklchToLinear(L, C, H)) + 0.05)

let failed = 0
const check = (name, ratio) => {
  const ok = ratio >= 4.5
  if (!ok) failed++
  console.log(`${ok ? "ok  " : "FAIL"} white on ${name}: ${ratio.toFixed(2)} : 1`)
}

const css = read("app/globals.css")
for (const token of ["--color-accent-fill", "--color-accent-fill-hover", "--color-accent-fill-press"]) {
  const m = new RegExp(`${token}: oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`).exec(css)
  if (!m) { failed++; console.log(`FAIL ${token} is missing from globals.css`); continue }
  check(token, onWhite(+m[1], +m[2], +m[3]))
}

const buttons = read("components/Buttons.tsx")
const stops = [...buttons.matchAll(/linear-gradient\(to_bottom,([^\]]+)\)\]/g)].flatMap((g) =>
  [...g[1].matchAll(/oklch\(([\d.]+)_([\d.]+)_([\d.]+)\)/g)].map((s) => [+s[1], +s[2], +s[3]]))
if (stops.length < 2) { failed++; console.log("FAIL no gradient stops found on the download button") }
for (const [L, C, H] of stops) check(`download stop oklch(${L} ${C} ${H})`, onWhite(L, C, H))

const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.tsx?$/.test(e.name)) files.push(p)
  }
}
for (const dir of ["app", "components"]) walk(dir)
for (const file of files) {
  for (const [cls] of read(file).matchAll(/className=\{?[`"][^`"]*[`"]/g)) {
    if (/\btext-white\b/.test(cls) && /(^|[\s`"])(hover:)?bg-accent(?![-/\w])/.test(cls)) {
      failed++
      console.log(`FAIL ${file}: text-white on the bare accent — use bg-accent-fill`)
    }
  }
}

if (failed) { console.log(`${failed} contrast failure(s)`); process.exit(1) }
console.log("every word on the accent clears 4.5 : 1")
