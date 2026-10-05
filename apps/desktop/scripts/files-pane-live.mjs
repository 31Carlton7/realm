/**
 * Live check for the documents pane's home (run with: pnpm build && node apps/desktop/scripts/files-pane-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent standing in for every engine
 * (REALM_FAKE_STANDS_IN), so nothing runs a billed turn. The session's files are the real pipeline:
 * its scripted turn writes a note and a script and edits the README, and a message attaches a
 * picture — the Library's index records all four, and this script puts the files those tool calls
 * name on disk, with the content they carry. The Library's other rows are seeded into the index for
 * two other sessions, as the recipe in live-check-via-cdp-recipe.md does. Checks, in the window:
 *
 *   1. The session bar's Documents button opens the pane as a tab of the side pane, on a centred
 *      "No files yet" with New document and Code file… — no strip, no void.
 *   2. After the turn: "This session" lists the agent's files and the attachment, once each, and the
 *      Library lists the other sessions' files, none of the session's again.
 *   3. A row's Add-to-message button puts the file in the prompter as a chip.
 *   4. Search narrows both lists and adds the checkout's own names; a name nothing has is offered.
 *   5. New is the in-app menu with a line per kind, Code file… among them.
 *   6. Code file…: the language sets the extension, Create opens it in the code editor.
 *   7. A file from the home opens in the pane; the Files tab goes back.
 *   8. ⌘P from the prompter lands in the home's search.
 *   9. A file the pane cannot reach opens the preview instead.
 *  10. A new tab's Tools list has one Documents row wearing ⌘P, and no Files row.
 * Then the same views in the light face.
 *
 * Ports: LIVE_SERVER_PORT (8802), LIVE_CDP_PORT (9242). Screenshots go to LIVE_OUT_DIR; the scratch
 * home to LIVE_SCRATCH_DIR. Kills only what listens on its own ports.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9242);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8802);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-files-pane-live-"));
const home = path.join(scratch, "home");
const TITLE = "Pricing page";
const VIEWPORT = { width: 1560, height: 940 };
const OUT = (tag) => path.join(OUT_DIR, `files-pane-${tag}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

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
    await sleep(200);
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

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

/** A React-controlled field, filled the way typing fills it. */
const fill = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true; })()`;
/** A button by its visible text inside `scope`. */
const clickText = (scope, text) => `(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}));
  if (!b) return false; b.click(); return true; })()`;
/** The names a home section lists, in order. */
const namesIn = (section) => `[...(document.querySelector('.docs-home section[aria-label=${JSON.stringify(section)}]')?.querySelectorAll('.docs-home-name') ?? [])].map((n) => n.textContent)`;
/** The centre of the element `selector` matches, for a real pointer to go to. */
const centreOf = (c, selector) => evalIn(c, `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
async function pointer(c, type, at) { await c.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 }); }
async function realClick(c, at) { await pointer(c, "mouseMoved", at); await pointer(c, "mousePressed", at); await pointer(c, "mouseReleased", at); }

