/**
 * Live check for the "what changed" pill and the review it opens
 * (pnpm build, then: node apps/desktop/scripts/what-changed-live.mjs; pictures land in LIVE_SHOT_DIR).
 *
 * A scratch home, the scripted agent only — no turn here is billed. The onboarding session is switched
 * to the fake agent over RPC before anything is sent, and its folder is made a git repository holding
 * the mixed changes a person's own work would: an edited document, a redrawn picture, a new picture,
 * a deleted document, an edited source file. One scripted turn then writes a document and edits the
 * source file for real, so the turn's edit card has something to say too.
 *
 * jsdom can hold no opinion on what this checks: that the pill is drawn on the strip above the card
 * with its stack of marks overlapping, that a click at its real centre opens the review in the side
 * panel, and that the review's pictures are pictures — decoded, before beside after — in both faces
 * and in a narrow window.
 *
 * Ports: LIVE_CDP_PORT / LIVE_SERVER_PORT. Kills only what it started, writes only into a scratch dir.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9252), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8812);
const shots = process.env.LIVE_SHOT_DIR ?? path.join(os.tmpdir(), "realm-what-changed");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-what-changed-live-"));
const home = path.join(scratch, "home");
const WINDOW = { width: 1280, height: 820 };
let electron = null;
let api = null;
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
    await sleep(80);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
    }
  });
  return {
    ready, errors,
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
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
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

const HELPERS = `
window.__live = window.__live ?? {
  setInput(el, value) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  rect(el) { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; },
  pill() {
    const p = document.querySelector(".composer-overstrip .what-changed");
    if (!p) return null;
    const strip = p.closest(".composer-overstrip");
    const kinds = [...p.querySelectorAll(".what-changed-kind")];
    return {
      text: p.textContent.trim(), title: p.getAttribute("title"), strip: strip.textContent.trim(),
      firstChild: strip.firstElementChild === p,
      box: __live.rect(p), stripBox: __live.rect(strip),
      kinds: kinds.map((k) => ({ kind: k.dataset.kind, ...__live.rect(k), mask: getComputedStyle(k).maskImage || getComputedStyle(k).webkitMaskImage })),
    };
  },
  card() {
    const c = [...document.querySelectorAll(".edit-summary")].pop();
    return c ? { name: c.getAttribute("aria-label"), title: c.querySelector(".edit-summary-title")?.textContent, review: !!c.querySelector("button.btn"),
      files: [...c.querySelectorAll(".edit-file-name")].map((n) => n.textContent) } : null;
  },
  review() {
    const pane = document.querySelector(".diff-pane");
    if (!pane || pane.getBoundingClientRect().width === 0) return null;
    const row = (name) => [...pane.querySelectorAll(".diff-file")].find((f) => f.querySelector(".diff-base")?.textContent === name);
    const thumbs = (name) => [...(row(name)?.querySelectorAll(".diff-thumb") ?? [])].map((i) => ({ side: i.dataset.side, decoded: i.complete && i.naturalWidth > 0, ...__live.rect(i) }));
    return {
      box: __live.rect(pane),
      title: pane.querySelector(".diff-summary-title")?.textContent,
      meta: pane.querySelector(".diff-summary-meta")?.textContent,
      groups: [...pane.querySelectorAll(".diff-group")].map((g) => g.getAttribute("aria-label")),
      whats: Object.fromEntries([...pane.querySelectorAll(".diff-file")].map((f) => [f.querySelector(".diff-base")?.textContent, f.querySelector(".diff-what")?.textContent])),
      hero: thumbs("hero.png"), diagram: thumbs("diagram.png"),
      tabTitle: [...document.querySelectorAll(".pane-tab, [role=tab]")].map((t) => t.textContent.trim()).find((t) => t.startsWith("Changes")) ?? null,
    };
  },
  tab(label) {
    const t = [...document.querySelectorAll(".settings-tab, .page-nav a, .page-nav button, [role=tab]")].find((l) => l.textContent.trim() === label);
    if (!t) return false;
    (t.querySelector("input") ?? t).click();
    return true;
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

async function clickAt(c, { x, y }) {
  for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}

async function press(c, { key, code, keyCode, meta = false }) {
  const modifiers = meta ? 4 : 0;
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, key, code, windowsVirtualKeyCode: keyCode });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: keyCode });
}

/** The window's material is not in the DOM, so the root gets a stand-in ground for the capture alone. */
async function shot(c, name, clip) {
  // The pointer off every control, so no hover or tooltip is in the picture.
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 400 });
  await sleep(250);
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    const file = path.join(shots, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`SHOT ${file}`);
  } finally {
    await evalIn(c, `(() => { document.documentElement.style.background = ""; return true; })()`);
  }
}
const clipOf = (c, sel, pad = 0) => evalIn(c, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
  const r = e.getBoundingClientRect(); const x = Math.max(0, r.x - ${pad}), y = Math.max(0, r.y - ${pad});
  return { x, y, width: Math.min(innerWidth - x, r.width + ${2 * pad}), height: Math.min(innerHeight - y, r.height + ${2 * pad}) }; })()`);

/** The window as a person sees a key window: not greyed, not quiet. */
const keyWindow = (c) => evalIn(c, `(() => { const root = document.documentElement;
  const clear = () => { root.removeAttribute("data-window-inactive"); root.removeAttribute("data-quiet"); };
  clear(); new MutationObserver(clear).observe(root, { attributes: true, attributeFilter: ["data-window-inactive", "data-quiet"] }); return true; })()`);

/** A solid picture with a disc in it, so a before and an after are told apart at a glance. */
function png(w, h, ground, disc) {
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (h / 3) ** 2;
      const [r, g, b] = inside ? disc : ground;
      const o = y * row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=live@example.com", "-c", "user.name=Live", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

/** The person's own work, before the agent's turn: committed once, then changed in every way the pill
 *  has words for. */
function stageCheckout(cwd) {
  const write = (rel, body) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), body); };
  write("README.md", "# Garden\n\nA small site about the garden.\n");
  write("old-notes.md", "Notes from last spring.\n");
  write("src/app.ts", "export const greet = () => \"hello\";\n");
  write("art/hero.png", png(192, 128, [250, 240, 225], [214, 76, 60]));
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "Start the garden site");
  write("README.md", "# Garden\n\nA small site about the garden, and what grows in it.\n");
  write("art/hero.png", png(192, 128, [225, 236, 250], [50, 110, 220]));
  write("art/diagram.png", png(128, 128, [236, 248, 236], [40, 160, 90]));
  fs.rmSync(path.join(cwd, "old-notes.md"));
}

async function attach() {
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Page.enable");
  return c;
}

async function setTheme(c, face) {
  await press(c, { key: ",", code: "Comma", keyCode: 188, meta: true });
  await until(() => evalIn(c, `!!document.querySelector(".settings-page-pane")`), 8000, "settings");
  for (const label of ["App", "Appearance"]) if (await evalIn(c, `__live.tab(${JSON.stringify(label)})`)) break;
  await until(() => evalIn(c, `!!document.querySelector('fieldset[aria-label="Theme"] input[value="${face}"]')`), 8000, "theme control");
  await evalIn(c, `document.querySelector('fieldset[aria-label="Theme"] input[value="${face}"]').click(); true`);
  await until(() => evalIn(c, `document.documentElement.dataset.mode === "${face}"`), 5000, `the ${face} face`);
  await press(c, { key: "Escape", code: "Escape", keyCode: 27 });
  await until(() => evalIn(c, `!document.querySelector(".settings-page-pane")`), 5000, "settings put away");
  await sleep(500);
}

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);

  const script = path.join(scratch, "script.json");
  fs.writeFileSync(script, JSON.stringify([{ on: "WC turn", emit: [
    { kind: "tool", name: "Write", input: { file_path: "notes/plan.md", content: "# Plan\n\n- Redraw the hero\n- Say more about what grows\n" }, result: "File created successfully at: notes/plan.md", apply: true },
    { kind: "tool", name: "Edit", input: { file_path: "src/app.ts", old_string: "\"hello\"", new_string: "\"hello, gardener\"" }, result: "The file src/app.ts has been updated.", apply: true },
    { kind: "text", text: "Wrote the plan and made the greeting warmer." },
  ] }]));

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const mainLog = fs.createWriteStream(path.join(scratch, "main.log"));
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: { ...process.env, REALM_HOME: home, REALM_ENABLE_FAKE_AGENT: "1", REALM_FAKE_SCRIPT: script, REALM_HTML_MENUS: "1",
      REALM_GH_BIN: path.join(scratch, "no-gh"), REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.pipe(mainLog); electron.stdout.pipe(mainLog);

  const c = await attach();
  await keyWindow(c);
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.setInput(input, "Garden"); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: WINDOW.width, height: WINDOW.height, deviceScaleFactor: 2, mobile: false });

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [session] = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15_000, "a session");
  // Before anything is sent: no turn of this check may reach a real, billed agent.
  await api.call("sessions.setAgent", { id: session.id, agentKind: "fake" });
  check("the session is on the scripted agent before anything is sent", (await api.call("sessions.get", { id: session.id })).agentKind === "fake");

  // ── 0. A folder that is not a repository yet: no strip at all ──
  await sleep(600);
  check("no strip over the prompter while nothing has changed", await evalIn(c, `!document.querySelector(".composer-overstrip")`));

  stageCheckout(session.cwd);
  await api.call("sessions.send", { id: session.id, text: "WC turn", attachments: [], mentions: [] });
  await until(async () => (await api.call("sessions.get", { id: session.id })).status === "idle" && await evalIn(c, `!!__live.pill()`), 30_000, "the turn's end and the pill");
  await sleep(500);

  // ── 1. The pill ──
  const pill = await evalIn(c, `__live.pill()`);
  check("the pill says what changed in plain words", pill.text === "Changed 6 files", pill.text);
  check("its stack is documents, images, code — in that order", pill.kinds.map((k) => k.kind).join() === "document,image,code", pill.kinds.map((k) => k.kind));
  check("the tooltip breaks the six down by kind", pill.title === "Review what changed: 3 documents, 2 images and 1 code file", pill.title);
  check("the strip carries no branch and no line counts", !/main|\+\d|−\d/.test(pill.strip), pill.strip);
  check("the pill is the strip's first child", pill.firstChild);
  const overlaps = pill.kinds.slice(1).every((k, i) => k.x < pill.kinds[i].x + pill.kinds[i].w);
  check("the marks overlap as a stack, each cut round the next", overlaps && pill.kinds.slice(0, -1).every((k) => k.mask && k.mask !== "none"),
    pill.kinds.map((k) => ({ x: k.x, w: k.w, mask: (k.mask ?? "").slice(0, 30) })));
  check("the pill sits inside its strip, centred", Math.abs((pill.box.x + pill.box.w / 2) - (pill.stripBox.x + pill.stripBox.w / 2)) <= 2, { pill: pill.box, strip: pill.stripBox });

  // How many files the turn's card counts is the checkpoint's measurement (git can read a picture
  // rewritten within the same second as unchanged or changed); the words are what is checked here.
  const card = await evalIn(c, `__live.card()`);
  check("the turn's card speaks the pill's language and keeps Review", /^(Changed|Added) \d+ /.test(card?.title ?? "") && !/Edited/.test(card.title) && card.review, card);

  const stripClip = await clipOf(c, ".composer-dock", 12) ?? await clipOf(c, ".composer", 40);
  await shot(c, "pill-dark", stripClip);

  // ── 2. The review it opens ──
  await c.send("Page.bringToFront");
  await clickAt(c, { x: pill.box.x + pill.box.w / 2, y: pill.box.y + pill.box.h / 2 });
  const review = await until(async () => { const r = await evalIn(c, `__live.review()`); return r && r.hero.length === 2 && r.hero.every((t) => t.decoded) && r.diagram.every((t) => t.decoded) ? r : null; }, 15_000, "the review, its pictures decoded");
  check("the review leads with the pill's words", review.title === "Changed 6 files", review.title);
  check("the branch and the line counts are on the quiet line", /main/.test(review.meta) && /\+\d/.test(review.meta), review.meta);
  check("files are grouped by kind", review.groups.join() === "Documents,Images,Code", review.groups);
  check("each file says what happened to it", review.whats["old-notes.md"] === "Deleted" && review.whats["diagram.png"] === "New" && review.whats["plan.md"] === "New"
    && review.whats["hero.png"] === "Edited" && review.whats["app.ts"] === "Edited", review.whats);
  check("the redrawn picture shows its before beside its after", review.hero.map((t) => t.side).join() === "before,after" && review.hero[0].x < review.hero[1].x, review.hero);
  check("the new picture shows only its after", review.diagram.map((t) => t.side).join() === "after", review.diagram);
  check("the tab is named Changes", review.tabTitle === "Changes", review.tabTitle);
  await shot(c, "review-dark", await clipOf(c, ".diff-pane"));
  await shot(c, "window-dark");

  // A document opens rendered, in Documents.
  const docRow = await evalIn(c, `(() => { const b = [...document.querySelectorAll(".diff-pane .diff-expand")].find((e) => e.getAttribute("aria-label") === "Open README.md"); return b ? __live.rect(b) : null; })()`);
  await clickAt(c, { x: docRow.x + 40, y: docRow.y + docRow.h / 2 });
  const docs = await until(() => evalIn(c, `(() => { const p = [...document.querySelectorAll(".documents-pane, .docs-pane, [class*=documents]")].find((e) => e.getBoundingClientRect().width > 0 && /garden/i.test(e.textContent)); return p ? p.className : null; })()`), 15_000, "README open in Documents").catch(() => null);
  check("a document row opens the file in Documents, rendered", !!docs, docs);
  await shot(c, "document-opened-dark");
  // Back to the review for the light face.
  await evalIn(c, `(() => { const t = [...document.querySelectorAll("button[role=tab]")].find((e) => e.textContent.trim().startsWith("Changes")); t?.click(); return !!t; })()`);
  await until(() => evalIn(c, `!!__live.review()`), 8000, "the review again");

  // ── 3. The light face ──
  await setTheme(c, "light");
  await until(() => evalIn(c, `!!__live.review() && !!__live.pill()`), 8000, "review and pill in light");
  await sleep(400);
  await shot(c, "pill-light", await clipOf(c, ".composer-dock", 12) ?? await clipOf(c, ".composer", 40));
  await shot(c, "review-light", await clipOf(c, ".diff-pane"));
  await shot(c, "window-light");

  // ── 4. Narrow ──
  // A session pane at 820: the side panel steps aside, and the pill has the strip to itself.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 820, height: WINDOW.height, deviceScaleFactor: 2, mobile: false });
  await sleep(700);
  const narrowPill = await evalIn(c, `__live.pill()`);
  check("narrow, the pill keeps its words whole", narrowPill?.text === "Changed 6 files" && narrowPill.box.w <= narrowPill.stripBox.w, narrowPill && { pill: narrowPill.box, strip: narrowPill.stripBox });
  await shot(c, "window-narrow-light");
  // The panel's toggle puts it in the panes' place; at 640 that is a narrow review.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 640, height: WINDOW.height, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  await evalIn(c, `document.querySelector('button[aria-label="Show side panel"]')?.click(); true`);
  const narrowReview = await until(() => evalIn(c, `__live.review()`), 8000, "the review in the panes' place").catch(() => null);
  await sleep(700); // its entrance, so the capture is of the panel and not of its fade
  check("narrow, the review still leads with its words and shows its pictures", narrowReview?.title === "Changed 6 files" && narrowReview.hero.length === 2,
    narrowReview && { box: narrowReview.box, title: narrowReview.title });
  await shot(c, "review-narrow-light", await clipOf(c, ".diff-pane"));
  await setTheme(c, "dark");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 640, height: WINDOW.height, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  if (await evalIn(c, `!!__live.review()`)) await shot(c, "review-narrow-dark", await clipOf(c, ".diff-pane"));
  await evalIn(c, `document.querySelector('button[aria-label="Hide side panel"]')?.click(); true`);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 820, height: WINDOW.height, deviceScaleFactor: 2, mobile: false });
  await sleep(600);
  await shot(c, "window-narrow-dark");

  const errs = c.errors.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(async () => {
    try { await api?.call("daemon.stop", {}); } catch { /* already going */ }
    api?.close();
    electron?.kill("SIGTERM");
    await sleep(1200);
    electron?.kill("SIGKILL");
    await stopDaemons(home);
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
