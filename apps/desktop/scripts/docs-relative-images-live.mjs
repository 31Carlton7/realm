/**
 * Live check: a Markdown document's pictures by relative path are drawn, and saving keeps the path
 * (#548; run with: node apps/desktop/scripts/docs-relative-images-live.mjs, after `pnpm build`)
 *
 * `![x](pic.png)` beside a file drew as a broken image: the raw src resolved against the renderer's
 * page. This opens a note in a real space with `pic.png` beside it, `img/pic.png` under it and a
 * picture outside the space it tries to climb to, and measures each `<img>` decoded or not. Then it
 * types into the block that holds a picture, waits for the save, and reads the file's bytes: the
 * written path must still be there and the resolved `realm-media:` URL must not. Screenshots in dark
 * and light go to LIVE_OUT_DIR.
 *
 * Ports: env-overridable (8788 server, 9223 CDP). Touches only a scratch dir; stops the daemon it
 * started and kills only the process it spawned.
 */
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { spawnLiveElectron } from "./lib/live-app.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9223), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8788);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-docs-relative-images-"));
const home = path.join(scratch, "home");
const OUT_DIR = process.env.LIVE_OUT_DIR ?? path.join(os.tmpdir(), "realm-docs-relative-images");
fs.mkdirSync(OUT_DIR, { recursive: true });
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

async function setTheme(c, mode) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  const label = `Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`;
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === ${JSON.stringify(label)});
    if (!hit) return null; hit.click(); return true; })()`), 4000, label);
  await until(() => evalIn(c, `document.documentElement.getAttribute("data-mode") === ${JSON.stringify(mode)}`), 4000, `mode ${mode}`);
  await sleep(400);
}

const NOTE = [
  "# Pictures", "",
  "Beside the note: ![beside](pic.png)", "",
  "In a folder under it: ![nested](img/pic.png)", "",
  "Climbing out of the space: ![outside](../outside.png)", "",
].join("\n");

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);"].join("\n"));
  electron = spawnLiveElectron([wrapper, ...UNTHROTTLED], {
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
  // `../outside.png` is written beside the space's folder, so that folder has to be the scratch one.
  if (!fs.realpathSync(space.folderPath).startsWith(fs.realpathSync(scratch))) throw new Error(`space folder ${space.folderPath} is outside the scratch dir`);
  const note = path.join(space.folderPath, "note.md");
  fs.mkdirSync(path.join(space.folderPath, "img"), { recursive: true });
  fs.writeFileSync(path.join(space.folderPath, "pic.png"), gradientPng(480, 200));
  fs.writeFileSync(path.join(space.folderPath, "img/pic.png"), gradientPng(200, 200));
  fs.writeFileSync(path.join(space.folderPath, "../outside.png"), gradientPng(200, 200));
  fs.writeFileSync(note, NOTE);
  await api.call("documents.openPath", { spaceId: space.id, path: note });

  const IMAGES = `[...document.querySelectorAll('.documents-rich-surface img')].map((i) => ({
    alt: i.alt, written: i.dataset.markdownSrc, src: i.getAttribute('src'), complete: i.complete, naturalWidth: i.naturalWidth }))`;
  const images = await until(async () => {
    const list = await evalIn(c, IMAGES);
    return list.length === 3 && list.every((i) => i.complete) ? list : null;
  }, 30000, "the note's pictures");
  console.log("INFO images", JSON.stringify(images));
  const [beside, nested, outside] = images;
  check("the picture beside the note is drawn", beside.naturalWidth === 480 && beside.src.startsWith("realm-media://space/"), beside);
  check("the picture in a folder under it is drawn", nested.naturalWidth === 200, nested);
  check("the picture outside the space is refused", outside.naturalWidth === 0, outside);

  for (const mode of ["dark", "light"]) {
    await setTheme(c, mode);
    await evalIn(c, `(() => { document.querySelector('.palette input') && window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
    await sleep(300);
    const shot = await c.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(OUT_DIR, `after-${mode}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log(`screenshot ${file}`);
  }

  // Type into the paragraph that holds the first picture, so that block is serialized afresh.
  await evalIn(c, `(() => {
    const pm = document.querySelector('.documents-rich-surface');
    const para = [...pm.querySelectorAll('p')].find((p) => p.textContent.startsWith('Beside the note'));
    pm.focus();
    const range = document.createRange();
    range.setStart(para.firstChild, 0); range.collapse(true);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    return true; })()`);
  await sleep(200);
  await c.send("Input.insertText", { text: "Edited. " });
  const saved = await until(() => {
    const bytes = fs.readFileSync(note, "utf8");
    return bytes.includes("Edited. ") ? bytes : null;
  }, 15000, "the save");
  console.log("INFO saved bytes\n" + saved);
  fs.writeFileSync(path.join(OUT_DIR, "note-after-save.md"), saved);
  check("the edited block keeps the written path", saved.includes("Edited. Beside the note: ![beside](pic.png)"), saved);
  check("the untouched blocks keep theirs", saved.includes("![nested](img/pic.png)") && saved.includes("![outside](../outside.png)"));
  check("no resolved URL reaches the file", !saved.includes("realm-media"));
}

main()
  .catch((e) => { console.error("FAIL", e.message); process.exitCode = 1; })
  .finally(async () => {
    await stopDaemons(home).catch(() => {});
    if (electron && electron.exitCode === null) { electron.kill("SIGTERM"); await sleep(1500); if (electron.exitCode === null) electron.kill("SIGKILL"); }
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit();
  });
