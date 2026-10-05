/**
 * Live check for the prompter's one `@` list (run with: pnpm build && node apps/desktop/scripts/mentions-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent standing in for Claude
 * (REALM_FAKE_STANDS_IN), so nothing reaches a real engine. Main's app scan is pointed at a scratch
 * Applications folder of fake bundles (REALM_APPS_DIRS) wearing icons copied from the system's own
 * apps, with a scratch Dock order (REALM_DOCK_PLIST) — no app of this Mac is listed, and none is ever
 * driven: the one computer-use call the scripted agent makes only LISTS what is running. Checks:
 *
 *   1. A bare `@` is the tour: @Mac first with the Apple mark, then Files, Library, Skills, Apps under
 *      their heads, apps in the Dock's order with their real icons; `.env` and ignored files absent.
 *   2. A typed word is one ranked list (`@m`, `@auth`), each row saying what it is.
 *   3. Each chip kind in the draft: a file, a Library file, a skill, @mac and an app (its own icon),
 *      and what the prompter says while macOS has not let Realm drive apps.
 *   4. The sent message: the chips in the bubble, the refs on the transcript's user_message, and —
 *      in the scripted agent's echo — what the agent was handed (the files, the computer-use note).
 *   5. The scoped grant on the production path: the agent's `computer_list_apps` reaches the provider
 *      in a space that never switched computer use on.
 *
 * Ports: LIVE_SERVER_PORT (8805), LIVE_CDP_PORT (9245). Screenshots go to LIVE_OUT_DIR, the scratch
 * home to LIVE_SCRATCH_DIR (both the system temp dir unless set). Kills only what listens on its ports.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9245);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8805);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-mentions-live-"));
const home = path.join(scratch, "home");
const VIEWPORT = { width: 1440, height: 900 };
const OUT = (tag) => path.join(OUT_DIR, `mentions-${tag}.png`);
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

const plistXml = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${body}\n</plist>\n`;

/** Fake bundles in a scratch Applications folder, each wearing a system app's icon. Two carry the
 *  real bundle ids of apps the `mac` CLI drives, so the agent's note about the CLI can be seen; none
 *  is ever launched, and the one computer-use call below only lists what is running. */
const FAKE_APPS = [
  { name: "Messages", id: "com.apple.MobileSMS", icon: "/System/Applications/Messages.app/Contents/Resources/AppIcon.icns" },
  { name: "Mail", id: "com.apple.mail", icon: "/System/Applications/Mail.app/Contents/Resources/ApplicationIcon.icns" },
  { name: "Mapmaker", id: "com.example.mapmaker", icon: "/System/Applications/Maps.app/Contents/Resources/AppIcon.icns" },
  { name: "Metronome", id: "com.example.metronome", icon: "/System/Applications/Clock.app/Contents/Resources/AppIcon.icns" },
  { name: "Sketchpad", id: "com.example.sketchpad", icon: "/System/Applications/Freeform.app/Contents/Resources/AppIcon.icns" },
  { name: "Ledger", id: "com.example.ledger", icon: "/System/Applications/Calculator.app/Contents/Resources/AppIcon.icns" },
  { name: "Postcard", id: "com.example.postcard", icon: "/System/Applications/Stickies.app/Contents/Resources/AppIcon.icns" },
];

function seedApps(dir) {
  for (const a of FAKE_APPS) {
    const res = path.join(dir, `${a.name}.app`, "Contents", "Resources");
    fs.mkdirSync(res, { recursive: true });
    fs.writeFileSync(path.join(dir, `${a.name}.app`, "Contents", "Info.plist"), plistXml(`<dict>
  <key>CFBundleIdentifier</key><string>${a.id}</string>
  <key>CFBundleName</key><string>${a.name}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
</dict>`));
    if (fs.existsSync(a.icon)) fs.copyFileSync(a.icon, path.join(res, "AppIcon.icns"));
  }
  // The Dock's order: Messages, then Sketchpad, then Mail.
  const dockXml = path.join(scratch, "dock.xml");
  fs.writeFileSync(dockXml, plistXml(`<dict><key>persistent-apps</key><array>${["com.apple.MobileSMS", "com.example.sketchpad", "com.apple.mail"]
    .map((id) => `<dict><key>tile-data</key><dict><key>bundle-identifier</key><string>${id}</string></dict></dict>`).join("")}</array></dict>`));
  execFileSync("plutil", ["-convert", "binary1", "-o", path.join(scratch, "dock.plist"), dockXml]);
}

