/**
 * Live check for the team's 3D icons (run with: node apps/desktop/scripts/team-icons3d-live.mjs)
 *
 * Boots the REAL app (built out/main + dist/main.js — run `pnpm build` first) on a scratch home with the
 * scripted agent standing in for every role, so nothing is billed, and looks at every place a picture
 * stands:
 *
 *   I1  the team's column: the chats, Add teammate in the Realmites' column, and the Team rows — Review,
 *       Overview, a row per kind of record, Policies, Vault, Activity — each drawing its picture at 2x;
 *   I2  the picker a space that is not a team yet opens on: Custom teammate's picture beside the
 *       starters' Realmites;
 *   I3  New record type: each preset as its own kind of thing;
 *   I4  a team with nobody on it, and Review with nobody to send anything;
 *   I5  motion: a Team row under the pointer leans and lifts, a click on another settles it once, and
 *       under Reduce motion neither moves;
 *   I6  dark, then light, at 1440 and at a narrow 760.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8821 / 9261). Screenshots go to LIVE_OUT. It touches only its
 * own scratch home (a fresh temp dir), and kills only what holds its own two ports.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9261);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8821);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-team-icons3d-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-team-icons3d-live-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
let liveC = null;

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

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
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(String(msg.id))?.(msg); });
  return { ws, ready, pending, next: () => ++id };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(String(i), (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
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

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) {
      // Only what this worktree started: the command line names it.
      const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (!cmd.includes(repoRoot) && !cmd.includes(scratch)) { console.log(`SKIP pid ${pid} on :${port} is not ours`); continue; }
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  } catch { /* nothing listening */ }
}

