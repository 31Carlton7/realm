/**
 * Live check for the empty session's greeting link (run with: node apps/desktop/scripts/empty-session-link-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME (run `pnpm build` first) and proves, in the real
 * renderer, what jsdom can only describe:
 *
 *   1. The place the greeting names is drawn as a link in prose: the accent, the line's own type,
 *      no underline until the pointer is on it, and inline with the sentence.
 *   2. The keyboard reaches it — Shift+Tab out of the prompter lands on it, with the focus ring on
 *      screen — and Enter opens the space's page.
 *   3. A session working in a checkout that is not the space's own folder names that checkout, by
 *      its folder name, and its link still opens the space's page.
 *
 * Sessions are the fake agent's, created over RPC; the onboarding session is a real, billed engine
 * and is never typed into. Ports: env-overridable. Touches only a scratch dir; stops only what it
 * started. Screenshots of both faces go to LIVE_SHOTS (default: the OS temp dir).
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9365), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8965);
/** Chromium's switches for a covered window: lay it out and run its timers anyway. */
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const SHOTS = process.env.LIVE_SHOTS ?? os.tmpdir();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-empty-session-link-"));
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
  const events = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      events.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (msg.method === "Runtime.exceptionThrown") {
      events.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "exception");
    }
  });
  return { ws, ready, pending, events, next: () => ++id };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
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
    /* Bounded, so a server that went away fails the run by name instead of hanging it. */
    call: (method, params) => new Promise((res, rej) => {
      const i = String(s.next());
      const timer = setTimeout(() => { s.pending.delete(i); rej(new Error(`${method}: no answer in 30s — is the server still up?`)); }, 30000);
      s.pending.set(i, (msg) => { clearTimeout(timer); s.pending.delete(i); return msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`)); });
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}

const HELPERS = `
globalThis.__live = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; },
  link() { return document.querySelector('.session-pane[data-focused] .hero-greeting .hero-greeting-place'); },
  /** The link, as it is painted: what kind of element, its words, and its ink against the accent. */
  read() {
    const a = __live.link();
    if (!a) return null;
    const cs = getComputedStyle(a);
    const probe = document.createElement('span'); probe.style.color = 'var(--rl-accent)'; document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color; probe.remove();
    const line = a.closest('.hero-greeting');
    return { tag: a.tagName, type: a.getAttribute('type'), text: a.textContent, title: a.getAttribute('title'),
      color: cs.color, accent, decoration: cs.textDecorationLine, display: cs.display,
      fontSize: cs.fontSize, lineFontSize: getComputedStyle(line).fontSize, weight: cs.fontWeight, lineWeight: getComputedStyle(line).fontWeight,
      box: __live.box(a), lineBox: __live.box(line), runBox: __live.box(line.firstElementChild), sentence: line.textContent,
      focused: document.activeElement === a, focusVisible: a.matches(':focus-visible'), outline: cs.outlineStyle + ' ' + cs.outlineWidth };
  },
  rowFor(title) { return [...document.querySelectorAll('.item-row')].find((b) => b.querySelector('.item-title')?.textContent === title) ?? null; },
  spacePage() { return !!document.querySelector('.space-page-pane'); },
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

async function clickAt(c, { x, y }) {
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(60);
  for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
const centre = (b) => ({ x: Math.round((b.l + b.r) / 2), y: Math.round((b.t + b.b) / 2) });
const park = (c) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1150, y: 40 });
async function press(c, key, { shift = false } = {}) {
  const codes = { Tab: ["Tab", 9], Enter: ["Enter", 13], Escape: ["Escape", 27] };
  const [code, vk] = codes[key];
  for (const type of ["keyDown", "keyUp"]) {
    await c.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0,
      ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}) });
  }
}