/** The session's checkout: a git repository, so `.gitignore` is what decides what is listed. */
function seedWorkspace(dir) {
  const files = {
    "src/server/auth.ts": "export function signIn() {}\n",
    "src/server/session.ts": "export function openSession() {}\n",
    "src/auth.test.ts": "import { signIn } from './server/auth';\n",
    "docs/launch-notes.md": "# Launch\n",
    "README.md": "# Atlas\n",
    ".gitignore": "node_modules/\n",
    "node_modules/leftpad/index.js": "module.exports = () => {};\n",
    // Untracked and NOT ignored: git lists it as an ordinary file. The @ list must not.
    ".env": "API_TOKEN=not-a-real-token\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
}

/** The React tree's store, found through the root's fiber — a test harness's reach, used for ONE
 *  capture only: the chip as it reads once macOS has granted Accessibility, which this shell cannot
 *  grant and a script must never try to. */
const FIND_STORE = `(() => {
  if (window.__liveStore) return true;
  const root = document.getElementById("root");
  const key = root && Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
  if (!key) return false;
  const stack = [root[key]];
  for (let n = 0; stack.length && n < 400000; n++) {
    const f = stack.pop();
    const v = f && f.memoizedProps && f.memoizedProps.value;
    if (v && typeof v.getState === "function" && typeof v.setState === "function" && v.getState() && "draftRefs" in v.getState()) { window.__liveStore = v; return true; }
    if (f && f.sibling) stack.push(f.sibling);
    if (f && f.child) stack.push(f.child);
  }
  return false; })()`;

/** The "Launch prep" session's pane — every selector below is scoped to it. */
const PANE = `(() => { window.__pane = () => { const panes = [...document.querySelectorAll('.session-pane')];
  return panes.find((p) => (p.closest('.panel')?.textContent ?? "").includes("Launch prep")) ?? panes[panes.length - 1]; }; return true; })()`;

/** Type into the prompter the way a keystroke does: the native setter, then `input`, caret at the end. */
const typeInto = (value) => `(() => {
  const el = window.__pane().querySelector('.composer-input');
  el.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
  el.setSelectionRange(el.value.length, el.value.length);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el.value; })()`;
const draftValue = `window.__pane().querySelector('.composer-input').value`;
const rowNames = `[...document.querySelectorAll('#mention-list [role=option] .mention-row-name')].map((e) => e.textContent)`;
const pickRow = (name) => `(() => { const r = [...document.querySelectorAll('#mention-list [role=option]')].find((e) => e.querySelector('.mention-row-name')?.textContent === ${JSON.stringify(name)});
  if (!r) return false; r.click(); return true; })()`;

/** Type `typed` after what the draft already holds, wait for `name` among the rows, and pick it. */
async function mention(c, typed, name) {
  const before = await evalIn(c, draftValue);
  await evalIn(c, typeInto(before + typed));
  await until(async () => (await evalIn(c, rowNames))?.includes(name), 8_000, `row ${name}`);
  await sleep(250);
  return evalIn(c, pickRow(name));
}

/** The window's material is not in the DOM, so the capture paints the root with a stand-in ground
 *  (dark or light as the face is) and puts it back after. `clip` crops to a region of the window. */
async function shot(c, tag, clip) {
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
  await evalIn(c, `(() => { document.documentElement.style.background = ""; return true; })()`);
}

/** The prompter and whatever floats over it, with a margin — the list, the card, the chips. */
const composerClip = (c) => evalIn(c, `(() => {
  const els = [window.__pane().querySelector('.composer'), document.getElementById('mention-list')].filter(Boolean);
  const rs = els.map((e) => e.getBoundingClientRect());
  const x = Math.max(0, Math.min(...rs.map((r) => r.left)) - 24), y = Math.max(0, Math.min(...rs.map((r) => r.top)) - 24);
  const right = Math.min(innerWidth, Math.max(...rs.map((r) => r.right)) + 24), bottom = Math.min(innerHeight, Math.max(...rs.map((r) => r.bottom)) + 24);
  return { x, y, width: right - x, height: bottom - y }; })()`);
const paneClip = (c) => evalIn(c, `(() => { const r = window.__pane().getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);

const setMode = (c, mode) => evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(mode)}; return true; })()`);
const holdAwake = (c) => evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
  new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`);

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const appsDir = path.join(scratch, "Applications");
  seedApps(appsDir);

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
      // Claude is the scripted agent here: the onboarding session and every session below run the
      // script, which skills can be injected into like Claude's — and nothing reaches a real engine.
      REALM_FAKE_STANDS_IN: "claude",
      REALM_APPS_DIRS: appsDir,
      REALM_DOCK_PLIST: path.join(scratch, "dock.plist"),
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
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await holdAwake(c);

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Atlas");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await holdAwake(c);

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  seedWorkspace(space.folderPath);

  // The Library: two files a session was given, indexed by the server the way any attachment is.
  const library = path.join(scratch, "library");
  fs.mkdirSync(library, { recursive: true });
  const pdf = path.join(library, "Q3 report.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  const png = path.join(library, "launch-hero.png");
  execFileSync("sips", ["-s", "format", "png", "-Z", "256", FAKE_APPS[4].icon, "--out", png], { stdio: "ignore" });
  const { session: weekly } = await api.call("sessions.create", { spaceId: space.id, agentKind: "claude", title: "Weekly report", permissionMode: "default" });
  await api.call("sessions.send", { id: weekly.id, text: "Here are this week's files", attachments: [{ path: pdf, mime: "application/pdf" }, { path: png, mime: "image/png" }], mentions: [] });

  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "claude", title: "Launch prep", permissionMode: "default" });
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes("Launch prep"))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes("Launch prep")).click(); return true; })()`);
  await sleep(800);
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes("Launch prep")) b.click(); return true; })()`);
  await sleep(600);
  await holdAwake(c);
  await evalIn(c, PANE);

  // ── 1. The tour ───────────────────────────────────────────────────────────────────────────
  await evalIn(c, typeInto("@"));
  await until(async () => (await evalIn(c, `[...document.querySelectorAll('#mention-list .mention-head')].map((h) => h.textContent).join("|")`)) === "Files|Library|Skills|Apps", 10_000, "tour heads");
  await until(() => evalIn(c, `[...document.querySelectorAll('#mention-list [data-kind=app] img')].length >= 3`), 10_000, "app icons");
  await sleep(300);
  const tour = await evalIn(c, `(() => ({
    first: document.querySelector('#mention-list [role=option] .mention-row-name')?.textContent,
    apple: !!document.querySelector('#mention-list [role=option][data-kind=mac] [data-brand=apple]'),
    rows: [...document.querySelectorAll('#mention-list [role=option]')].map((r) => [r.dataset.kind, r.querySelector('.mention-row-name').textContent, r.querySelector('.mention-row-desc')?.textContent ?? ""]),
    icons: [...document.querySelectorAll('#mention-list [data-kind=app] img')].map((i) => [i.naturalWidth, i.src.slice(0, 22)]),
  }))()`);
  note("tour", tour);
  check("a bare @ leads with @Mac, wearing the Apple mark", tour.first === "mac" && tour.apple, tour.first);
  const apps = tour.rows.filter((r) => r[0] === "app").map((r) => r[1]);
  check("apps come in the Dock's order, then by name", apps.slice(0, 3).join(",") === "Messages,Sketchpad,Mail", apps);
  check("every app row wears its own icon, cut from its bundle", tour.icons.length === apps.length && tour.icons.every(([w, src]) => w >= 32 && src.startsWith("data:image/png")), tour.icons);
  const files = tour.rows.filter((r) => r[0] === "file").map((r) => r[1]);
  check("the checkout's files are listed, and never .env or what .gitignore keeps out", files.length > 0 && !files.includes(".env") && !files.includes("index.js"), files);
  const lib = tour.rows.filter((r) => r[0] === "library").map((r) => r[1]);
  check("the Library's files are listed with the session they came from", lib.includes("Q3 report.pdf") && tour.rows.some((r) => r[0] === "library" && r[2] === "Weekly report"), lib);
  for (const mode of ["dark", "light"]) { await setMode(c, mode); await sleep(250); await shot(c, `1-tour-${mode}`, await composerClip(c)); }
  await setMode(c, "dark");

  // ── 2. Typed: one ranked list ─────────────────────────────────────────────────────────────
  await evalIn(c, typeInto("@m"));
  await until(async () => (await evalIn(c, rowNames))?.[0] === "mac" || (await evalIn(c, rowNames))?.includes("Messages"), 8_000, "@m");
  await sleep(400);
  const m = await evalIn(c, `[...document.querySelectorAll('#mention-list [role=option]')].map((r) => [r.dataset.kind, r.querySelector('.mention-row-name').textContent, r.querySelector('.mention-row-desc')?.textContent ?? ""])`);
  note("@m", m);
  check("@m is one list across kinds with no heads, each row saying what it is", m.length > 3 && m.some((r) => r[0] === "app" && r[2].startsWith("Computer use"))
    && (await evalIn(c, `document.querySelectorAll('#mention-list .mention-head').length`)) === 0, m.map((r) => r[1]));
  for (const mode of ["dark", "light"]) { await setMode(c, mode); await sleep(250); await shot(c, `2-filtered-m-${mode}`, await composerClip(c)); }
  await setMode(c, "dark");
  await evalIn(c, typeInto("@auth"));
  await until(async () => (await evalIn(c, rowNames))?.[0] === "auth.ts", 8_000, "@auth");
  await sleep(300);
  for (const mode of ["dark", "light"]) { await setMode(c, mode); await sleep(250); await shot(c, `2-filtered-auth-${mode}`, await composerClip(c)); }
  await setMode(c, "dark");

  // ── 3. Every chip kind in one draft ───────────────────────────────────────────────────────
  await evalIn(c, typeInto(""));
  await sleep(200);
  await mention(c, "Compare @auth", "auth.ts");
  await mention(c, "with @q3", "Q3 report.pdf");
  await mention(c, "then make a @study", "study-guide");
  await mention(c, "ask @ma", "mac");
  await mention(c, "for my week, and text Sam on @mess", "Messages");
  await evalIn(c, typeInto((await evalIn(c, draftValue)) + "when it is done."));
  await sleep(500);
  const draft = await evalIn(c, draftValue);
  note("draft", draft);
  const chipKinds = await evalIn(c, `[...document.querySelectorAll('.composer-highlight [data-chip]')].map((e) => [e.className, e.dataset.ref ?? "", e.querySelector('img') ? "img" : e.querySelector('[data-brand]')?.getAttribute('data-brand') ?? "glyph"])`);
  note("chips", chipKinds);
  check("the draft wears a file, a Library file, a skill, @mac and an app chip", chipKinds.length === 5 && chipKinds.some((k) => k[1] === "file") && chipKinds.some((k) => k[1] === "library")
    && chipKinds.some((k) => k[0] === "ch-mention" && k[2] === "apple") && chipKinds.some((k) => k[1] === "app" && k[2] === "img"), chipKinds);
  const access = await evalIn(c, `(() => { const n = [...document.querySelectorAll('.composer-mention-note')].map((e) => e.textContent).join(" "); const chip = document.querySelector('.composer-highlight [data-ref=app]'); return { note: n, warn: chip?.hasAttribute('data-warn') ?? false }; })()`);
  note("accessibility", access);
  check("the prompter says honestly whether macOS lets Realm drive the app", access.warn === access.note.includes("cannot drive Messages"), access);
  await evalIn(c, `window.__pane().querySelector('.composer-input').blur()`);
  for (const mode of ["dark", "light"]) { await setMode(c, mode); await sleep(250); await shot(c, `3-chips-${mode}`, await composerClip(c)); }
  // The same draft as it reads once Accessibility is granted — a state this harness cannot reach for
  // real, set in the renderer's store for this one capture and put back straight after.
  if (await evalIn(c, FIND_STORE)) {
    const saved = await evalIn(c, `JSON.stringify(window.__liveStore.getState().computerAccess)`);
    await evalIn(c, `(() => { const s = window.__liveStore; const ca = s.getState().computerAccess ?? { rows: [], hostName: "Realm", packaged: false, helperAvailable: true };
      s.setState({ computerAccess: { ...ca, rows: [{ id: "accessibility", label: "Accessibility", state: "granted", detail: "", canPrompt: false, needsSettings: false, askExplanation: null }, ...ca.rows.filter((r) => r.id !== "accessibility")] } }); return true; })()`);
    await sleep(300);
    for (const mode of ["dark", "light"]) { await setMode(c, mode); await sleep(250); await shot(c, `3-chips-granted-simulated-${mode}`, await composerClip(c)); }
    await evalIn(c, `(() => { window.__liveStore.setState({ computerAccess: ${saved} }); return true; })()`);
  } else note("store", "not found — the granted variant was not captured");
  await setMode(c, "dark");

  // ── 4. Send ───────────────────────────────────────────────────────────────────────────────
  await evalIn(c, `window.__pane().querySelector('.composer-send').click()`);
  await until(() => evalIn(c, `[...window.__pane().querySelectorAll('.msg-user .msg-chip')].length >= 5`), 15_000, "sent chips");
  await until(() => evalIn(c, `[...window.__pane().querySelectorAll('.msg-assistant')].some((e) => e.textContent.includes("echo:"))`), 15_000, "echo");
  await sleep(800);
  const events = await api.call("sessions.events", { id: session.id });
  const sent = events.map((e) => e.event).find((e) => e.type === "user_message");
  note("user_message", sent?.payload);
  check("the transcript keeps the text as typed and the refs beside it, with no second tile for a mentioned file",
    sent?.payload.text === draft.trim() && sent.payload.attachments.length === 0
      && ["file", "library", "app"].every((k) => sent.payload.refs?.some((r) => r.kind === k)), sent?.payload.refs?.map((r) => r.kind));
  const echo = events.map((e) => e.event).filter((e) => e.type === "assistant_text").map((e) => e.payload.text).join("\n");
  note("what the agent was handed", echo);
  check("the agent was handed each file by its chip", echo.includes(`@[auth.ts] — ${path.join(space.folderPath, "src/server/auth.ts")}`) && echo.includes(`@[Q3 report.pdf] — ${pdf}`));
  check("…and told computer use is on for Messages alone, approval and mode still in force",
    echo.includes("@[Messages] — Messages, com.apple.MobileSMS") && echo.includes("no others") && echo.includes("permission mode applies"));
  check("…and pointed at the mac CLI for an app it drives", echo.includes("`mac messages`"));
  check("the @ is gone from what the agent read: @mac and @study-guide resolved or degraded, never literal",
    !/(^|\s)@mac\b/.test(echo.replace(/^echo: /, "")) && !/(^|\s)@study-guide\b/.test(echo.replace(/^echo: /, "")));
  // The bubble as sent — its chips with their marks — then what the agent was handed, below it.
  await evalIn(c, `(() => { const rows = window.__pane().querySelectorAll('.msg-user-row'); rows[rows.length - 1]?.scrollIntoView({ block: "start" }); return true; })()`);
  await sleep(400);
  const bubbleClip = await evalIn(c, `(() => { const rows = window.__pane().querySelectorAll('.msg-user-row'); const r = rows[rows.length - 1].getBoundingClientRect(); const p = window.__pane().getBoundingClientRect();
    return { x: p.left, y: Math.max(p.top, r.top - 24), width: p.width, height: Math.min(r.height + 48 + 260, p.bottom - Math.max(p.top, r.top - 24)) }; })()`);
  for (const mode of ["dark", "light"]) { await setMode(c, mode); await sleep(250); await shot(c, `4-sent-${mode}`, bubbleClip); }
  await evalIn(c, `(() => { const s = window.__pane().querySelector('.transcript, [data-transcript], .msg-list'); const sc = s ?? window.__pane(); sc.scrollTop = sc.scrollHeight; return true; })()`);
  await sleep(300);
  for (const mode of ["dark", "light"]) { await setMode(c, mode); await sleep(250); await shot(c, `4-handed-${mode}`, await paneClip(c)); }
  await setMode(c, "dark");

  // ── 5. The scoped grant, through the agent's own gateway ──────────────────────────────────
  await mention(c, "what is open in @mess", "Messages");
  await evalIn(c, `window.__pane().querySelector('.composer-send').click()`);
  const answered = await until(async () => {
    const evs = await api.call("sessions.events", { id: session.id });
    return evs.map((e) => e.event).find((e) => e.type === "tool_result") ?? null;
  }, 20_000, "list_apps result");
  note("computer_list_apps", answered.payload);
  check("the provider answered the session in a space that never switched computer use on",
    !answered.payload.content.includes("off for this space"), answered.payload.content.slice(0, 160));
  await sleep(800);
  for (const mode of ["dark", "light"]) { await setMode(c, mode); await sleep(250); await shot(c, `5-scoped-call-${mode}`, await paneClip(c)); }
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
