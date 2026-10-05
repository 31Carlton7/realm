// Render Realm's mark (mark.mjs) and every icon in icons.mjs into what Realm ships, then package the
// bundle's .icns.
//
//   cd resources/icon-src && node render.mjs                 # the shipped files
//   cd resources/icon-src && node render.mjs --sheet a.png   # every icon at 128 and 32 px, light and dark
//
// Writes resources/icon.png and resources/icon.icns from the default — the bundle's own icon, which
// stage-pack copies to build/ for electron-builder — and a 256 px picture of each icon into the
// renderer's assets, which Settings ▸ App draws and hands the Dock at run time (it never draws one
// larger than 256 px on a 2x display). And the mark wherever it is drawn as itself: mark.svg and
// mark-flat.svg here, the renderer's realm-mark.svg, and the boot mark inline in its index.html.
//
// Every size is rendered NATIVELY from the vector, never shrunk from a big one, so 16 px is drawn as
// 16 px. The rasterizer is headless Chrome driven over DevTools: Quick Look thumbnails are flattened
// onto white, and a screenshot through DevTools can be clipped to any size and keep its transparency,
// which Chrome's own --screenshot could do for neither (it hangs on a window smaller than its minimum,
// and writes the file and then never exits).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ICONS, iconSvg } from "./icons.mjs";
import { MARK_BOX, MARK_TONES, flatMarkSvg, markLayer, markSvg } from "./mark.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const resources = join(here, "..");
const renderer = join(here, "../../apps/desktop/src/renderer");
const runtime = join(renderer, "src/assets/app-icons");
const chrome = process.env.REALM_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome)) throw new Error(`No Chrome at ${chrome}; point REALM_CHROME at a Chromium binary`);

const PORT = Number(process.env.REALM_ICON_CDP_PORT ?? 9874);
/** The .icns an app carries: each point size at 1x and 2x. */
const ICNS = [16, 32, 128, 256, 512];
const RUNTIME_SIZE = 256;

const svgUrl = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const htmlUrl = (html) => `data:text/html;base64,${Buffer.from(html).toString("base64")}`;

/** A headless Chrome and one page in it, over DevTools. */
async function openChrome() {
  const profile = mkdtempSync(join(tmpdir(), "realm-icon-"));
  const child = spawn(chrome, [
    "--headless=new", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--disable-extensions", "--hide-scrollbars", "about:blank",
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
  const events = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id) pending.get(msg.id)?.(msg);
    else events.get(msg.method)?.();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send("Page.enable");
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });

  /** Load a page and take `width` × `height` of it from the top-left corner, as PNG bytes. */
  const shoot = async (html, width, height) => {
    await send("Emulation.setDeviceMetricsOverride", { width: Math.max(width, 64), height: Math.max(height, 64), deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise((resolve) => events.set("Page.loadEventFired", resolve));
    await send("Page.navigate", { url: htmlUrl(html) });
    await loaded;
    const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } });
    return Buffer.from(data, "base64");
  };
  const close = async () => {
    ws.close();
    child.kill("SIGKILL");
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)));
    rmSync(profile, { recursive: true, force: true });
  };
  return { shoot, close };
}

const page = (body, ground = "transparent") =>
  `<!doctype html><html><body style="margin:0;background:${ground}">${body}</body></html>`;
const img = (src, size) => `<img src="${src}" width="${size}" height="${size}" style="display:block">`;

/** One icon at exactly `size` px, transparent round its body. */
const renderAt = (browser, svg, size) => browser.shoot(page(img(svgUrl(svg), size)), size, size);

