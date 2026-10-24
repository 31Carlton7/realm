/**
 * Live check for the prompter's queue (run with: node apps/desktop/scripts/queued-ui-live.mjs).
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent, starts a turn that runs for
 * minutes, and queues behind it through the server's own `sessions.send` — one message with two files,
 * then two, then four — editing one on the way. Each state is photographed dark and light, at a normal
 * window and at one narrow enough for the pane's 420px rung, into LIVE_SHOT_DIR, for a person to judge
 * against the prompter it sits in. The layout facts a unit test cannot see are checked as it goes:
 * that two lines of a long message show, that the actions are on screen without a hover, and that the
 * narrow pane really is under its rung.
 *
 * Ports: LIVE_CDP_PORT / LIVE_SERVER_PORT, defaulting to a pair a running Realm does not use. Touches
 * only its scratch dir; reaps what it started by port.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9272), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8832);
const shots = process.env.LIVE_SHOT_DIR ?? path.join(os.tmpdir(), "realm-queued-ui");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-queued-ui-"));
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
  const events = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") events.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  });
  return { ws, ready, events, pending, next: () => ++id };
}

function cdp(url) {
  const s = socket(url);
  return {
    ready: s.ready, events: s.events,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
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
    close: () => s.ws.close(),
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

/** A small real PNG (a 64×40 gradient drawn in the page and written out) and a one-page PDF. */
function makePdf() {
  const content = "BT /F1 24 Tf 60 700 Td (Realm queue check) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const LONG_TURN = "Start the long refactor";
const MESSAGES = [
  "I changed the icon here, but in the top left it still shows like a folder of one of the old spaces — can you check where the sidebar reads the space's icon from and make it use the new one everywhere?",
  "Also run the queue tests again once that lands.",
  "Then update the changelog with both fixes, in the voice the last three entries use.",
  "And open a draft PR when it is all green.",
];

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);

  const words = Array.from({ length: 400 }, (_, i) => `step${i}`).join(" ");
  const script = path.join(scratch, "fake-script.json");
  fs.writeFileSync(script, JSON.stringify([{ on: LONG_TURN, emit: [{ kind: "text", paceMs: 2000, text: `Working through the refactor. ${words}` }] }]));
  const files = path.join(scratch, "files");
  fs.mkdirSync(files);
  fs.writeFileSync(path.join(files, "sidebar-icon.pdf"), makePdf());

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const home = path.join(scratch, "home");
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_FAKE_SCRIPT: script,
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
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  globalThis.__c = c;
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  // The window opens behind whoever is at the Mac; without focus Realm goes quiet.
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  // A picture for the attachment chip: drawn in the page, so it is a real decodable PNG on disk.
  const pngB64 = await evalIn(c, `(() => {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 40;
    const g = cv.getContext('2d'); const gr = g.createLinearGradient(0, 0, 64, 40);
    gr.addColorStop(0, '#5b8def'); gr.addColorStop(1, '#f2a65a'); g.fillStyle = gr; g.fillRect(0, 0, 64, 40);
    return cv.toDataURL('image/png').split(',')[1]; })()`);
  fs.writeFileSync(path.join(files, "Screenshot 2026-10-12 at 09.14.png"), Buffer.from(pngB64, "base64"));

  const api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const session = await until(async () => (await api.call("sessions.listAll", {}))[0] ?? null, 15000, "a session");
  await api.call("sessions.setAgent", { id: session.id, agentKind: "fake" });
  await api.call("sessions.send", { id: session.id, text: LONG_TURN });
  await until(() => evalIn(c, `!!document.querySelector('.composer-send[data-state="stop"]')`), 15000, "the long turn running");

  const viewports = { normal: { width: 1280, height: 820 }, narrow: { width: 700, height: 820 } };
  const shoot = async (state, prep = async () => {}) => {
    for (const [vp, size] of Object.entries(viewports)) {
      await c.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2, mobile: false });
      await sleep(350);
      for (const mode of ["dark", "light"]) {
        await evalIn(c, `document.documentElement.dataset.mode = ${JSON.stringify(mode)}; true`);
        await prep();
        await sleep(350);
        const box = await evalIn(c, `(() => {
          const pane = document.querySelector('.session-pane').getBoundingClientRect();
          const card = document.querySelector('.composer').getBoundingClientRect();
          const top = Math.max(pane.top, card.top - 150);
          return { x: Math.round(pane.left), y: Math.round(top), width: Math.round(pane.width), height: Math.round(Math.min(pane.bottom, card.bottom + 24) - top), pane: Math.round(pane.width) }; })()`);
        const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } });
        const file = path.join(shots, `${state}-${vp}-${mode}.png`);
        fs.writeFileSync(file, Buffer.from(data, "base64"));
        console.log(`SHOT ${file} (pane ${box.pane}px)`);
      }
    }
    await c.send("Emulation.setDeviceMetricsOverride", { ...viewports.normal, deviceScaleFactor: 2, mobile: false });
    await evalIn(c, `document.documentElement.dataset.mode = 'dark'; true`);
    await sleep(250);
  };
  // The count the tray says, not its rows: folded, it draws none.
  const rowCount = async () => Number((await evalIn(c, `document.querySelector('.composer-queue')?.dataset.count ?? "0"`)));
  const queue = async (text, attachments = []) => {
    const before = await rowCount();
    await api.call("sessions.send", { id: session.id, text, attachments, delivery: "queue" });
    try {
      await until(async () => (await evalIn(c, `document.querySelector('.composer-queue')?.dataset.count`)) === String(before + 1) || null, 8000, "the queued row");
    } catch (e) {
      console.log("STATE", JSON.stringify({ before, server: (await api.call("sessions.queued", { id: session.id })).queued.map((q) => [q.text.slice(0, 20), q.held]),
        dom: await evalIn(c, `({ count: document.querySelector('.composer-queue')?.dataset.count, head: document.querySelector('.queue-head')?.textContent, stop: !!document.querySelector('.composer-send[data-state="stop"]') })`) }));
      throw e;
    }
    await sleep(450);
  };

  // 1 — one message, with a picture and a PDF.
  await queue(MESSAGES[0], [
    { path: path.join(files, "Screenshot 2026-10-12 at 09.14.png"), mime: "image/png" },
    { path: path.join(files, "sidebar-icon.pdf"), mime: "application/pdf" },
  ]);
  await until(() => evalIn(c, `document.querySelectorAll('.queue-file .attach-thumb').length === 2 || null`), 20000, "both chips' pictures");
  const one = await evalIn(c, `(() => {
    const t = document.querySelector('.queue-text'); const lh = parseFloat(getComputedStyle(t).lineHeight);
    const a = [...document.querySelectorAll('.composer-queue-item .queue-actions > button')].map((b) => ({ cls: b.className, o: getComputedStyle(b).opacity, w: b.getBoundingClientRect().width }));
    return { lines: Math.round(t.getBoundingClientRect().height / lh), head: document.querySelector('.queue-head').textContent, actions: a }; })()`);
  check("a long queued message shows two lines of itself", one.lines === 2, one.lines);
  check("the head says what it is and when it goes", one.head.includes("Queued") && one.head.includes("this turn ends"), one.head);
  check("Edit, Send now and Remove are on screen with no hover", one.actions.length === 3 && one.actions.every((x) => Number(x.o) > 0.9 && x.w > 0), one.actions);
  await shoot("1-one");

  // 2 — two messages.
  await queue(MESSAGES[1]);
  await shoot("2-two");
  // Hovering the second row reveals its handle and steps.
  const hoverRow = async () => {
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
    const at = await evalIn(c, `(() => { const b = document.querySelectorAll('.composer-queue-item')[1].getBoundingClientRect(); return { x: b.x + 120, y: b.y + b.height / 2 }; })()`);
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await sleep(250);
  };
  await hoverRow();
  check("hovering a row shows its reorder steps, and only that row's",
    (await evalIn(c, `[...document.querySelectorAll('.composer-queue-item .queue-steps')].map((x) => getComputedStyle(x).opacity).sort().join()`)) === "0,1");
  await shoot("2-two-hover", hoverRow);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });

  // Editing the second: held, the field open, the keys named.
  await evalIn(c, `(() => { document.querySelectorAll('.composer-queue-item .queue-edit-btn')[1].click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.queue-edit')`), 5000, "the edit field");
  await evalIn(c, `(() => { const ta = document.querySelector('.queue-edit');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ta.value + ' And the server suite.');
    ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(300);
  await shoot("3-editing");
  // The shoot loop moved focus nowhere, but be sure the field is still the one open, then let go.
  await evalIn(c, `(() => { document.querySelector('.queue-edit').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!document.querySelector('.queue-edit')`), 5000, "the edit closed");

  // 4 — four messages fold to one line, and open to all of them.
  await queue(MESSAGES[2]);
  await queue(MESSAGES[3]);
  const folded = await evalIn(c, `({ rows: document.querySelectorAll('.composer-queue-item').length, head: document.querySelector('.queue-head').textContent })`);
  check("four queued fold to one line naming what goes next", folded.rows === 0 && folded.head.includes("4 queued") && folded.head.includes("Next:"), folded);
  await shoot("4-four-folded");
  await evalIn(c, `(() => { document.querySelector('.queue-fold').click(); return true; })()`);
  await sleep(400);
  await shoot("4-four-open");

  // The narrow rung is really reached at the narrow window.
  await c.send("Emulation.setDeviceMetricsOverride", { ...viewports.narrow, deviceScaleFactor: 2, mobile: false });
  await sleep(350);
  const narrow = await evalIn(c, `({ pane: Math.round(document.querySelector('.session-pane').getBoundingClientRect().width),
    label: getComputedStyle(document.querySelector('.queue-send-label')).display })`);
  check("the narrow window puts the pane under the 420px rung, and Send now becomes its arrow", narrow.pane <= 420 && narrow.label === "none", narrow);

  api.close();
  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  c.close();
}

/** The server is a second Electron holding REALM_PORT; reaped by port, and only the ports chosen here. */
function reap() {
  electron?.kill();
  for (const port of [SERVER_PORT, CDP_PORT]) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid)); } catch {} }
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(() => { reap(); setTimeout(() => process.exit(process.exitCode ?? 0), 300); });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { reap(); process.exit(1); });
