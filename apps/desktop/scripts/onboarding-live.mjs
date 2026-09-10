/**
 * Live check for the first-run sheet's two columns (run with: node apps/desktop/scripts/onboarding-live.mjs)
 *
 * Onboarding is two columns that fold into one, and jsdom has no layout — it will tell you the two
 * fieldsets exist and nothing at all about whether they are beside each other, whether either one
 * fits, or where the Start button ended up. Those are the only questions this screen raises.
 *
 * It boots the built app on a scratch home, which lands straight on the sheet (no spaces exist), and
 * measures at a wide window and a very narrow one, in both faces. It waits for the agent PROBE to
 * land first: before it does, the list is all thirteen kinds, which is not the state a real machine
 * sits in and not the one worth reviewing.
 *
 * What it caught, and would catch again: `minmax(248px, 1fr)` reads like a hint and is a FLOOR, so
 * the columns kept their 248px in a 191px sheet and hung out of it — visible only at a width where
 * the sidebar leaves the stage barely wider than one column.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9381), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8947);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-divider-audit-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function portFree(port) {
  return new Promise((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(true));
  });
}

async function until(fn, ms, tag) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(150);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return {
    ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** Raw pixels of a clip, as [y][x] RGB triples. The reduction is done in node, per sample point,
 *  because averaging ALONG a divider is what made the first version of this script cry wolf: one
 *  icon sitting against the line pulled the neighbour's mean up to the line's own value. */
const PIXELS = (b64) => `(async () => {
  const img = new Image();
  img.src = "data:image/png;base64," + ${JSON.stringify(b64)};
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const rows = [];
  for (let y = 0; y < cv.height; y++) {
    const row = [];
    for (let x = 0; x < cv.width; x++) { const i = (y * cv.width + x) * 4; row.push([d[i], d[i+1], d[i+2]]); }
    rows.push(row);
  }
  return rows;
})()`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} in use`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  electron = spawn(path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), [wrapper], {
    env: { ...process.env, REALM_HOME: path.join(scratch, "home"), REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["ignore", "pipe", "pipe"] });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const t = await until(async () => (await targets()).find((x) => x.type === "page" && x.url.startsWith("file://")), 30000, "renderer");
  const c = cdp(t.webSocketDebuggerUrl); await c.ready;
  await c.send("Runtime.enable"); await c.send("Page.enable");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding')`), 20000, "onboarding");
  // Wait for the probe to actually LAND — the pre-probe state lists all thirteen kinds, which is not
  // the state a real machine sits in and not the one worth reviewing.
  await until(() => evalIn(c, `!document.body.textContent.includes('Checking which agents are installed')`), 30000, "probe");
  await sleep(600);

  const GEO = `(() => {
    const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect();
      return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) }; };
    const cols = [...document.querySelectorAll('.onboarding-col')].map((e) => { const r = e.getBoundingClientRect();
      return { legend: e.querySelector('legend')?.textContent, x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.h?.toFixed?.(1) ?? +r.height.toFixed(1) }; });
    const body = document.querySelector('.onboarding-body');
    return { sheet: box('.sheet.onboarding'), cols, foot: box('.sheet-foot'),
             scrolls: body ? body.scrollHeight > body.clientHeight + 1 : null,
             focused: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName,
             rows: document.querySelectorAll('.onboarding-col .cli-row').length,
             fold: document.querySelector('.onboarding-more')?.textContent?.trim() ?? null,
             swatches: document.querySelectorAll('.onboarding-space .swatch').length,
             iconTrigger: !!document.querySelector('.onboarding-space .icon-picker-trigger') };
  })()`;

  const shot = async (name, clipEl) => {
    const b = await evalIn(c, `(() => { const e = document.querySelector(${JSON.stringify(clipEl)}); const r = e.getBoundingClientRect();
      return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: r.height + 24 }; })()`);
    const png = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip: { ...b, scale: 2 } });
    fs.writeFileSync(`/tmp/onboarding-${name}.png`, Buffer.from(png.data, "base64"));
  };

  for (const [label, w, h] of [["wide", 1200, 860], ["narrow", 520, 860]]) {
    await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false });
    await sleep(500);
    for (const mode of ["dark", "light"]) {
      await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(mode)}; return true; })()`);
      await sleep(300);
      const g = await evalIn(c, GEO);
      await shot(`${label}-${mode}`, ".sheet.onboarding");
      if (mode === "dark") {
        const [a, sp] = g.cols;
        const sideBySide = a && sp && Math.abs(a.y - sp.y) < 2 && sp.x > a.x + a.w - 2;
        const stacked = a && sp && sp.y > a.y + 2 && Math.abs(a.x - sp.x) < 2;
        console.log(`${label} ${w}x${h}: sheet ${g.sheet.w}x${g.sheet.h}  cols=${JSON.stringify(g.cols.map((x) => [x.legend, x.x, x.y, x.w]))}`);
        console.log(`  scrolls=${g.scrolls}  focus=${g.focused}  agentRows=${g.rows}  fold=${JSON.stringify(g.fold)}`);
        if (label === "wide") {
          check("wide: the two columns sit side by side, agent left", sideBySide, g.cols);
          check("wide: the agent column is the left one", g.cols[0]?.legend === "Agent" && g.cols[0].x < g.cols[1].x, g.cols.map((x) => x.legend));
          // Not "nothing scrolls" — with no agent installed the list is all thirteen kinds and the
          // body is SUPPOSED to scroll. The invariant is the one the sheet was built around: the
          // decision lives outside the scroller, so Start is on screen whatever the list does.
          check("wide: Start stays out of the scroller and on screen", g.foot.bottom <= g.sheet.bottom + 1 && g.foot.h > 0, { foot: g.foot, sheet: g.sheet });
        } else {
          check("narrow: the columns fold into one, in source order", stacked, g.cols);
        }
        check(`${label}: focus lands in the name field`, g.focused === "Space name", g.focused);
        check(`${label}: the identity controls are both there`, g.swatches === 10 && g.iconTrigger, { swatches: g.swatches, iconPicker: g.iconTrigger });
        check(`${label}: nothing overflows the sheet`, g.cols.every((x) => x.x >= g.sheet.x - 1 && x.x + x.w <= g.sheet.right + 1), { sheet: g.sheet, cols: g.cols });
      }
    }
  }
  await c.send("Emulation.clearDeviceMetricsOverride");
  console.log("wrote /tmp/onboarding-{wide,narrow}-{dark,light}.png");
  c.close();
}
main().catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(() => { electron?.kill(); fs.rmSync(scratch, { recursive: true, force: true }); });
