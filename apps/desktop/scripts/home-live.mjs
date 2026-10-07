/**
 * Live check for Home (run with: pnpm build && node apps/desktop/scripts/home-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and checks, in both faces, in the real window:
 *
 *   1. The rail holds Home, Library, Connections, Scheduled tasks and Code review, and no Agents page.
 *      With a session waiting on you, Home is unlit and wears no count, and the session says so in
 *      Needs you.
 *   2. Home goes back from every page — Library, Connections, Scheduled tasks, Code review,
 *      Settings, You, a space's Overview and a profile — to the session that was in front, with its
 *      prompter on screen and nothing new made.
 *   3. The foot of Settings ▸ General credits its author, and nobody else.
 *   4. Nothing logs an error to the console, from a reload onwards.
 *
 * Ports: LIVE_SERVER_PORT (8813), LIVE_CDP_PORT (9253). Scratch and pictures under LIVE_DIR. Nothing is
 * billed: every session is moved to the fake agent before anything is sent, and nothing is typed into
 * a composer. Nothing reaches GitHub: Code review is handed a gh that is not there, and says so.
 * Kills only what listens on its own ports.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9253), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8813);
const LIVE_DIR = process.env.LIVE_DIR ?? path.join(repoRoot, "../.verify/home-live");
const shots = path.join(LIVE_DIR, "shots");
fs.mkdirSync(LIVE_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(LIVE_DIR, "run-"));
const home = path.join(scratch, "home");
const WINDOW = { width: 1400, height: 900 };
let electron = null, api = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** What the renderer said was wrong, from the reload on. */
const errors = [];

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
  const listeners = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else for (const fn of listeners) fn(msg);
  });
  return {
    ready,
    on: (fn) => listeners.push(fn),
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return {
    ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

/** What the page is asked, in one line per question. */
const HELPERS = `
globalThis.__live = {
  type(input, value) {
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  },
  rail() {
    return [...document.querySelectorAll(".app-rail .rail-group .rail-btn")].map((b) => ({
      name: b.getAttribute("aria-label"), pressed: b.getAttribute("aria-pressed"), title: b.getAttribute("title"),
      badge: b.querySelector(".sb-badge")?.textContent ?? null, bg: getComputedStyle(b).backgroundColor,
    }));
  },
  click(label) {
    const b = [...document.querySelectorAll(".app-rail .rail-btn")].find((x) => (x.getAttribute("aria-label") ?? "").startsWith(label));
    if (!b) throw new Error("no rail button " + label);
    b.click();
    return true;
  },
  /* Where the window is: the page over it, if any, and the session in front. */
  where() {
    const panel = document.querySelector(".panehost .panel[data-focused]");
    const composer = panel?.querySelector(".composer");
    return {
      page: document.querySelector(".page-overlay")?.getAttribute("aria-label") ?? null,
      front: panel?.querySelector(".panel-title")?.textContent ?? null,
      composer: !!composer && composer.getBoundingClientRect().height > 0,
      needsYou: [...document.querySelectorAll('.sb-needs .item-row')].map((r) => r.getAttribute("aria-label")).slice(0, 4),
    };
  },
  tab(label) {
    const t = [...document.querySelectorAll(".settings-tab")].find((l) => l.textContent.trim() === label);
    if (!t) return false;
    (t.querySelector("input") ?? t).click();
    return true;
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const note = (name, detail) => console.log(`NOTE ${name} ${JSON.stringify(detail)}`);

/** The window's material is not in the DOM, so a capture composites the translucent grounds over
 *  nothing. For the capture alone the root is painted with a ground that stands in for the material
 *  over a plain wallpaper, dark or light as the face is (files-pane-live's). */
async function shot(c, name, clip) {
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
    const file = path.join(shots, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`SHOT ${file}`);
  } finally {
    await evalIn(c, `(() => { document.documentElement.style.background = ""; return true; })()`);
  }
}
const clipOf = (c, sel, pad = 0) => evalIn(c, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
  const r = e.getBoundingClientRect(); return { x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y - ${pad}),
  width: Math.min(innerWidth, r.width + ${2 * pad}), height: Math.min(innerHeight - Math.max(0, r.y - ${pad}), r.height + ${2 * pad}) }; })()`);

async function press(c, { key, code, keyCode, meta = false }) {
  const modifiers = meta ? 4 : 0;
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, key, code, windowsVirtualKeyCode: keyCode });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: keyCode });
}

