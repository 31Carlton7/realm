/**
 * Live check for the terminal dock's CARD (run with: node apps/desktop/scripts/terminal-dock-live.mjs)
 *
 * The dock shipped as a bare rectangle: flush to the pane's edges, square-cornered, with the
 * transcript showing through it. The cause was that the card look — surface, inset, radius, shadow —
 * was enumerated as `.session-summary, .subagent-dock`, and the terminal dock carried `.pane-dock`
 * like the others while nothing styled that class.
 *
 * Not one assertion in the suite could see it. `styles.test.ts` matches declaration TEXT, so a rule
 * that exists under a selector nothing MATCHES reads as present; jsdom lays nothing out, so an inset
 * of zero and an inset of six measure the same. Both of those are what this asks a real engine.
 *
 * Read-only: it measures, it does not fix. Touches only a scratch dir; kills only what it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9362), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8932);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-tdock-"));
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);

/**
 * The dock's card, as the engine resolved it — the five properties whose absence is exactly what the
 * bug looked like: a bare rectangle flush to the pane's edges with the transcript showing through.
 */
const DOCK = `(() => {
  const el = document.querySelector('.terminal-dock');
  if (!el) return null;
  const cs = getComputedStyle(el);
  const bar = document.querySelector('.terminal-dock-bar');
  const r = el.getBoundingClientRect();
  const pane = document.querySelector('.session-pane')?.getBoundingClientRect();
  return {
    background: cs.backgroundColor,
    radius: cs.borderTopLeftRadius + ' ' + cs.borderBottomRightRadius,
    cornerShape: cs.cornerShape ?? '(unsupported)',
    margin: cs.marginTop + ' ' + cs.marginRight,
    boxShadow: cs.boxShadow === 'none' ? 'none' : 'set',
    overflow: cs.overflow,
    barBorderBottom: bar ? getComputedStyle(bar).borderBottomWidth : null,
    // Inset from the pane on every side is what says "card over a page" rather than "flush panel".
    insetFromPaneRight: pane ? Math.round(pane.right - r.right) : null,
    insetFromPaneTop: pane ? Math.round(r.top - pane.top) : null,
    shellBg: (() => { const t = el.querySelector('.terminal-pane'); return t ? getComputedStyle(t).backgroundColor : null; })(),
  };
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
  const rendererTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(rendererTarget.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(500);

  /* ── Open the terminal dock ───────────────────────────────────────────────────────────────── */
  const toggle = await until(() => evalIn(c, `!!document.querySelector('button[aria-label^="Show terminal"]')`), 15000, "the terminal toggle");
  check("the pane bar offers a terminal toggle", toggle === true);
  await evalIn(c, `(() => { document.querySelector('button[aria-label^="Show terminal"]').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.terminal-dock')`), 15000, "the terminal dock");
  await sleep(500); // past the arrival animation, so these are settled values

  const d = await evalIn(c, DOCK);
  note("the terminal dock, as the engine resolved it", d);

  check("it has a surface — the bug was seeing the transcript through it",
    d.background !== "rgba(0, 0, 0, 0)" && d.background !== "transparent", d.background);
  check("its corners are rounded — the bug was square", d.radius !== "0px 0px", d.radius);
  check("it is inset from the pane on both axes — the bug was flush to the edge",
    d.insetFromPaneRight > 0 && d.insetFromPaneTop > 0, { right: d.insetFromPaneRight, top: d.insetFromPaneTop });
  check("it casts the overlay shadow, so it reads as over the pane rather than part of it", d.boxShadow === "set", d.boxShadow);
  check("it clips, so the shell cannot paint a square over the rounded corner", d.overflow === "hidden", d.overflow);
  check("there is NO rule under its title", d.barBorderBottom === "0px", d.barBorderBottom);

}

main()
  .catch((e) => { console.log(`FAIL harness ${e.message}`); process.exitCode = 1; })
  .finally(async () => {
    try { electron?.kill("SIGKILL"); } catch {}
    await sleep(200);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
