// Renders the Realm app icon from icon.wgsl, headless on the GPU via vgpu.
//
//   cd resources/icon-src && npm install && npm run render            # rebuilds ../icon.png + ../icon.icns
//   node render.mjs --variants                                         # writes variants/*.png for comparison
//
// Every iconset size is rendered natively (4x supersampled, box-filtered) rather than downscaled
// from 1024, so the ring can be thickened where a 16 px icon would otherwise lose it.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { init, effect, target } from "vgpu/node";

const here = dirname(fileURLToPath(import.meta.url));
const resources = join(here, "..");
const SS = 4;
const v3 = ([r, g, b]) => `vec3f(${r}, ${g}, ${b})`;

const base = {
  RING_R: 0.29, RING_W: 0.026, HEAD: -2.2, TAIL_DIM: 0.35, TWIST: 1.6, GLOW: 1.0,
  BG_TOP: [0.11, 0.12, 0.16], BG_BOT: [0.03, 0.035, 0.05],
};
const variants = {
  aurora: { ...base, PALETTE: 1 },
  spectrum: { ...base, PALETTE: 0, HEAD: -2.4 },
  ember: { ...base, PALETTE: 2, HEAD: -2.6, TWIST: 1.2 },
};
const CHOSEN = "aurora";

const src = readFileSync(join(here, "icon.wgsl"), "utf8");
const gpu = await init();

async function render(cfg, size) {
  const res = size * SS;
  const iconPx = size * (824 / 1024);
  // At 16/32 px the 0.026-sigma ring is well under a pixel; keep the core at least ~1.1 px.
  const ringW = Math.max(cfg.RING_W, 1.1 / iconPx);
  const knobs = { ...cfg, RES: res, RING_W: ringW, HALO_W: cfg.RING_W };
  let wgsl = src;
  for (const [k, val] of Object.entries(knobs)) {
    const lit = Array.isArray(val) ? v3(val) : k === "PALETTE" ? String(val) : Number(val).toFixed(4);
    wgsl = wgsl.replaceAll(`__${k}__`, lit);
  }
  const left = wgsl.match(/__[A-Z_]+__/);
  if (left) throw new Error("unfilled knob " + left[0]);
  const t = target(gpu, { size: [res, res], format: "rgba8unorm" });
  effect(gpu, wgsl).draw(t);
  const px = await t.read();
  const png = new PNG({ width: size, height: size });
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
      png.data[o] = Math.min(255, Math.round(r * k));
      png.data[o + 1] = Math.min(255, Math.round(g * k));
      png.data[o + 2] = Math.min(255, Math.round(b * k));
      png.data[o + 3] = Math.round(a);
    }
  }
  return PNG.sync.write(png);
}

if (process.argv.includes("--variants")) {
  mkdirSync(join(here, "variants"), { recursive: true });
  for (const [name, cfg] of Object.entries(variants)) {
    writeFileSync(join(here, "variants", `${name}.png`), await render(cfg, 1024));
    console.log(`variants/${name}.png`);
  }
} else {
  const cfg = variants[CHOSEN];
  const iconset = join(here, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  const entries = [[16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2]];
  const cache = new Map();
  for (const [pt, scale] of entries) {
    const size = pt * scale;
    if (!cache.has(size)) cache.set(size, await render(cfg, size));
    writeFileSync(join(iconset, `icon_${pt}x${pt}${scale === 2 ? "@2x" : ""}.png`), cache.get(size));
  }
  writeFileSync(join(resources, "icon.png"), cache.get(1024));
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(resources, "icon.icns")]);
  rmSync(iconset, { recursive: true, force: true });
  console.log("wrote resources/icon.png and resources/icon.icns");
}
gpu.dispose();
