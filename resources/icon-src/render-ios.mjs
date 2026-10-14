// Render Realm's app icon for the iPhone, from the same vector the Mac's is drawn from.
//
//   cd resources/icon-src && node render-ios.mjs                 # write the app's icon set
//   cd resources/icon-src && node render-ios.mjs --preview dir   # also lay each one under iOS's mask
//
// iOS draws an app icon from one full-bleed 1024 px square: no transparency, no body, no shadow and
// no margin — the system cuts the corners and lays its own edge and depth over it. So this is the
// macOS icon's ground and mark (icons.mjs, mark.mjs) re-proportioned onto that square: the Mac's
// 824 px body becomes the whole canvas, and the mark is scaled with it, so it holds the same share
// of the icon on both. The numbers are read from iconSvg's own output rather than restated here, so
// the phone follows the Mac when the Mac's icon changes.
//
// Three appearances, as an iOS asset catalog takes them:
// - any: the default colouring, opaque. App Store icons may carry no alpha channel, so the PNG is
//   written as plain RGB.
// - dark: Realm's icon is already a dark ground with a light mark, so the dark face is the same
//   drawing; giving it explicitly stops iOS darkening it a second time.
// - tinted: the mark alone in grey, on transparency. iOS reads its luminance and lays the person's
//   tint over its own dark ground. The mark keeps its three faces as three greys (a shaded mark its lit
//   doorway as white too); a shadow is left out, since a tinted icon is a luminance map and a shadow
//   there reads as a smudge.
//
// Rendering is headless Chrome over DevTools, as render.mjs does it; the pixels come back from a
// canvas so they can be written without an alpha channel.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { ICONS, iconSvg } from "./icons.mjs";
import { MARK, MARK_BOX, markLayer, planesLayer } from "./mark.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const ICONSET = join(here, "../../apps/ios/Realm/Assets.xcassets/AppIcon.appiconset");
const chrome = process.env.REALM_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.REALM_ICON_CDP_PORT ?? 9875);
const SIZE = 1024;

const num = (n) => (Math.abs(n) < 5e-5 ? "0" : n.toFixed(4).replace(/\.?0+$/, ""));
const stops = (colors) => colors.map((c, i) => `<stop offset="${colors.length === 1 ? 0 : i / (colors.length - 1)}" stop-color="${c}"/>`).join("");

/** The Mac icon's grid, read off its own SVG: where the body runs, the mark's scale, and its lift —
 *  which only a shaded mark has, since a flat mark lifted off its body is no longer flat. */
export function macGrid(icon = ICONS.find((i) => i.id === "default")) {
  const svg = iconSvg(icon);
  const read = (re, what) => {
    const m = svg.match(re);
    if (!m) throw new Error(`icons.mjs no longer draws ${what} the way render-ios.mjs reads it`);
    return m.slice(1).map(Number);
  };
  const [top, bottom] = read(/<linearGradient id="ground" x1="[\d.]+" y1="([\d.]+)" x2="[\d.]+" y2="([\d.]+)"/, "its ground");
  const [scale] = read(/<g transform="translate\([\d. -]+\) scale\(([\d.]+)\)">/, "its mark");
  if (!icon.lift) return { body: bottom - top, scale, lift: null };
  const [blur] = read(/<filter id="lift"[^>]*><feGaussianBlur stdDeviation="([\d.]+)"\/>/, "the mark's lift");
  const [dy] = read(/transform="translate\(0 ([\d.]+)\)" filter="url\(#lift\)"/, "the mark's lift");
  return { body: bottom - top, scale, lift: { dy, blur } };
}

/** Grey of the same luminance as a colour, for the tinted face. */
function grey(hex) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16)));
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const v = Math.round((y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055) * 255);
  return `#${v.toString(16).padStart(2, "0").repeat(3)}`;
}

const greyTones = (tones) => Object.fromEntries(Object.entries(tones).map(([k, v]) => [k, Array.isArray(v) ? v.map(grey) : grey(v)]));

