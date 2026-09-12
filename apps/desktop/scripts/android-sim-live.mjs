/**
 * Live check for Android in the simulator pane, against a REAL emulator.
 *
 * What this settles and no unit test can: that the device the SDK reports reaches the picker, that
 * choosing it boots a stream Realm's own server serves, and that the pane ends up with PIXELS of the
 * phone in it. Everything below the pane is faked in the suite precisely so this can be the thing
 * that is not.
 *
 * Needs an emulator already running (`emulator -avd <name>`); it will not start one, because a cold
 * AVD takes over a minute and a live check that boots one is a live check nobody runs.
 *
 * Hygiene: scratch REALM_HOME + userData under mkdtemp, removed at exit. Never the real ~/Realm.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP = Number(process.env.LIVE_CDP_PORT ?? 9357), PORT = Number(process.env.LIVE_SERVER_PORT ?? 8919);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-android-live-"));
const outDir = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-android-live");
fs.mkdirSync(outDir, { recursive: true });
let electron = null, failures = 0, shotN = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`); if (!ok) failures++; };
const until = async (fn, ms, tag) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${tag}`); await sleep(400); } };
const portFree = (port) => new Promise((res) => { const s = connect({ port, host: "127.0.0.1" }); s.on("connect", () => { s.destroy(); res(false); }); s.on("error", () => res(true)); });

function cdp(url) {
  const ws = new WebSocket(url); let i = 0; const p = new Map();
  const ready = new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } });
  return { ready, send: (method, params) => new Promise((res) => { const id = ++i; p.set(id, (m) => res(m.result ?? m)); ws.send(JSON.stringify({ id, method, params })); }) };
}

async function main() {
  for (const p of [CDP, PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use`);
  fs.writeFileSync(path.join(scratch, "w.mjs"), 'import { app } from "electron";\napp.setPath("userData", process.env.UD);\nawait import(process.env.MAIN);');
  electron = spawn(path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), [path.join(scratch, "w.mjs")], {
    env: { ...process.env, REALM_HOME: path.join(scratch, "home"), REALM_PORT: String(PORT), REALM_DEVTOOLS_PORT: String(CDP),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), UD: path.join(scratch, "ud"), MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["ignore", "ignore", "pipe"],
  });
  electron.stderr.on("data", () => {});
  const t = await until(async () => (await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json())).find((x) => x.type === "page" && x.url.startsWith("file://")), 40000, "renderer");
  const c = cdp(t.webSocketDebuggerUrl); await c.ready;
  await c.send("Runtime.enable"); await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  const ev = async (e) => (await c.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
  const shot = async (tag) => {
    const r = await c.send("Page.captureScreenshot", { format: "png" });
    const out = path.join(outDir, `${String(++shotN).padStart(2, "0")}-${tag}.png`);
    fs.writeFileSync(out, Buffer.from(r.data, "base64")); console.log(`  shot: ${out}`);
  };

  await until(() => ev(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30000, "onboarding");
  await ev(`(()=>{const i=document.querySelector('.onboarding input:not([type=radio])');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Android');i.dispatchEvent(new Event('input',{bubbles:true}));i.closest('form').requestSubmit();return true})()`);
  await until(() => ev(`!!document.querySelector('.composer')`), 30000, "composer");
  await sleep(600);

  // 1. the SDK reaches the RPC
  const listed = await ev(`window.__realmRpc ? null : (async () => {
    const r = await (await import('/src/state/live-api.ts')).rpc().call('simulators.devices', {});
    return r;
  })().catch(e => ({ error: String(e) }))`);
  // The renderer module path is not stable across builds; ask the pane instead.
  await ev(`(()=>{const b=[...document.querySelectorAll('.panel-actions .icon-btn')].find(x=>/simulator/i.test(x.getAttribute('aria-label')??''));if(!b)throw new Error('no simulator button: '+[...document.querySelectorAll('.panel-actions .icon-btn')].map(x=>x.getAttribute('aria-label')).join('|'));b.click();return true})()`);
  await until(() => ev(`!!document.querySelector('.sim-devices')`), 20000, "picker");
  await sleep(800);
  await shot("picker");

  const groups = await ev(`[...document.querySelectorAll('.sim-group-label')].map(e=>e.textContent)`);
  const devices = await ev(`[...document.querySelectorAll('.sim-device')].map(b=>({name:b.querySelector('.sim-device-name')?.textContent,facts:b.querySelector('.sim-device-facts')?.textContent}))`);
  check("the picker lists an Android device from the real SDK", devices.some((d) => /Android/.test(d.facts ?? "")), devices);
  check("it is grouped under an Android heading", groups.includes("Android"), groups);

  // 2. choosing it streams
  await ev(`(()=>{const b=[...document.querySelectorAll('.sim-device')].find(x=>/Android/.test(x.querySelector('.sim-device-facts')?.textContent??''));b.click();return true})()`);
  const running = await until(async () => {
    const s = await ev(`(()=>{const i=document.querySelector('.sim-picture');return i?{src:i.src,w:i.naturalWidth,h:i.naturalHeight}:null})()`);
    return s && s.w > 0 ? s : null;
  }, 90000, "a picture of the phone").catch(() => null);
  check("the pane ends up with real pixels of the device", Boolean(running && running.w > 0 && running.h > 0), running);
  check("those pixels come from Realm's own loopback stream", Boolean(running && /^http:\/\/127\.0\.0\.1:\d+\//.test(running.src ?? "")), running?.src);
  await sleep(1200);
  await shot("android-running");

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
}

const cleanup = () => {
  try { electron?.kill("SIGTERM"); } catch { /* gone */ }
  setTimeout(() => { try { electron?.kill("SIGKILL"); } catch { /* gone */ } }, 800);
  if (!process.env.LIVE_KEEP) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } }
};
const bail = setTimeout(() => { console.error("[live] TIMEOUT"); cleanup(); process.exit(2); }, 300_000);
try { await main(); } catch (e) { console.error("[live] failed:", e.message); failures++; }
clearTimeout(bail); cleanup();
process.exit(failures === 0 ? 0 : 1);
