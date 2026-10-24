/**
 * Live check for Share as web page (run with: pnpm build && node apps/desktop/scripts/share-page-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent, and plays one turn with every
 * shape the page draws: Markdown with a heading, a list, a table and code; a read, a search and a
 * command that asks first; an edit; one of the harness's own sub-agents; and one of Realm's, which
 * runs as a session of its own. The prompt carries a picture of the window and a token-shaped string.
 * Then, in the window:
 *
 *   1. The session's ⋯ menu has "Share as web page…", and it opens the Share sheet.
 *   2. The sheet offers what this session has (no Thinking: the scripted agent has none), says the
 *      file's size, and that a value will show as [hidden].
 *   3. Save writes one .html file — the save dialog is answered by the harness, since no CDP command
 *      can drive a native one — and the foot then offers Show in Finder and Open (not pressed: either
 *      would act on the owner's screen).
 *   4. The file carries its picture, both sub-agents, the decided prompt and the diff, no home folder,
 *      no token, one script, a policy that fetches nothing — and no network URL but its links.
 *
 * Captures the sheet dark and light. The saved page is copied to LIVE_OUT_DIR as share-live.html for
 * the browser captures. Ports: LIVE_SERVER_PORT (8811), LIVE_CDP_PORT (9251). Kills only what listens
 * on its own ports.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9251);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8811);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-share-live-"));
const home = path.join(scratch, "home");
const SAVE_PATH = path.join(scratch, "Stream the tokenizer.html");
const TITLE = "Stream the tokenizer";
const VIEWPORT = { width: 1440, height: 900 };
const OUT = (tag) => path.join(OUT_DIR, `share-${tag}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The owner's account folder, written into the scripted paths so the page has a home to hide.
const ME = os.homedir();
// A string in a GitHub token's shape, built here so no credential-looking literal is in the repo.
const TOKEN = `ghp_${"aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z".repeat(2).slice(0, 36)}`;
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

/** Kills what listens on `port` — only when its command line is this checkout's, never a peer's. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) {
      const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (!cmd.includes(repoRoot) && !cmd.includes(scratch)) { note("not killing a process outside this checkout", { port, pid }); continue; }
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  } catch { /* nothing listening */ }
}

/** A button or a menu row by its visible text inside `scope`. */
const clickText = (scope, text) => `(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
  if (!b) return false; b.click(); return true; })()`;

