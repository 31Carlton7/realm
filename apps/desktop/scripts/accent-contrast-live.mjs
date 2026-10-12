/**
 * Live check: a word on a filled accent control reads at AA (run with: node apps/desktop/scripts/accent-contrast-live.mjs)
 *
 * Boots the BUILT app on a scratch home, parks a fake-engine session on a permission card, and for
 * Realm dark, Realm light and Codex light screenshots the session (permission card + prompter),
 * Settings ▸ Appearance, and a board of every filled-accent control at rest, hover, pressed and
 * disabled. Each control's ground is read off the COMPOSITED screenshot and held against the label
 * colour the cascade gives it: 4.5 : 1 or the run fails.
 *
 * The window is made non-focusable and titled SCRATCH, so nobody can type into it by mistake, and the
 * one session is switched to the fake engine before anything is sent. Nothing is billed.
 *
 * REBUILD FIRST (`pnpm build`). Ports: LIVE_CDP_PORT (9282), LIVE_SERVER_PORT (8842).
 * Screenshots: LIVE_OUT_DIR (os.tmpdir()). Touches only a scratch dir; reaps only what it started.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9282), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8842);
const OUT = process.env.LIVE_OUT_DIR ?? os.tmpdir();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-accent-contrast-live-"));
const home = path.join(scratch, "home");
let electron = null, api = null;
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

const lin = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

async function shot(c, name) {
  const data = (await c.send("Page.captureScreenshot", { format: "png" })).data;
  const file = path.join(OUT, `accent-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${name} ${file}`);
  return data;
}

/** Every control that writes a word or a mark on the accent fill, as the stylesheet draws it. */
const BOARD = `
<div class="contrast-board" style="position:fixed; right:16px; top:56px; z-index:99999; display:grid; gap:10px; padding:14px 16px;
  background:var(--surface); border-radius:12px; box-shadow:var(--shadow-overlay, 0 8px 24px #0004); color:var(--ink); font-size:12px; width:330px">
  <div style="font-weight:600; letter-spacing:.02em">SCRATCH — contrast check, not the owner's Realm</div>
  <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
    <button class="btn primary" data-k="primary">Approve</button>
    <button class="btn primary" data-k="primary-hover">Hover</button>
    <button class="btn primary" data-k="primary-pressed" data-pressed>Pressed</button>
    <button class="btn primary" data-k="primary-disabled" disabled>Disabled</button>
  </div>
  <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
    <button class="btn destructive" data-k="destructive">Delete</button>
    <button class="btn destructive" data-k="destructive-hover">Hover</button>
    <button class="btn destructive" data-k="destructive-pressed" data-pressed>Pressed</button>
  </div>
  <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
    <button class="plan-approve" data-k="plan-approve" style="padding:6px 12px; border-radius:var(--r-ctl); font-size:13px">Approve plan</button>
    <button class="machine-primary" data-k="machine-primary">Connect</button>
    <button class="sim-primary" data-k="sim-primary">Download for Mac</button>
  </div>
  <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; position:relative; height:30px">
    <div class="new-msgs-pill" data-k="new-msgs-pill" style="position:static; transform:none">3 new messages</div>
    <span class="drive-frame-label" data-k="drive-frame-label" style="position:static; translate:none">Realm is driving</span>
    <input type="checkbox" class="checkbox" checked aria-label="checked">
  </div>
</div>`;

async function forceHover(c, selector) {
  const { root } = await c.send("DOM.getDocument", {});
  const { nodeId } = await c.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (nodeId) await c.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
}

/** The ground of a control, read off the screenshot in its left padding (no glyph there), and the
 *  label colour the cascade gives it. */
async function measure(c, png, sel) {
  const box = await evalIn(c, `__live.box(${JSON.stringify(sel)})`);
  if (!box) return null;
  const inset = sel.includes("composer-send") ? Math.round(box.w * 0.18) : 3;
  const ground = await evalIn(c, `__live.band(${JSON.stringify(png)}, ${box.x + inset}, ${box.y + box.h / 2 - 2}, ${box.x + inset + 3}, ${box.y + box.h / 2 + 2})`);
  const label = await evalIn(c, `__live.srgb(getComputedStyle(document.querySelector(${JSON.stringify(sel)})).color)`);
  return { ground, label, ratio: Number(ratio(ground, label).toFixed(2)) };
}

