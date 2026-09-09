// Renders every icon candidate in candidates/ at the sizes an .icns actually carries, and lays them
// out as one contact sheet per candidate plus a combined sheet.
//
//   cd resources/icon-src && node render-candidates.mjs
//
// This is the only honest way to judge an app icon: a mark tuned at 512px and shrunk is not the same
// object as one that survives 16. Each size is rendered NATIVELY at 4× supersampling — never
// downscaled from a big one — so a candidate that widens a feature at small sizes gets to.
//
// Sheets are written to candidates/sheets/ and are not committed; they exist to be looked at.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { init, effect, target } from "vgpu/node";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "candidates");
const out = join(dir, "sheets");
const SS = 4;

/** The sizes macOS actually asks for, plus 512 as the one a human judges. */
const SIZES = [16, 32, 64, 128, 256, 512];
/** The page the sheet sits on: Realm's own --color-page, so the icons are judged where they live. */
const PAGE = [0x17, 0x18, 0x1a];
const GAP = 28;
const PAD = 40;

const frame = readFileSync(join(dir, "_frame.wgsl"), "utf8");
const epilogue = readFileSync(join(dir, "_epilogue.wgsl"), "utf8");
const names = readdirSync(dir)
  .filter((f) => f.endsWith(".wgsl") && !f.startsWith("_"))
  .map((f) => f.replace(/\.wgsl$/, ""));

const gpu = await init();

/** One candidate at one size: native render, 4× supersampled, box-filtered, un-premultiplied. */
async function render(name, size) {
  const res = size * SS;
  const body = readFileSync(join(dir, `${name}.wgsl`), "utf8");
  const wgsl = `${frame}\n${body}\n${epilogue}`
    .replaceAll("__RES__", res.toFixed(1))
    // Device pixels per grid pixel at this size — what a candidate clamps a thin feature against.
    .replaceAll("__UNIT__", (size / 1024).toFixed(6));
  const left = wgsl.match(/__[A-Z_]+__/);
  if (left) throw new Error(`${name}: unfilled knob ${left[0]}`);

  const t = target(gpu, { size: [res, res], format: "rgba8unorm" });
  effect(gpu, wgsl).draw(t);
  const px = await t.read();

  const image = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  const n = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * res + (x * SS + sx)) * 4;
          r += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3];
        }
      }
      a /= n;
      const k = a > 0 ? 255 / (a * n) : 0; // un-premultiply the averaged pixel
      const o = (y * size + x) * 4;
      image.data[o] = Math.min(255, Math.round(r * k));
      image.data[o + 1] = Math.min(255, Math.round(g * k));
      image.data[o + 2] = Math.min(255, Math.round(b * k));
      image.data[o + 3] = Math.round(a);
    }
  }
  return image;
}

/** Source-over of an un-premultiplied RGBA image onto an opaque sheet. */
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

function blank(width, height) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = PAGE[0];
    png.data[i * 4 + 1] = PAGE[1];
    png.data[i * 4 + 2] = PAGE[2];
    png.data[i * 4 + 3] = 255;
  }
  return png;
}

mkdirSync(out, { recursive: true });

// `--single <px>` writes each candidate on its own at one size, for looking at rather than comparing.
const singleAt = process.argv.indexOf("--single");
if (singleAt !== -1) {
  const size = Number(process.argv[singleAt + 1] ?? 512);
  for (const name of names) {
    const image = await render(name, size);
    const sheet = blank(size + PAD * 2, size + PAD * 2);
    blit(sheet, image, PAD, PAD);
    writeFileSync(join(out, `${name}@${size}.png`), PNG.sync.write(sheet));
    console.log(`sheets/${name}@${size}.png`);
  }
  gpu.dispose();
  process.exit(0);
}

const rowHeight = Math.max(...SIZES) + GAP;
const rowWidth = SIZES.reduce((sum, s) => sum + s + GAP, 0) - GAP;
const rendered = new Map();

for (const name of names) {
  const images = [];
  for (const size of SIZES) images.push(await render(name, size));
  rendered.set(name, images);

  // Per-candidate sheet: every size on one baseline, largest last, so the eye walks up.
  const sheet = blank(rowWidth + PAD * 2, rowHeight + PAD * 2 - GAP);
  let x = PAD;
  for (const image of images) {
    blit(sheet, image, x, PAD + (Math.max(...SIZES) - image.height));
    x += image.width + GAP;
  }
  writeFileSync(join(out, `${name}.png`), PNG.sync.write(sheet));
  console.log(`sheets/${name}.png  ${SIZES.join(" ")}`);
}

// Combined sheet: candidates down, sizes across, so they are compared at equal size rather than
// against whichever one was looked at last.
const combined = blank(rowWidth + PAD * 2, (rowHeight + GAP) * names.length + PAD * 2 - GAP);
let y = PAD;
for (const name of names) {
  let x = PAD;
  for (const image of rendered.get(name)) {
    blit(combined, image, x, y + (Math.max(...SIZES) - image.height));
    x += image.width + GAP;
  }
  y += rowHeight + GAP;
}
writeFileSync(join(out, "_all.png"), PNG.sync.write(combined));
console.log(`sheets/_all.png  ${names.join(" ")}`);

gpu.dispose();
