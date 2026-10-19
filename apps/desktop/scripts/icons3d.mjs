/**
 * Turns the team's 3D icon renders into what the app ships: each one lifted off its white ground,
 * trimmed, centred on a square and written as WebP at every size `Icon3D` draws, at 1x, 2x and 3x.
 *
 *   pnpm --filter @realm/desktop exec electron scripts/icons3d.mjs --from <folder of renders>
 *   … --only review,vault          # just these
 *   … --sheet <file.png>           # also a contact sheet: every icon on dark, mid and light ground
 *
 * The renders are made from a prompt rather than drawn, so a render is regenerated, never edited:
 * the style every one of them shares and the object each one shows are in ICONS below, and a render
 * named `<name>.png` in the folder becomes `assets/icons3d/<name>-<px>.webp`. They are asked for on a
 * flat white ground with no shadow — the app draws one contact shadow under all of them — and the
 * cut is `lib/icons3d-matte.mjs`.
 *
 * It runs under Electron because Chromium decodes and encodes WebP and Node does not: one hidden
 * window does the decoding and the encoding, and the pixels in between are worked in Node.
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cutFromGround, shrink, squareAround } from "./lib/icons3d-matte.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, "../src/renderer/src/assets/icons3d");

/** The sizes `Icon3D` draws (its SIZES), and the densities each is shipped at. */
const RUNGS = [20, 32, 64];
const DENSITIES = [1, 2, 3];
const PIXELS = [...new Set(RUNGS.flatMap((r) => DENSITIES.map((d) => r * d)))].sort((a, b) => a - b);
/** Lossy colour, lossless alpha (Chromium's WebP keeps alpha exact), which is where a fringe would show. */
const QUALITY = 0.9;

const STYLE = "A single small 3D object rendered as a soft, tactile, toy-like app icon, in the spirit of Airbnb's 2025 dimensional icons. "
  + "Material: smooth matte-satin clay-like plastic with a gentle sheen; every edge generously rounded and bevelled, no sharp corners, no surface texture, no outlines, no line art. "
  + "Camera: three-quarter view from slightly above (about 30° down), the object turned about 30° to the left, a long lens with almost no perspective distortion; the object upright, centred, and filling about 70% of the frame with an even margin on every side. "
  + "Light: one large soft key light from the upper left, a faint fill from the right and a subtle rim light along the right edges; soft gradients, one gentle specular highlight on the upper-left surfaces, soft ambient occlusion where parts meet. "
  + "Palette, and only this palette: Realm blue for the main body (mid #4F8CF5, lit faces toward #9CC1FF, shaded faces toward #2457C4); warm cream #F3E6CC for paper and every light part (never white, never light grey); soft graphite #3A3F4B only for tiny details; at most one small butter-yellow #F5D37A accent, only where the object names it. Saturated but calm, not neon. "
  + "Background: plain flat pure white #FFFFFF, perfectly uniform from edge to edge — no floor, no ground plane, no cast shadow, no contact shadow, no reflection, no vignette, no gradient. "
  + "No text, no letters, no numbers, no logos, no faces, no people, no hands. Square image.";

/** Every icon: its file name and the object its render shows ("The object: …" after STYLE). */
const ICONS = [
  ["review", "a shallow rounded inbox tray in blue, holding one cream card that carries a raised blue check mark"],
  ["overview", "a small round table with a blue top and three rounded cream stools tucked in around it, nobody sitting"],
  ["records", "a small open card-file box in blue with a row of cream index cards standing in it, one card with a small butter-yellow tab"],
  ["policies", "a plump rounded shield, blue face with a thick soft cream rim"],
  ["vault", "a small rounded safe with a blue body, a round cream dial on its door and a short graphite handle"],
  ["activity", "a spiral-bound logbook lying slightly open, blue cover and cream pages, with a butter-yellow ribbon bookmark"],
  ["add-teammate", "a small empty cushioned chair in blue, with a round cream badge carrying a raised blue plus sign floating at its upper right"],
  ["custom-teammate", "a blank cream name badge on a short blue clip, with a short blue pencil resting across it"],
  ["note", "a small cream notepad with a blue top binding and three soft blue lines across the page, no writing"],
  ["link", "two rounded chain links interlocked, one blue and one cream"],
  ["contact", "a cream contact card standing slightly tilted, with a round blue disc on its left and two short blue bars beside it — no face, no writing"],
  ["briefcase", "a small rounded briefcase in blue with a cream handle and two tiny graphite clasps"],
  ["flag", "a small flag on a short blue pole set in a round blue base, the flag butter-yellow with a soft wave"],
  ["bug", "a small rounded beetle with a glossy blue shell, round cream spots on its back and tiny graphite legs"],
  ["browser", "a small rounded browser window standing upright: blue frame, cream screen, three tiny cream dots on its top bar"],
];

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };

