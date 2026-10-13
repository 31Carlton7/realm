/**
 * Live check for the Codex light theme (run with: node apps/desktop/scripts/codex-theme-live.mjs)
 *
 * Boots the BUILT app on a fresh scratch home — no saved palette — in light mode, and checks that
 * the window is wearing Codex: the default for a home that never chose a light palette. Then reads
 * the palette back off the real cascade and the composited screenshot, and saves screenshots of the
 * sidebar + session + prompter, a menu (the command palette) and Settings ▸ Appearance for a
 * side-by-side with the Codex app. The session runs on the fake engine; nothing is billed.
 *
 * REBUILD FIRST (`pnpm build`): this boots apps/desktop/out, not the sources.
 * Ports: LIVE_CDP_PORT (9275), LIVE_SERVER_PORT (8835). Screenshots: LIVE_OUT_DIR (os.tmpdir()).
 * Touches only a scratch dir; reaps only the processes it started.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9275), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8835);
const OUT = process.env.LIVE_OUT_DIR ?? os.tmpdir();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-codex-theme-live-"));
const home = path.join(scratch, "home");
let electron = null, api = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Codex's light palette as Chromium resolved it from the Codex app's own stylesheets and theme
 *  engine (packages/ui/src/codex-theme.test.ts holds the same table against the derivation). */