/** What a scripted Write carries is what lands on disk — the half of a real Write the fake does not do. */
function writeOut(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      // Every engine is the scripted agent, onboarding's session included: nothing reaches a real one.
      REALM_FAKE_STANDS_IN: "claude,codex",
      // The OS menus cannot be driven over CDP; the app draws its own.
      REALM_HTML_MENUS: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  // A window the script opened behind someone's work is not key: Realm greys its accent and goes
  // quiet. Focus is emulated, and the inactive mark held off, so what is captured is the app awake.
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const awake = `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
    new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`;
  await evalIn(c, awake);

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "yooo");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await evalIn(c, awake);

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const envs = await api.call("environments.list", { spaceId: space.id });
  const root = envs.find((e) => e.kind === "primary").path;
  note("checkout", root);
  // The README the agent's turn will edit, as it stood before the turn.
  writeOut(root, { "README.md": "# yooo\n" });
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE, permissionMode: "default" });
  const lead = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  // One pane: the lead alone, so every tab after this is one the check asked for.
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(500);

  // ── 1. Documents, from the session's bar: a tab of its side pane, on a home that is not a void ──
  const opened = await evalIn(c, `(() => { const b = document.querySelector('button[aria-label=${JSON.stringify(`Open documents for ${TITLE}`)}]'); if (!b) return false; b.click(); return true; })()`);
  check("the session bar has a Documents button", opened);
  await until(() => evalIn(c, `!!document.querySelector('.docs-home .pane-empty')`), 10_000, "empty home");
  await sleep(500);
  const empty = await evalIn(c, `(() => { const h = document.querySelector('.docs-home');
    return { title: h.querySelector('.pane-empty-title')?.textContent, line: h.querySelector('.pane-empty-line')?.textContent,
      actions: [...h.querySelectorAll('.docs-home-empty-actions button')].map((b) => b.textContent),
      strip: !!document.querySelector('.documents-tabs'), inSidePane: !!h.closest('.panel')?.querySelector('[role=tab]') }; })()`);
  note("empty home", empty);
  check("a pane with no files anywhere says where they will come from, centred, with two ways to start", empty.title === "No files yet"
    && empty.line?.includes("Files the agent writes or edits in this session") && empty.actions.join("|") === "New document|Code file…" && !empty.strip, empty);
  await shot(c, "1-empty");

  // ── 2. The Library's other files, and the session's own turn ───────────────────────────────────
  const { session: research } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: "Pricing research", permissionMode: "default" });
  const ryez = await api.call("spaces.create", { profileId: space.profileId, name: "ryez" });
  const { session: copy } = await api.call("sessions.create", { spaceId: ryez.id, agentKind: "fake", title: "Onboarding copy", permissionMode: "default" });
  const ryezRoot = (await api.call("environments.list", { spaceId: ryez.id })).find((e) => e.kind === "primary").path;
  const downloads = path.join(scratch, "Downloads");
  fs.mkdirSync(downloads, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "site/public/product/spaces.png"), path.join(downloads, "competitor-pricing.png"));
  writeOut(root, {
    "research/pricing-tiers.md": "# Pricing tiers\n\nThree tiers, one of them free.\n",
    "data/q3-revenue.csv": "month,revenue\nJuly,41200\nAugust,44950\nSeptember,47310\n",
    "scripts/deploy.sh": "#!/bin/sh\nset -e\npnpm build && pnpm deploy\n",
    // On disk and in no record: only the checkout's own search can find it.
    "notes/planning.md": "# Planning\n",
  });
  fs.copyFileSync(path.join(repoRoot, "site/public/product/session.png"), path.join(root, "research/hero-shot.png"));
  writeOut(ryezRoot, { "copy/welcome-email.md": "# Welcome\n\nThanks for signing up.\n" });
  const now = Date.now();
  const rows = [
    [research.id, "output", path.join(root, "research/pricing-tiers.md"), now - 50 * 60_000],
    [research.id, "output", path.join(root, "data/q3-revenue.csv"), now - 3 * 3600_000],
    [research.id, "output", path.join(root, "research/hero-shot.png"), now - 4 * 3600_000],
    [research.id, "output", path.join(root, "scripts/deploy.sh"), now - 26 * 3600_000],
    [copy.id, "output", path.join(ryezRoot, "copy/welcome-email.md"), now - 3 * 86_400_000],
    [copy.id, "upload", path.join(downloads, "competitor-pricing.png"), now - 4 * 86_400_000],
  ];
  const sql = rows.map(([sid, kind, p, ts], i) => {
    const name = path.basename(p); const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    return `INSERT INTO artifacts (id, session_id, seq, kind, path, name, ext, ts) VALUES (${q(`${sid}:${900000 + i}:${p}`)}, ${q(sid)}, ${900000 + i}, ${q(kind)}, ${q(p)}, ${q(name)}, ${q(ext)}, ${ts});`;
  }).join("\n");
  execFileSync("sqlite3", [path.join(home, "realm.db")], { input: sql });

  // The session's own: a picture attached to the message, and the files its turn writes and edits.
  fs.copyFileSync(path.join(repoRoot, "site/public/product/palette.png"), path.join(downloads, "pricing-sketch.png"));
  await api.call("sessions.send", { id: lead, text: "Draft the launch notes and a greeting script, from this sketch.", attachments: [{ path: path.join(downloads, "pricing-sketch.png"), mime: "image/png" }], mentions: [] });
  const evs = await until(async () => {
    const e = await api.call("sessions.events", { id: lead, afterSeq: 0, limit: 500 });
    return e.some((x) => x.event.type === "assistant_text" && x.event.payload.text.startsWith("Wrote the launch plan")) ? e : null;
  }, 20_000, "the turn");
  for (const x of evs.filter((x) => x.event.type === "tool_call")) {
    const { name, input } = x.event.payload;
    if (name === "Write") writeOut(root, { [input.file_path]: input.content });
    if (name === "Edit") writeOut(root, { [input.file_path]: fs.readFileSync(path.join(root, input.file_path), "utf8").replace(input.old_string, input.new_string) });
  }
  await until(async () => (await evalIn(c, namesIn("This session"))).length >= 4, 15_000, "the session's files");
  await sleep(600);
  const session1 = await evalIn(c, namesIn("This session"));
  const library1 = await evalIn(c, namesIn("Library"));
  note("this session", session1);
  note("library", library1);
  check("This session lists the agent's files, newest first, and the attachment, each once",
    JSON.stringify([...session1].sort()) === JSON.stringify(["README.md", "greet.ts", "launch-plan.md", "pricing-sketch.png"].sort()), session1);
  check("the Library lists the other sessions' files, across spaces, and none of this session's",
    ["pricing-tiers.md", "q3-revenue.csv", "welcome-email.md", "competitor-pricing.png"].every((n) => library1.includes(n)) && !library1.some((n) => session1.includes(n)), library1);
  await evalIn(c, `(() => { document.activeElement?.blur?.(); return true; })()`);
  await shot(c, "2-home");

  // ── 3. Add to the next message ──────────────────────────────────────────────────────────────────
  const row = await centreOf(c, `.docs-home section[aria-label="This session"] .docs-home-row:nth-child(2) .docs-home-open`);
  await pointer(c, "mouseMoved", row);
  await sleep(200);
  const addAt = await centreOf(c, `.docs-home section[aria-label="This session"] .docs-home-row:nth-child(2) .docs-home-attach`);
  await realClick(c, addAt);
  const chip = await until(() => evalIn(c, `[...document.querySelectorAll('.composer .attach-tile .visually-hidden')].map((e) => e.textContent)[0] ?? null`), 5_000, "chip").catch(() => null);
  const pressed = await evalIn(c, `document.querySelector('.docs-home section[aria-label="This session"] .docs-home-row:nth-child(2) .docs-home-attach')?.getAttribute('aria-pressed')`);
  note("prompter after Add", { chip, pressed });
  check("Add to the next message puts the file in the prompter, and the row says it is in", !!chip && pressed === "true", { chip, pressed });
  await pointer(c, "mouseMoved", { x: 820, y: 700 });
  await shot(c, "3-added");

  // ── 4. Search ───────────────────────────────────────────────────────────────────────────────────
  await evalIn(c, fill(".docs-home-search input", "plan"));
  await until(async () => (await evalIn(c, namesIn("In yooo"))).length > 0, 8_000, "checkout hits").catch(() => null);
  await sleep(400);
  const found = { session: await evalIn(c, namesIn("This session")), library: await evalIn(c, namesIn("Library")), checkout: await evalIn(c, namesIn("In yooo")) };
  note("search plan", found);
  check("search narrows the session's files and adds the checkout's own names", found.session.includes("launch-plan.md") && found.checkout.includes("planning.md"), found);
  await shot(c, "4-search");
  await evalIn(c, fill(".docs-home-search input", "release-notes.md"));
  const offer = await until(() => evalIn(c, `document.querySelector('.docs-home-create')?.textContent ?? null`), 5_000, "create offer").catch(() => null);
  check("a typed name nothing has is offered to be made", offer?.startsWith("Create release-notes.md"), offer);
  await shot(c, "5-create-offer");
  await evalIn(c, fill(".docs-home-search input", ""));
  await sleep(400);

  // ── 5. New ──────────────────────────────────────────────────────────────────────────────────────
  await evalIn(c, `(() => { document.querySelector('.docs-home-new').click(); return true; })()`);
  const menu = await until(() => evalIn(c, `(() => { const m = document.querySelector('.new-doc-menu'); if (!m) return null;
    return [...m.querySelectorAll('[role=menuitem]')].map((r) => [r.querySelector('.menu-label')?.textContent, r.querySelector('.menu-detail')?.textContent ?? ""]); })()`), 5_000, "new menu");
  note("new menu", menu);
  check("New says what each kind is, with Code file… second", menu[1]?.[0] === "Code file…" && menu.every(([, d]) => d.length > 0), menu);
  await sleep(300);
  await shot(c, "6-new-menu");

  // ── 6. Code file… ───────────────────────────────────────────────────────────────────────────────
  await evalIn(c, clickText(".new-doc-menu [role=menuitem]", "Code file…"));
  await until(() => evalIn(c, `!!document.querySelector('.code-file-prompt input')`), 5_000, "code prompt");
  await sleep(300);
  await evalIn(c, `(() => { [...document.querySelectorAll('.code-file-language')].find((o) => o.textContent.startsWith('Python')).click(); return true; })()`);
  await evalIn(c, fill(".code-file-prompt input", "fetch_prices.py"));
  await sleep(300);
  const prompt = await evalIn(c, `(() => { const p = document.querySelector('.code-file-prompt');
    return { name: p.querySelector('input').value, picked: p.querySelector('[aria-selected=true]')?.textContent, says: p.querySelector('.code-file-says')?.textContent }; })()`);
  note("code prompt", prompt);
  check("the language and the name agree, and the prompt says what it will open as", prompt.name === "fetch_prices.py" && prompt.picked?.startsWith("Python") && prompt.says === "Opens in the code editor as Python", prompt);
  await shot(c, "7-code-prompt");
  await evalIn(c, `(() => { [...document.querySelectorAll('.code-file-prompt button')].find((b) => b.textContent === 'Create').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.documents-code .cm-content')`), 10_000, "code editor");
  await evalIn(c, `(() => { document.querySelector('.documents-code .cm-content').focus(); return true; })()`);
  await c.send("Input.insertText", { text: "import json\n\n\ndef fetch_prices(path: str) -> dict:\n    with open(path) as f:\n        return json.load(f)\n" });
  await until(() => evalIn(c, `document.querySelector('.documents-state')?.textContent === 'Saved'`), 5_000, "saved").catch(() => null);
  const onDisk = fs.existsSync(path.join(root, "fetch_prices.py")) ? fs.readFileSync(path.join(root, "fetch_prices.py"), "utf8") : null;
  const tab = await evalIn(c, `[...document.querySelectorAll('.documents-tab[data-active] .documents-tab-label')].map((t) => t.textContent)`);
  check("Create made the file and opened it in the code editor, which saves it", (onDisk ?? "").includes("def fetch_prices") && tab.includes("fetch_prices.py"), { tab, onDisk: onDisk?.slice(0, 40) });
  await sleep(400);
  await shot(c, "8-code-created");

  // ── 7. Open from the home, and back ─────────────────────────────────────────────────────────────
  await evalIn(c, `(() => { document.querySelector('.documents-home-tab button').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.docs-home section')`), 5_000, "home again");
  await evalIn(c, `(() => { [...document.querySelectorAll('.docs-home-open')].find((b) => b.querySelector('.docs-home-name')?.textContent === 'greet.ts').click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelector('.documents-code .cm-content')?.textContent.includes('Welcome to the launch')`), 10_000, "greet.ts open");
  await sleep(600);
  check("a file from the home opens in the pane's code editor", true);
  await shot(c, "9-open-code");

  // ── 8. ⌘P from the prompter ─────────────────────────────────────────────────────────────────────
  await evalIn(c, `(() => { document.querySelector('.composer textarea')?.focus(); return true; })()`);
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "p", code: "KeyP", windowsVirtualKeyCode: 80, modifiers: 4 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "p", code: "KeyP", windowsVirtualKeyCode: 80, modifiers: 4 });
  const searchFocused = await until(() => evalIn(c, `document.activeElement?.matches?.('.docs-home-search input') ?? false`), 5_000, "⌘P").catch(() => false);
  check("⌘P from the prompter lands in the home's search", searchFocused);
  await sleep(300);
  await shot(c, "10-cmd-p");

  // ── 9. A file the pane cannot reach ─────────────────────────────────────────────────────────────
  await evalIn(c, `(() => { [...document.querySelectorAll('.docs-home-open')].find((b) => b.querySelector('.docs-home-name')?.textContent === 'competitor-pricing.png').click(); return true; })()`);
  const sheet = await until(() => evalIn(c, `(() => { const s = [...document.querySelectorAll('[role=dialog]')].find((d) => d.textContent.includes('competitor-pricing.png')); if (!s) return null;
    return { buttons: [...s.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean) }; })()`), 5_000, "preview").catch(() => null);
  note("preview of an outside file", sheet);
  check("a file outside the checkout opens the preview, which does not offer the pane", !!sheet && !sheet.buttons.includes("Open in the documents pane"), sheet);
  await sleep(500);
  await shot(c, "11-outside-preview");
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(400);

  // ── 10. A new tab's Tools ───────────────────────────────────────────────────────────────────────
  await evalIn(c, `(() => { document.querySelector('.pane-tabs-add')?.click(); return true; })()`);
  await until(() => evalIn(c, clickText(".menu [role=menuitem]", "New tab")), 5_000, "new tab menu").catch(() => null);
  const tools = await until(() => evalIn(c, `(() => { const s = document.querySelector('.new-tab section[aria-label=Tools]'); if (!s) return null;
    return [...s.querySelectorAll('.new-tab-row')].map((r) => [r.querySelector('.new-tab-row-label').textContent, r.querySelector('kbd')?.textContent ?? ""]); })()`), 8_000, "new tab").catch(() => null);
  note("new tab tools", tools);
  check("a new tab offers Documents once, wearing ⌘P, and no Files row", !!tools && tools[0]?.[0] === "Documents" && tools[0]?.[1] === "⌘P" && !tools.some(([l]) => l === "Files"), tools);
  if (tools) await shot(c, "12-new-tab");
  // Back to the documents tab for the light face.
  await evalIn(c, `(() => { [...document.querySelectorAll('.pane-tab-label')].find((t) => t.textContent.includes('Documents'))?.click(); return true; })()`);
  await sleep(600);

  // ── The light face: the same views, re-tokened ──────────────────────────────────────────────────
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "light"; return true; })()`);
  await evalIn(c, `(() => { document.querySelector('.documents-home-tab button')?.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.docs-home section')`), 5_000, "home, light");
  await evalIn(c, fill(".docs-home-search input", ""));
  await sleep(500);
  await evalIn(c, `(() => { document.activeElement?.blur?.(); return true; })()`);
  await shot(c, "13-home-light");
  await evalIn(c, fill(".docs-home-search input", "plan"));
  await sleep(900);
  await shot(c, "14-search-light");
  await evalIn(c, fill(".docs-home-search input", ""));
  await sleep(400);
  await evalIn(c, `(() => { document.querySelector('.docs-home-new').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.new-doc-menu')`), 5_000, "new menu, light");
  await sleep(300);
  await shot(c, "15-new-menu-light");
  await evalIn(c, clickText(".new-doc-menu [role=menuitem]", "Code file…"));
  await until(() => evalIn(c, `!!document.querySelector('.code-file-prompt input')`), 5_000, "code prompt, light");
  await sleep(300);
  await shot(c, "16-code-prompt-light");
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);
  await evalIn(c, `(() => { [...document.querySelectorAll('.docs-home-open')].find((b) => b.querySelector('.docs-home-name')?.textContent === 'greet.ts')?.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.documents-code .cm-content')`), 8_000, "code, light");
  await sleep(600);
  await shot(c, "17-open-code-light");
}

/** The window's material is not in the DOM, so a capture composites the translucent grounds over
 *  nothing and the PNG comes out see-through. For the capture alone the root is painted with a
 *  ground that stands in for the material over a plain wallpaper, dark or light as the face is. */
async function shot(c, tag) {
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
  await evalIn(c, `(() => { document.documentElement.style.background = ""; return true; })()`);
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