async function shot(c, tag, clip) {
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const out = path.join(SHOTS, `realm-empty-session-link-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}
const around = (b) => ({ x: Math.max(0, b.l - 24), y: Math.max(0, b.t - 24), width: b.w + 48, height: b.h + 48 });

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
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
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
  await c.send("DOM.enable");
  await c.send("CSS.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 820, deviceScaleFactor: 2, mobile: false });
  await c.send("Page.bringToFront");

  const api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});

  /* The greeting is picked from a pool by session id, and one line in eight greets the person without
     naming a place at all. So fake sessions are made until one names the space — the line under test —
     and that is the one opened. */
  const openFresh = async (title, extra = {}) => {
    const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title, ...extra });
    const row = await until(() => evalIn(c, `__live.box(__live.rowFor(${JSON.stringify(title)}))`), 10000, `row ${title}`);
    await clickAt(c, centre(row));
    await until(() => evalIn(c, `!!document.querySelector('.session-pane[data-focused] .hero-greeting')`), 10000, `hero for ${title}`);
    await park(c);
    await sleep(300);
    return session;
  };
  let read = null;
  for (let n = 1; n <= 6 && !read; n++) {
    await openFresh(`Empty ${n}`);
    read = await evalIn(c, `__live.read()`);
  }
  check("an empty session's greeting names its space as a link", read !== null && read.text === "Live", read && { sentence: read.sentence, text: read.text });

  /* ── 1. Drawn as a link in prose ─────────────────────────────────────────────────────────────── */
  check("it is a button, so the keyboard can reach it", read.tag === "BUTTON" && read.type === "button" && read.title === "Open Live", { tag: read.tag, type: read.type, title: read.title });
  check("in the accent, in the line's own type, with no underline at rest", read.color === read.accent && read.decoration === "none"
    && read.fontSize === read.lineFontSize && read.weight === read.lineWeight, { color: read.color, accent: read.accent, decoration: read.decoration, size: [read.fontSize, read.lineFontSize], weight: [read.weight, read.lineWeight] });
  // On the sentence's own line: the sentence is one line here, so the run it sits in is the link's
  // height and starts where the link does. A link laid out as a block would stand on a line of its own.
  const onTheLine = (r) => Math.abs(r.box.t - r.runBox.t) < 2 && r.runBox.h <= r.box.h + 2;
  check("it sits in the sentence, on its line, not as a box on a line of its own", onTheLine(read), { link: read.box, run: read.runBox });
  await evalIn(c, `(() => { const st = document.createElement('style'); st.id = 'mutant-block'; st.textContent = '.hero-greeting-place { display: block !important; }'; document.head.appendChild(st); return true; })()`);
  await sleep(120);
  const blocked = await evalIn(c, `__live.read()`);
  check("the mutant reproduces the failure (a block ⇒ the name breaks the sentence onto three lines)", !onTheLine(blocked), { link: blocked.box, run: blocked.runBox });
  await evalIn(c, `(() => { document.getElementById('mutant-block').remove(); return true; })()`);
  await sleep(120);
  const { root } = await c.send("DOM.getDocument", {});
  const { nodeId } = await c.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".session-pane[data-focused] .hero-greeting-place" });
  await c.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
  await sleep(150);
  const hovered = await evalIn(c, `__live.read()`);
  check("the underline comes back under the pointer", hovered.decoration === "underline", { decoration: hovered.decoration });
  await c.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
  await shot(c, "dark", around(read.lineBox));

  /* ── 2. The keyboard reaches it, and Enter opens the space's page ──────────────────────────────── */
  await evalIn(c, `(() => { document.querySelector('.session-pane[data-focused] .composer-input').focus(); return true; })()`);
  let reached = null;
  for (let i = 0; i < 20 && !reached; i++) {
    await press(c, "Tab", { shift: true });
    const r = await evalIn(c, `__live.read()`);
    if (r?.focused) reached = r;
  }
  check("Shift+Tab out of the prompter reaches it, with the focus ring on screen",
    reached !== null && reached.focusVisible && /solid 2px/.test(reached.outline), reached && { focusVisible: reached.focusVisible, outline: reached.outline });
  if (reached) await shot(c, "focus", around(reached.lineBox));
  await press(c, "Enter");
  const opened = await until(() => evalIn(c, `__live.spacePage()`), 8000, "the space page from the keyboard").catch(() => false);
  check("Enter on it opens the space's page", opened === true);
  await press(c, "Escape");
  await until(() => evalIn(c, `!__live.spacePage()`), 8000, "the space page put away");

  /* ── 3. A session in a checkout names the checkout, and still leads to the space ─────────────── */
  const checkout = path.join(scratch, "code", "stora-platform");
  fs.mkdirSync(checkout, { recursive: true });
  const project = await api.call("projects.create", { spaceId: space.id, name: "stora-platform", rootPath: checkout });
  let elsewhere = null;
  for (let n = 1; n <= 6 && !elsewhere; n++) {
    await openFresh(`In a checkout ${n}`, { projectId: project.id });
    const r = await evalIn(c, `__live.read()`);
    if (r) elsewhere = r;
  }
  check("a session working in a linked checkout names the checkout by its folder", elsewhere !== null && elsewhere.text === "stora-platform",
    elsewhere && { sentence: elsewhere.sentence });
  await shot(c, "checkout", around(elsewhere.lineBox));
  await clickAt(c, centre(elsewhere.box));
  const fromCheckout = await until(() => evalIn(c, `__live.spacePage()`), 8000, "the space page from the checkout's link").catch(() => false);
  check("…and its link still opens the space's page", fromCheckout === true);
  await press(c, "Escape");
  await until(() => evalIn(c, `!__live.spacePage()`), 8000, "the space page put away again");

  /* ── The light face ─────────────────────────────────────────────────────────────────────────── */
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!__live.link() && document.documentElement.dataset.mode === 'light'`), 30000, "the light face");
  await park(c);
  await sleep(600);
  const light = await evalIn(c, `__live.read()`);
  check("the light face draws it in its own accent", light.color === light.accent, { color: light.color, accent: light.accent });
  await shot(c, "light", around(light.lineBox));
  await api.call("settings.set", { key: "ui.theme", value: "dark" });

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  api.close();
  c.close();
}

/** Stop what this run started, and only that. */
async function teardown() {
  electron?.kill("SIGTERM");
  await sleep(1200);
  electron?.kill("SIGKILL");
  await stopDaemons(home);
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const pids = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    for (const pid of pids) {
      const cmd = execSync(`ps -o command= -p ${pid} || true`, { encoding: "utf8" });
      if (cmd.includes(scratch) || cmd.includes(path.join(repoRoot, "node_modules/.pnpm/electron@"))) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(async () => {
    await teardown();
    process.exit(process.exitCode ?? 0);
  });
