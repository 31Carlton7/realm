/**
 * Live check: a session's row stays where it is when it is selected, and comes to the top when it is
 * prompted (run with: node apps/desktop/scripts/sidebar-order-live.mjs, after `pnpm build`).
 *
 * The report: "if we select a session it removes the session from the sidebar like it kind of moves
 * it". Two things moved it. The sidebar ordered sessions by `updatedAt`, which every write to the row
 * moves — a resume's init, a status, a cursor — and it ranked unread sessions above read ones, so
 * opening a session read it and dropped it down its space, under "Show more" when the others were
 * unread too.
 *
 * Eight fake-agent sessions in one space, each prompted in turn and each left unread. The fifth row is
 * clicked; its index and its y are read before and after, and its row's `updatedAt` and `activityAt`
 * from the server. Then a prompt is typed into its composer, and the row is read again.
 *
 * Fake agent only: onboarding's session is switched to `fake` before anything is sent, and the seeded
 * ones are made fake. Ports are env-overridable; the server and Electron are reaped by port and the
 * scratch home deleted.
 */
import { spawn, execSync } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9258), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8818);
const OUT = process.env.LIVE_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), "realm-sidebar-order-shots-"));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-sidebar-order-live-"));
const home = path.join(scratch, "home");
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
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
  });
  return { ws, ready, pending, next: () => String(++id) };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      s.ws.send(JSON.stringify({ id: Number(i), method, params }));
    }),
    close: () => s.ws.close(),
  };
}

function rpc(port, token) {
  const s = socket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  return {
    ready: s.ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = s.next();
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

async function press(c, key) {
  for (const type of ["keyDown", "keyUp"]) {
    await c.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      ...(type === "keyDown" ? { text: "\r" } : {}) });
  }
}