/** A palette entry by the start of its name. */
async function palette(c, query, label) {
  await press(c, { key: "k", code: "KeyK", keyCode: 75, meta: true });
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "palette");
  await evalIn(c, `__live.type(document.querySelector(".palette input"), ${JSON.stringify(query)}); true`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!hit) return false; hit.click(); return true; })()`), 5000, label);
}

/** Every way onto a page the rail and the palette offer, each with the page it should put up. */
const PAGES = [
  ["Library", (c) => evalIn(c, `__live.click("Library")`)],
  ["Connections", (c) => evalIn(c, `__live.click("Connections")`)],
  ["Scheduled tasks", (c) => evalIn(c, `__live.click("Scheduled tasks")`)],
  ["Code review", (c) => evalIn(c, `__live.click("Code review")`)],
  ["Settings", (c) => press(c, { key: ",", code: "Comma", keyCode: 188, meta: true })],
  ["You", async (c) => {
    await evalIn(c, `document.querySelector('.rail-foot .rail-btn[aria-haspopup="menu"]').click(); true`);
    await until(() => evalIn(c, `(() => { const m = document.querySelector('.menu[aria-label="You"] [role=menuitem]'); if (!m) return false; m.click(); return true; })()`), 5000, "the person's menu");
  }],
  ["Overview", (c) => palette(c, "open space", "Open space")],
  ["Profile", (c) => palette(c, "open profile", "Open profile")],
];

async function setTheme(c, face) {
  await press(c, { key: ",", code: "Comma", keyCode: 188, meta: true });
  await until(() => evalIn(c, `!!document.querySelector(".settings-page-pane")`), 8000, "settings");
  await evalIn(c, `__live.tab("Appearance")`);
  await until(() => evalIn(c, `!!document.querySelector('fieldset[aria-label="Theme"] input[value="${face}"]')`), 8000, "theme control");
  await evalIn(c, `document.querySelector('fieldset[aria-label="Theme"] input[value="${face}"]').click(); true`);
  await until(() => evalIn(c, `document.documentElement.dataset.mode === "${face}"`), 5000, `the ${face} face`);
  await sleep(400);
}

async function attach() {
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  c.on((msg) => {
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push({ console: msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 300) });
    }
    if (msg.method === "Runtime.exceptionThrown") errors.push({ exception: (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 300) });
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") errors.push({ log: `${msg.params.entry.source}: ${msg.params.entry.text}`.slice(0, 300) });
  });
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Log.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  return c;
}

/** The window as the person at the Mac sees a key window: not greyed, not quiet. */
const keyWindow = (c) => evalIn(c, `(() => { const root = document.documentElement;
  const clear = () => { root.removeAttribute("data-window-inactive"); root.removeAttribute("data-quiet"); };
  clear(); new MutationObserver(clear).observe(root, { attributes: true, attributeFilter: ["data-window-inactive", "data-quiet"] }); return true; })()`);

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const mainLog = fs.createWriteStream(path.join(scratch, "main.log"));
  electron = spawn(electronBin, [wrapper,
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: { ...process.env, REALM_HOME: home, REALM_ENABLE_FAKE_AGENT: "1", REALM_HTML_MENUS: "1", REALM_GH_BIN: path.join(scratch, "no-gh"),
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.pipe(mainLog); electron.stdout.pipe(mainLog);
  const c = await attach();
  await evalIn(c, HELPERS);
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.type(input, 'Live'); input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  return c;
}

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  let c = await boot();
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const first = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15_000, "a session");
  for (const s of first) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  // A second space, so an Overview can be about somewhere other than the session's own.
  await api.call("spaces.create", { profileId: space.profileId, name: "Other" });
  // A session waiting on you: the fake agent holds a permission open on "ask me".
  const { session: asks } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: "Wants a yes", permissionMode: "default" });
  await api.call("sessions.send", { id: asks.id, text: "ask me", attachments: [], mentions: [] });
  await until(async () => (await api.call("sessions.get", { id: asks.id })).status === "waiting_permission", 20_000, "the session waiting on you");

  // From a reload on, every console error is this build's to answer for.
  await c.send("Page.reload", {});
  c.close();
  await sleep(1500);
  c = await attach();
  await until(() => evalIn(c, `!!document.querySelector('.composer')`).catch(() => false), 30_000, "composer after the reload");
  await evalIn(c, HELPERS);
  await keyWindow(c);
  await c.send("Emulation.setDeviceMetricsOverride", { width: WINDOW.width, height: WINDOW.height, deviceScaleFactor: 2, mobile: false });
  await until(() => evalIn(c, `__live.where().needsYou.length > 0`), 10_000, "Needs you");
  await sleep(600);
  const front = (await evalIn(c, `__live.where()`)).front;
  note("in front", front);

  for (const face of ["dark", "light"]) {
    await setTheme(c, face);
    await evalIn(c, `__live.click("Home")`);
    await until(() => evalIn(c, `__live.where().page === null`), 5000, "home after the theme");
    await sleep(500);

    /* ── 1. The rail ───────────────────────────────────────────────────────────────────────── */
    const rail = await evalIn(c, `__live.rail()`);
    const names = rail.map((b) => b.name);
    check(`${face}: the rail is Home, Library, Connections, Scheduled tasks and Code review — no Agents page`,
      names.length === 5 && names[0] === "Home" && names[1] === "Library" && names[2] === "Connections" && names[3] === "Scheduled tasks"
        && names[4] === "Code review" && !document_has_agents(names), names);
    const homeBtn = rail[0];
    check(`${face}: Home is unlit and wears no count while a session waits on you`, homeBtn.pressed === null && homeBtn.badge === null
      && homeBtn.title === "Back to your sessions", homeBtn);
    const where = await evalIn(c, `__live.where()`);
    check(`${face}: …the waiting session says so in Needs you`, where.needsYou.some((t) => t.includes("Wants a yes")), { needsYou: where.needsYou });
    check(`${face}: none of the old page's list, wall or office anywhere in the document`, await evalIn(c, `!document.querySelector(".agents-group, .agent-wall, .agent-office")`));
    await shot(c, `${face}-rail`, await evalIn(c, `(() => { const r = document.querySelector(".app-rail").getBoundingClientRect(); const s = document.querySelector("#app-sidebar").getBoundingClientRect();
      return { x: 0, y: 0, width: Math.round(s.right), height: Math.min(innerHeight, 520) }; })()`));
    await shot(c, `${face}-window`);

    /* ── 2. Home from every page ───────────────────────────────────────────────────────────── */
    for (const [label, open] of PAGES) {
      await open(c);
      const up = await until(async () => { const w = await evalIn(c, `__live.where()`); return w.page ? w : null; }, 8000, `${label} up`).catch(() => null);
      if (label === "Settings" || label === "Library") { await sleep(600); await shot(c, `${face}-${label.toLowerCase()}-up`); }
      await evalIn(c, `__live.click("Home")`);
      const back = await until(async () => { const w = await evalIn(c, `__live.where()`); return w.page === null ? w : null; }, 5000, `Home from ${label}`).catch(() => evalIn(c, `__live.where()`));
      check(`${face}: Home from ${label} goes back to the session in front, its prompter on screen`,
        up?.page && back.page === null && back.front === front && back.composer, { up: up?.page ?? null, back });
      if (label === "Settings" || label === "Library") { await sleep(500); await shot(c, `${face}-home-from-${label.toLowerCase()}`); }
    }
    const made = (await api.call("sessions.listAll", {})).length;
    check(`${face}: Home made no session on the way — there was one in front every time`, made === first.length + 1, { sessions: made });

    /* ── 3. The foot of Settings ───────────────────────────────────────────────────────────── */
    await press(c, { key: ",", code: "Comma", keyCode: 188, meta: true });
    await until(() => evalIn(c, `!!document.querySelector(".settings-page-pane")`), 8000, "settings");
    await evalIn(c, `__live.tab("General")`);
    await until(() => evalIn(c, `!!document.querySelector(".settings-attribution")`), 8000, "the credit");
    await evalIn(c, `(() => { document.querySelector(".settings-attribution").scrollIntoView({ block: "center", behavior: "instant" }); return true; })()`);
    await sleep(700);
    const foot = await evalIn(c, `(() => { const a = document.querySelector(".settings-attribution");
      return { text: a.innerText.trim(), links: [...a.querySelectorAll("a")].map((l) => [l.textContent, l.href]) }; })()`);
    check(`${face}: Settings' foot credits its author and nobody else`, foot.links.length === 1 && foot.links[0][0] === "Carlton Aikins"
      && !/pixel|MetroCity|office/i.test(foot.text), foot);
    await shot(c, `${face}-settings-foot`, await clipOf(c, ".settings-attribution", 80));
    await evalIn(c, `__live.click("Home")`);
    await until(() => evalIn(c, `__live.where().page === null`), 5000, "home from the foot");
  }

  /* ── 4. Nothing logged ─────────────────────────────────────────────────────────────────────── */
  check("nothing logged an error in the renderer from the reload on", errors.length === 0, errors.slice(0, 10));
  const mainLines = fs.readFileSync(path.join(scratch, "main.log"), "utf8").split("\n").filter((l) => /\berror\b|exception|unhandled/i.test(l));
  note("main and server lines naming an error", mainLines.slice(0, 20));
  fs.copyFileSync(path.join(scratch, "main.log"), path.join(LIVE_DIR, "main.log"));
  api.close();
  c.close();
}

/** No name in the rail is the page's. */
const document_has_agents = (names) => names.some((n) => /^Agents/.test(n ?? ""));

async function reap() {
  try { api?.close(); } catch {}
  await stopDaemons(home).catch(() => {});
  electron?.kill("SIGKILL");
  for (const port of [SERVER_PORT, CDP_PORT]) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(reap);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void reap().finally(() => process.exit(1)); });
