/**
 * Live check for the one question card every asker reaches (run: node apps/desktop/scripts/ask-cards-live.mjs)
 *
 * The suite renders the card and drives each feed's mapping. It cannot say whether a question from
 * each feed reaches the REAL transcript as the card — through the gateway, the hub, an adapter's
 * child process and the broker — nor what the card looks like on screen. So this boots the built
 * app on a scratch home and asks, for real:
 *
 *   - realm-ui's `ui_ask`, called by the fake agent through its own gateway: pictures as tiles,
 *     several choices, a model per plan step, a file, a branch, a time and a masked token;
 *   - an MCP server behind the hub (a stdio fixture connected as "Linear"): a form, a page to open,
 *     and a form asking for a key, which must be declined unasked;
 *   - Codex, through the real adapter and the fake app-server: `requestUserInput`, and a server of
 *     its own config passing an elicitation on;
 *
 * and captures every card unanswered and answered, in the dark face and the light one. The fake
 * agent answers everything: no engine is billed. URL cards record their address instead of opening
 * a browser. Ports are env-overridable; it touches only its own scratch directory and stops only the
 * processes it started.
 */
import { spawn, execFileSync } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9246), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8806);
const verify = process.env.LIVE_OUT ?? path.resolve(repoRoot, "../.verify/question-card-live");
const scratch = path.join(verify, `run-${Date.now()}`);
const shots = path.join(verify, "shots");
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
    const v = await fn().catch(() => null);
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
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const results = [];
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/* ── A picture to choose between: three settings-page mockups, drawn as PNGs with nothing but zlib ── */
function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function png(w, h, paint) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) { const [r, g, b] = paint(x, y); const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255; }
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const inBox = (x, y, x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
const MOCKUPS = {
  calm: (x, y) => (inBox(x, y, 0, 0, 90, 300) ? [236, 237, 240] : inBox(x, y, 120, 40, 370, 52) ? [40, 42, 48]
    : [1, 2, 3, 4].some((i) => inBox(x, y, 120, 70 + i * 44, 370, 100 + i * 44)) ? [246, 247, 249] : [252, 252, 253]),
  bold: (x, y) => (inBox(x, y, 0, 0, 400, 70) ? [44, 92, 214] : inBox(x, y, 30, 100, 300, 130) ? [24, 24, 28]
    : inBox(x, y, 30, 150, 220, 200) ? [246, 196, 70] : [20, 21, 26]),
  dense: (x, y) => (inBox(x, y, 0, 0, 70, 300) ? [32, 34, 40] : (y % 22 < 16 && x > 84 && x < 390) ? ((Math.floor(y / 22) % 3 === 0) ? [70, 74, 86] : [52, 55, 64]) : [26, 27, 32]),
};

/* ── The window ────────────────────────────────────────────────────────────────────────────────── */
async function setTheme(c, mode) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  const label = `Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`;
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === ${JSON.stringify(label)});
    if (!hit) return null; hit.click(); return true; })()`), 4000, label);
  await until(() => evalIn(c, `document.documentElement.getAttribute("data-mode") === ${JSON.stringify(mode)}`), 4000, `mode ${mode}`);
  await sleep(250);
}

/** One element, captured at 2× with a margin of the ground around it, so the card is seen on what it
 *  sits on. A portalled chooser rides along when it is open. */
async function shoot(c, name, selector, { pad = 16, withChooser = false } = {}) {
  const box = await evalIn(c, `(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = els.at(-1); if (!el) return null;
    el.scrollIntoView({ block: "center" });
    let r = el.getBoundingClientRect(); let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    if (${withChooser}) { const ch = document.querySelector(".subagents-chooser"); if (ch) { const q = ch.getBoundingClientRect(); x0 = Math.min(x0, q.left); y0 = Math.min(y0, q.top); x1 = Math.max(x1, q.right); y1 = Math.max(y1, q.bottom); } }
    return { x: Math.max(0, x0 - ${pad}), y: Math.max(0, y0 - ${pad}), width: x1 - x0 + ${pad * 2}, height: y1 - y0 + ${pad * 2} };
  })()`);
  if (!box) throw new Error(`nothing to shoot for ${selector}`);
  await sleep(120);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 }, captureBeyondViewport: false });
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return path.relative(verify, file);
}

/** The live card in both faces, from whichever face the window is in, back to dark. */
async function bothFaces(c, name, selector = ".question-card", o = {}) {
  const dark = await shoot(c, `${name}-dark`, selector, o);
  await setTheme(c, "light");
  const light = await shoot(c, `${name}-light`, selector, o);
  await setTheme(c, "dark");
  return { dark, light };
}

const js = JSON.stringify;
const click = (c, selector, text) => evalIn(c, `(() => {
  const el = [...document.querySelectorAll(${js(selector)})].filter((e) => ${text === undefined ? "true" : `(e.getAttribute("aria-label") ?? e.textContent).trim().startsWith(${js(text)})`}).at(-1);
  if (!el) throw new Error("nothing to click: " + ${js(`${selector} ${text ?? ""}`)});
  el.click(); return true; })()`);
const type = (c, selector, value) => evalIn(c, `(() => {
  const el = [...document.querySelectorAll(${js(selector)})].at(-1); if (!el) throw new Error("no field " + ${js(selector)});
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${js(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
const heading = (c) => evalIn(c, `[...document.querySelectorAll(".question-card .question-title")].at(-1)?.textContent ?? ""`);
const cardOpen = (c) => until(() => evalIn(c, `!!document.querySelector(".question-card")`), 25_000, "a question card");
const cardGone = (c) => until(() => evalIn(c, `!document.querySelector(".question-card")`), 15_000, "the card to close");

async function openSession(c, title) {
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${js(title)}))`), 20_000, `row ${title}`);
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${js(title)})).click(); return true; })()`);
  await sleep(700);
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${js(title)})) b.click(); return true; })()`);
  await sleep(400);
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });

  // Codex through the REAL adapter, its app-server being the fake: a wrapper the adapter can exec.
  const codexBin = path.join(scratch, "codex");
  fs.writeFileSync(codexBin, `#!/bin/sh\nexec ${js(process.execPath)} ${js(path.join(repoRoot, "packages/adapters/src/codex/fixtures/fake-codex-server.mjs"))} "$@"\n`);
  fs.chmodSync(codexBin, 0o755);

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...process.env,
      REALM_HOME: path.join(scratch, "home"), REALM_ENABLE_FAKE_AGENT: "1", REALM_CODEX_BIN: codexBin,
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(path.join(scratch, "electron.log"));
  electron.stderr.pipe(log); electron.stdout.pipe(log);

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30_000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20_000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1320, height: 900, deviceScaleFactor: 2, mobile: false });
  // Opened behind the person's own window it is never key, and greys its accent: hold it key.
  await evalIn(c, `(() => { const root = document.documentElement; root.removeAttribute("data-window-inactive");
    new MutationObserver(() => root.hasAttribute("data-window-inactive") && root.removeAttribute("data-window-inactive")).observe(root, { attributes: true }); return true; })()`);
  // A page to open must not really open: record where it would have gone instead.
  await evalIn(c, `(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; return true; })()`);

  const api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  // Onboarding's session would be a real, billed engine: it is put on the fake before anything else.
  for (const s of await api.call("sessions.list", { spaceId: space.id })) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  const { session: fake } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: "Questions", permissionMode: "default" });

  // The workspace the questions are about: three mockups, a changelog, and a checkout with branches.
  const ws = fake.cwd;
  fs.mkdirSync(path.join(ws, "mockups"), { recursive: true });
  for (const [name, paint] of Object.entries(MOCKUPS)) fs.writeFileSync(path.join(ws, "mockups", `${name}.png`), png(400, 300, paint));
  fs.writeFileSync(path.join(ws, "CHANGELOG.md"), "# Changelog\n\n## 2.0.0\n");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "settings.ts"), "export const theme = 'dark';\n");
  const git = (...args) => execFileSync("git", ["-c", "user.name=Live", "-c", "user.email=live@example.invalid", ...args], { cwd: ws, stdio: "pipe" });
  if (!fs.existsSync(path.join(ws, ".git"))) git("init", "-q", "-b", "main");
  git("add", "-A"); git("commit", "-q", "-m", "Seed", "--allow-empty");
  for (const b of ["release/v2.0.0", "feat/dark-mode"]) git("branch", "-f", b);

  // The Connection that asks: the stdio fixture, as "Linear", on in this space.
  const linear = await api.call("mcp.add", { spaceId: space.id, name: "Linear", transport: "stdio", command: process.execPath, args: [path.join(repoRoot, "apps/server/src/mcp/fixtures/elicit-stdio.mjs")] });
  await api.call("mcp.setEnabled", { spaceId: space.id, id: linear.id, enabled: true });

  await openSession(c, "Questions");
  // A known face to start from: the default follows the Mac, which may be in either.
  await setTheme(c, "dark");
  const send = (id, text) => api.call("sessions.send", { id, text, attachments: [], mentions: [] });

  // ── 1. Pictures as tiles, then several choices ────────────────────────────────────────────────
  await send(fake.id, "ask with pictures");
  await cardOpen(c);
  await until(() => evalIn(c, `[...document.querySelectorAll(".question-tile-pic img")].length === 3`), 10_000, "three thumbnails");
  check("realm-ui asks with Realm's card, as the session's own agent", (await evalIn(c, `document.querySelector(".question-card .question-from")?.textContent ?? ""`)).includes("Fake agent asks"));
  check("an option's picture is the workspace file, drawn by main as a data URL", await evalIn(c, `[...document.querySelectorAll(".question-tile-pic img")].every((i) => i.src.startsWith("data:image/"))`));
  const tiles = await bothFaces(c, "01-choice-pictures");
  await click(c, ".question-tile", "Calm");
  await until(async () => (await heading(c)) === "What should ship with it?", 8000, "page 2");
  await click(c, ".question-option", "Keyboard shortcuts"); await click(c, ".question-option", "Export settings");
  const multi = await bothFaces(c, "02-multi");
  await click(c, ".question-continue");
  await cardGone(c);
  await until(() => evalIn(c, `!!document.querySelector(".question-answered")`), 10_000, "the answered card");
  const answered1 = await bothFaces(c, "03-choice-answered", ".question-answered");
  check("the answered card shows what was answered, in place of the call's tool row",
    await evalIn(c, `(() => { const a = [...document.querySelectorAll(".question-answered")].at(-1)?.textContent ?? "";
      return a.includes("Calm") && a.includes("Keyboard shortcuts, Export settings") && !document.querySelector('.tool-row[aria-label*="ui_ask"], .tool-card[data-tool*="ui_ask"]'); })()`), { tiles, multi, answered1 });

  // ── 2. Who builds each step ────────────────────────────────────────────────────────────────────
  await send(fake.id, "ask who builds");
  // The model field waits on the catalog, which on a first ask is a whole probe of this Mac's agents.
  await until(() => evalIn(c, `!!document.querySelector(".question-card")`), 90_000, "the model card");
  const chips = await evalIn(c, `[...document.querySelectorAll(".question-model-chip")].map((b) => b.getAttribute("aria-label"))`);
  check("a model chip per step, defaulted to the session's own model", chips.length === 3 && chips.every((l) => l.endsWith(": Fake")), chips);
  await click(c, ".question-model-chip", "Model for Add the toggle");
  await until(() => evalIn(c, `!!document.querySelector(".subagents-chooser")`), 5000, "the chooser");
  check("the chooser a question opens carries data-no-agent", await evalIn(c, `document.querySelector(".subagents-chooser")?.getAttribute("data-no-agent") === "question"`));
  const chooser = await bothFaces(c, "04-model-chooser", ".question-card", { withChooser: true });
  await click(c, ".subagents-chooser-row", "GPT-5.6-Sol");
  await until(() => evalIn(c, `!document.querySelector(".subagents-chooser")`), 5000, "the chooser to close");
  await click(c, ".question-model-chip", "Model for Write the tests");
  await until(() => evalIn(c, `!!document.querySelector(".subagents-chooser")`), 5000, "the chooser");
  await click(c, ".subagents-chooser-row", "Claude Fable 5.1");
  await until(() => evalIn(c, `!document.querySelector(".subagents-chooser")`), 5000, "the chooser to close");
  const models = await bothFaces(c, "05-model-rows");
  await click(c, ".question-continue");
  await cardGone(c);
  const builders = await until(async () => {
    const evs = await api.call("sessions.events", { id: fake.id });
    const r = evs.map((e) => e.event).filter((e) => e.type === "tool_result").at(-1);
    return r?.payload.content.includes("builders") ? r.payload.content : null;
  }, 10_000, "the answer reaching the agent");
  check("the answer reaches the agent as model ids constraints.model takes", builders.includes("2. Add the toggle to Settings ▸ App: gpt-5.6-sol") && builders.includes("3. Write the tests for both: claude-fable-5-1"), builders);
  const answered2 = await bothFaces(c, "06-model-answered", ".question-answered");

  // ── 3. A file, a branch, a time and a masked token ─────────────────────────────────────────────
  await send(fake.id, "ask about the release");
  await cardOpen(c);
  await type(c, ".question-card .question-filter input", "change");
  await until(() => evalIn(c, `!!document.querySelector('.question-card [role=option][aria-label="CHANGELOG.md"]')`), 8000, "a file hit");
  const file = await bothFaces(c, "07-file");
  await click(c, ".question-card [role=option]", "CHANGELOG.md");
  await until(async () => (await heading(c)) === "Which branch should the release go on?", 8000, "the branch page");
  const branch = await bothFaces(c, "08-branch");
  await click(c, ".question-option", "release/v2.0.0");
  await until(async () => (await heading(c)) === "When should it go out?", 8000, "the time page");
  await type(c, ".question-card .question-text-input", "2026-10-09T14:30");
  const time = await bothFaces(c, "09-time");
  await click(c, ".question-continue");
  await until(async () => (await heading(c)) === "Paste the deploy token.", 8000, "the token page");
  await type(c, ".question-card .question-text-input", "tok_live_SHOULD_NEVER_BE_LOGGED");
  check("a secret is typed into a masked field, and the card says where it goes",
    await evalIn(c, `document.querySelector(".question-card .question-text-input").type === "password" && (document.querySelector(".question-card .question-note")?.textContent ?? "").includes("Goes to Fake agent only")`));
  const secret = await bothFaces(c, "10-secret");
  await click(c, ".question-continue");
  await cardGone(c);
  const answered3 = await bothFaces(c, "11-release-answered", ".question-answered");
  const log1 = JSON.stringify(await api.call("sessions.events", { id: fake.id }));
  const calls = JSON.stringify(await api.call("mcp.calls.list", { sessionId: fake.id }));
  check("the masked answer is nowhere in the log or in Activity", !log1.includes("SHOULD_NEVER_BE_LOGGED") && !calls.includes("SHOULD_NEVER_BE_LOGGED"));
  check("and nowhere on screen", !(await evalIn(c, `document.body.textContent.includes("SHOULD_NEVER_BE_LOGGED")`)));

  // ── 4. A Connection's MCP server asking mid-call ───────────────────────────────────────────────
  await send(fake.id, "file the Linear issue");
  await cardOpen(c);
  check("a Connection's question names the server", (await evalIn(c, `document.querySelector(".question-card .question-from")?.textContent ?? ""`)).includes("Linear's MCP server asks"));
  const form = await bothFaces(c, "12-mcp-form");
  await click(c, ".question-option", "Engineering");
  await until(async () => (await heading(c)) === "Priority", 8000, "the priority field");
  await click(c, ".question-option", "High");
  await until(async () => (await heading(c)) === "Estimate, in points", 8000, "the estimate field");
  await type(c, ".question-card .question-text-input", "3");
  await click(c, ".question-continue");
  await until(async () => (await heading(c)) === "Tell the team in Slack?", 8000, "the yes/no field");
  await click(c, ".question-option", "Yes");
  await cardGone(c);
  const created = await until(async () => {
    const evs = await api.call("sessions.events", { id: fake.id });
    const r = evs.map((e) => e.event).filter((e) => e.type === "tool_result").at(-1);
    return r?.payload.content.includes("ENG-421") ? r.payload.content : null;
  }, 15_000, "the server's answer");
  check("the server is answered in the form's own types", created.includes('"team":"eng"') && created.includes('"estimate":3') && created.includes('"notify":true'), created);
  const answered4 = await bothFaces(c, "13-mcp-form-answered", ".question-answered");

  await send(fake.id, "connect Linear");
  await cardOpen(c);
  check("a page to open shows its whole address with the host set apart, as text and not a link",
    await evalIn(c, `!document.querySelector(".question-card a") && document.querySelector(".question-link-host")?.textContent === "linear.app"`));
  const url = await bothFaces(c, "14-mcp-url");
  await click(c, ".question-continue", "Open linear.app");
  await cardGone(c);
  check("the page opens only on the click, in the system browser", (await evalIn(c, `window.__opened`)).join() === "https://linear.app/oauth/authorize?client_id=realm-fixture&scope=read");
  const answered5 = await bothFaces(c, "15-mcp-url-answered", ".question-answered");

  await send(fake.id, "set the Linear key");
  const refused = await until(async () => {
    const evs = await api.call("sessions.events", { id: fake.id });
    const r = evs.map((e) => e.event).filter((e) => e.type === "tool_result").at(-1);
    return r?.payload.content.includes("answered decline") ? r.payload.content : null;
  }, 15_000, "the server's key form, declined");
  check("a form asking for a key is declined without a card", Boolean(refused) && !(await evalIn(c, `!!document.querySelector(".question-card")`)), refused);
  const declined = await bothFaces(c, "16-mcp-key-declined", ".question-answered");

  // ── 5. Codex ───────────────────────────────────────────────────────────────────────────────────
  const { session: codex } = await api.call("sessions.create", { spaceId: space.id, agentKind: "codex", title: "Codex questions", permissionMode: "default" });
  await openSession(c, "Codex questions");
  await send(codex.id, "ASKUSER");
  await cardOpen(c);
  check("Codex's own question is Realm's card, naming Codex", (await evalIn(c, `document.querySelector(".question-card .question-from")?.textContent ?? ""`)).includes("Codex asks"));
  const codex1 = await bothFaces(c, "17-codex-question");
  await click(c, ".question-option", "release/v2");
  await until(async () => (await heading(c)) === "Paste the deploy token.", 8000, "Codex's token page");
  await type(c, ".question-card .question-text-input", "tok_codex_NEVER_LOGGED");
  await click(c, ".question-continue");
  await cardGone(c);
  const codexSaid = await until(async () => evalIn(c, `[...document.querySelectorAll(".msg-assistant")].map((m) => m.textContent).find((t) => t.includes("answered")) ?? null`), 15_000, "Codex's reply");
  check("Codex is answered in its own shape, the masked one kept out of the log", codexSaid.includes('"base":{"answers":["release/v2"]}')
    && !JSON.stringify(await api.call("sessions.events", { id: codex.id })).includes("tok_codex_NEVER_LOGGED"));
  const codex2 = await bothFaces(c, "18-codex-answered", ".question-answered");

  await send(codex.id, "ELICIT");
  await cardOpen(c);
  check("a server of Codex's own config asks as itself, through Codex", (await evalIn(c, `document.querySelector(".question-card .question-from")?.textContent ?? ""`)).includes("notion's MCP server asks, through Codex"));
  const codex3 = await bothFaces(c, "19-codex-elicitation");
  await click(c, ".question-option", "Meeting notes");
  await until(async () => (await heading(c)) === "Share it publicly?", 8000, "the yes/no field");
  await click(c, ".question-option", "No");
  await cardGone(c);
  const codex4 = await bothFaces(c, "20-codex-elicitation-answered", ".question-answered");

  // The whole window once, so the card is seen where it lives.
  await send(fake.id, "ask with pictures");
  await openSession(c, "Questions");
  await cardOpen(c);
  for (const mode of ["dark", "light"]) {
    await setTheme(c, mode);
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `00-window-${mode}.png`), Buffer.from(data, "base64"));
  }
  await setTheme(c, "dark");

  console.log(JSON.stringify({ shots: path.relative(repoRoot, shots), codex1, codex2, codex3, codex4, url, answered5, declined, form, answered4, file, branch, time, secret, answered3, chooser, models, answered2 }, null, 1));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  api.close();
  c.close();
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(async () => {
    electron?.kill("SIGKILL");
    await stopDaemons(path.join(scratch, "home"));
    // Anything still listening on the two ports is this run's, started under its scratch home.
    try { execFileSync("bash", ["-c", `lsof -nP -tiTCP:${SERVER_PORT},${CDP_PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`]); } catch { /* nothing left */ }
  });
