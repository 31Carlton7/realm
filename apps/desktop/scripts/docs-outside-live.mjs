/**
 * Live check: a file the session touched OUTSIDE the space's folder opens inside the Documents pane,
 * drawn by the same editor as a file inside it — never a grey stage
 * (run with: node apps/desktop/scripts/docs-outside-live.mjs, after `pnpm build`)
 *
 * The report was a REPORT.md an agent wrote in another worktree, listed under "This session" in a
 * session's side Documents, opening as a grey screen: rows outside the checkout went to the media
 * viewer, which asked macOS for a picture of the markdown. This seeds the session's artifacts index
 * with files inside and outside the space folder, clicks each row in the side pane as a person would,
 * and records what lands — the pane's editor and its header note, or the viewer's stage — with a
 * screenshot of each, in the dark face and the light one.
 *
 * Ports: env-overridable (8822 server, 9262 CDP). Touches only a scratch dir; stops the daemon it
 * started and reaps both ports. LIVE_SHOTS names where the screenshots go; LIVE_TAG prefixes them.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { openSideTool } from "./lib/side-tools.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9262), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8822);
const SHOTS = process.env.LIVE_SHOTS ?? path.join(os.tmpdir(), "realm-docs-outside-shots");
const TAG = process.env.LIVE_TAG ?? "run";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-docs-outside-"));
const home = path.join(scratch, "home");
const outside = path.join(scratch, "elsewhere", "tool-rejection");
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portFree = (port) => new Promise((resolve) => {
  const s = connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});

function reap() {
  for (const port of [SERVER_PORT, CDP_PORT]) {
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

const REPORT = `# Tool rejection — verify report

The agent's **rejected** tool call now lands as a card, not a stack trace.

## Matrix

- Claude: rejected, card shown
- Codex: rejected, card shown

\`\`\`ts
const verdict = "pass";
\`\`\`
`;

/** The fixtures, by name: what each file holds. Written once inside the space and once outside it. */
const FILES = {
  "REPORT.md": () => REPORT,
  "teams-vault-live.mjs": () => `import fs from "node:fs";\n\nexport async function main() {\n  const shots = fs.readdirSync(".");\n  return shots.length;\n}\n`,
  "live-presence.test.ts": () => `import { describe, expect, it } from "vitest";\n\ndescribe("presence", () => {\n  it("is live", () => { expect(1 + 1).toBe(2); });\n});\n`,
  "config.json": () => `{\n  "name": "realm",\n  "private": true,\n  "version": "2.0.2"\n}\n`,
  "gradient.png": () => gradientPng(800, 500),
};
/** Files that cannot be shown as text, outside the space only: what the pane says about each. */
const ODD = {
  "huge.md": () => "# big\n" + "x".repeat(3 * 1024 * 1024),
  "blob.json": () => Buffer.from([0x7b, 0x00, 0x01, 0x02, 0x7d]),
};

