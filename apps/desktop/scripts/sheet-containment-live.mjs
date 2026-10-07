/**
 * Live check: a Sheet must escape the containment of the pane that opened it.
 * (run with: node apps/desktop/scripts/sheet-containment-live.mjs)
 *
 * `.panel` and `.page` both declare `container-type: inline-size`. Container-type applies LAYOUT
 * CONTAINMENT, which makes the element a containing block for `position: fixed` descendants — and
 * `.panel` also sets `overflow: hidden`. A Sheet rendered in place therefore had its
 * `position: fixed; inset: 0` backdrop resolve against the PANE rather than the window: the scrim
 * dimmed one pane, the panel was clipped at the pane's edge, and the viewport coordinates
 * `centerOverComplement` returns were measured against the wrong origin.
 *
 * jsdom has no layout, so the unit test beside Sheet.tsx can only assert the DOM escape. This asserts
 * the GEOMETRY, in the real app, with getBoundingClientRect numbers:
 *
 *   1. the backdrop covers the whole window, not the page box it was opened from
 *   2. the sheet is centred on the WINDOW, and sits fully inside it (nothing clipped away)
 *   3. the sheet is not confined to its opener: the opener really is a containment box, so a
 *      backdrop that matched it would have been the bug
 *
 * Ports: 9225 (CDP), 8790 (realm-server), overridable via LIVE_CDP_PORT / LIVE_SERVER_PORT.
 * Refuses to run if either is taken.
 * Touches only a scratch dir (REALM_HOME + userData); kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Its own ports, overridable: 9223/8788 are what the other live checks and `run` use, and a peer
// instance holding them must not be killed to make room for this one.
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9225), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8790);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-sheet-containment-live-"));
const results = {};
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
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(150);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  return { ready, send, close: () => ws.close() };
}

const HELPERS = `
window.__live = window.__live ?? {
  rect(sel) { const el = document.querySelector(sel); if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; },
  setInput(el, value) {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  clickByText(sel, text) {
    const el = [...document.querySelectorAll(sel)].find((e) => (e.textContent || "").trim() === text);
    if (!el) return false; el.click(); return true;
  },
  clickContaining(sel, text) {
    const el = [...document.querySelectorAll(sel)].find((e) => (e.textContent || "").includes(text));
    if (!el) return false; el.click(); return true;
  },
  key(target, key, opts = {}) { (target ?? window).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts })); },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  results[name] = { pass: !!cond, ...(detail !== undefined ? { detail } : {}) };
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  // Own process group: the app spawns realm-server as a CHILD, and SIGTERM to the Electron pid alone
  // leaves that child holding the port — which then refuses the next run.
  electron = spawn(electronBin, [wrapper], {
    detached: true,
    env: {
      ...process.env,
      REALM_HOME: path.join(scratch, "home"),
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const t = await until(async () => (await targets()).find((x) => x.type === "page" && x.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(t.webSocketDebuggerUrl); client = c;
  await c.ready;
  await c.send("Runtime.enable");

  // Onboarding → first space.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.setInput(input, "Live");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.panel')`), 20000, "first pane");

  // Connections, the surface the bug was reported on.
  await evalIn(c, `__live.key(window, "k", { metaKey: true })`);
  await until(() => evalIn(c, `!!document.querySelector('.palette')`), 5000, "palette open");
  // Type the query first: the palette's default list is recents, and the page commands only surface
  // once something matches them.
  await evalIn(c, `(() => {
    const input = document.querySelector('.palette-input input');
    __live.setInput(input, "connections");
    return true; })()`);
  await until(() => evalIn(c, `__live.clickByText('.palette-opt .palette-label', 'Open connections')`), 8000,
    "Connections command; palette showed: " + JSON.stringify(
      await evalIn(c, `[...document.querySelectorAll('.palette-label')].map((e) => e.textContent)`)));
  await until(() => evalIn(c, `!!document.querySelector('.connections-page-pane')`), 10000, "connections page");
  await sleep(400);

  // The opener's own box — this is the containment box the backdrop used to be trapped in.
  const opener = await evalIn(c, `__live.rect('.connections-page-pane')`);
  const win = await evalIn(c, `({ width: window.innerWidth, height: window.innerHeight })`);
  check("the opener is inset from the window (so trapping would be visible)", opener.x > 0 || opener.y > 0 || opener.width < win.width, { opener, win });

  await until(() => evalIn(c, `__live.clickContaining('.connections-page-pane button', 'Add server')`), 10000, "Add server");
  await until(() => evalIn(c, `!!document.querySelector('.sheet-backdrop .sheet')`), 5000, "sheet open");
  await sleep(300);

  const inBody = await evalIn(c, `document.querySelector('.sheet-backdrop').parentElement === document.body`);
  check("backdrop is mounted on document.body, not inside the page", inBody);

  const back = await evalIn(c, `__live.rect('.sheet-backdrop')`);
  check("backdrop covers the whole window", Math.abs(back.x) < 1 && Math.abs(back.y) < 1
    && Math.abs(back.width - win.width) < 1 && Math.abs(back.height - win.height) < 1, { backdrop: back, win });
  check("backdrop is NOT the opener's box (the containment trap)",
    Math.abs(back.x - opener.x) > 1 || Math.abs(back.width - opener.width) > 1, { backdrop: back, opener });

  const sheet = await evalIn(c, `__live.rect('.sheet-backdrop .sheet')`);
  check("sheet sits fully inside the window — nothing clipped away",
    sheet.x >= -0.5 && sheet.y >= -0.5 && sheet.x + sheet.width <= win.width + 0.5 && sheet.y + sheet.height <= win.height + 0.5,
    { sheet, win });
  check("sheet is centred on the window, not on the pane",
    Math.abs((sheet.x + sheet.width / 2) - win.width / 2) < 1.5,
    { sheetCentre: sheet.x + sheet.width / 2, windowCentre: win.width / 2, openerCentre: opener.x + opener.width / 2 });
  check("sheet renders at its asked-for width (560 for this sheet)", Math.abs(sheet.width - 560) < 1, sheet);

  // The left edge the screenshot lost: the sheet's first label must be fully on-screen.
  const label = await evalIn(c, `__live.rect('.sheet-head h3')`);
  check("the sheet title is fully on-screen (the clipped-left symptom)", label && label.x >= 0, { label });

  c.close();
}

let client = null;
main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(async () => {
    if (client) { try { client.close(); } catch {} }
    if (electron) { try { process.kill(-electron.pid, "SIGTERM"); } catch { try { electron.kill("SIGTERM"); } catch {} } }
    await sleep(600);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
    console.log("\n" + JSON.stringify(results, null, 2));
  });
