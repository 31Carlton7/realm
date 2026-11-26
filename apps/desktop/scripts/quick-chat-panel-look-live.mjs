/**
 * Live check for the quick chat panel's frame, laid out after ChatGPT's companion bar (run with:
 * node apps/desktop/scripts/quick-chat-panel-look-live.mjs; `pnpm build` first). The BUILT app on a
 * scratch home and HOME, quiet, with the scripted agent, the calendar stand-in, and the renderer over
 * http so the painted curve draws. Nothing is billed: the answer is the scripted agent's.
 *
 * Rows, in `rows.txt` under LIVE_OUT_DIR:
 *
 *   bar       the window opens as the bar: 362 × 72 pt, the capsule 40 pt tall inside a 16 pt margin
 *   grown     one exchange grows the window upward, its bottom edge where the bar's was, and the card
 *             sits above the capsule
 *   assistant the meeting assistant fills the panel to its ceiling, above the same capsule
 *   away      Escape narrows the bar away and main hides the window
 *   picture   each state in dark and light, Plain and Glass: the whole page, laid over `--page`
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { cdp, desktopRoot, freePort, launchLiveApp, sleep, until } from "./lib/live-app.mjs";
import { noCalendar } from "./quick-chat-panel/no-calendar.mjs";

const OUT_DIR = process.env.LIVE_OUT_DIR ?? path.resolve(process.cwd(), ".verify/quick-chat-panel-look");
const QUESTION = "What is 2+2?";
const ANSWER = "2 + 2 = 4.";
const CHORD = "mod+ctrl+alt+shift+f19";
const js = (v) => JSON.stringify(v);

const rows = [];
const row = (group, name, value, ok) => {
  if (ok === false) process.exitCode = 1;
  rows.push({ group, name, value, ok });
  console.log(`${ok === undefined ? "    " : ok ? "PASS" : "FAIL"} ${group.padEnd(9)} ${name}  ${js(value)}`);
};

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return {
    ready: new Promise((res) => ws.addEventListener("open", res)),
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(js({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const tools = fs.mkdtempSync(path.join(os.tmpdir(), "realm-panel-look-tools-"));
const scriptFile = path.join(tools, "fake-script.json");
fs.writeFileSync(scriptFile, js([{ on: QUESTION, emit: [{ kind: "text", text: ANSWER }] }]));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "realm-panel-look-home-"));
const calendar = noCalendar();

let web = null;
let app = null;
let api = null;
const watchdog = setTimeout(async () => {
  console.error("FAIL watchdog: the check ran for four minutes");
  await app?.stop().catch(() => {});
  web?.kill();
  process.exit(9);
}, 240_000);

const panelOf = `require("electron").BrowserWindow.getAllWindows().find((w) => !w.isResizable())`;
const panelVisible = () => app.main.eval(`${panelOf}?.isVisible() === true`);
const bounds = () => app.main.eval(`${panelOf}.getBounds()`);
const press = () => app.main.eval(`globalThis.__quickChatChord.press(); true`);
const openPanel = async () => { if (!(await panelVisible())) await press(); await until(panelVisible, 10_000, "the panel to open"); };
const closePanel = async (page) => {
  if (await panelVisible()) await page.eval(`window.realm.quickChatPanel.hide(); true`);
  await until(async () => !(await panelVisible()), 10_000, "the panel to close");
};

async function attachPanel() {
  return until(async () => {
    for (const t of (await app.targets()).filter((x) => x.type === "page")) {
      const c = await cdp(t.webSocketDebuggerUrl);
      if (await c.eval(`window.realm?.surface === "quick-chat"`).catch(() => false)) { await c.send("Runtime.enable"); return c; }
      c.close();
    }
    return null;
  }, 20_000, "the panel's page");
}

/** The whole page, laid over the theme's `--page` so the capture has no see-through pixels. True when
 *  the ground came out opaque. */
async function shot(page, file) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
  await sleep(500);
  // The whole window at 2x, the scale ChatGPT's reference was captured at on this Mac's display.
  const size = await page.eval(`({ width: innerWidth, height: innerHeight })`);
  const { data } = await page.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, ...size, scale: 2 } });
  const { png, alpha } = await page.eval(`(async () => {
    const img = new Image(); img.src = "data:image/png;base64,${data}"; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext("2d");
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim() || "#000";
    g.fillRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0);
    return { png: cv.toDataURL("image/png").split(",")[1], alpha: cv.getContext("2d").getImageData(0, 0, 1, 1).data[3] };
  })()`);
  fs.writeFileSync(file, Buffer.from(png, "base64"));
  return alpha === 255;
}

/** Where the page's shapes are, in the window's points. */
const shapes = (page) => page.eval(`(() => {
  const box = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r && r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; };
  return { window: { width: innerWidth, height: innerHeight }, capsule: box(".quick-chat .composer"), side: box(".quick-chat-side"),
    card: box(".quick-chat-card"), squircle: document.documentElement.hasAttribute("data-squircle") };
})()`);

async function everyLook(page, state, prepare) {
  for (const mode of ["dark", "light"]) for (const look of ["plain", "glass"]) {
    await api.call("settings.set", { key: "ui.theme", value: mode });
    await api.call("settings.set", { key: "ui.look", value: look });
    await closePanel(page); await openPanel();
    await prepare?.();
    await until(() => page.eval(`document.documentElement.dataset.mode === ${js(mode)} && document.documentElement.hasAttribute("data-glass") === ${look === "glass"}`),
      15_000, `the panel in ${mode} ${look}`).catch(() => null);
    const drawn = await page.eval(`({ mode: document.documentElement.dataset.mode, glass: document.documentElement.hasAttribute("data-glass") })`);
    await sleep(600);
    const file = `${state}-${mode}-${look}.png`;
    row("picture", `${state}, ${mode} ${look}`, { file, drawn }, await shot(page, path.join(OUT_DIR, file)));
  }
}

