/**
 * Live check for the pane bar's closing control (run with: node apps/desktop/scripts/pane-close-live.mjs)
 *
 * A destination page, terminal, browser or documents pane now ends its bar in the TRASH rather than
 * the ×, because a layout-only close left the row behind in the space — the pane looked closed and
 * the space said otherwise. jsdom can assert the button exists; only a real window can answer the
 * two things that actually matter here:
 *
 *   1. **The row is gone from the sidebar.** That is the whole complaint, and it lives across two
 *      surfaces at once — the pane host and the item list. A test that renders one of them can only
 *      ever check half of it.
 *   2. **The confirm fits its bar.** "Really delete?" is TEXT where every neighbour is a 14px glyph.
 *      A stylesheet cannot say whether it pushes the title into an ellipsis; a rendered box can.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9377), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8943);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-pane-close-live-"));
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

const HELPERS = `
globalThis.__live = {
  box: (n) => { const b = n.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; },
  dest(label) {
    const row = [...document.querySelectorAll('.sb-destinations .dest-row')].find((b) => b.textContent.trim().startsWith(label));
    if (!row) throw new Error('no destination: ' + label);
    row.click();
    return true;
  },
  /** The bar of the pane whose title matches, wherever the layout has put it. */
  bar(title) {
    const bars = [...document.querySelectorAll('.panel-bar')];
    const b = bars.find((x) => x.querySelector('.panel-title')?.textContent.trim() === title);
    if (!b) throw new Error('no pane bar: ' + title + ' (have: ' + bars.map((x) => x.querySelector('.panel-title')?.textContent).join('|') + ')');
    return b;
  },
  /** Every title the sidebar's OPEN + archived item lists are showing. */
  sidebarTitles: () => [...document.querySelectorAll('.item-list .item-title')].map((n) => n.textContent.trim()),
  paneTitles: () => [...document.querySelectorAll('.panel-title')].map((n) => n.textContent.trim()),
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