/** One icon as the iPhone's full-bleed square. */
export function iosIconSvg(icon, { tinted = false } = {}) {
  const grid = macGrid(icon);
  const scale = grid.scale * (SIZE / grid.body);
  const tx = SIZE / 2 - (MARK_BOX.width / 2) * scale;
  const ty = SIZE / 2 - (MARK_BOX.height / 2) * scale;
  const mark = icon.planes
    ? planesLayer(tinted ? greyTones(icon.planes) : icon.planes, "mark-")
    : markLayer(tinted ? greyTones(icon.mark) : icon.mark, "mark-");
  const [liftColor, liftOpacity] = icon.lift ?? [];
  const angle = ((icon.angle ?? 0) * Math.PI) / 180;
  const dx = (Math.sin(angle) * SIZE) / 2, dy = (Math.cos(angle) * SIZE) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<defs>
<linearGradient id="ground" x1="${num(SIZE / 2 - dx)}" y1="${num(SIZE / 2 - dy)}" x2="${num(SIZE / 2 + dx)}" y2="${num(SIZE / 2 + dy)}" gradientUnits="userSpaceOnUse">${stops(icon.ground)}</linearGradient>
${grid.lift ? `<filter id="lift" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="${grid.lift.blur}"/></filter>` : ""}
${mark.defs.join("\n")}
</defs>
${tinted ? "" : `<rect width="${SIZE}" height="${SIZE}" fill="url(#ground)"/>`}
<g transform="translate(${num(tx)} ${num(ty)}) scale(${num(scale)})">
${tinted || !grid.lift ? "" : `<path d="${MARK.silhouette}" fill="${liftColor}" fill-opacity="${liftOpacity}" transform="translate(0 ${grid.lift.dy})" filter="url(#lift)"/>`}
${mark.body.join("\n")}
</g>
</svg>
`;
}

/** iOS's own mask for a preview: the continuous corner at the radius the Home Screen draws. */
const maskSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" rx="${0.2237 * SIZE}" fill="#000"/></svg>`;

/** A PNG from 8-bit RGBA pixels: plain RGB when `alpha` is false. */
export function png(rgba, width, height, { alpha }) {
  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * channels + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4, to = row + 1 + x * channels;
      for (let c = 0; c < channels; c++) raw[to + c] = rgba[from + c];
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A headless Chrome page that rasterizes SVG into a canvas and hands back its pixels. */
async function openChrome() {
  const profile = mkdtempSync(join(tmpdir(), "realm-ios-icon-"));
  const child = spawn(chrome, [
    "--headless=new", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--no-first-run",
    "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--disable-extensions", "--force-color-profile=srgb", "about:blank",
  ], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 200 && !target; i++) {
    await sleep(100);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page"); } catch { /* not up yet */ }
  }
  if (!target) throw new Error(`Chrome did not open DevTools on ${PORT}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id) pending.get(msg.id)?.(msg); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  /** `layers` are drawn in order; a layer with `mask` keeps only what is under it. */
  const pixels = async (layers) => {
    const expression = `(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = ${SIZE}; canvas.height = ${SIZE};
      const ctx = canvas.getContext("2d", { colorSpace: "srgb" });
      for (const layer of ${JSON.stringify(layers)}) {
        const img = new Image();
        img.src = URL.createObjectURL(new Blob([layer.svg], { type: "image/svg+xml" }));
        await img.decode();
        ctx.globalCompositeOperation = layer.mask ? "destination-in" : "source-over";
        ctx.drawImage(img, 0, 0, ${SIZE}, ${SIZE});
      }
      const data = ctx.getImageData(0, 0, ${SIZE}, ${SIZE}).data;
      let bin = "";
      for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return btoa(bin);
    })()`;
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return Buffer.from(result.value, "base64");
  };
  const close = async () => {
    ws.close();
    child.kill("SIGKILL");
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)));
    rmSync(profile, { recursive: true, force: true });
  };
  return { pixels, close };
}

const CONTENTS = {
  images: [
    { filename: "AppIcon.png", idiom: "universal", platform: "ios", size: "1024x1024" },
    { appearances: [{ appearance: "luminosity", value: "dark" }], filename: "AppIcon-Dark.png", idiom: "universal", platform: "ios", size: "1024x1024" },
    { appearances: [{ appearance: "luminosity", value: "tinted" }], filename: "AppIcon-Tinted.png", idiom: "universal", platform: "ios", size: "1024x1024" },
  ],
  info: { author: "xcode", version: 1 },
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const icon = ICONS.find((i) => i.id === "default");
  const browser = await openChrome();
  try {
    mkdirSync(ICONSET, { recursive: true });
    const full = iosIconSvg(icon);
    const tinted = iosIconSvg(icon, { tinted: true });
    const opaque = await browser.pixels([{ svg: full }]);
    for (let i = 3; i < opaque.length; i += 4) if (opaque[i] !== 255) throw new Error("the full-bleed icon has a transparent pixel");
    writeFileSync(join(ICONSET, "AppIcon.png"), png(opaque, SIZE, SIZE, { alpha: false }));
    writeFileSync(join(ICONSET, "AppIcon-Dark.png"), png(opaque, SIZE, SIZE, { alpha: false }));
    writeFileSync(join(ICONSET, "AppIcon-Tinted.png"), png(await browser.pixels([{ svg: tinted }]), SIZE, SIZE, { alpha: true }));
    writeFileSync(join(ICONSET, "Contents.json"), `${JSON.stringify(CONTENTS, null, 2)}\n`);
    console.log("wrote AppIcon.png, AppIcon-Dark.png, AppIcon-Tinted.png and Contents.json");
    const previewAt = process.argv.indexOf("--preview");
    if (previewAt !== -1) {
      const dir = process.argv[previewAt + 1] ?? "ios-preview";
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "masked.png"), png(await browser.pixels([{ svg: full }, { svg: maskSvg(), mask: true }]), SIZE, SIZE, { alpha: true }));
      writeFileSync(join(dir, "full.svg"), full);
      console.log(`wrote ${dir}/masked.png and full.svg`);
    }
  } finally {
    await browser.close();
  }
}
