/**
 * Live check for the agents rail (run with: node apps/desktop/scripts/agents-rail-live.mjs)
 *
 * What the unit tests cannot see, because jsdom lays nothing out:
 *
 *  - the rail is a COLUMN — opening it takes its width from the panes, rather than floating over them;
 *  - nothing scrolls sideways, open or closed. The sidebar hides with a negative start margin, and the
 *    mirror of that on the right would have made the whole window horizontally scrollable;
 *  - closed, its toggle in the top-right corner does not sit on the top-right pane's own controls;
 *  - a page opened over the panes stops at the rail on the right and at the sidebar's REAL width on
 *    the left — the second half being an older bug this change fixed;
 *  - and the point of it: an agent waiting in ANOTHER space is listed, and one click lands its session.
 *
 * Agents are parked on a permission the fake agent holds open ("ask me") — the one state a session
 * stays in long enough to measure, found by the Agents wall's own live check.
 *
 * Ports: env-overridable. Touches only a scratch dir; reaps only the ports it chose.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9383), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8953);
const shots = process.env.LIVE_SHOT_DIR ?? "/tmp/realm-rail-live";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-rail-live-"));
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

async function shoot(c, name, clip) {
  const { data } = await c.send("Page.captureScreenshot", clip ? { clip: { ...clip, scale: 2 } } : {});
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  shot ${file}`);
}

async function chord(c, { key, code, vk, meta = false, alt = false, shift = false }) {
  const modifiers = (alt ? 1 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
  for (const type of ["keyDown", "keyUp"]) {
    await c.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  }
}

/** The geometry every assertion below is made of, read in one pass so the numbers agree. */
const GEOM = `(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; };
  const doc = document.documentElement;
  return {
    inner: innerWidth,
    scrollW: doc.scrollWidth,
    main: box(document.querySelector('.main')),
    rail: box(document.querySelector('.rail')),
    sidebar: box(document.querySelector('.sidebar')),
    corner: box(document.querySelector('.rail-corner button')),
    railOpen: document.querySelector('.app')?.hasAttribute('data-rail-open') ?? null,
  };
})()`;

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper], {
    env: {
      ...process.env,
      REALM_HOME: path.join(scratch, "home"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", (d) => process.stderr.write(`    [electron] ${d}`));
  electron.stdout.on("data", (d) => process.stderr.write(`    [electron] ${d}`));

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const t = await until(async () => (await targets()).find((x) => x.type === "page" && x.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(t.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Here'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
  await sleep(500);

  // ---- a second space, with an agent waiting in it ---------------------------------------------
  const api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const here = (await api.call("spaces.list", {}))[0];
  const elsewhere = await api.call("spaces.create", { profileId: here.profileId, name: "Elsewhere" });
  const { session: away } = await api.call("sessions.create", { spaceId: elsewhere.id, agentKind: "fake", title: "Waiting over there" });
  // Not awaited: the send resolves only when the permission is answered, which is the point.
  void api.call("sessions.send", { id: away.id, text: "ask me" }).catch(() => {});
  await sleep(1200);

  // ---- 1. closed: a corner toggle, no column, nothing to scroll ----------------------------------
  const closed = await evalIn(c, GEOM);
  console.log(`  closed: ${JSON.stringify(closed)}`);
  check("closed, the rail takes no width", closed.rail && closed.rail.w === 0, closed.rail);
  check("closed, the toggle waits in the top-right corner", closed.corner && closed.corner.right <= closed.inner && closed.corner.right > closed.inner - 60, closed.corner);
  check("closed, nothing scrolls sideways", closed.scrollW <= closed.inner, { scrollW: closed.scrollW, inner: closed.inner });

  /* The corner must not sit on the top-right pane's own controls. Measured as the rightmost control
     in that pane's bar against the corner button's left edge. */
  const clearance = await evalIn(c, `(() => {
    const bar = document.querySelector('.panel[data-top-right-leaf] > .panel-bar');
    const btn = document.querySelector('.rail-corner button');
    if (!bar || !btn) return null;
    const ctrls = [...bar.querySelectorAll('button')].map((b) => b.getBoundingClientRect().right);
    return { lastControlRight: Math.round(Math.max(...ctrls)), cornerLeft: Math.round(btn.getBoundingClientRect().left),
             padRight: getComputedStyle(bar).paddingRight };
  })()`);
  console.log(`  corner clearance: ${JSON.stringify(clearance)}`);
  check("the top-right pane's controls stop short of the corner toggle",
    clearance && clearance.lastControlRight <= clearance.cornerLeft, clearance);
  await shoot(c, "01-closed-corner", { x: 640, y: 0, width: 640, height: 120 });

  // ---- 2. ⌥⌘B opens it as a column -------------------------------------------------------------
  await chord(c, { key: "∫", code: "KeyB", vk: 66, meta: true, alt: true });
  await until(() => evalIn(c, `document.querySelector('.app').hasAttribute('data-rail-open')`), 5000, "rail open");
  await sleep(700); // past the width transition
  const open = await evalIn(c, GEOM);
  console.log(`  open: ${JSON.stringify(open)}`);
  check("⌥⌘B opens the rail", open.railOpen === true);
  check("open, the rail is 264px of real column", open.rail && open.rail.w === 264, open.rail);
  check("…taken from the panes, not floated over them", closed.main.w - open.main.w === 264,
    { before: closed.main.w, after: open.main.w, diff: closed.main.w - open.main.w });
  check("the rail sits flush against the window's right edge", open.rail.right === open.inner, { right: open.rail.right, inner: open.inner });
  check("open, nothing scrolls sideways either", open.scrollW <= open.inner, { scrollW: open.scrollW, inner: open.inner });
  check("the corner toggle has moved into the rail's head", open.corner === null);

  // ---- 3. it lists the agent in the other space ------------------------------------------------
  const listed = await until(() => evalIn(c, `(() => {
    const rows = [...document.querySelectorAll('.rail .rail-row')].map((r) => r.textContent);
    const groups = [...document.querySelectorAll('.rail .rail-group-label')].map((g) => g.textContent);
    return rows.some((t) => t.includes('Waiting over there')) ? { rows, groups } : null;
  })()`), 15000, "agent listed");
  console.log(`  listed: ${JSON.stringify(listed)}`);
  check("an agent waiting in ANOTHER space is listed", !!listed);
  check("…under Needs you", listed.groups.includes("Needs you"), listed.groups);
  check("…naming the space it is in", listed.rows.some((t) => t.includes("Elsewhere")), listed.rows);
  await shoot(c, "02-rail-open");

  // ---- 4. one click lands it -------------------------------------------------------------------
  const activeBefore = await evalIn(c, `document.querySelector('.space-title')?.textContent?.trim() ?? null`);
  await evalIn(c, `[...document.querySelectorAll('.rail .rail-row')].find((r) => r.textContent.includes('Waiting over there')).click()`);
  const landed = await until(() => evalIn(c, `(() => {
    const title = document.querySelector('.space-title')?.textContent?.trim() ?? null;
    const pane = [...document.querySelectorAll('.panel .panel-bar')].some((b) => b.textContent.includes('Waiting over there'));
    return title === 'Elsewhere' && pane ? { title, pane } : null;
  })()`), 15000, "landed");
  console.log(`  landed: space before=${activeBefore} after=${landed.title}`);
  check("one click switches to the agent's space", activeBefore !== "Elsewhere" && landed.title === "Elsewhere", { activeBefore, after: landed.title });
  check("…and opens its session as a pane", landed.pane === true);
  check("the rail survives the space switch", await evalIn(c, `document.querySelector('.app').hasAttribute('data-rail-open')`));
  const current = await evalIn(c, `[...document.querySelectorAll('.rail .rail-row[aria-current]')].map((r) => r.textContent)`);
  check("…and marks the session you are now in", current.length === 1 && current[0].includes("Waiting over there"), current);
  await shoot(c, "03-landed");

  // ---- 5. a page stops at the rail, and at the sidebar's REAL width ------------------------------
  /* Widen the sidebar off its 280px default first — at the default, the old bug is invisible,
     because the stale value it read happened to be the right one. */
  await evalIn(c, `document.querySelector('.sb-resize').focus()`);
  for (let i = 0; i < 3; i++) await chord(c, { key: "ArrowRight", code: "ArrowRight", vk: 39 });
  // Let go of the handle, or its keyboard-focus line is still lit down the sidebar's edge in the
  // capture — which reads as a stray border the rail introduced, and is not one.
  await evalIn(c, `document.activeElement?.blur(); true`);
  await sleep(500);
  await evalIn(c, `(() => { const row = [...document.querySelectorAll('.sb-destinations .dest-row')].find((b) => b.textContent.trim().startsWith('Agents')); row.click(); return true; })()`);
  const page = await until(() => evalIn(c, `(() => {
    const p = document.querySelector('.page-overlay'); if (!p) return null;
    const r = p.getBoundingClientRect(), s = document.querySelector('.sidebar').getBoundingClientRect(), rl = document.querySelector('.rail').getBoundingClientRect();
    return { pageLeft: Math.round(r.left), pageRight: Math.round(r.right), sidebarRight: Math.round(s.right), railLeft: Math.round(rl.left) };
  })()`), 10000, "page overlay");
  console.log(`  page: ${JSON.stringify(page)}`);
  check("the sidebar really was widened off its default", page.sidebarRight !== 280, page.sidebarRight);
  check("a page starts where the sidebar ACTUALLY ends", page.pageLeft === page.sidebarRight, page);
  check("…and stops where the rail begins", page.pageRight === page.railLeft, page);
  /* The page fades in, and a capture taken as it appears shows the pane underneath through it —
     overlapping text that looks like a layering bug. Wait out the entrance before photographing. */
  await sleep(700);
  await shoot(c, "04-page-between");
  await chord(c, { key: "Escape", code: "Escape", vk: 27 });
  await sleep(400);

  // ---- 6. ⌥⌘B closes it, and the panes take the width back -------------------------------------
  await chord(c, { key: "∫", code: "KeyB", vk: 66, meta: true, alt: true });
  await until(() => evalIn(c, `!document.querySelector('.app').hasAttribute('data-rail-open')`), 5000, "rail closed");
  await sleep(700);
  const reclosed = await evalIn(c, GEOM);
  check("⌥⌘B closes it to no width at all", reclosed.rail.w === 0, reclosed.rail);
  check("…the toggle is back in the corner", reclosed.corner !== null);
  check("…and nothing scrolls sideways", reclosed.scrollW <= reclosed.inner, reclosed);

  api.close();
  c.close();
}

/** The server is a second Electron process holding REALM_PORT; killing the parent leaves it running.
 *  Reap by port, so an interrupted run's orphan is cleared too — only the ports this script chose. */
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
  .finally(reap);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { reap(); process.exit(1); });