const shot = async (c, tag, clip) => {
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 3 } } : {}) });
  const out = path.join(os.tmpdir(), `realm-pane-close-live-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
};

/** The bar's trailing control, and what the title beside it had to give up for it. */
const barState = (title) => `(() => {
  const bar = __live.bar(${JSON.stringify(title)});
  const btns = [...bar.querySelectorAll('.panel-actions .icon-btn')];
  const last = btns[btns.length - 1];
  const t = bar.querySelector('.panel-title');
  return { last: last.getAttribute('aria-label'), danger: last.classList.contains('danger'),
           icon: last.querySelector('svg') ? 'glyph' : last.textContent.trim(),
           closeButtons: btns.filter((b) => /^Close /.test(b.getAttribute('aria-label') ?? '')).length,
           bar: __live.box(bar), title: __live.box(t), titleClipped: t.scrollWidth > t.clientWidth + 1 };
})()`;

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
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 950, deviceScaleFactor: 2, mobile: false });
  await sleep(500);

  /* ── 1. Every destination page's bar ends in the trash ──────────────────── */
  for (const [dest, title] of [["Agents", "Agents"], ["Library", "Library"], ["Connections", "Connections"],
                               ["Notifications", "Notifications"], ["Settings", "Settings"]]) {
    await evalIn(c, `__live.dest(${JSON.stringify(dest)})`);
    await until(() => evalIn(c, `__live.paneTitles().includes(${JSON.stringify(title)})`), 15000, `${dest} pane`);
    await sleep(300);
    const s = await evalIn(c, barState(title));
    check(`${dest}: the bar's last control is Delete, not Close`, s.last === `Delete ${title}` && s.closeButtons === 0, s);
    check(`${dest}: it is drawn as the danger glyph`, s.danger && s.icon === "glyph", { danger: s.danger, icon: s.icon });
  }
  await shot(c, "page-bar", { x: 0, y: 0, width: 1500, height: 120 });

  /* ── 2. One click on a page's trash, and the space forgets it ───────────── */
  const before = await evalIn(c, `__live.sidebarTitles()`);
  check("the closed-over complaint exists to begin with: Settings is a row in the space", before.includes("Settings"), before);
  await evalIn(c, `__live.bar("Settings").querySelector('.panel-actions .icon-btn.danger').click()`);
  await sleep(700);
  const after = await evalIn(c, `({ sidebar: __live.sidebarTitles(), panes: __live.paneTitles() })`);
  // The point of the change, and the half a component test cannot see: BOTH surfaces let go.
  check("one click: the Settings pane is gone", !after.panes.includes("Settings"), after.panes);
  check("one click: the Settings row is gone from the space", !after.sidebar.includes("Settings"), after.sidebar);

  /* ── 3. A terminal arms first, and its confirm fits the bar ─────────────── */
  // A terminal item is titled after its cwd's basename, so the new pane is found by DIFFING the
  // bar titles rather than by matching a word the server never promised.
  const beforeTerm = await evalIn(c, `__live.paneTitles()`);
  await evalIn(c, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true }))`);
  const termTitle = await until(
    () => evalIn(c, `__live.paneTitles().find((x) => !${JSON.stringify(beforeTerm)}.includes(x)) ?? null`),
    20000, "terminal pane");
  await sleep(400);
  const armed0 = await evalIn(c, barState(termTitle));
  check(`terminal: the bar's last control is Delete`, armed0.last === `Delete ${termTitle}`, armed0);
  await evalIn(c, `__live.bar(${JSON.stringify(termTitle)}).querySelector('.panel-actions .icon-btn.danger').click()`);
  await sleep(350);
  const armed = await evalIn(c, barState(termTitle));
  check("terminal: one click ARMS rather than deletes", armed.last === `Really delete ${termTitle}?`, armed);
  check("terminal: the pane is still open", (await evalIn(c, `__live.paneTitles()`)).includes(termTitle), null);
  // The measurement the stylesheet cannot make: a text button among glyphs, in a bar that also has
  // to hold a title, back/forward and the ⋯ menu.
  check("terminal: the armed confirm does not crush the pane title",
    !armed.titleClipped && armed.title.w === armed0.title.w, { armed: armed.title, resting: armed0.title });
  check("terminal: the confirm stays inside its bar", armed.bar.h <= armed0.bar.h + 1, { armed: armed.bar, resting: armed0.bar });
  await shot(c, "terminal-armed", { x: 0, y: 0, width: 1500, height: 120 });

  await evalIn(c, `__live.bar(${JSON.stringify(termTitle)}).querySelector('.panel-actions .icon-btn.danger').click()`);
  await sleep(800);
  const gone = await evalIn(c, `({ sidebar: __live.sidebarTitles(), panes: __live.paneTitles() })`);
  check("terminal: the confirm deletes it from pane and space alike",
    !gone.panes.includes(termTitle) && !gone.sidebar.includes(termTitle), gone);

  /* ── 4. A session still closes WITHOUT deleting — the rule that stands ──── */
  const sessionTitle = await evalIn(c, `(() => {
    const row = [...document.querySelectorAll('.item-list .item .item-row')]
      .find((r) => r.querySelector('.item-title')?.textContent.trim() === 'New session');
    if (!row) return null;
    row.click();
    return row.querySelector('.item-title').textContent.trim(); })()`);
  check("a session pane is reachable to compare against", sessionTitle !== null, sessionTitle);
  if (sessionTitle) {
    await until(() => evalIn(c, `__live.paneTitles().includes(${JSON.stringify(sessionTitle)})`), 15000, "session pane");
    await sleep(400);
    const s = await evalIn(c, barState(sessionTitle));
    check("session: its bar still ends in Close — a transcript outlives the pane that showed it",
      s.last === `Close ${sessionTitle}` && !s.danger, s);
  }

  c.close();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    if (electron) { electron.kill("SIGTERM"); await sleep(700); electron.kill("SIGKILL"); }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