async function face(c, name) {
  await evalIn(c, `(() => { document.querySelector('.contrast-board')?.remove(); return true; })()`);
  // The session: permission card + prompter.
  await evalIn(c, `(() => { document.querySelector('.settings-page-pane') && window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  await sleep(500);
  await evalIn(c, `(() => { const ta = document.querySelector('.composer-input'); if (ta) __live.setInput(ta, "Draft only — never sent"); return true; })()`);
  await sleep(400);
  const session = await shot(c, `${name}-session`);
  const rows = [];
  for (const sel of [".permission-card .btn.primary", ".composer-send"]) {
    const m = await measure(c, session, sel);
    if (m) rows.push({ face: name, control: sel, ...m });
  }
  // The board, over the session.
  await evalIn(c, `(() => { document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(BOARD)}); return true; })()`);
  await forceHover(c, '.contrast-board [data-k="primary-hover"]');
  await forceHover(c, '.contrast-board [data-k="destructive-hover"]');
  await sleep(500);
  const board = await shot(c, `${name}-board`);
  for (const k of ["primary", "primary-hover", "primary-pressed", "plan-approve", "machine-primary", "sim-primary", "new-msgs-pill", "drive-frame-label",
    "destructive", "destructive-hover", "destructive-pressed"]) {
    const m = await measure(c, board, `.contrast-board [data-k="${k}"]`);
    if (m) rows.push({ face: name, control: k, ...m });
  }
  await evalIn(c, `(() => { document.querySelector('.contrast-board')?.remove(); return true; })()`);
  for (const r of rows) check(`${r.face} ${r.control} label ${r.ratio}:1`, r.ratio >= 4.5, { ground: r.ground, label: r.label });
  return rows;
}

async function setMode(c, mode) {
  await evalIn(c, `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.palette input')`), 5000, "palette");
  const label = `Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`;
  await evalIn(c, `(() => { __live.setInput(document.querySelector(".palette input"), ${JSON.stringify(label)}); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === ${JSON.stringify(label)});
    if (!hit) return null; hit.click(); return true; })()`), 3000, label);
  await until(async () => (await evalIn(c, `document.documentElement.dataset.mode`)) === mode, 10000, `${mode} mode`);
}

async function lightPalette(c, name) {
  await until(() => evalIn(c, `__live.openSettings()`), 20000, "settings");
  await evalIn(c, `(async () => { document.querySelector('.settings-rail input[value="appearance"]')?.click(); await new Promise((x) => setTimeout(x, 400)); return true; })()`);
  const picked = await evalIn(c, `(async () => { const g = document.querySelector('[aria-label="Light theme"]'); if (!g) return null;
    const input = [...g.querySelectorAll('input[type=radio]')].find((i) => new RegExp(${JSON.stringify("^" + name)}).test(i.closest('label')?.textContent.trim() ?? ""));
    input?.click(); await new Promise((x) => setTimeout(x, 600)); g.scrollIntoView({ block: "start" }); return document.documentElement.dataset.theme ?? null; })()`);
  console.log(`LIGHT PALETTE ${name} -> data-theme=${picked}`);
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    // A scratch window must never take the owner's typing: no key focus, and a title that says so.
    'app.on("browser-window-created", (_e, w) => { w.setFocusable(false); w.setTitle("SCRATCH — contrast check");',
    '  w.on("page-title-updated", (e) => e.preventDefault()); });',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper,
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
  await c.send("DOM.enable");
  await c.send("CSS.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.setInput(input, "contrast"); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  // The onboarding session runs the first engine this Mac has — a real, billed one. Fake, first.
  const sessions = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15000, "a session");
  for (const s of sessions) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  await api.call("sessions.send", { id: sessions[0].id, text: "Build the dark-mode toggle", attachments: [], mentions: [] });
  await until(() => evalIn(c, `!!document.querySelector('.permission-card')`), 45000, "permission card");

  const all = [];
  await setMode(c, "dark");
  all.push(...await face(c, "realm-dark"));
  await setMode(c, "light");
  await lightPalette(c, "Realm");
  await shot(c, "realm-light-settings");
  all.push(...await face(c, "realm-light"));
  await lightPalette(c, "Codex");
  await shot(c, "codex-light-settings");
  all.push(...await face(c, "codex-light"));
  await setMode(c, "dark");
  await until(() => evalIn(c, `__live.openSettings()`), 20000, "settings");
  await sleep(500);
  await shot(c, "realm-dark-settings");
  fs.writeFileSync(path.join(OUT, "accent-contrast.json"), JSON.stringify(all, null, 2));
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
