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
import { createRequire } from "node:module";
import { createServer } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "realmite-gallery"));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
fs.mkdirSync(out, { recursive: true });

const vite = await createServer({
  root: repoRoot, configFile: false, logLevel: "error", appType: "custom", server: { middlewareMode: true }, esbuild: { jsx: "automatic" },
});
let R, T, M, React, Server;
try {
  R = await vite.ssrLoadModule("/packages/ui/src/realmite/index.ts");
  T = await vite.ssrLoadModule("/packages/ui/src/themes.ts");
  M = await vite.ssrLoadModule("/apps/desktop/src/renderer/src/components/RealmiteMaker.tsx");
} finally {
  await vite.close();
}
// The desktop app's own React, which is the copy the SSR-loaded maker resolves to as well.
const desktopRequire = createRequire(path.join(repoRoot, "apps/desktop/package.json"));
React = desktopRequire("react");
Server = desktopRequire("react-dom/server");

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

/** The maker as it would sit in a sheet, drawn by React from the real component with the app's own
 *  stylesheet linked in (no paint worklet here, so its squircles fall back to plain rounding). */
function makerPage(mode) {
  const css = ["theme/tokens.css", "styles.css"].map((f) => `<link rel="stylesheet" href="file://${path.join(repoRoot, "apps/desktop/src/renderer/src", f)}">`).join("");
  const maker = (seed, name) => Server.renderToStaticMarkup(React.createElement(M.RealmiteMaker, { spec: R.realmiteFromSeed(seed), name, onChange() {} }));
  return page(mode, "maker", `${css}<h1>Realmite maker</h1><p>What a person sees making a team role. Every choice is the creature with that part on.</p>
<div style="display:flex;flex-direction:column;gap:16px">
<div style="background:var(--surface);border-radius:16px;padding:20px 24px">${maker("role-12", "Creator Manager")}</div>
<div style="background:var(--surface);border-radius:16px;padding:20px 24px">${maker("role-21", "Content Producer")}</div></div>`);
}

const pages = [
  ["sizes", sizesPage, 1500, 940],
  ["hero", heroPage, 1700, 1700],
  ["states", statesPage, 1500, 1330],
  ["parts", partsPage, 1500, 1240],
  ["maker", makerPage, 1100, 1060],
];

/** Headless Chrome with its own profile; when it is done, or past `ms`, everything that profile
 *  started goes with it — killing the browser alone leaves its helpers running. */
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

for (const mode of ["dark", "light"]) {
  for (const [name, build, w, h] of pages) {
    const html = path.join(out, `${name}-${mode}.html`);
    fs.writeFileSync(html, build(mode));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "realmite-chrome-"));
    await chrome(["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2", `--window-size=${w},${h}`,
      `--user-data-dir=${profile}`, "--no-first-run", "--force-prefers-reduced-motion", "--virtual-time-budget=1500",
      `--screenshot=${path.join(out, `${name}-${mode}.png`)}`, `file://${html}`], 40_000, profile);
    fs.rmSync(profile, { recursive: true, force: true });
    console.log(path.join(out, `${name}-${mode}.png`));
  }
}

/* ── --motion: the loops run, and Reduce motion stops every one ─────────────
   Loads the states page in a Chrome this script starts, counts the running animations over CDP,
   then emulates prefers-reduced-motion and counts again. The mutant is the page with the media
   rule stripped out, which must still be animating under the same emulation. */
if (process.argv.includes("--motion")) {
  const port = Number(process.env.REALMITE_CDP_PORT ?? 9246);
  const statesHtml = fs.readFileSync(path.join(out, "states-dark.html"), "utf8");
  const mutant = path.join(out, "motion-mutant.html");
  fs.writeFileSync(mutant, statesHtml.replace(/@media \(prefers-reduced-motion:reduce\)\{[^}]*\}\}/, ""));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "realmite-cdp-"));
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  const killer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await new Promise((r) => setTimeout(r, 200));
      target = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => null);
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let id = 0;
    const send = (method, params = {}) => new Promise((resolve) => {
      const me = ++id;
      const on = (e) => { const m = JSON.parse(e.data); if (m.id === me) { ws.removeEventListener("message", on); resolve(m.result); } };
      ws.addEventListener("message", on);
      ws.send(JSON.stringify({ id: me, method, params }));
    });
    const count = async (file, reduce) => {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] });
      await send("Page.navigate", { url: `file://${file}` });
      await new Promise((r) => setTimeout(r, 800));
      const r = await send("Runtime.evaluate", { expression: "document.getAnimations().filter(a => a.playState === 'running').length", returnByValue: true });
      return r.result.value;
    };
    const statesFile = path.join(out, "states-dark.html");
    const free = await count(statesFile, false), reduced = await count(statesFile, true), mutated = await count(mutant, true);
    console.log(`running animations — no preference: ${free}; reduced motion: ${reduced}; mutant (rule removed) under reduced motion: ${mutated}`);
    ws.close();
    if (!(free > 0 && reduced === 0 && mutated > 0)) process.exitCode = 1;
  } finally {
    clearTimeout(killer);
    proc.kill("SIGKILL");
    spawn("pkill", ["-f", profile], { stdio: "ignore" });
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