try {
  const httpPort = await freePort();
  web = spawn("python3", ["-m", "http.server", String(httpPort), "--bind", "127.0.0.1"], { cwd: path.join(desktopRoot, "out/renderer"), stdio: "ignore" });
  const rendererUrl = `http://127.0.0.1:${httpPort}/index.html`;
  await until(() => fetch(rendererUrl).then((r) => r.ok), 10_000, "the renderer over http");
  app = await launchLiveApp({ name: "quick-chat-panel-look", inspect: true, rendererUrl,
    env: { ...calendar.env, HOME: home, REALM_FAKE_SCRIPT: scriptFile, REALM_FAKE_STANDS_IN: "claude", REALM_REAL_LIVE_ANSWERS: "" } });
  api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const profile = (await api.call("profiles.list", {}))[0];
  const space = await api.call("spaces.create", { profileId: profile.id, name: "Stub space" });
  await api.call("settings.set", { key: "ui.activeSpaceId", value: space.id });
  await api.call("settings.set", { key: "quickChatModel", value: { agentKind: "claude", model: "claude-haiku-5-5" } });
  await until(() => app.main.eval(`require("electron").BrowserWindow.getAllWindows().some((w) => w.isResizable() && !w.webContents.isLoading())`), 30_000, "the window's first load");
  await app.main.eval(`(() => { const { globalShortcut } = require("electron");
    const register = globalShortcut.register;
    globalShortcut.register = (accelerator, cb) => { globalThis.__quickChatChord = { press: cb }; return register(accelerator, cb); }; return true; })()`);
  await app.page.eval(`window.realm.quickChatPanel.setShortcut(${js(CHORD)})`);

  await openPanel();
  const page = await attachPanel();
  await until(() => page.eval(`!!document.querySelector(".quick-chat .composer-input")`), 20_000, "the panel's prompter");
  await sleep(800);

  /* ── the bar ─────────────────────────────────────────────────────────────────────────────── */
  const bar = { bounds: await bounds(), shapes: await shapes(page) };
  row("bar", "opens as the bar alone: 362 × 72, a 40 pt capsule and the round button inside the margin", bar,
    bar.bounds.width === 362 && bar.bounds.height === 72 && bar.shapes.capsule?.height === 40 && bar.shapes.capsule?.y === 16
      && bar.shapes.side?.width === 40 && bar.shapes.card === null && bar.shapes.squircle);
  await everyLook(page, "1-bar");

  /* ── one exchange ────────────────────────────────────────────────────────────────────────── */
  await page.eval(`(() => { const el = document.querySelector(".quick-chat .composer-input");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${js(QUESTION)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
  await until(() => page.eval(`document.querySelector(".quick-chat-card")?.innerText.includes(${js(ANSWER)}) ?? false`), 30_000, "the scripted answer");
  await sleep(1000);
  const grown = { before: bar.bounds, after: await bounds(), shapes: await shapes(page) };
  const bottom = (b) => b.y + b.height;
  row("grown", "the exchange grows the window up out of the bar, bottom edge held, card above the capsule", grown,
    grown.after.height > grown.before.height && bottom(grown.after) === bottom(grown.before) && grown.after.x === grown.before.x
      && grown.shapes.card !== null && grown.shapes.card.y + grown.shapes.card.height + 8 === grown.shapes.capsule.y);
  await everyLook(page, "2-grown");

  /* ── the meeting assistant ───────────────────────────────────────────────────────────────── */
  const showAssistant = async () => {
    await page.eval(`(() => { const b = document.querySelector(".quick-chat-side"); if (b.getAttribute("aria-pressed") !== "true") b.click(); return true; })()`);
    await until(() => page.eval(`!!document.querySelector(".meeting-strip")`), 10_000, "the assistant view");
  };
  await showAssistant();
  await sleep(800);
  const assistant = { bounds: await bounds(), shapes: await shapes(page) };
  row("assistant", "fills the panel to its ceiling above the same capsule", assistant,
    assistant.bounds.height === 520 + 32 && bottom(assistant.bounds) === bottom(bar.bounds) && assistant.shapes.card !== null);
  await everyLook(page, "3-assistant", showAssistant);
  await page.eval(`document.querySelector(".quick-chat-side").click(); true`);

  /* ── put away ────────────────────────────────────────────────────────────────────────────── */
  await page.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  const leaving = await page.eval(`document.documentElement.hasAttribute("data-panel-out")`);
  const stillUp = await panelVisible();
  const hidden = await until(async () => !(await panelVisible()), 5000, "Escape to put it away").then(() => true, () => false);
  row("away", "Escape narrows the bar away first, then main hides the window", { leaving, stillUpAtFirst: stillUp, hidden }, leaving && stillUp && hidden);
  page.close();
} catch (err) {
  process.exitCode = 1;
  console.error(`FAIL ${err.stack ?? err}`);
} finally {
  fs.writeFileSync(path.join(OUT_DIR, "rows.txt"), rows.map((r) => `${r.ok === undefined ? "    " : r.ok ? "PASS" : "FAIL"} ${r.group.padEnd(9)} ${r.name}  ${js(r.value)}`).join("\n") + "\n");
  await app?.page.eval(`window.realm.quickChatPanel.setShortcut(null)`).catch(() => {});
  api?.close();
  await app?.stop();
  calendar.remove();
  fs.rmSync(tools, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  web?.kill();
  clearTimeout(watchdog);
}
process.exit(process.exitCode ?? 0);
