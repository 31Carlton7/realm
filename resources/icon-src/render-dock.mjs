// Lays each candidate into a Dock strip beside real applications, at 128px.
//
//   node render-dock.mjs /path/to/neighbours-dir
//
// A contact sheet answers "is it legible". This answers the other question, which no sheet can: is
// it distinguishable from what is already sitting next to it. The neighbours are PNGs exported from
// the .icns of installed apps, so the comparison is against the actual Dock and not an impression
// of one.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { init, effect, target } from "vgpu/node";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "candidates");
const out = join(dir, "sheets");
const neighbourDir = process.argv[2];
const SS = 4;
const SIZE = 128;
const GAP = 22;
const PAD = 34;
/** A Dock is a light translucent shelf far more often than it is black. */
const SHELF = [0x2b, 0x2d, 0x33];

const frame = readFileSync(join(dir, "_frame.wgsl"), "utf8");
const epilogue = readFileSync(join(dir, "_epilogue.wgsl"), "utf8");
const names = readdirSync(dir)
  .filter((f) => f.endsWith(".wgsl") && !f.startsWith("_"))
  .map((f) => f.replace(/\.wgsl$/, ""));

const gpu = await init();

async function render(name) {
  const res = SIZE * SS;
  const body = readFileSync(join(dir, `${name}.wgsl`), "utf8");
  const wgsl = `${frame}\n${body}\n${epilogue}`
    .replaceAll("__RES__", res.toFixed(1))
    .replaceAll("__UNIT__", (SIZE / 1024).toFixed(6));
  const t = target(gpu, { size: [res, res], format: "rgba8unorm" });
  effect(gpu, wgsl).draw(t);
  const px = await t.read();
  const image = { width: SIZE, height: SIZE, data: new Uint8Array(SIZE * SIZE * 4) };
  const n = SS * SS;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * res + (x * SS + sx)) * 4;
          r += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3];
        }
      }
      a /= n;
      const k = a > 0 ? 255 / (a * n) : 0;
      const o = (y * SIZE + x) * 4;
      image.data[o] = Math.min(255, Math.round(r * k));
      image.data[o + 1] = Math.min(255, Math.round(g * k));
      image.data[o + 2] = Math.min(255, Math.round(b * k));
      image.data[o + 3] = Math.round(a);
    }
  }
  return image;
}

function load(file) {
  const png = PNG.sync.read(readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
}

function blit(sheet, image, left, top) {
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const s = (y * image.width + x) * 4;
      const alpha = image.data[s + 3] / 255;
      if (alpha === 0) continue;
      const d = ((top + y) * sheet.width + (left + x)) * 4;
      for (let ch = 0; ch < 3; ch++) {
        sheet.data[d + ch] = Math.round(image.data[s + ch] * alpha + sheet.data[d + ch] * (1 - alpha));
      }
    }
  }
}

const neighbours = neighbourDir
  ? readdirSync(neighbourDir).filter((f) => f.endsWith(".png")).map((f) => load(join(neighbourDir, f)))
  : [];
if (neighbours.length === 0) console.warn("no neighbours given — the strip will only show candidates");

// One row per candidate: the candidate first, then the neighbours, so the eye lands on it cold.
const cols = neighbours.length + 1;
const width = PAD * 2 + cols * SIZE + (cols - 1) * GAP;
const height = PAD * 2 + names.length * SIZE + (names.length - 1) * GAP;
const sheet = new PNG({ width, height });
for (let i = 0; i < width * height; i++) {
  sheet.data[i * 4] = SHELF[0];
  sheet.data[i * 4 + 1] = SHELF[1];
  sheet.data[i * 4 + 2] = SHELF[2];
  sheet.data[i * 4 + 3] = 255;
}

let y = PAD;
for (const name of names) {
  blit(sheet, await render(name), PAD, y);
  let x = PAD + SIZE + GAP;
  for (const neighbour of neighbours) {
    blit(sheet, neighbour, x, y);
    x += SIZE + GAP;
  }
  y += SIZE + GAP;
}

writeFileSync(join(out, "_dock.png"), PNG.sync.write(sheet));
console.log(`sheets/_dock.png  ${names.join(" ")} vs ${neighbours.length} installed apps`);
gpu.dispose();
