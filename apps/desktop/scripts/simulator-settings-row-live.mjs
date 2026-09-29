/**
 * Live check for the simulator tools' settings row on a Mac that CANNOT run a simulator
 * (run with: pnpm build && node apps/desktop/scripts/simulator-settings-row-live.mjs)
 *
 * The row's other state — the switch, on a Mac that can — is §9 of `simulator-agent-tools-live.mjs`.
 * This one needs the opposite Mac, and makes it without touching the real one: the built server runs
 * its real probe (`toolchainAvailable`, handed over by `main.ts`), with `REALM_XCRUN_BIN` pointed at
 * `/usr/bin/false` so `simctl` never answers, and `ANDROID_HOME` pointed at an empty folder so the SDK
 * that is really installed is not the one found. Nothing is typed into any session.
 *
 * What only the real app can say: that the probe's "no" travels from `main.ts` through
 * `mcp.providers.list` into the row, and that the row then says what the Mac lacks instead of wearing
 * a switch that reads "Enabled" over tools that do nothing here.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-sim-row-live-"));
const home = path.join(scratch, "home");
const OUT = path.join(os.tmpdir(), "realm-simulator-settings-row-missing.png");
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

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const emptySdk = path.join(scratch, "no-android-sdk");
  fs.mkdirSync(emptySdk);

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      // The Mac without simulators, made out of this one: simctl never answers, and the SDK Realm
      // finds is an empty folder rather than the one really installed.
      REALM_XCRUN_BIN: "/usr/bin/false",
      ANDROID_HOME: emptySdk,
      LIVE_USER_DATA: path.join(scratch, "userData"),
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
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20_000, "composer");

  await evalIn(c, `(() => { [...document.querySelectorAll('.sb-destinations .dest-row')].find((b) => b.textContent.trim().startsWith("Connections")).click(); return true; })()`);
  const read = (name) => `(() => {
    const row = [...document.querySelectorAll('.mcp-row')].find((r) => r.querySelector('.env-name')?.textContent === ${JSON.stringify(name)});
    if (!row) return null;
    const actions = row.querySelector('.env-actions');
    const b = row.getBoundingClientRect();
    return { switch: !!row.querySelector('[role=switch]'), actions: actions?.textContent.trim() ?? null,
             title: actions?.firstElementChild?.getAttribute('title') ?? null,
             box: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) } };
  })()`;
  // The probe answers a moment after boot; the row may say "Checking…" first, which is the point of
  // that word — so wait for the answer rather than reading the first frame.
  const sim = await until(async () => {
    const r = await evalIn(c, read("realm-simulator"));
    return r && r.actions !== "Checking…" ? r : null;
  }, 20_000, "the realm-simulator row with an answer");
  check("on a Mac with no toolchain, the simulator row says what it needs", sim.actions === "Needs Xcode or Android Studio", sim);
  check("…and wears no switch that would read Enabled", sim.switch === false && !/Enabled/.test(sim.actions ?? ""), sim);
  check("…and says in its title that the space's choice is kept", /switch is kept/.test(sim.title ?? ""), sim.title);
  const browser = await evalIn(c, read("realm-browser"));
  check("a provider that acts inside Realm keeps its switch beside it", browser?.switch === true && browser.actions === "Enabled", browser);

  // The list sits below the fold on this page, and a clip outside the viewport captures nothing — so
  // it is scrolled into view first and measured again, then taken whole: the row among its neighbours.
  const list = await evalIn(c, `(() => {
    const ul = [...document.querySelectorAll('.mcp-row')].find((r) => r.querySelector('.env-name')?.textContent === "realm-simulator")?.closest('ul');
    if (!ul) return null;
    ul.scrollIntoView({ block: "center" });
    const b = ul.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
  })()`);
  await sleep(300);
  const shot = await c.send("Page.captureScreenshot", { format: "png", clip: { x: list.x - 8, y: Math.max(0, list.y - 8), width: list.w + 16, height: list.h + 16, scale: 1 } });
  fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log(`SCREENSHOT ${OUT}`);
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
