/**
 * Renders the Realmite gallery: 48 seeds at every size and state, every part on one base, in both
 * faces, as PNGs a person can look at (run with: node apps/desktop/scripts/realmite-gallery.mjs <out-dir>).
 *
 * The drawing is loaded through Vite's SSR loader straight from packages/ui, so what is pictured is
 * the source as it stands, not a build. Grounds and the state colours are Realm's seed through `deriveVars`,
 * the same values the app writes on its root. Pages are shot by headless Chrome with reduced motion
 * forced, so every Realmite is in its still pose; `--motion` additionally measures, over CDP, that the
 * loops run without the preference and that none run with it.
 *
 * Touches only <out-dir> and a temp profile; kills only the Chrome it started.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "realmite-gallery"));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
fs.mkdirSync(out, { recursive: true });

const vite = await createServer({ root: repoRoot, configFile: false, logLevel: "error", appType: "custom", server: { middlewareMode: true } });
let R, T;
try {
  R = await vite.ssrLoadModule("/packages/ui/src/realmite/index.ts");
  T = await vite.ssrLoadModule("/packages/ui/src/themes.ts");
} finally {
  await vite.close();
}

const SEEDS = Array.from({ length: 48 }, (_, i) => `role-${i + 1}`);
let uid = 0;
const svg = (spec, size, state = "idle") => R.realmiteSvg(spec, { size, state, uid: `g${uid++}` });
const label = (s) => `<span class="lab">${s}</span>`;

function page(mode, title, body) {
  const vars = T.deriveVars(T.REALM_SEED[mode], mode);
  const root = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";");
  return `<!doctype html><html data-mode="${mode}"><head><meta charset="utf-8"><title>${title}</title><style>
:root{${root}}
body{margin:0;padding:28px 32px;background:var(--canvas);color:var(--ink);font:13px/16px -apple-system,Inter,sans-serif}
h1{font-size:18px;font-weight:560;margin:0 0 4px}
h2{font-size:14px;font-weight:560;margin:22px 0 10px;color:var(--ink-2)}
p{margin:0 0 14px;color:var(--ink-2)}
.grid{display:grid;gap:14px 10px;grid-auto-columns:minmax(0,1fr)}
.grid>*{min-width:0}
.cell{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 4px;border-radius:12px;background:var(--surface)}
.cell.page{background:var(--page)}
.row{display:flex;align-items:flex-end;gap:10px}
.lab{font-size:11px;line-height:14px;color:var(--ink-3);text-align:center;max-width:170px}
.side{display:flex;gap:12px}
.side>div{flex:1;padding:14px;border-radius:12px}
.sidebar-row{display:flex;align-items:center;gap:8px;height:28px;padding:0 10px;border-radius:8px;font-size:14px}
${R.REALMITE_CSS}
</style></head><body>${body}</body></html>`;
}

function sizesPage(mode) {
  const cells = SEEDS.map((seed) => {
    const spec = R.realmiteFromSeed(seed);
    return `<div class="cell"><div class="row">${svg(spec, 16)}${svg(spec, 24)}${svg(spec, 48)}</div>${label(seed)}</div>`;
  }).join("");
  return page(mode, "sizes", `<h1>48 seeds · 16, 24 and 48px</h1><p>Idle, still pose, on the surface ground.</p><div class="grid" style="grid-template-columns:repeat(8,minmax(0,1fr))">${cells}</div>`);
}

function heroPage(mode) {
  const cells = SEEDS.map((seed) => {
    const spec = R.realmiteFromSeed(seed);
    return `<div class="cell page">${svg(spec, 160)}${label(`${seed} · ${spec.body} ${spec.palette} ${spec.eyes} ${spec.mouth} ${spec.accessory} ${spec.pattern}${spec.cheeks ? " cheeks" : ""}`)}</div>`;
  }).join("");
  return page(mode, "hero", `<h1>48 seeds · 160px</h1><div class="grid" style="grid-template-columns:repeat(8,minmax(0,1fr))">${cells}</div>`);
}

function statesPage(mode) {
  const rows = SEEDS.slice(0, 12).map((seed) => {
    const spec = R.realmiteFromSeed(seed);
    return R.REALMITE_STATES.map((st) => `<div class="cell">${svg(spec, 96, st)}<div class="row">${svg(spec, 48, st)}${svg(spec, 24, st)}${svg(spec, 16, st)}</div>${label(`${seed} · ${st}`)}</div>`).join("");
  }).join("");
  return page(mode, "states", `<h1>States · idle, working, needs you, sleeping</h1><p>The still pose each state holds under Reduce motion; 96, 48, 24 and 16px.</p><div class="grid" style="grid-template-columns:repeat(8,minmax(0,1fr))">${rows}</div>`);
}

function partsPage(mode) {
  const base = R.realmiteFromSeed("parts-base");
  const groups = [
    ["body", R.BODIES], ["palette", R.PALETTES], ["eyes", R.EYES], ["mouth", R.MOUTHS], ["accessory", R.ACCESSORIES], ["pattern", R.PATTERNS],
  ].map(([part, table]) => {
    const cells = Object.entries(table).map(([id, def]) => {
      const spec = R.customize(base, { [part]: id, ...(part === "pattern" ? { accessory: "none" } : {}) });
      return `<div class="cell">${svg(spec, 80)}<div class="row">${svg(spec, 24)}${svg(spec, 16)}</div>${label(typeof def === "string" ? def : def.label)}</div>`;
    }).join("");
    return `<h2>${part}</h2><div class="grid" style="grid-template-columns:repeat(12,minmax(0,1fr))">${cells}</div>`;
  }).join("");
  return page(mode, "parts", `<h1>Every part on one base</h1>${groups}`);
}

const pages = [
  ["sizes", sizesPage, 1500, 940],
  ["hero", heroPage, 1700, 1700],
  ["states", statesPage, 1500, 1330],
  ["parts", partsPage, 1500, 1240],
];

function chrome(args, ms) {
  return new Promise((resolve) => {
    const p = spawn(CHROME, args, { stdio: "ignore" });
    const t = setTimeout(() => p.kill("SIGKILL"), ms);
    p.on("exit", () => { clearTimeout(t); resolve(); });
  });
}

for (const mode of ["dark", "light"]) {
  for (const [name, build, w, h] of pages) {
    const html = path.join(out, `${name}-${mode}.html`);
    fs.writeFileSync(html, build(mode));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "realmite-chrome-"));
    await chrome(["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2", `--window-size=${w},${h}`,
      `--user-data-dir=${profile}`, "--no-first-run", "--force-prefers-reduced-motion", "--virtual-time-budget=1500",
      `--screenshot=${path.join(out, `${name}-${mode}.png`)}`, `file://${html}`], 40_000);
    fs.rmSync(profile, { recursive: true, force: true });
    console.log(path.join(out, `${name}-${mode}.png`));
  }
}