/** The scripted turn, and the sub-agent Realm starts from it. */
function fakeScript() {
  const tokenizer = `${ME}/widgets/src/tokenizer.ts`;
  const answer = [
    "The whole input is read up front in `parser.ts`, and `tokenize` walks a string it already holds. Streaming needs two changes:",
    "",
    "## What changes",
    "",
    "1. **A `Tokenizer` class** with `feed(chunk)` that yields each token as soon as it is complete.",
    "2. **`parse(path)` reads a stream** of 64 KB chunks, so the first line appears before the file has loaded.",
    "",
    "| Input | Before | After |",
    "| --- | ---: | ---: |",
    "| 2 GB log, first line | 40.1 s | 0.08 s |",
    "| Peak memory | 2.4 GB | 96 MB |",
    "",
    "```ts",
    "export class Tokenizer {",
    "  private carry = \"\";",
    "  *feed(chunk: string): Generator<Token> {",
    "    const src = this.carry + chunk;",
    "    for (const token of scan(src)) yield token;",
    "  }",
    "}",
    "```",
    "",
    "See the [Streams API](https://nodejs.org/api/stream.html) for the reader it uses.",
  ].join("\n");
  return [
    { on: "Stream the tokenizer", emit: [
      { kind: "text", text: "I'll read the tokenizer and how the parser calls it first." },
      { kind: "tool", name: "Read", input: { file_path: tokenizer }, result: "     1\texport function tokenize(src: string) {\n     2\t  return src.split(' ');\n     3\t}" },
      { kind: "tool", name: "Grep", input: { pattern: "tokenize\\(" }, result: "src/parser.ts:12:  const tokens = tokenize(readFileSync(path, \"utf8\"));" },
      { kind: "tool", name: "Bash", needsPermission: true, input: { command: "pnpm vitest run tokenizer" }, result: " Test Files  1 passed (1)\n      Tests  4 passed (4)" },
      { kind: "text", text: answer },
      { kind: "tool", name: "Edit", input: { file_path: `${ME}/widgets/src/parser.ts`, old_string: "const tokens = tokenize(readFileSync(path, \"utf8\"));", new_string: "const tokens = [];\nfor await (const chunk of createReadStream(path)) tokens.push(...tokenizer.feed(chunk));" }, result: "Edited" },
      { kind: "tool", name: "Task", input: { description: "Check the parser tests", prompt: "Run the parser's tests against the streaming tokenizer and report anything that fails.", subagent_type: "Explore" }, result: "All **twelve** parser tests pass." },
      { kind: "call", tool: "realm-agent__agent_start", input: { title: "README note", goal: "Write the README note about streaming" } },
      { kind: "call", tool: "realm-agent__agent_wait", input: {} },
      { kind: "text", text: "Done. `parse` streams now, the parser's tests pass, and the README says so." },
    ] },
    { on: "Write the README note about streaming", emit: [
      { kind: "tool", name: "Edit", input: { file_path: `${ME}/widgets/README.md`, old_string: "The tokenizer reads its whole input.", new_string: "The tokenizer streams its input, 64 KB at a time." }, result: "Edited" },
      { kind: "text", text: "The README now says the tokenizer streams." },
    ] },
  ];
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const scriptPath = path.join(scratch, "fake-script.json");
  fs.writeFileSync(scriptPath, JSON.stringify(fakeScript()));

  // The save dialog is the one step no CDP command can drive, so the harness answers it with a path
  // in the scratch folder. Everything after the answer is the app's own path: main writes the file.
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app, dialog } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "dialog.showSaveDialog = async () => ({ canceled: false, filePath: process.env.LIVE_SAVE_PATH });",
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_FAKE_SCRIPT: scriptPath,
      // Every engine the sub-agent could land on is the scripted one: nothing reaches an account.
      REALM_FAKE_STANDS_IN: "claude,codex",
      REALM_LIVE_SCRATCH: "1",
      REALM_HTML_MENUS: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
      LIVE_SAVE_PATH: SAVE_PATH,
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
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const awake = `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
    new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`;
  await evalIn(c, awake);

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Widgets");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await evalIn(c, awake);

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE, permissionMode: "default" });
  const lead = session.id;
  check("the session runs on the scripted agent", (await api.call("sessions.get", { id: lead })).agentKind === "fake");
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);

  // A picture to attach: the window as it stands, which is what a person attaches most.
  const picture = path.join(scratch, "window.png");
  fs.writeFileSync(picture, Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // ── The turn ─────────────────────────────────────────────────────────────────────────────────
  await api.call("sessions.send", { id: lead, mentions: [], attachments: [{ path: picture, mime: "image/png" }],
    text: `Stream the tokenizer: it reads a whole 2 GB log before the first line shows. Keep the parser's API. The CI token is ${TOKEN}, and my notes are in ${ME}/notes.md.` });
  const events = async (id) => api.call("sessions.events", { id, afterSeq: 0, limit: 5000 });
  const asked = await until(async () => (await events(lead)).find((e) => e.event.type === "permission_request"), 30_000, "permission prompt");
  await api.call("sessions.respondPermission", { id: lead, requestId: asked.event.payload.requestId, decision: "allow" });
  await until(async () => (await events(lead)).some((e) => e.event.type === "assistant_text" && e.event.payload.text.startsWith("Done.")), 90_000, "turn over");
  await until(async () => (await api.call("sessions.get", { id: lead })).status === "idle", 30_000, "lead idle");
  await sleep(1000);

  // ── The ⋯ menu, and the sheet ────────────────────────────────────────────────────────────────
  await evalIn(c, `(() => { const bar = [...document.querySelectorAll('.panel-bar')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)}));
    bar.querySelector('button[aria-label^="Pane menu for"]').click(); return true; })()`);
  const rows = await until(() => evalIn(c, `(() => { const m = document.querySelector('[role=menu]'); return m ? [...m.querySelectorAll('[role=menuitem]')].map((x) => x.textContent.trim()) : null; })()`), 5000, "pane menu");
  check("the session's ⋯ menu offers Share as web page…, beside Rename", rows[0] === "Rename" && rows[1] === "Share as web page…", rows);
  await evalIn(c, clickText("[role=menu] [role=menuitem]", "Share as web page…"));
  await until(() => evalIn(c, `!!document.querySelector('.sheet [role=switch]')`), 30_000, "share sheet");
  await sleep(400);
  const sheet = await evalIn(c, `(() => { const s = document.querySelector('.sheet');
    return { title: s.querySelector('h3').textContent, switches: [...s.querySelectorAll('[role=switch]')].map((x) => [x.getAttribute('aria-label'), x.checked]),
      status: s.querySelector('.share-sheet-status')?.textContent ?? null, notes: [...s.querySelectorAll('.share-sheet-note')].map((n) => n.textContent),
      selectable: getComputedStyle(s.querySelector('.settings-row-name')).userSelect }; })()`);
  note("sheet", sheet);
  check("the sheet offers what this session has, thinking aside", JSON.stringify(sheet.switches) === JSON.stringify([["Tool details", true], ["Pictures", true], ["Sub-agents", true], ["Hide file paths", true]]), sheet.switches);
  check("the sheet says the file's size", /^\d+(\.\d)? (KB|MB)$/.test(sheet.status ?? ""), sheet.status);
  check("the sheet says the token will show as [hidden]", sheet.notes.includes("A value that looks like a key or a token shows as [hidden]."), sheet.notes);
  for (const face of ["dark", "light"]) {
    await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(face)}; return true; })()`);
    await sleep(400);
    await shot(c, `sheet-${face}`);
  }
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);

  // ── Save ─────────────────────────────────────────────────────────────────────────────────────
  await evalIn(c, clickText(".sheet button", "Save…"));
  const saved = await until(() => evalIn(c, `document.querySelector('.share-sheet-status')?.textContent.startsWith('Saved') ? [...document.querySelectorAll('.sheet-foot button')].map((b) => b.textContent) : null`), 15_000, "saved");
  check("Save writes the file and the foot offers Show in Finder and Open", fs.existsSync(SAVE_PATH) && saved.join("|") === "Show in Finder|Open|Done", saved);
  await shot(c, "sheet-saved-dark");

  const html = fs.readFileSync(SAVE_PATH, "utf8");
  fs.copyFileSync(SAVE_PATH, path.join(OUT_DIR, "share-live.html"));
  note("saved page", { bytes: html.length });
  check("the page is one document with one script, and a policy that fetches nothing",
    html.startsWith("<!doctype html>") && (html.match(/<script>/g) ?? []).length === 1 && html.includes("default-src 'none'") && html.includes("img-src data:"));
  check("the page carries the attached picture inside it", /<img src="data:image\/png;base64,/.test(html));
  check("the page holds the answer's table and highlighted code", html.includes('<div class="table"><table>') && html.includes('class="hljs-keyword"'));
  check("the page draws the edit as a diff and the decided prompt on its line", html.includes('<tr data-kind="add">') && html.includes("Allowed when asked"));
  check("the page nests both sub-agents, Realm's with its own session", html.includes("Check the parser tests") && html.includes("The README now says the tokenizer streams."));
  check("the page writes the home folder as ~", !html.includes(ME) && html.includes("~/widgets/src/parser.ts"));
  check("the page hides the token and says so", !html.includes(TOKEN) && html.includes('class="secret"') && html.includes("Realm hid a value that looked like a key or a token."));
  const urls = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith("#") && !u.startsWith("data:"));
  check("no URL in the page is loaded, only linked", urls.every((u) => /^https:\/\//.test(u)) && !/\bsrc="https?:/.test(html), urls);

  await evalIn(c, clickText(".sheet-foot button", "Done"));
  check("Done puts the sheet away", await until(() => evalIn(c, `!document.querySelector('.sheet')`), 3000, "sheet gone").catch(() => false));

  // The `/share` command opens the same sheet.
  await evalIn(c, `(() => { const box = document.querySelector('.composer-input'); box.focus(); return true; })()`);
  await c.send("Input.insertText", { text: "/share" });
  await until(() => evalIn(c, `!!document.querySelector('.slash-picker')`), 3000, "slash picker");
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  check("/share opens the Share sheet", await until(() => evalIn(c, `document.querySelector('.sheet h3')?.textContent === 'Share as web page'`), 5000, "slash sheet").catch(() => false));
}

/** The window's material is not in the DOM, so a capture composites the translucent grounds over
 *  nothing. For the capture alone the root gets a ground standing in for it, and the scratch banner
 *  is lifted off so the sheet reads as the owner's window would. */
async function shot(c, tag) {
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b";
    const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = "none"; return true; })()`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
  await evalIn(c, `(() => { document.documentElement.style.background = ""; const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = ""; return true; })()`);
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
