/**
 * Live check: a picture opened in the Documents pane is drawn, not an empty pane
 * (run with: node apps/desktop/scripts/docs-picture-live.mjs, after `pnpm build`)
 *
 * The report was an agent's `docs_open` on a PNG answering success while the pane said "Nothing open
 * yet": pictures were an unsupported kind, so the tab went onto the strip and nothing drew it. This
 * opens a real PNG in the space's folder through `documents.openPath` — the call `docs_open` makes —
 * and measures what lands: the tab, the Quick Look render decoded into the pane at a real size, and
 * no empty state left over. A unit test can say the kind is `preview`; only the running app says
 * the server's render reached the screen.
 *
 * Ports: env-overridable (8966 server, 9366 CDP). Touches only a scratch dir; stops the daemon it
 * started and kills only the process it spawned.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9366), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8966);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-docs-picture-"));
const home = path.join(scratch, "home");
const SHOT = path.join(os.tmpdir(), "realm-docs-picture.png");
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portFree = (port) => new Promise((resolve) => {
  const s = connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});

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

/** An 800×500 gradient, written by hand so the check needs nothing installed to make a picture. */
function gradientPng(w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) row.set([Math.round((x * 255) / w), Math.round((y * 255) / h), 160], 1 + x * 3);
    rows.push(row);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: { ...process.env, REALM_HOME: home, REALM_ENABLE_FAKE_AGENT: "1", REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });

  const api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const space = (await api.call("spaces.list", {}))[0];
  const picture = path.join(space.folderPath, "gradient.png");
  fs.writeFileSync(picture, gradientPng(800, 500));
  // The call an agent's docs_open makes: the absolute path, relativized by the server.
  const opened = await api.call("documents.openPath", { spaceId: space.id, path: picture });
  check("documents.openPath accepts the picture", !!opened.documentsId, opened);

  const tab = await until(() => evalIn(c, `(() => {
    // The label drops the extension ("gradient"); the button's title is the tab's path.
    const t = document.querySelector('.documents-tab-label[title="gradient.png"]')?.closest('.documents-tab');
    return t ? { selected: t.getAttribute('aria-selected'), label: t.textContent } : null; })()`), 20000, "the picture's tab").catch(async (e) => {
    console.log("STATE", JSON.stringify(await evalIn(c, `(() => ({
      panes: [...document.querySelectorAll('.panel')].map((p) => p.className + ' :: ' + p.textContent.slice(0, 120)),
      docPane: document.querySelector('.documents-pane')?.textContent.slice(0, 300) ?? null,
      tabs: [...document.querySelectorAll('.documents-tab')].map((t) => t.textContent),
    }))()`)));
    throw e;
  });
  check("the picture opens as the active tab", tab.selected === "true", tab);

  const img = await until(() => evalIn(c, `(() => {
    const i = document.querySelector('.documents-pane img.ql-page');
    if (!i || !i.complete || i.naturalWidth === 0) return null;
    const r = i.getBoundingClientRect();
    return { naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight, width: Math.round(r.width), height: Math.round(r.height), alt: i.alt }; })()`), 30000, "the picture to render");
  check("the pane draws the picture's render, decoded", img.naturalWidth > 0 && img.width > 100 && img.height > 50, img);
  check("the render keeps the picture's shape", Math.abs(img.naturalWidth / img.naturalHeight - 800 / 500) < 0.02, img);
  const empty = await evalIn(c, `(() => { const p = document.querySelector('.documents-pane'); return {
    nothingOpen: p.textContent.includes('Nothing open yet'), unavailable: p.textContent.includes('Preview unavailable'),
    documentNote: !!p.querySelector('.ql-note') }; })()`);
  // The note under a document's render (no selectable text, maybe one page) is untrue of a picture.
  check("no empty state, failure or document's note is left on the pane", !empty.nothingOpen && !empty.unavailable && !empty.documentNote, empty);

  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  console.log(`screenshot ${SHOT}`);
}

main()
  .catch((e) => { console.error("FAIL", e.message); process.exitCode = 1; })
  .finally(async () => {
    await stopDaemons(home).catch(() => {});
    if (electron && electron.exitCode === null) { electron.kill("SIGTERM"); await sleep(1500); if (electron.exitCode === null) electron.kill("SIGKILL"); }
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit();
  });
