/**
 * Live check for the sidebar's resize handle (run with: node apps/desktop/scripts/sidebar-resize-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME and drags the column with real mouse input, because the
 * three things that can go wrong here are all things jsdom cannot have an opinion about:
 *
 *   1. The handle has to be HITTABLE. It is an 8px strip at the sidebar's right edge, and jsdom will
 *      happily dispatch a pointerdown at a coordinate no real pointer could reach — over a pane that
 *      paints above it, or outside a box that laid out at a different width than expected.
 *   2. The column has to actually move, and stop. The clamp is arithmetic, but "the panes take the
 *      room back" is layout.
 *   3. Collapsing has to still hide it. The animation is a negative margin of exactly the width
 *      variable, so a widened column that collapses to the OLD number leaves a strip on screen.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9354), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8920);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-sidebar-live-"));
const VIEWPORT = { width: 1280, height: 860 };
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
  const events = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      events.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });
  return {
    ready, events,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

const HELPERS = `
window.__live = window.__live ?? {
  setInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  /** What the shell is actually laid out as, rather than what it was asked for. */
  metrics() {
    const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
    const main = document.querySelector(".main").getBoundingClientRect();
    const handle = document.querySelector(".sb-resize").getBoundingClientRect();
    const round = (b) => ({ left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) });
    return { sidebar: round(sidebar), main: round(main), handle: round(handle),
      variable: getComputedStyle(document.querySelector(".app")).getPropertyValue("--sidebar-w").trim(),
      cursor: getComputedStyle(document.querySelector(".sb-resize")).cursor };
  },
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

const save = (tag, b64) => {
  const out = path.join(os.tmpdir(), `realm-sidebar-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(b64, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
};

/** A real drag: press on the handle, move in steps the way a hand does, release. */
async function dragTo(c, fromX, toX, y) {
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: fromX, y, button: "left", buttons: 1, clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(fromX + ((toX - fromX) * i) / steps), y, button: "left", buttons: 1 });
    await sleep(16);
  }
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: toX, y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(200);
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

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
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
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

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.setInput(input, "Live");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  await sleep(500);

  // ── 1. Where the handle is, and whether a pointer can land on it ─────────
  const rest = await evalIn(c, `__live.metrics()`);
  check("the column ships at its default width", rest.variable === "280px" && rest.sidebar.width === 280, rest);
  check("the handle is a strip on the column's own right edge",
    rest.handle.right === rest.sidebar.right && rest.handle.width === 8, rest.handle);
  check("it offers the resize cursor", rest.cursor === "col-resize", { cursor: rest.cursor });
  const y = Math.round(VIEWPORT.height / 2);
  const grabX = rest.sidebar.right - 4;
  const onTop = await evalIn(c, `(() => document.elementFromPoint(${grabX}, ${y})?.className ?? null)()`);
  check("nothing paints over it: a pointer at that edge hits the handle", onTop === "sb-resize", { at: grabX, hit: onTop });

  // ── 2. Dragging it ──────────────────────────────────────────────────────
  await dragTo(c, grabX, grabX + 80, y);
  const wide = await evalIn(c, `__live.metrics()`);
  check("the drag widens the column by what the pointer travelled", wide.sidebar.width === 360, wide.sidebar);
  check("the panes give up exactly that room", wide.main.left === wide.sidebar.right && wide.main.width === VIEWPORT.width - 360,
    { main: wide.main, window: VIEWPORT.width });
  check("the drag leaves no resize cursor behind",
    await evalIn(c, `!document.documentElement.hasAttribute("data-sidebar-resizing")`));
  save("wide", (await c.send("Page.captureScreenshot", { format: "png" })).data);

  // ── 3. The ends of the range, as layout rather than arithmetic ──────────
  await dragTo(c, wide.sidebar.right - 4, wide.sidebar.right + 600, y);
  const max = await evalIn(c, `__live.metrics()`);
  check("it stops at the maximum with the window still mostly panes", max.sidebar.width === 400, max.sidebar);
  save("max", (await c.send("Page.captureScreenshot", { format: "png" })).data);

  await dragTo(c, max.sidebar.right - 4, 0, y);
  const min = await evalIn(c, `__live.metrics()`);
  check("it stops at the minimum", min.sidebar.width === 200, min.sidebar);
  // The floor is a legibility claim, and the destinations are what it is a claim about: their labels
  // are fixed, they are the nav proper, and none of them may be ellipsis at the narrowest the column
  // goes. (A session TITLE clips at any width — that is the title being long, not the column being
  // narrow, and it is why the floor is not measured on one.)
  const dests = await evalIn(c, `(() => [...document.querySelectorAll('.dest-row')].map((el) => ({
    text: el.textContent.trim(), clipped: el.scrollWidth > el.clientWidth + 1 })))()`);
  check("every destination label still reads at the narrowest the column goes",
    dests.length > 0 && dests.every((d) => !d.clipped), dests);
  save("min", (await c.send("Page.captureScreenshot", { format: "png" })).data);

  // ── 4. A widened column still gets out of the way ───────────────────────
  await dragTo(c, min.sidebar.right - 4, min.sidebar.right + 200, y);
  const before = await evalIn(c, `__live.metrics()`);
  check("back up to 400 for the collapse", before.sidebar.width === 400, before.sidebar);
  await evalIn(c, `(() => { document.querySelector('button[aria-label^="Hide sidebar"]').click(); return true; })()`);
  await sleep(700);
  const collapsed = await evalIn(c, `__live.metrics()`);
  // THE stale-margin bug: the collapse animation is a negative margin of the width VARIABLE. Read
  // from a stale 280 it would leave 120px of column on screen, which no unit test can see.
  check("the widened column collapses all the way off the window", collapsed.sidebar.right <= 0, collapsed.sidebar);
  check("and the panes take the whole window", collapsed.main.left === 0 && collapsed.main.width === VIEWPORT.width, collapsed.main);
  save("collapsed", (await c.send("Page.captureScreenshot", { format: "png" })).data);

  // ── 5. And it is still there on the next launch ─────────────────────────
  await evalIn(c, `(() => { document.querySelector('button[aria-label^="Show sidebar"]').click(); return true; })()`);
  await sleep(700);
  const restored = await evalIn(c, `__live.metrics()`);
  check("bringing it back brings back the width it had", restored.sidebar.width === 400, restored.sidebar);

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { electron?.kill("SIGKILL"); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 1200);
  });