const CODEX = {
  "--page": [246, 246, 246], "--canvas": [255, 255, 255], "--surface": [255, 255, 255],
  "--ink": [26, 28, 31], "--accent": [58, 131, 247], "--accent-ink": [44, 103, 197],
};

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

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return {
    ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

const HELPERS = `
globalThis.__live = globalThis.__live ?? {
  setInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  /** A CSS colour as sRGB bytes, painted rather than parsed so oklch() and color-mix() resolve. */
  srgb(css) {
    const cv = (this._cv ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }));
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.clearRect(0, 0, 1, 1); g.fillStyle = "#fff"; g.fillRect(0, 0, 1, 1); g.fillStyle = css; g.fillRect(0, 0, 1, 1);
    return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  },
  tokens(names) {
    const cs = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((n) => [n, this.srgb(cs.getPropertyValue(n).trim())]));
  },
  box(sel) { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; },
  async openSettings() {
    if (document.querySelector(".settings-page-pane")) return true;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector(".palette input"); i++) await new Promise((r) => setTimeout(r, 25));
    const input = document.querySelector(".palette input");
    if (input) this.setInput(input, "settings");
    for (let i = 0; i < 40; i++) {
      const hit = [...document.querySelectorAll(".palette-list [role=option], .palette-list button")].find((b) => /open settings/i.test(b.textContent));
      if (hit) { hit.click(); break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    for (let i = 0; i < 80 && !document.querySelector(".settings-page-pane"); i++) await new Promise((r) => setTimeout(r, 25));
    return !!document.querySelector(".settings-page-pane");
  },
  /** The mean colour of a band of a screenshot, as [r,g,b] — solid grounds only. */
  async band(b64, x0, y0, x1, y1) {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    const g = cv.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0);
    const dpr = img.width / window.innerWidth;
    const px = g.getImageData(Math.floor(x0 * dpr), Math.floor(y0 * dpr), Math.max(1, Math.floor((x1 - x0) * dpr)), Math.max(1, Math.floor((y1 - y0) * dpr))).data;
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; }
    const n = px.length / 4;
    return [r / n, gg / n, b / n].map(Math.round);
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) { failures++; process.exitCode = 1; }
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function shot(c, name) {
  const data = (await c.send("Page.captureScreenshot", { format: "png" })).data;
  const file = path.join(OUT, `codex-live-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${name} ${file}`);
  return data;
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper,
    // Opened behind the user's window, Chromium stops laying the page out without these.
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.setInput(input, "stora"); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  // An unkeyed Mac window greys its accent; this run is about the accent, so hold it keyed.
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  // Through the app's own control (⌘K ▸ Theme: Light), which is what writes the preference AND the
  // store; a bare settings.set reaches the database and leaves the open window where it was.
  await evalIn(c, `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.palette input')`), 5000, "palette");
  await evalIn(c, `(() => { __live.setInput(document.querySelector(".palette input"), "Theme: Light"); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === "Theme: Light");
    if (!hit) return null; hit.click(); return true; })()`), 3000, "Theme: Light");
  const worn = await until(async () => {
    const s = await evalIn(c, `({ mode: document.documentElement.dataset.mode, theme: document.documentElement.dataset.theme })`);
    return s.mode === "light" ? s : null;
  }, 10000, "light mode");

  // 1. The default: a home with no saved light palette wears Codex.
  check("a fresh home's light face wears Codex", worn.theme === "codex", worn);
  const saved = await api.call("settings.get", { key: "ui.themeName.light" }).catch(() => null);
  check("…without writing a choice the user never made", saved === null || saved === undefined || saved?.value == null, { saved });

  // 2. The palette reached the cascade as Codex's values.
  const t = await evalIn(c, `__live.tokens(${JSON.stringify(Object.keys(CODEX))})`);
  for (const [k, want] of Object.entries(CODEX)) check(`${k} is Codex's ${want}`, near(t[k], want, 1), { got: t[k] });

  // A session on the fake engine, with a code block, so the transcript has something to show.
  const sessions = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15000, "a session");
  const sessionId = sessions[0].id;
  await api.call("sessions.setAgent", { id: sessionId, agentKind: "fake" });
  await api.call("sessions.send", { id: sessionId, text: "Standardize the button design tokens and show me the diff.", attachments: [], mentions: [] });
  await sleep(4000);

  // 3. Sidebar + session + prompter, and the composited grounds.
  const main = await shot(c, "session");
  const pane = await evalIn(c, `__live.box('.main') ?? __live.box('main')`);
  const composer = await evalIn(c, `__live.box('.composer')`);
  if (pane) {
    const ground = await evalIn(c, `__live.band(${JSON.stringify(main)}, ${pane.x + pane.w - 60}, ${pane.y + 80}, ${pane.x + pane.w - 20}, ${pane.y + 120})`);
    console.log(`PANE GROUND ${ground}`);
  }
  if (composer) {
    const ground = await evalIn(c, `__live.band(${JSON.stringify(main)}, ${composer.x + 40}, ${composer.y + composer.h - 14}, ${composer.x + 120}, ${composer.y + composer.h - 8})`);
    console.log(`COMPOSER GROUND ${ground}`);
  }

  // The chrome row and the rail are Codex's window ground with nothing laid over it.
  const chrome = await evalIn(c, `getComputedStyle(document.documentElement).getPropertyValue("--chrome-tint").trim()`);
  check("the chrome row carries no tint of its own, as Codex's title bar does not", chrome === "transparent", { chrome });

  // 4. A menu: the command palette, the app's commonest floating surface.
  await evalIn(c, `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.palette input')`), 5000, "palette");
  await sleep(300);
  await shot(c, "menu");
  await evalIn(c, `(() => { document.querySelector(".palette input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  await sleep(300);

  // 5. Settings ▸ Appearance: Codex is the checked light palette, and Realm is still offered.
  await until(() => evalIn(c, `__live.openSettings()`), 20000, "settings");
  await evalIn(c, `(async () => { const r = document.querySelector('.settings-rail input[value="appearance"]'); r?.click(); await new Promise((x) => setTimeout(x, 400)); return true; })()`);
  const rows = await evalIn(c, `(() => { const g = document.querySelector('[aria-label="Light theme"]'); if (!g) return null;
    g.scrollIntoView({ block: "start" });
    return [...g.querySelectorAll('input[type=radio]')].map((i) => ({ name: i.closest('label')?.textContent.trim().split('\\n')[0], checked: i.checked })); })()`);
  check("Settings' light row lists Codex, checked", !!rows?.find((r) => /Codex/.test(r.name) && r.checked), rows);
  check("…and still offers Realm", !!rows?.find((r) => /^Realm/.test(r.name)), rows);
  await sleep(400);
  await shot(c, "settings");
}

function reap() {
  // By port, and only processes running this worktree's build — never the user's own Realm.
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) {
      const cmd = execSync(`ps -o command= -p ${pid} || true`, { encoding: "utf8" });
      if (cmd.includes(repoRoot)) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
    }
  }
}

main()
  .catch((e) => { failures++; process.exitCode = 1; console.error("ERROR", e.message); })
  .finally(async () => {
    await api?.call("daemon.stop", {}).catch(() => {});
    electron?.kill();
    await sleep(1500);
    reap();
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log(failures ? `${failures} FAILED` : "ALL PASS");
    process.exit(process.exitCode ?? 0);
  });
process.on("SIGINT", () => { reap(); process.exit(130); });