async function click(c, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** The Live section's session rows, top to bottom: title and y. The "New session" row and Show more
 *  are not session rows. */
const ROWS = `(() => [...document.querySelectorAll('.sb-section[aria-label="Live"] .sb-row')]
  .filter((r) => !r.querySelector('.sb-start'))
  .map((r) => { const b = r.querySelector('.item-row').getBoundingClientRect();
    return { title: r.querySelector('.item-title')?.textContent ?? '', y: Math.round(b.top), x: Math.round(b.left + b.width / 2), h: Math.round(b.height),
      unread: r.dataset.unread === 'true', active: r.dataset.active === 'true' }; }))()`;

async function shot(c, name) {
  const r = await evalIn(c, `(() => { const b = document.querySelector('.sb-section[aria-label="Live"]').getBoundingClientRect();
    return { x: Math.max(0, b.left - 8), y: Math.max(0, b.top - 8), width: b.width + 16, height: b.height + 16 }; })()`);
  const s = await c.send("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 2 } });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(s.data, "base64"));
  const full = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(file.replace(/\.png$/, "-window.png"), Buffer.from(full.data, "base64"));
  console.log("  shot", file);
}

function reapPorts() {
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) {
      const cmd = execSync(`ps -o command= -p ${pid} || true`, { encoding: "utf8" });
      // Only this worktree's Electron — never the user's /Applications/Realm.app.
      if (cmd.includes(repoRoot)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    }
  }
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_ENABLE_FAKE_AGENT: "1",
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
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  const api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const first = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15000, "onboarding's session");
  // Onboarding's session runs the first engine this Mac has — a real, billed one. Fake, before anything.
  for (const s of first) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  const spaceId = first[0].spaceId;

  /* Eight sessions, each prompted in turn — so each has a real activity time, newest last — and each
     left unread: read up to just short of its last event, the way a reply that landed while you were
     elsewhere leaves it. */
  const made = [];
  for (let i = 1; i <= 8; i++) {
    const { session, itemId } = await api.call("sessions.create", { spaceId, agentKind: "fake", title: `Task ${i}` });
    await api.call("items.update", { id: itemId, title: `Task ${i}` });
    await api.call("sessions.send", { id: session.id, text: `Do task ${i}`, attachments: [], mentions: [] });
    const done = await until(async () => { const s = await api.call("sessions.get", { id: session.id }); return s.status === "idle" && s.lastEventSeq > 0 ? s : null; }, 15000, `task ${i} settles`);
    await api.call("sessions.markSeen", { id: session.id, seq: done.lastEventSeq - 1 });
    made.push({ id: session.id, itemId, title: `Task ${i}` });
    await sleep(120);
  }
  // A fresh renderer over the seeded home, rather than one patched by broadcasts as they came.
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.querySelectorAll('.sb-section[aria-label="Live"] .sb-row').length >= 5`), 20000, "the Live section");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const root = document.documentElement; root.removeAttribute('data-window-inactive');
    new MutationObserver(() => root.removeAttribute('data-window-inactive')).observe(root, { attributes: true, attributeFilter: ['data-window-inactive'] });
    return true; })()`);
  await sleep(800);

  const before = await evalIn(c, ROWS);
  console.log("before:", before.map((r) => `${r.title}@${r.y}${r.unread ? "*" : ""}`).join("  "));
  check("the section lists the newest five, newest first", before.slice(0, 5).map((r) => r.title).join(",") === "Task 8,Task 7,Task 6,Task 5,Task 4", before.map((r) => r.title));
  const fifth = before[4];
  check("the fifth row is unread before it is opened", fifth.unread, fifth);
  const target5 = made.find((m) => m.title === fifth.title);
  const rowBefore = await api.call("sessions.get", { id: target5.id });
  await shot(c, "1-before-select.png");

  // ── Select it ──
  await click(c, fifth.x, fifth.y + fifth.h / 2);
  await until(() => evalIn(c, `(() => { const r = [...document.querySelectorAll('.sb-section[aria-label="Live"] .sb-row')].find((x) => x.querySelector('.item-title')?.textContent === ${JSON.stringify(fifth.title)}); return r?.dataset.active === 'true'; })()`), 10000, "the row is the focused session");
  await sleep(2500); // whatever opening it writes — the read mark, a status, a refetch — has landed
  const afterSelect = await evalIn(c, ROWS);
  const rowAfter = await api.call("sessions.get", { id: target5.id });
  console.log("after select:", afterSelect.map((r) => `${r.title}@${r.y}${r.unread ? "*" : ""}`).join("  "));
  const idx = afterSelect.findIndex((r) => r.title === fifth.title);
  check("selecting it leaves it at the same index", idx === 4, { before: 4, after: idx });
  check("…and at the same y", idx >= 0 && afterSelect[idx].y === fifth.y, { before: fifth.y, after: afterSelect[idx]?.y });
  check("…and it was read by being opened (the ring is gone)", idx >= 0 && !afterSelect[idx].unread, afterSelect[idx]);
  check("no other row moved either", afterSelect.map((r) => r.title).join() === before.map((r) => r.title).join(), afterSelect.map((r) => r.title));
  console.log("  server row:", { updatedAt: [rowBefore.updatedAt, rowAfter.updatedAt], activityAt: [rowBefore.activityAt, rowAfter.activityAt], seenSeq: [rowBefore.seenSeq, rowAfter.seenSeq] });
  check("the server's activity time did not move on select", rowAfter.activityAt === rowBefore.activityAt, { before: rowBefore.activityAt, after: rowAfter.activityAt });
  await shot(c, "2-after-select.png");

  // ── Prompt it, from its own composer ──
  await evalIn(c, `(() => { document.querySelector('.composer-input').focus(); return true; })()`);
  await c.send("Input.insertText", { text: "One more thing" });
  await press(c, "Enter");
  const moved = await until(async () => { const r = await evalIn(c, ROWS); return r[0]?.title === fifth.title ? r : null; }, 10000, "the prompted row at the top").catch(() => null);
  const afterPrompt = moved ?? await evalIn(c, ROWS);
  console.log("after prompt:", afterPrompt.map((r) => `${r.title}@${r.y}${r.unread ? "*" : ""}`).join("  "));
  check("prompting it moves it to index 0", afterPrompt[0]?.title === fifth.title, afterPrompt.map((r) => r.title));
  check("…and the rest keep their order beneath it", afterPrompt.slice(1, 5).map((r) => r.title).join(",") === "Task 8,Task 7,Task 6,Task 5", afterPrompt.map((r) => r.title));
  const rowPrompted = await until(async () => { const s = await api.call("sessions.get", { id: target5.id }); return s.activityAt > rowAfter.activityAt ? s : null; }, 10000, "server activity").catch(() => null);
  check("the server confirms it: activityAt moved", !!rowPrompted, { before: rowAfter.activityAt, after: rowPrompted?.activityAt });
  await sleep(600);
  await shot(c, "3-after-prompt.png");

  api.close();
  c.close();
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(async () => {
    try { electron?.kill("SIGKILL"); } catch { /* gone */ }
    await stopDaemons(home);
    reapPorts();
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log("shots in", OUT);
  });
