/**
 * Renders the teammate icons: every shape in every colour at 16, 24 and 64px, the sizes between, a
 * sidebar's worth of rows, and the Lead's badge — in both faces, as PNGs a person can look at (run with:
 * node apps/desktop/scripts/teammate-icon-gallery.mjs <out-dir>).
 *
 * The component is loaded through Vite's SSR loader straight from packages/ui and drawn with the
 * desktop app's own React, so what is pictured is the source as it stands, not a build. Grounds are
 * Realm's seed through `deriveVars`, the same values the app writes on its root, and `color-scheme`
 * is set from the face as the app's tokens set it, which is what the icons' `light-dark()` reads.
 * Headless Chrome shoots each page at 2x, and `--1x` adds a 1x page for judging the row sizes as a
 * non-Retina screen draws them.
 *
 * Touches only <out-dir> and a temp profile; kills only the Chrome it started.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "teammate-icon-gallery"));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
fs.mkdirSync(out, { recursive: true });

const vite = await createServer({
  root: repoRoot, configFile: false, logLevel: "error", appType: "custom", server: { middlewareMode: true }, esbuild: { jsx: "automatic" },
});
let I, T;
try {
  I = await vite.ssrLoadModule("/packages/ui/src/teammate-icon/index.ts");
  T = await vite.ssrLoadModule("/packages/ui/src/themes.ts");
} finally {
  await vite.close();
}
const desktopRequire = createRequire(path.join(repoRoot, "apps/desktop/package.json"));
const React = desktopRequire("react");
const Server = desktopRequire("react-dom/server");

const SHAPES = Object.keys(I.TEAMMATE_SHAPES);
const COLORS = Object.keys(I.TEAMMATE_COLORS);
const icon = (shape, color, size, lead = false) =>
  Server.renderToStaticMarkup(React.createElement(I.TeammateIcon, { icon: { shape, color }, size, lead }));

function page(mode, title, body) {
  const vars = T.deriveVars(T.REALM_SEED[mode], mode);
  const root = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";");
  return `<!doctype html><html data-mode="${mode}"><head><meta charset="utf-8"><title>${title}</title><style>
:root{${root};color-scheme:${mode}}
body{margin:0;padding:28px 32px;background:var(--canvas);color:var(--ink);font:13px/16px -apple-system,Inter,sans-serif}
h1{font-size:18px;font-weight:560;margin:0 0 4px}
h2{font-size:14px;font-weight:560;margin:22px 0 10px;color:var(--ink-2)}
p{margin:0 0 14px;color:var(--ink-2)}
.grid{display:grid;gap:10px 8px}
.cell{display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px 4px}
.row{display:flex;align-items:center;gap:10px}
.lab{font-size:11px;line-height:14px;color:var(--ink-3);text-align:center}
.side{display:flex;gap:16px}
.side>div{flex:1;padding:12px 8px;border-radius:12px}
.srow{display:flex;align-items:center;gap:8px;height:28px;padding:0 10px;border-radius:8px;font-size:14px;color:var(--ink)}
.srow.lit{background:var(--hover-2)}
.srow .dot{margin-left:auto;width:6px;height:6px;border-radius:50%;background:var(--accent)}
</style></head><body>${body}</body></html>`;
}

/** Every shape × colour, at the three sizes the app draws: the 64 maker, the 24 head and the 16 row. */
function setPage(mode) {
  const head = `<div></div>${COLORS.map((c) => `<div class="lab">${I.TEAMMATE_COLORS[c].label}</div>`).join("")}`;
  const rows = SHAPES.map((shape) => `<div class="lab" style="align-self:center;text-align:right">${I.TEAMMATE_SHAPES[shape]}</div>${
    COLORS.map((color) => `<div class="cell">${icon(shape, color, 64)}<div class="row">${icon(shape, color, 24)}${icon(shape, color, 16)}</div></div>`).join("")}`).join("");
  return page(mode, "set", `<h1>Teammate icons · 8 shapes × 12 colours</h1><p>64, 24 and 16px on the canvas.</p>
<div class="grid" style="grid-template-columns:90px repeat(12,minmax(0,1fr))">${head}${rows}</div>`);
}

/** One shape per colour at every size the brief names, and the Lead's badge on each shape. */
function sizesPage(mode) {
  const sizes = [16, 20, 24, 32, 64];
  const rows = SHAPES.map((shape, i) => {
    const color = COLORS[(i * 5) % COLORS.length];
    return `<div class="row" style="gap:18px;margin-bottom:14px"><span class="lab" style="width:90px;text-align:right">${I.TEAMMATE_SHAPES[shape]}</span>${
      sizes.map((s) => icon(shape, color, s)).join("")}<span style="width:24px"></span>${sizes.map((s) => icon(shape, color, s, true)).join("")}</div>`;
  }).join("");
  return page(mode, "sizes", `<h1>16, 20, 24, 32, 64px · plain, then Lead</h1>${rows}`);
}

/** The icons where they will live: a sidebar's Team section on the page ground, one row lit. */
function rowsPage(mode) {
  const team = [
    ["Lead", "circle", "graphite", true], ["cto", "hexagon", "blue"], ["design engineer", "flower", "pink"],
    ["research", "cloud", "teal"], ["cleanup", "pill", "lime"], ["tpm", "squircle", "amber"], ["writer", "drop", "violet"], ["ops", "triangle", "orange"],
  ];
  const list = (lit) => team.map(([name, shape, color, lead], i) =>
    `<div class="srow${i === lit ? " lit" : ""}">${icon(shape, color, 16, !!lead)}<span>${name}</span>${i === 1 ? '<span class="dot"></span>' : ""}</div>`).join("");
  return page(mode, "rows", `<h1>In a sidebar</h1><div class="side"><div style="background:var(--page)">${list(2)}</div><div style="background:var(--canvas)">${list(-1)}</div><div style="background:var(--surface)">${list(5)}</div></div>`);
}

const pages = [["set", setPage, 1500, 1200], ["sizes", sizesPage, 900, 760], ["rows", rowsPage, 900, 420]];

function chrome(args, ms, profile) {
  return new Promise((resolve) => {
    const p = spawn(CHROME, args, { stdio: "ignore" });
    const t = setTimeout(() => p.kill("SIGKILL"), ms);
    p.on("exit", () => {
      clearTimeout(t);
      spawn("pkill", ["-f", profile], { stdio: "ignore" }).on("exit", () => resolve());
    });
  });
}

const scales = process.argv.includes("--1x") ? [2, 1] : [2];
for (const mode of ["dark", "light"]) {
  for (const [name, build, w, h] of pages) {
    const html = path.join(out, `${name}-${mode}.html`);
    fs.writeFileSync(html, build(mode));
    for (const scale of scales) {
      const png = path.join(out, `${name}-${mode}${scale === 1 ? "@1x" : ""}.png`);
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-icon-chrome-"));
      await chrome(["--headless=new", "--disable-gpu", "--hide-scrollbars", `--force-device-scale-factor=${scale}`, `--window-size=${w},${h}`,
        `--user-data-dir=${profile}`, "--no-first-run", "--virtual-time-budget=1000", `--screenshot=${png}`, `file://${html}`], 40_000, profile);
      fs.rmSync(profile, { recursive: true, force: true });
      console.log(png);
    }
  }
}