const HELPERS = `
globalThis.__live = {
  q: (sel) => document.querySelector(sel),
  qa: (sel) => [...document.querySelectorAll(sel)],
  click(el) { if (!el) throw new Error('nothing to click'); el.click(); return true; },
  named(re, root = document) { return [...root.querySelectorAll('button')].find((b) => new RegExp(re).test(b.getAttribute('aria-label') ?? '')) ?? null; },
  teamRow(label) { return [...document.querySelectorAll('.sb-page-nav .page-rail-tab')].find((l) => l.querySelector('.tp-rail-label')?.textContent === label) ?? null; },
  box(el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception in ${expr.slice(0, 120)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function shot(c, tag, clip) {
  await ground(c);
  await sleep(clip ? 0 : 700);
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: clip.scale ?? 1 } } : {}) });
  const out = path.join(OUT_DIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}

async function holdKey(c) {
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await evalIn(c, `(() => { const hide = () => document.getElementById('live-scratch-banner')?.remove(); hide();
    new MutationObserver(hide).observe(document.body, { childList: true }); return true; })()`);
  await ground(c);
}

/** A capture has no window material behind the translucent chrome: a plain ground of the mode's own
 *  stands in for it. */
async function ground(c) {
  const light = await evalIn(c, `document.documentElement.dataset.mode === 'light'`);
  await c.send("Emulation.setDefaultBackgroundColorOverride", { color: light ? { r: 236, g: 236, b: 238, a: 1 } : { r: 28, g: 28, b: 30, a: 1 } });
}

async function size(c, width, height) {
  await c.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
}

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const scriptFile = path.join(scratch, "fake-script.json");
  fs.writeFileSync(scriptFile, JSON.stringify([]));
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home, REALM_HTML_MENUS: "1", REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1", REALM_FAKE_STANDS_IN: "claude", REALM_FAKE_SCRIPT: scriptFile, REALM_LIVE_SCRATCH: "1",
      REALM_MEMORY_FALLBACK_DIR: path.join(scratch, "memory-fallback"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Versed");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await holdKey(c);
  await size(c, 1440, 900);
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

async function openSpacePage(c, spaceName) {
  await evalIn(c, `__live.click(__live.named('^More for ${spaceName}$'))`);
  const row = `[...document.querySelectorAll('[role=menu] [role=menuitem]')].find((b) => /^(Team|Make this a team…)$/.test(b.textContent.trim()))`;
  await until(() => evalIn(c, `!!${row}`), 5_000, "menu row Team");
  await evalIn(c, `__live.click(${row})`);
  await until(() => evalIn(c, `!!__live.q('.sb-page-nav .page-rail') || !!__live.q('.tp-shelf')`), 8_000, "team page");
  await sleep(400);
}

async function backToSpaces(c) {
  await evalIn(c, `__live.q('.sb-page-back') && __live.click(__live.q('.sb-page-back'))`).catch(() => {});
  await until(() => evalIn(c, `!!__live.named('^More for Versed$')`), 10_000, "spaces");
}

/** Every picture on screen: which, at what rung, whether it loaded, and which file the screen chose. */
const pictures = (c, root = "document") => evalIn(c, `[...${root}.querySelectorAll('.i3d')].map((b) => {
  const img = b.querySelector('img');
  return { icon: b.dataset.icon, size: b.dataset.size, art: b.hasAttribute('data-art'), loaded: !!img && img.complete && img.naturalWidth > 0,
    file: img ? img.currentSrc.split('/').pop() : null, w: Math.round(b.getBoundingClientRect().width) };
})`);

async function surfaces(c, mode, width) {
  const tag = `${mode}-${width}`;
  await openSpacePage(c, "Versed");
  await until(() => evalIn(c, `!!__live.teamRow('Vault')`), 8_000, "team rows");
  await shot(c, `01-messenger-${tag}`);
  const col = await evalIn(c, `__live.box(__live.q('.sb-page-nav'))`);
  await shot(c, `02-column-${tag}`, { ...col, height: Math.min(col.height, 640) });
  if (width === 1440) {
    const rows = await pictures(c, "__live.q('.sb-page-nav')");
    check(`I1 ${tag} every Team row and Add teammate draws its picture, loaded`, rows.length >= 9 && rows.every((r) => r.art && r.loaded), rows);
    check(`I1 ${tag} at 2x the 20 rung draws its 40px file`, rows.filter((r) => r.size === "20").every((r) => /-40(-[\w-]+)?\.webp$/.test(r.file)), rows.map((r) => r.file));
    const align = await evalIn(c, `(() => {
      const add = __live.q('.tc-add .tp-rail-label').getBoundingClientRect().left;
      const name = __live.q('.tc-chat-row .tc-chat-name').getBoundingClientRect().left;
      return { add: Math.round(add), name: Math.round(name) };
    })()`);
    check(`I1 ${tag} Add teammate's words start where the teammates' names do`, Math.abs(align.add - align.name) <= 1, align);
  }
  await backToSpaces(c);

  await openSpacePage(c, "Lab");
  await until(() => evalIn(c, `!!__live.q('.tp-card-custom .i3d')`), 8_000, "picker");
  await evalIn(c, `__live.q('.tp-card-custom').scrollIntoView({ block: 'center' })`);
  await shot(c, `03-picker-${tag}`);
  if (width === 1440) {
    const custom = await pictures(c, "__live.q('.tp-card-custom')");
    check(`I2 ${tag} Custom teammate's card draws its picture at the card rung`, custom.length === 1 && custom[0].icon === "custom-teammate" && custom[0].size === "32" && custom[0].loaded, custom);
  }
  await backToSpaces(c);

  await openSpacePage(c, "Versed");
  await evalIn(c, `__live.click([...document.querySelectorAll('.sb-page-nav .page-rail-tab')].find((l) => l.querySelector('.tp-rail-label')?.textContent === 'Creators').querySelector('input'))`);
  await until(() => evalIn(c, `!!__live.q('.tp-new-type')`), 8_000, "records page");
  await evalIn(c, `__live.click(__live.q('.tp-new-type'))`);
  await until(() => evalIn(c, `!!__live.q('.tp-type-card .i3d')`), 8_000, "new record type");
  await shot(c, `04-record-presets-${tag}`);
  if (width === 1440) {
    const presets = await evalIn(c, `__live.qa('.tp-type-card').map((card) => [card.querySelector('.tp-card-name').textContent, card.querySelector('.i3d')?.dataset.icon, !!card.querySelector('.i3d img')?.naturalWidth])`);
    check(`I3 ${tag} each preset draws its own kind of thing`, presets.length >= 6 && presets.every(([, icon, loaded]) => icon && loaded), presets);
  }
  await backToSpaces(c);

  await openSpacePage(c, "Studio");
  await until(() => evalIn(c, `!!__live.q('.tc-empty-team .i3d')`), 8_000, "empty team");
  await shot(c, `05-empty-team-${tag}`);
  await evalIn(c, `__live.click([...document.querySelectorAll('.sb-page-nav button.page-rail-tab')].find((b) => b.textContent.includes('Review')))`);
  await until(() => evalIn(c, `!!__live.q('.rv-empty .i3d img')`), 8_000, "review empty");
  await shot(c, `06-review-empty-${tag}`);
  await backToSpaces(c);
}

