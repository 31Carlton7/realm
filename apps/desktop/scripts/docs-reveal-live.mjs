/**
 * Live check: the documents pane's Show in Finder reaches main with the file's absolute path — the
 * space's folder from the home, the open document from its head, the same document from the pane's
 * menu — with the head shot in the dark face and the light one
 * (run with: node apps/desktop/scripts/docs-reveal-live.mjs, after `pnpm build`)
 *
 * `shell.showItemInFolder` is replaced over main's inspector with a recorder, so the check reads what
 * the Finder would have been asked rather than opening Finder windows. Nothing is sent to any agent:
 * the onboarding session is moved to the fake agent and never typed into.
 *
 * Ports: env-overridable (8795 server, 9235 CDP, 9236 main's inspector). Touches only a scratch dir;
 * stops the daemon it started and reaps the ports. LIVE_SHOTS names where the screenshots go.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { openSideTool } from "./lib/side-tools.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9235), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8795);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9236);
const SHOTS = process.env.LIVE_SHOTS ?? path.join(os.tmpdir(), "realm-docs-reveal-shots");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-docs-reveal-live-"));
const home = path.join(scratch, "home");
const DOC = "notes/week 1.md";
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portFree = (port) => new Promise((resolve) => {
  const s = connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});

function reap() {
  for (const port of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT]) {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) {
      // Only this worktree's Electron: never the user's installed app.
      const cmd = execSync(`ps -o command= -p ${pid} || true`, { encoding: "utf8" });
      if (cmd.includes(repoRoot) || cmd.includes(scratch)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    }
  }
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

function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return { ws, ready, pending, next: () => ++id };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
  };
}

function rpc(port, token) {
  const s = socket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  return {
    ready: s.ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(s.next());
      s.pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
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

/** The documents pane on screen. */
const PANE = `[...document.querySelectorAll('.documents-pane')].find((p) => p.getBoundingClientRect().width > 0)`;

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT, MAIN_INSPECT_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [`--inspect=${MAIN_INSPECT_PORT}`, wrapper, ...UNTHROTTLED], {
    env: { ...process.env, REALM_HOME: home, REALM_ENABLE_FAKE_AGENT: "1", REALM_HTML_MENUS: "1", REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  // Main's `shell.showItemInFolder`, swapped for a recorder: what the Finder would have been asked.
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 20_000, "main inspector");
  const m = cdp(mainTarget.webSocketDebuggerUrl); await m.ready;
  const inMain = async (expression) => {
    const r = await m.send("Runtime.evaluate", { expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await inMain(`(() => { const { shell } = require("electron"); globalThis.__revealed = []; shell.showItemInFolder = (p) => { globalThis.__revealed.push(p); }; return true; })()`);
  const revealed = () => inMain("globalThis.__revealed.splice(0)");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'notes');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await evalIn(c, `(() => { const h = document.documentElement; h.removeAttribute('data-window-inactive');
    new MutationObserver(() => h.hasAttribute('data-window-inactive') && h.removeAttribute('data-window-inactive')).observe(h, { attributes: true }); return true; })()`);

  const api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const space = (await api.call("spaces.list", {}))[0];
  const session = (await api.call("sessions.listAll", {}))[0];
  // Never a billed turn: the onboarding session is moved to the fake agent, and nothing is sent to it.
  await api.call("sessions.setAgent", { id: session.id, agentKind: "fake" }).catch(() => {});

  fs.mkdirSync(path.join(space.folderPath, "notes"), { recursive: true });
  fs.writeFileSync(path.join(space.folderPath, DOC), "# Week 1\n\nThe reading for Thursday, and the questions to bring.\n");

  const shootHead = async (selector, file) => {
    const box = await evalIn(c, `(() => { const r = ${PANE}?.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null; })()`);
    if (!box) throw new Error(`no ${selector} to shoot`);
    const pad = 8;
    const shot = await c.send("Page.captureScreenshot", { format: "png", clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2, scale: 2 } });
    const out = path.join(SHOTS, `${file}.png`);
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    const full = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, `${file}-window.png`), Buffer.from(full.data, "base64"));
    return out;
  };
  const theme = async (face) => {
    await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
    const label = `Theme: ${face[0].toUpperCase()}${face.slice(1)}`;
    await evalIn(c, `(() => { const input = document.querySelector(".palette input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
      input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === ${JSON.stringify(label)});
      if (!hit) return null; hit.click(); return true; })()`), 3000, `palette row ${label}`);
    await sleep(600);
  };
  const click = (label) => evalIn(c, `(() => { const b = ${PANE}?.querySelector('button[aria-label=${JSON.stringify(label)}]'); if (!b) return false; b.click(); return true; })()`);

  // 1. The home, nothing open: its head reveals the space's folder.
  await openSideTool(c, null, "Documents");
  await until(() => evalIn(c, `!!${PANE}?.querySelector('.docs-home-head')`), 20_000, "documents home");
  const folderLabel = `Show ${path.basename(space.folderPath)} in Finder`;
  await until(() => evalIn(c, `!!${PANE}?.querySelector('button[aria-label=${JSON.stringify(folderLabel)}]')`), 10_000, "the home's Show in Finder");
  for (const face of ["dark", "light"]) { await theme(face); console.log("shot", await shootHead(".docs-home-head", `home-head-${face}`)); }
  check("the home's button is labelled for the Finder", await click(folderLabel), folderLabel);
  await sleep(500);
  const fromHome = await revealed();
  check("the home reveals the space's folder", fromHome.length === 1 && fromHome[0] === space.folderPath, { fromHome, folder: space.folderPath });

  // 2. A document open: its head reveals the file, by its absolute path.
  const opened = await api.call("documents.openPath", { spaceId: space.id, path: DOC });
  await until(() => evalIn(c, `${PANE}?.querySelector('.documents-head .documents-name')?.textContent?.includes('week 1')`), 20_000, "the document's head");
  await sleep(800);
  const docLabel = "Show week 1.md in Finder";
  check("the head has the button", await evalIn(c, `!!${PANE}?.querySelector('.documents-head button[aria-label=${JSON.stringify(docLabel)}]')`));
  const geometry = await evalIn(c, `(() => { const p = ${PANE}; const head = p.querySelector('.documents-head').getBoundingClientRect();
    const b = p.querySelector('.documents-reveal').getBoundingClientRect(); const g = p.querySelector('.documents-head-glyph').getBoundingClientRect();
    const svg = p.querySelector('.documents-reveal svg').getBoundingClientRect();
    return { headH: head.height, leftInset: g.left - head.left, rightInset: head.right - svg.right, buttonRightOfHead: head.right - b.right, title: p.querySelector('.documents-reveal').title }; })()`);
  console.log("geometry", JSON.stringify(geometry));
  for (const face of ["dark", "light"]) { await theme(face); console.log("shot", await shootHead(".documents-head", `doc-head-${face}`)); }
  check("the head's button reveals", await click(docLabel));
  await sleep(500);
  const fromHead = await revealed();
  const abs = path.join(space.folderPath, DOC);
  check("the head reveals the document's absolute path", fromHead.length === 1 && fromHead[0] === abs, { fromHead, abs, opened });

  // 3. The pane's ⋯ menu, drawn in the page under REALM_HTML_MENUS: Reveal in Finder, same path.
  const menuOpened = await evalIn(c, `(() => { const panel = ${PANE}.closest('.panel'); const b = panel?.querySelector('[aria-label^="Pane menu for"]');
    if (!b) return null; b.click(); return b.getAttribute('aria-label'); })()`);
  await sleep(400);
  const row = await evalIn(c, `(() => { const r = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim().startsWith('Reveal in Finder')); if (!r) return [...document.querySelectorAll('[role=menuitem]')].map((x) => x.textContent.trim()); r.click(); return true; })()`);
  await sleep(500);
  const fromMenu = await revealed();
  check("the pane's menu has Reveal in Finder, at the same path", row === true && fromMenu[0] === abs, { menuOpened, row, fromMenu });
}

main()
  .catch((e) => { console.error("FAIL", e.message); process.exitCode = 1; })
  .finally(async () => {
    await stopDaemons(home).catch(() => {});
    if (electron && electron.exitCode === null) { electron.kill("SIGTERM"); await sleep(1500); if (electron.exitCode === null) electron.kill("SIGKILL"); }
    reap();
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit();
  });