/* ── the hidden window's half: bytes in, pixels out, and back ── */

const PAGE_HELPERS = `
  const toB64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b64) => { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
`;

async function decode(win, file) {
  const b64 = fs.readFileSync(file).toString("base64");
  const got = await win.webContents.executeJavaScript(`(async () => { ${PAGE_HELPERS}
    const bmp = await createImageBitmap(new Blob([fromB64(${JSON.stringify(b64)})]), { premultiplyAlpha: "none" });
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const g = canvas.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    return { width: bmp.width, height: bmp.height, b64: toB64(g.getImageData(0, 0, bmp.width, bmp.height).data) };
  })()`);
  return { width: got.width, height: got.height, data: new Uint8ClampedArray(Buffer.from(got.b64, "base64")) };
}

async function encode(win, img, type, quality) {
  const b64 = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).toString("base64");
  const got = await win.webContents.executeJavaScript(`(async () => { ${PAGE_HELPERS}
    const canvas = new OffscreenCanvas(${img.width}, ${img.height});
    canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(fromB64(${JSON.stringify(b64)}).buffer), ${img.width}, ${img.height}), 0, 0);
    const blob = await canvas.convertToBlob({ type: ${JSON.stringify(type)}, quality: ${quality} });
    return { type: blob.type, b64: toB64(new Uint8Array(await blob.arrayBuffer())) };
  })()`);
  if (got.type !== type) throw new Error(`this Chromium wrote ${got.type} when asked for ${type}`);
  return Buffer.from(got.b64, "base64");
}

/* ── the contact sheet: each icon at 64 and 20 (2x) on three grounds, to judge the cut ── */

const GROUNDS = [[24, 25, 28], [120, 122, 128], [246, 246, 248]];

function sheet(rows) {
  const cell = 160, gap = 8;
  const width = GROUNDS.length * cell, height = rows.length * (cell + gap);
  const data = new Uint8ClampedArray(width * height * 4);
  rows.forEach(({ large, small }, r) => {
    GROUNDS.forEach((ground, g) => {
      const x0 = g * cell, y0 = r * (cell + gap);
      for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
        const i = ((y0 + y) * width + x0 + x) * 4;
        data.set(ground, i); data[i + 3] = 255;
      }
      paint(data, width, large, x0 + 8, y0 + (cell - large.height) / 2);
      paint(data, width, small, x0 + 8 + large.width + 12, y0 + (cell - small.height) / 2);
    });
  });
  return { width, height, data };
}

function paint(data, width, img, left, top) {
  left = Math.round(left); top = Math.round(top);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const s = (y * img.width + x) * 4, d = ((top + y) * width + left + x) * 4;
    const a = img.data[s + 3] / 255;
    for (let k = 0; k < 3; k++) data[d + k] = img.data[s + k] * a + data[d + k] * (1 - a);
  }
}

/* ── run ── */

async function main() {
  const from = arg("--from") ?? process.env.ICONS3D_RENDERS;
  if (!from) throw new Error("say where the renders are: --from <folder>");
  const only = arg("--only")?.split(",");
  const wanted = ICONS.filter(([name]) => !only || only.includes(name));
  const missing = [];
  const rows = [];
  fs.mkdirSync(assets, { recursive: true });
  const win = new BrowserWindow({ show: false, focusable: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL("about:blank");
  for (const [name] of wanted) {
    const file = ["png", "jpg", "jpeg", "webp"].map((ext) => path.join(from, `${name}.${ext}`)).find((f) => fs.existsSync(f));
    if (!file) { missing.push(name); continue; }
    const square = squareAround(cutFromGround(await decode(win, file)));
    let bytes = 0;
    for (const px of PIXELS) {
      const webp = await encode(win, shrink(square, px), "image/webp", QUALITY);
      fs.writeFileSync(path.join(assets, `${name}-${px}.webp`), webp);
      bytes += webp.length;
    }
    rows.push({ name, large: shrink(square, 128), small: shrink(square, 40) });
    console.log(`${name}: ${square.width}px square → ${PIXELS.length} sizes, ${(bytes / 1024).toFixed(1)} KB`);
  }
  const sheetPath = arg("--sheet");
  if (sheetPath && rows.length) {
    fs.writeFileSync(sheetPath, await encode(win, sheet(rows), "image/png", 1));
    console.log(`sheet: ${sheetPath} (${rows.map((r) => r.name).join(", ")})`);
  }
  if (missing.length) console.log(`no render yet for: ${missing.join(", ")}`);
  win.destroy();
}

app.setActivationPolicy?.("accessory");
app.dock?.hide();
app.whenReady().then(main).then(() => app.quit(), (e) => { console.error(e); app.exit(1); });