/** Two frames of the motion: a row under the pointer mid-lean and at rest, and a chosen row mid-bounce. */
async function motion(c, mode) {
  await openSpacePage(c, "Versed");
  await until(() => evalIn(c, `!!__live.teamRow('Policies')`), 8_000, "team rows");
  await evalIn(c, `__live.click(__live.teamRow('Overview').querySelector('input'))`);
  await sleep(700);
  const col = await evalIn(c, `(() => { const a = __live.teamRow('Review').getBoundingClientRect(), b = __live.teamRow('Activity').getBoundingClientRect();
    return { x: a.left - 4, y: a.top - 6, width: a.width + 8, height: b.bottom - a.top + 12, scale: 2 }; })()`);
  const at = await evalIn(c, `(() => { const r = __live.teamRow('Policies').querySelector('.tp-rail-label').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await sleep(110);
  await shot(c, `07-motion-hover-mid-${mode}`, col);
  await sleep(700);
  await shot(c, `07-motion-hover-rest-${mode}`, col);
  const leaned = await evalIn(c, `getComputedStyle(__live.teamRow('Policies').querySelector('.i3d-art')).transform`);
  check(`I5 ${mode} the hovered row's picture leans and lifts`, leaned !== "none", leaned);

  const vault = await evalIn(c, `(() => { const r = __live.teamRow('Vault').querySelector('.tp-rail-label').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: vault.x, y: vault.y });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: vault.x, y: vault.y, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: vault.x, y: vault.y, button: "left", clickCount: 1 });
  const settle = await evalIn(c, `(() => { const b = __live.teamRow('Vault').querySelector('.i3d'); return { on: b.hasAttribute('data-settle'), anim: getComputedStyle(b.querySelector('.i3d-art')).animationName }; })()`);
  await sleep(90);
  await shot(c, `08-motion-settle-mid-${mode}`, col);
  check(`I5 ${mode} a click on a row settles its picture once`, settle.on && settle.anim === "i3d-settle", settle);
  await sleep(800);
  const after = await evalIn(c, `__live.teamRow('Vault').querySelector('.i3d').hasAttribute('data-settle')`);
  check(`I5 ${mode} the bounce ends on its own`, after === false);
  await shot(c, `08-motion-settle-rest-${mode}`, col);

  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await sleep(300);
  const still = await evalIn(c, `getComputedStyle(__live.teamRow('Policies').querySelector('.i3d-art')).transform`);
  check(`I5 ${mode} under Reduce motion the hovered picture holds still`, still === "none", still);
  await c.send("Emulation.setEmulatedMedia", { features: [] });
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
  await backToSpaces(c);
}

async function main() {
  const c = await boot();
  liveC = c;
  const space = (await api.call("spaces.list", {})).find((s) => s.name === "Versed");
  check("onboarding made Versed", !!space);
  const team = await api.call("team.make", { spaceId: space.id, templates: ["researcher", "editor", "ops"] });
  for (const r of team.roles) await api.call("team.roleUpdate", { id: r.id, agentKind: "fake", model: null });
  for (const preset of ["creator", "lead", "bug"]) await api.call("team.recordTypes.create", { spaceId: space.id, preset });
  const studio = await api.call("spaces.create", { profileId: space.profileId, name: "Studio", icon: "folder" });
  const made = await api.call("team.make", { spaceId: studio.id, templates: ["researcher"] });
  await api.call("team.roleArchive", { id: made.roles[0].id });
  await api.call("spaces.create", { profileId: space.profileId, name: "Lab", icon: "folder" });

  await surfaces(c, "dark", 1440);
  await motion(c, "dark");
  await size(c, 760, 760);
  await surfaces(c, "dark", 760);
  await size(c, 1440, 900);

  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
  await holdKey(c);
  await surfaces(c, "light", 1440);
  await motion(c, "light");
  await size(c, 760, 760);
  await surfaces(c, "light", 760);
  c.close();
}

main()
  .catch(async (e) => {
    console.log(`FAIL harness ${e.message}`); process.exitCode = 1;
    try { await shot(liveC, "zz-failed"); } catch { /* the window is gone */ }
  })
  .finally(async () => {
    try { await api?.call("daemon.stop", {}); } catch {}
    try { api?.close(); } catch {}
    electron?.kill("SIGTERM");
    await sleep(800);
    try { electron?.kill("SIGKILL"); } catch {}
    await stopDaemons(home);
    killPort(SERVER_PORT); killPort(CDP_PORT);
    if (!process.env.LIVE_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