/** Every icon at 128 and 32 px, on a light ground and a dark one: the sizes a Dock and a menu draw. */
async function sheet(browser, file) {
  const row = (size) => `<div style="display:flex;gap:${size / 4}px;align-items:center">${ICONS.map((i) => img(svgUrl(iconSvg(i, { glass: true })), size)).join("")}</div>`;
  const half = (ground) => `<div style="background:${ground};padding:28px;display:flex;flex-direction:column;gap:20px">${row(128)}${row(32)}</div>`;
  const width = 56 + ICONS.length * 160 - 32, height = 2 * (56 + 128 + 20 + 32);
  writeFileSync(file, await browser.shoot(page(half("#ececf0") + half("#1e1f22")), width, height));
  console.log(`wrote ${file}`);
}

/**
 * The boot mark, inline in the renderer's index.html: it covers the gap before the bundle runs, so it
 * may fetch nothing. The page sweeps a highlight across it (`.boot-shine`), clipped to its silhouette.
 */
function bootMark() {
  const { defs, body } = markLayer(MARK_TONES, "b-");
  const shine = [
    '<linearGradient id="b-shine" x1="0" y1="0" x2="1" y2="0">',
    '  <stop offset="0" stop-color="#fff" stop-opacity="0"/>',
    '  <stop offset=".5" stop-color="#fff" stop-opacity=".72"/>',
    '  <stop offset="1" stop-color="#fff" stop-opacity="0"/>',
    "</linearGradient>",
  ];
  return [
    `<svg class="boot-mark" viewBox="0 0 ${MARK_BOX.width} ${MARK_BOX.height}" fill="none" xmlns="http://www.w3.org/2000/svg">`,
    "      <defs>", ...[...defs, ...shine].map((l) => `        ${l}`), "      </defs>",
    ...body.map((l) => `      ${l}`),
    '      <g clip-path="url(#b-silhouette)"><rect class="boot-shine" x="-44" y="-4" width="44" height="56" fill="url(#b-shine)"/></g>',
    "    </svg>",
  ].join("\n");
}

function writeMarks() {
  writeFileSync(join(here, "mark.svg"), markSvg());
  writeFileSync(join(here, "mark-flat.svg"), flatMarkSvg());
  writeFileSync(join(renderer, "src/assets/realm-mark.svg"), markSvg());
  const page = join(renderer, "index.html");
  const html = readFileSync(page, "utf8");
  const boot = /<svg class="boot-mark"[\s\S]*?<\/svg>/;
  if (!boot.test(html)) throw new Error(`no <svg class="boot-mark"> in ${page}`);
  writeFileSync(page, html.replace(boot, bootMark()));
  console.log("wrote mark.svg, mark-flat.svg, assets/realm-mark.svg and the boot mark in index.html");
}

const browser = await openChrome();
try {
  const sheetAt = process.argv.indexOf("--sheet");
  if (sheetAt !== -1) {
    await sheet(browser, process.argv[sheetAt + 1] ?? "sheet.png");
  } else {
    writeMarks();
    mkdirSync(runtime, { recursive: true });
    for (const icon of ICONS) {
      // Settings draws these and the Dock is handed them as they are, so they carry the glass edge
      // macOS would otherwise have drawn; the bundle's icon below leaves it to macOS.
      writeFileSync(join(runtime, `${icon.id}.png`), await renderAt(browser, iconSvg(icon, { glass: true }), RUNTIME_SIZE));
      console.log(`wrote assets/app-icons/${icon.id}.png`);
    }
    const scratch = mkdtempSync(join(tmpdir(), "realm-iconset-"));
    try {
      const iconset = join(scratch, "icon.iconset");
      mkdirSync(iconset);
      const svg = iconSvg(ICONS.find((i) => i.id === "default"));
      for (const pt of ICNS) {
        for (const scale of [1, 2]) {
          writeFileSync(join(iconset, `icon_${pt}x${pt}${scale === 2 ? "@2x" : ""}.png`), await renderAt(browser, svg, pt * scale));
        }
      }
      writeFileSync(join(resources, "icon.png"), await renderAt(browser, svg, 1024));
      execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(resources, "icon.icns")]);
      console.log("wrote resources/icon.png and resources/icon.icns");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
}