/** What is on screen after a row was clicked: the viewer and its stage, or the pane's open document. */
const READ_STATE = `(() => {
  const viewer = document.querySelector('.media-viewer');
  const pane = [...document.querySelectorAll('.documents-pane')].find((p) => p.getBoundingClientRect().width > 0);
  const img = viewer?.querySelector('.media-viewer-img');
  return {
    viewer: viewer ? {
      note: viewer.querySelector('.media-viewer-note')?.textContent ?? null,
      img: img ? { natural: img.naturalWidth + 'x' + img.naturalHeight, complete: img.complete, src: img.src.slice(0, 40) } : null,
      stageEmpty: !!viewer.querySelector('.media-viewer-stage') && !viewer.querySelector('.media-viewer-stage *'),
    } : null,
    pane: pane ? {
      editorKind: pane.querySelector('.documents-editor')?.getAttribute('data-kind') ?? null,
      rich: !!pane.querySelector('.documents-editor .ProseMirror'),
      richH1: pane.querySelector('.documents-editor .ProseMirror h1')?.textContent ?? null,
      richEditable: pane.querySelector('.documents-editor .ProseMirror')?.getAttribute('contenteditable') ?? null,
      code: !!pane.querySelector('.documents-editor .cm-editor'),
      codeEditable: pane.querySelector('.documents-editor .cm-content')?.getAttribute('contenteditable') ?? null,
      highlighted: pane.querySelectorAll('.documents-editor .cm-line span').length,
      qlImg: (() => { const i = pane.querySelector('.documents-editor img.ql-page'); return i ? i.naturalWidth + 'x' + i.naturalHeight : null; })(),
      head: pane.querySelector('.documents-head')?.textContent ?? null,
      note: pane.querySelector('.documents-outside')?.textContent ?? null,
      unshown: pane.querySelector('.documents-unshown')?.textContent ?? null,
      error: pane.querySelector('.documents-error')?.textContent ?? null,
      home: !!pane.querySelector('.docs-home'),
    } : null,
  };
})()`;

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: { ...process.env, REALM_HOME: home, REALM_ENABLE_FAKE_AGENT: "1", REALM_HTML_MENUS: "1", REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
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
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'realm');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await evalIn(c, `(() => { const h = document.documentElement; h.removeAttribute('data-window-inactive');
    new MutationObserver(() => h.hasAttribute('data-window-inactive') && h.removeAttribute('data-window-inactive')).observe(h, { attributes: true }); return true; })()`);

  const api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const space = (await api.call("spaces.list", {}))[0];
  const session = (await api.call("sessions.listAll", {}))[0];
  // Never a billed turn: the onboarding session is moved to the fake agent, and nothing is sent to it.
  await api.call("sessions.setAgent", { id: session.id, agentKind: "fake" }).catch(() => {});

  // The files, inside the space folder and outside it, and the index rows that make them this session's.
  fs.mkdirSync(outside, { recursive: true });
  const rows = [];
  let seq = 0;
  const now = Date.now();
  const add = (abs) => { rows.push({ abs, seq: ++seq }); };
  for (const [name, body] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(space.folderPath, name), body());
    fs.writeFileSync(path.join(outside, name), body());
    add(path.join(space.folderPath, name));
    add(path.join(outside, name));
  }
  for (const [name, body] of Object.entries(ODD)) { fs.writeFileSync(path.join(outside, name), body()); add(path.join(outside, name)); }
  add(path.join(outside, "gone.md")); // recorded, then deleted: never written at all
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  const sql = rows.map(({ abs, seq: s }) => {
    const name = path.basename(abs), ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
    return `INSERT INTO artifacts (id, session_id, seq, kind, path, name, ext, ts) VALUES (${q(`${session.id}:${s}:${abs}`)}, ${q(session.id)}, ${s}, 'output', ${q(abs)}, ${q(name)}, ${q(ext)}, ${now - s * 1000});`;
  }).join("\n");
  execFileSync("sqlite3", [path.join(home, "realm.db")], { input: sql });

  await openSideTool(c, null, "Documents");
  await until(() => evalIn(c, `document.querySelectorAll('.docs-home-section[aria-label="This session"] .docs-home-row').length >= 8`), 20000, "the session's rows");
  // Every row, not the first eight.
  await evalIn(c, `(() => { document.querySelector('.docs-home-section[aria-label="This session"] .docs-home-more')?.click(); return true; })()`);
  await sleep(400);

  const shoot = async (file) => {
    const shot = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, `${TAG}-${file}.png`), Buffer.from(shot.data, "base64"));
  };
  const backHome = async () => {
    await evalIn(c, `(() => {
      const v = document.querySelector('.media-viewer [aria-label="Close"]'); if (v) v.click();
      document.querySelector('.documents-home-tab .documents-tab-label')?.click(); return true; })()`);
    await until(() => evalIn(c, `!document.querySelector('.media-viewer') && !!document.querySelector('.docs-home-section[aria-label="This session"]')`), 8000, "back home");
    await evalIn(c, `(() => { const m = document.querySelector('.docs-home-section[aria-label="This session"] .docs-home-more'); if (m && m.textContent.startsWith('Show all')) m.click(); return true; })()`);
    await sleep(200);
  };

  const matrix = [];
  for (const { abs } of rows) {
    const where = abs.startsWith(space.folderPath + "/") ? "inside" : "outside";
    const name = path.basename(abs);
    const clicked = await evalIn(c, `(() => {
      const row = [...document.querySelectorAll('.docs-home-section[aria-label="This session"] .docs-home-row')]
        .find((r) => r.querySelector('.docs-home-open')?.title.split('\\n')[0] === ${JSON.stringify(where === "inside" ? name : abs.replace(/^\/Users\/[^/]+/, "~"))});
      if (!row) return false; row.querySelector('.docs-home-open').click(); return true; })()`);
    if (!clicked) { matrix.push({ where, name, state: "row not listed" }); continue; }
    await sleep(2500);
    const state = await evalIn(c, READ_STATE);
    matrix.push({ where, name, state });
    await shoot(`${where}-${name}`);
    await backHome();
  }
  fs.writeFileSync(path.join(SHOTS, `${TAG}-matrix.json`), JSON.stringify(matrix, null, 2));
  for (const m of matrix) console.log(`${m.where.padEnd(8)} ${m.name.padEnd(24)} ${JSON.stringify(m.state)}`);

  // The report's file, outside, in both faces: the shot a person compares with the bug's.
  for (const face of ["dark", "light"]) {
    await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
    const label = `Theme: ${face[0].toUpperCase()}${face.slice(1)}`;
    await evalIn(c, `(() => { const input = document.querySelector(".palette input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
      input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === ${JSON.stringify(label)});
      if (!hit) return null; hit.click(); return true; })()`), 3000, `palette row ${label}`);
    await sleep(500);
    await evalIn(c, `(() => { const row = [...document.querySelectorAll('.docs-home-section[aria-label="This session"] .docs-home-row')]
      .find((r) => r.querySelector('.docs-home-name')?.textContent === 'REPORT.md' && r.querySelector('.docs-home-open').title.includes('tool-rejection'));
      row.querySelector('.docs-home-open').click(); return true; })()`);
    await sleep(2500);
    await shoot(`${face}-outside-REPORT.md`);
    await backHome();
  }
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
