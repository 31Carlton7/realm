/**
 * Live check for Settings ▸ Computer use ▸ Computer control: one Allow per missing grant, Repair leading
 * on a grant an earlier build held, and the row turning Granted by itself when the switch is flipped.
 * (run with: pnpm build && node apps/desktop/scripts/computer-access-live.mjs)
 *
 * The real grant cannot be flipped from a script, and a helper spawned from here would report Electron's
 * grants anyway, so `REALM_AXHELPER_BIN` points at a scripted helper that reads trust from a file once at
 * launch — the same lifetime cache the real one has. Flipping the file is the user flipping the switch.
 * The stale grant is seeded the way Realm records one: `computer-grants.json` in userData naming an
 * earlier build. Nothing here presses Allow or Repair (either would open System Settings and run
 * tccutil); the buttons are read, and the store's watch is driven by the window's focus event.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only what is listening on its own ports.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopDaemons } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9233), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8793);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-computer-access-live-"));
const home = path.join(scratch, "home");
const userData = path.join(scratch, "userData");
const OUT = (tag) => path.join(os.tmpdir(), `realm-computer-access-${tag}.png`);
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE_HELPER = `
const fs = require("node:fs");
const dir = process.argv[2];
const read = (n) => { try { return fs.readFileSync(dir + "/" + n, "utf8").trim() === "1"; } catch { return false; } };
const trust = { accessibility: read("accessibility"), screenRecording: read("screenRecording") };
process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c; let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const { id } = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    process.stdout.write(JSON.stringify({ id, result: trust }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

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
    await sleep(250);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
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

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

const OPEN_SETTINGS = `(async () => {
  if (!document.querySelector(".settings-page-pane")) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector(".palette input"); i++) await new Promise((r) => setTimeout(r, 25));
    const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "settings");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 40; i++) {
      const hit = [...document.querySelectorAll(".palette-list [role=option], .palette-list button")].find((b) => /open settings/i.test(b.textContent));
      if (hit) { hit.click(); break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    for (let i = 0; i < 80 && !document.querySelector(".settings-page-pane"); i++) await new Promise((r) => setTimeout(r, 25));
  }
  document.querySelector('.settings-rail input[value="computer-use"]').click();
  return true;
})()`;

const READ_ROWS = `(() => [...document.querySelectorAll(".computer-access-field .settings-row")].map((r) => ({
  name: r.querySelector(".settings-row-name")?.textContent,
  chip: r.querySelector(".tcc-state")?.textContent,
  state: r.querySelector(".tcc-state")?.dataset.state,
  desc: r.querySelector(".settings-row-desc")?.textContent ?? null,
  buttons: [...r.querySelectorAll("button")].map((b) => ({ text: b.textContent, title: b.getAttribute("title") })),
})))()`;

async function shoot(c, tag) {
  const box = await evalIn(c, `(() => { const f = document.querySelector(".computer-access-field"); f.scrollIntoView({ block: "start" }); const b = f.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  await sleep(300);
  const shot = await c.send("Page.captureScreenshot", { format: "png", clip: { x: box.x - 12, y: Math.max(0, box.y - 12), width: box.w + 24, height: box.h + 24, scale: 1 } });
  fs.writeFileSync(OUT(tag), Buffer.from(shot.data, "base64"));
  console.log(`SCREENSHOT ${OUT(tag)}`);
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  const helperDir = path.join(scratch, "helper");
  fs.mkdirSync(helperDir);
  fs.writeFileSync(path.join(helperDir, "helper.cjs"), FAKE_HELPER);
  const helperBin = path.join(helperDir, "axhelper");
  fs.writeFileSync(helperBin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(helperDir, "helper.cjs")}" "${helperDir}"\n`);
  fs.chmodSync(helperBin, 0o755);
  const setTrust = (name, on) => fs.writeFileSync(path.join(helperDir, name), on ? "1" : "0");
  setTrust("accessibility", false);
  setTrust("screenRecording", false);
  // Accessibility was last held by an earlier build: the grant an update left behind.
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "computer-grants.json"), JSON.stringify({ accessibility: { build: "2.0.3+1" } }));

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_AXHELPER_BIN: helperBin,
      REALM_ENABLE_FAKE_AGENT: "1",
      LIVE_USER_DATA: userData,
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const page = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30_000, "renderer target");
  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20_000, "composer");
  await evalIn(c, OPEN_SETTINGS);

  const rows = await until(async () => { const r = await evalIn(c, READ_ROWS); return r.length === 2 ? r : null; }, 20_000, "computer control rows");
  const a11y = rows.find((r) => r.name === "Accessibility");
  const screen = rows.find((r) => r.name === "Screen Recording");
  check("a grant an earlier build held reads Not honoured", a11y.chip === "Not honoured" && a11y.state === "denied", a11y);
  check("…and leads with Repair, which names tccutil before it is pressed", a11y.buttons.length === 1 && a11y.buttons[0].text === "Repair" && /tccutil reset/.test(a11y.buttons[0].title ?? ""), a11y.buttons);
  check("…and says what happened", /stopped honouring/.test(a11y.desc ?? ""), a11y.desc);
  check("an ordinary refusal offers one Allow, with Repair behind Already on?", JSON.stringify(screen.buttons.map((b) => b.text)) === JSON.stringify(["Allow in System Settings", "Already on?"]), screen.buttons);
  check("Allow says where the switch is on this macOS", /Screen & System Audio Recording/.test(screen.buttons[0].title ?? ""), screen.buttons[0].title);
  await shoot(c, "before");

  // The user switches Realm on in System Settings. The scripted helper's answer moves; the window
  // coming back to the front re-reads, and the row turns Granted with no click in Realm.
  setTrust("accessibility", true);
  await evalIn(c, `window.dispatchEvent(new Event("focus")), true`);
  const after = await until(async () => {
    const r = await evalIn(c, READ_ROWS);
    const row = r.find((x) => x.name === "Accessibility");
    return row?.state === "granted" ? row : null;
  }, 10_000, "accessibility granted");
  check("the row turns Granted by itself once the switch is on", after.chip === "Granted" && after.buttons.length === 0, after);
  const history = JSON.parse(fs.readFileSync(path.join(userData, "computer-grants.json"), "utf8"));
  check("the grant is now recorded against this build", history.accessibility && history.accessibility.build !== "2.0.3+1", history);
  await shoot(c, "after");
  c.close();
}

async function teardown() {
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
