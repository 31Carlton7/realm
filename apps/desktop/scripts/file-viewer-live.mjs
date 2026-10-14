/**
 * Live check for how Realm shows a text file (run with: pnpm build && node apps/desktop/scripts/file-viewer-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent standing in for every engine,
 * sends one session a handful of source and text files (so the Library lists them), and looks at:
 *
 *   1. The Library's tiles: each text file wears its own logo (a `.ts` the blue TS square, a
 *      `package.json` Node's hexagon), not one code glyph for all of them.
 *   2. A text file opened from the Library: the documents pane's own editor on a sheet — a `.ts` as
 *      highlighted source with line numbers that scrolls sideways, a `.md` rendered as Markdown with
 *      its wide fence scrolling inside itself — and not QuickLook's grey picture of the page.
 *   3. The documents pane: a long line of source and of plain text scrolls sideways, the gutter stays
 *      put, and its home lists the files under their logos.
 *   4. The prompter: a file is a card with its mark, name and kind; a picture a square; a folder a
 *      folder; and Remove takes one out.
 * Both faces.
 *
 * Ports: REALM_PORT (8791) and REALM_DEVTOOLS_PORT (9231). Screenshots go to LIVE_OUT_DIR.
 * Kills only what listens on its own ports.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { openSideTool } from "./lib/side-tools.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.REALM_DEVTOOLS_PORT ?? 9231);
const SERVER_PORT = Number(process.env.REALM_PORT ?? 8791);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH_DIR ?? os.tmpdir(), "realm-file-viewer-live-"));
const home = path.join(scratch, "home");
const TITLE = "Atlas server";
const VIEWPORT = { width: 1440, height: 900 };
const OUT = (tag) => path.join(OUT_DIR, `file-viewer-${tag}.png`);
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
  const errors = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails?.exception?.description ?? "exception");
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

const click = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`;
async function key(c, k, code = k, vk = 0) {
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
}
const escape = (c) => key(c, "Escape", "Escape", 27);
/** The app's store, found through React's own fiber on the app root — for the two asks a script cannot
 *  make through the UI here: putting a folder in the prompter (the picker is a native dialog), and
 *  opening a file in the documents pane at once. */
const STORE = `(() => { const el = document.querySelector('.app'); const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
  for (let f = el[k]; f; f = f.return) { const v = f.memoizedProps?.value; if (v && typeof v.getState === 'function') return v; } return null; })()`;
const settled = (c) => evalIn(c, `Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime)).map((a) => a.finished.catch(() => null))),
  new Promise((r) => setTimeout(r, 2000)),
]).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => true)`);

const SERVER_TS = `import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** One route per resource; the handler table is the whole router, so a reader sees every path the server answers at a glance without following a chain of middleware. */
const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  "/health": async (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, uptime: process.uptime(), version: process.env.ATLAS_VERSION ?? "dev" })); },
  "/launches": async (_req, res) => { const rows = await listLaunches({ limit: 50, orderBy: "scheduledAt", direction: "desc", includeDrafts: false }); res.end(JSON.stringify(rows)); },
};

export function start(port = Number(process.env.PORT ?? 8080)) {
  const server = createServer((req, res) => void (routes[req.url ?? ""] ?? notFound)(req, res));
  server.listen(port, () => console.log(\`atlas listening on http://127.0.0.1:\${port}\`));
  return server;
}

async function notFound(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(404).end();
}

async function listLaunches(o: { limit: number; orderBy: string; direction: "asc" | "desc"; includeDrafts: boolean }) {
  return [] as { id: string; title: string; scheduledAt: string }[];
}
`;
const README = `# Atlas

Atlas schedules launches and keeps the page that announces each one in step with the product.

## Running it

1. Install the dependencies with \`pnpm install\`.
2. Start the server; it listens on port 8080 unless \`PORT\` says otherwise.

\`\`\`sh
PORT=8080 ATLAS_VERSION=$(git describe --tags --always) pnpm --filter @atlas/server exec tsx src/server.ts --log-level=debug --watch
\`\`\`

| Route | What it returns |
| --- | --- |
| \`/health\` | Uptime and version |
| \`/launches\` | The next fifty launches |

> The server reads no configuration file; everything it needs is in the environment.
`;
const NOTES = `Launch checklist — Atlas 3.0
2026-10-12 14:02:11.384 INFO  scheduler   picked launch 3.0 for 2026-10-20T16:00:00Z (window 16:00–18:00 UTC, owner: release-team, page: /launch/atlas-3)
2026-10-12 14:02:11.512 WARN  pages       the hero image on /launch/atlas-3 is 4.2 MB; the page budget is 1.5 MB — it will be served, but slowly, until someone exports a smaller one
2026-10-12 14:02:12.004 INFO  scheduler   3 launches queued, 0 drafts, next run in 30 minutes
`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    // A scratch window must never take the owner's typing: no key focus, and a title that says so.
    'app.on("browser-window-created", (_e, w) => { w.setFocusable(false); w.setTitle("SCRATCH — file viewer check");',
    '  w.on("page-title-updated", (e) => e.preventDefault()); });',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
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
      REALM_HTML_MENUS: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(path.join(OUT_DIR, "file-viewer-electron.log"));
  electron.stderr.pipe(log); electron.stdout.pipe(log);

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 180_000, "renderer target")
    .catch(async (e) => { note("targets", await targets()); throw e; });
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const awake = `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
    new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`;
  await evalIn(c, awake);

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 90_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Atlas");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await evalIn(c, awake);

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const envs = await api.call("environments.list", { spaceId: space.id });
  const env = envs.find((e) => e.kind === "primary");
  const root = env.path;
  note("checkout", root);

  const files = {
    "server.ts": SERVER_TS, "README.md": README, "notes.txt": NOTES,
    "package.json": JSON.stringify({ name: "@atlas/server", version: "3.0.0", type: "module", scripts: { dev: "tsx watch src/server.ts" } }, null, 2) + "\n",
    "styles.css": ":root { --ink: #1d1d1f; }\nbody { margin: 0; font: 15px/1.5 system-ui; color: var(--ink); }\n",
    "main.py": "def launch(name: str) -> None:\n    print(f\"launching {name}\")\n\n\nif __name__ == \"__main__\":\n    launch(\"atlas\")\n",
    "Dockerfile": "FROM node:22-slim\nWORKDIR /app\nCOPY . .\nRUN corepack enable && pnpm install --frozen-lockfile\nCMD [\"node\", \"dist/server.js\"]\n",
    "launches.csv": "id,title,scheduled_at,owner,page\n1,Atlas 3.0,2026-10-20T16:00:00Z,release-team,/launch/atlas-3\n2,Atlas 3.1,2026-11-17T16:00:00Z,release-team,/launch/atlas-3-1\n",
  };
  for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(root, n), body);
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  const ff = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x400", "-frames:v", "1", "-y", path.join(root, "hero.png")]);
  if (ff.status !== 0) throw new Error("ffmpeg failed");
  fs.copyFileSync(path.join(root, "hero.png"), path.join(root, "assets", "hero.png"));

  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE, permissionMode: "default" });
  const lead = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  const mime = (n) => (n.endsWith(".png") ? "image/png" : n.endsWith(".json") ? "application/json" : n.endsWith(".md") ? "text/markdown" : n.endsWith(".csv") ? "text/csv" : "text/plain");
  const sent = [...Object.keys(files), "hero.png"];
  await api.call("sessions.send", { id: lead, mentions: [], text: "The server, its readme and the launch notes.",
    attachments: sent.map((n) => ({ path: path.join(root, n), mime: mime(n) })) });
  await until(() => evalIn(c, `document.querySelectorAll('.msg-user-files .attach-tile').length === ${sent.length}`), 20_000, "the sent files");

  // ── 1. The Library's tiles ──────────────────────────────────────────────────────────────────────
  await evalIn(c, click(`.app-rail button[aria-label="Library"]`));
  await until(() => evalIn(c, `document.querySelectorAll('.library-tile').length >= ${sent.length}`), 15_000, "the Library");
  await sleep(800);
  const marks = await evalIn(c, `Object.fromEntries([...document.querySelectorAll('.library-tile')].map((t) => [t.title.split('/').pop(), t.querySelector('.file-mark')?.dataset.mark ?? (t.hasAttribute('data-thumb') ? 'picture' : null)]))`);
  note("library marks", marks);
  check("each text file in the Library wears its own logo", marks["server.ts"] === "typescript" && marks["README.md"] === "readme"
    && marks["package.json"] === "nodejs" && marks["main.py"] === "python" && marks["Dockerfile"] === "docker"
    && marks["launches.csv"] === "table" && marks["notes.txt"] === "document" && marks["styles.css"] === "css", marks);
  const tsImg = await evalIn(c, `(() => { const i = [...document.querySelectorAll('.library-tile')].find((t) => t.title.endsWith('/server.ts'))?.querySelector('.file-mark-img'); return i ? { ok: i.complete && i.naturalWidth > 0, w: i.getBoundingClientRect().width } : null; })()`);
  check("the logo is drawn, at the tile's mark size", tsImg?.ok && Math.round(tsImg.w) === 32, tsImg);
  await shot(c, "1-library-dark");

  // ── 2. Opening a text file from the Library ─────────────────────────────────────────────────────
  const openTile = (n) => evalIn(c, `(() => { [...document.querySelectorAll('.library-tile')].find((t) => t.title.endsWith('/${n}'))?.click(); return true; })()`);
  const VIEW = `(() => { const d = document.querySelector('.media-viewer .media-viewer-doc'); if (!d) return null;
    const sc = d.querySelector('.cm-scroller'); const r = d.getBoundingClientRect();
    const pre = d.querySelector('.documents-rich-surface pre');
    return { view: d.dataset.view, w: Math.round(r.width), h: Math.round(r.height),
      lines: d.querySelectorAll('.cm-lineNumbers .cm-gutterElement').length, wraps: !!d.querySelector('.cm-lineWrapping'),
      scrollsX: sc ? sc.scrollWidth > sc.clientWidth + 4 : null, scrollsY: sc ? sc.scrollHeight > sc.clientHeight + 4 : null,
      highlighted: d.querySelectorAll('.cm-line span[class]').length,
      h1: d.querySelector('.documents-rich-surface h1')?.textContent ?? null, table: !!d.querySelector('.documents-rich-surface table'),
      preScrollsX: pre ? pre.scrollWidth > pre.clientWidth + 4 : null, editable: d.querySelector('[contenteditable="true"]') !== null,
      picture: !!document.querySelector('.media-viewer img.media-viewer-img') }; })()`;
  await openTile("server.ts");
  const ts = await until(async () => { const v = await evalIn(c, VIEW); return v && v.lines > 5 && v.highlighted > 5 ? v : null; }, 15_000, "server.ts in the viewer");
  note("server.ts", ts);
  check("a .ts opens as highlighted source with line numbers, not a picture of the page", ts.view === "code" && !ts.picture && ts.lines >= 20, ts);
  check("its long lines scroll sideways rather than wrapping", ts.scrollsX && !ts.wraps, ts);
  check("it is read-only", !ts.editable, ts);
  // Sideways, the gutter holds: the numbers stay at the sheet's left edge.
  const gutter = await evalIn(c, `(() => { const d = document.querySelector('.media-viewer-doc'); const sc = d.querySelector('.cm-scroller'); const g = d.querySelector('.cm-gutters');
    const before = g.getBoundingClientRect().left; sc.scrollLeft = 400; return new Promise((r) => requestAnimationFrame(() => r({ before, after: g.getBoundingClientRect().left, left: sc.scrollLeft }))); })()`);
  check("scrolled sideways, the line numbers stay where they were", gutter.left > 0 && Math.abs(gutter.before - gutter.after) < 1, gutter);
  await evalIn(c, `(() => { document.querySelector('.media-viewer-doc .cm-scroller').scrollLeft = 0; return true; })()`);
  await shot(c, "2-viewer-ts-dark");
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");

  await openTile("README.md");
  const md = await until(async () => { const v = await evalIn(c, VIEW); return v?.h1 ? v : null; }, 15_000, "README.md in the viewer");
  note("README.md", md);
  check("a .md opens rendered, as the documents pane renders it", md.view === "markdown" && md.h1 === "Atlas" && md.table && !md.picture, md);
  check("its wide fence scrolls inside itself while the prose wraps", md.preScrollsX === true, md);
  check("the sheet is as tall as the file, not the window", md.h < VIEWPORT.height - 200, md);
  await shot(c, "3-viewer-md-dark");
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");

  await openTile("notes.txt");
  const txt = await until(async () => { const v = await evalIn(c, VIEW); return v && v.lines >= 4 ? v : null; }, 15_000, "notes.txt in the viewer");
  check("a .txt opens as text with line numbers, scrolling sideways", txt.view === "code" && txt.scrollsX && !txt.wraps, txt);
  await shot(c, "4-viewer-txt-dark");
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");

  await openTile("Dockerfile");
  const dock = await until(async () => { const v = await evalIn(c, VIEW); return v && v.lines >= 4 ? v : null; }, 15_000, "Dockerfile in the viewer");
  check("a file with no extension is tried as text", dock.view === "code", dock);
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");

  // ── The light face, for the Library and the viewer ─────────────────────────────────────────────
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "light"; return true; })()`);
  await sleep(400);
  await shot(c, "5-library-light");
  await openTile("server.ts");
  await until(async () => { const v = await evalIn(c, VIEW); return v && v.highlighted > 5 ? v : null; }, 15_000, "server.ts, light");
  await shot(c, "6-viewer-ts-light");
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");
  await openTile("README.md");
  await until(async () => { const v = await evalIn(c, VIEW); return v?.h1 ? v : null; }, 15_000, "README.md, light");
  await shot(c, "7-viewer-md-light");
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.page-overlay')`), 5_000, "the Library put away");
  await sleep(500);

  // ── 3. The documents pane ───────────────────────────────────────────────────────────────────────
  await openSideTool(c, TITLE, "Documents");
  await until(() => evalIn(c, `document.querySelectorAll('.docs-home .docs-home-row').length > 3`), 15_000, "the documents home");
  await sleep(600);
  const homeMarks = await evalIn(c, `[...document.querySelectorAll('.docs-home-row')].map((r) => [r.querySelector('.docs-home-name')?.textContent, r.querySelector('.file-mark')?.dataset.mark ?? null])`);
  note("documents home marks", homeMarks);
  check("the documents home lists files under their logos", homeMarks.some(([n, m]) => n === "server.ts" && m === "typescript"), homeMarks);
  await shot(c, "8-docs-home-dark");
  const PANE = (cls) => `(() => { const el = document.querySelector('.documents-editor ${cls}'); if (!el) return null;
    const r = el.getBoundingClientRect(); const pane = el.closest('.documents-editor').getBoundingClientRect();
    return { sw: el.scrollWidth, cw: el.clientWidth, right: Math.round(r.right), paneRight: Math.round(pane.right), wraps: !!document.querySelector('.documents-editor .cm-lineWrapping') }; })()`;
  await evalIn(c, `${STORE}.getState().openDocumentPath(${JSON.stringify(path.join(root, "server.ts"))}, ${JSON.stringify(env.id)})`);
  const paneTs = await until(() => evalIn(c, PANE(".cm-scroller")), 15_000, "server.ts in the pane");
  note("server.ts in the pane", paneTs);
  check("in the documents pane, a long line of source scrolls sideways inside the pane", paneTs.sw > paneTs.cw + 4 && paneTs.right <= paneTs.paneRight + 1 && !paneTs.wraps, paneTs);
  await evalIn(c, `(() => { document.querySelector('.documents-editor .cm-scroller').scrollLeft = 300; return true; })()`);
  await sleep(200);
  await shot(c, "9-docs-ts-scrolled-dark");
  await evalIn(c, `${STORE}.getState().openDocumentPath(${JSON.stringify(path.join(root, "notes.txt"))}, ${JSON.stringify(env.id)})`);
  const paneTxt = await until(async () => { const v = await evalIn(c, `(() => document.querySelector('.documents-editor .cm-content')?.textContent.includes('Launch checklist') ? ${PANE(".cm-scroller")} : null)()`); return v; }, 15_000, "notes.txt in the pane");
  check("and so does a line of plain text", paneTxt.sw > paneTxt.cw + 4 && !paneTxt.wraps, paneTxt);
  await shot(c, "10-docs-txt-dark");
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "light"; return true; })()`);
  await sleep(300);
  await shot(c, "11-docs-txt-light");
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);

  // ── 4. The prompter ─────────────────────────────────────────────────────────────────────────────
  const attach = ["server.ts", "README.md", "hero.png", "assets", "launches.csv"].map((n) => path.join(root, n));
  await evalIn(c, `${STORE}.getState().attachPaths(${JSON.stringify(lead)}, ${JSON.stringify(attach)})`);
  await until(() => evalIn(c, `document.querySelectorAll('.app .composer .attach-tile').length === 5`), 10_000, "the prompter's attachments");
  await sleep(800);
  const tiles = await evalIn(c, `[...document.querySelectorAll('.app .composer .attach-tile')].map((t) => ({ layout: t.dataset.layout ?? 'square', folder: t.hasAttribute('data-folder'),
    name: t.querySelector('.attach-card-name')?.textContent ?? null, kind: t.querySelector('.attach-card-kind')?.textContent ?? null,
    mark: t.querySelector('.file-mark')?.dataset.mark ?? null, thumb: !!t.querySelector('img.attach-thumb'), h: Math.round(t.getBoundingClientRect().height) }))`);
  note("prompter tiles", tiles);
  const byName = (n) => tiles.find((t) => t.name === n);
  check("a source file is a card with its logo, name, and kind and size", byName("server.ts")?.mark === "typescript" && /^TS · [\d.]+ (B|KB)$/.test(byName("server.ts")?.kind ?? ""), byName("server.ts"));
  check("a folder is a card that says Folder, with the folder mark", byName("assets")?.folder && byName("assets")?.kind === "Folder" && byName("assets")?.mark === "folder", byName("assets"));
  check("a picture stays its thumbnail", tiles.some((t) => t.layout === "square" && t.thumb), tiles);
  check("cards and squares share one height", new Set(tiles.map((t) => t.h)).size === 1, tiles.map((t) => t.h));
  // The hover state: Remove comes up on a card, at its corner.
  const card = await evalIn(c, `(() => { const t = [...document.querySelectorAll('.app .composer .attach-tile')].find((x) => x.querySelector('.attach-card-name')?.textContent === 'README.md'); const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: card.x, y: card.y, button: "none" });
  await sleep(400);
  await shotComposer(c, "12-prompter-dark");
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "light"; return true; })()`);
  await sleep(300);
  await shotComposer(c, "13-prompter-light");
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);
  await evalIn(c, `(() => { document.querySelector('.app .composer button.attach-remove[aria-label="Remove README.md"]').click(); return true; })()`);
  const after = await until(() => evalIn(c, `(() => { const n = [...document.querySelectorAll('.app .composer .attach-tile')].map((t) => t.querySelector('.attach-card-name')?.textContent ?? 'picture'); return n.length === 4 ? n : null; })()`), 5_000, "one fewer");
  check("Remove takes that file out, and only that one", !after.includes("README.md") && after.includes("server.ts"), after);
  // A card opens the viewer, the same as the Library's tile.
  await evalIn(c, `(() => { [...document.querySelectorAll('.app .composer .attach-tile')].find((x) => x.querySelector('.attach-card-name')?.textContent === 'server.ts').querySelector('.attach-open').click(); return true; })()`);
  const fromChip = await until(async () => { const v = await evalIn(c, VIEW); return v && v.lines > 5 ? v : null; }, 15_000, "server.ts from the chip");
  check("a card opens the same text view", fromChip.view === "code", fromChip);
  await escape(c);

  check("no page exceptions along the way", c.errors.length === 0, c.errors.slice(0, 3));
}

/** The window's material is not in the DOM, so the root is painted for the capture alone. */
async function shot(c, tag, clip) {
  await settled(c);
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b";
    const b = document.getElementById('live-scratch-banner'); if (b) b.style.visibility = 'hidden'; return true; })()`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
  await evalIn(c, `(() => { document.documentElement.style.background = ""; const b = document.getElementById('live-scratch-banner'); if (b) b.style.visibility = ''; return true; })()`);
}

/** The prompter and a margin round it — the attachments are small, and a whole window of them is a
 *  picture of everything else. */
async function shotComposer(c, tag) {
  const r = await evalIn(c, `(() => { const b = document.querySelector('.app .composer').getBoundingClientRect(); return { x: Math.max(0, b.left - 24), y: Math.max(0, b.top - 60), width: b.width + 48, height: b.height + 84 }; })()`);
  await shot(c, tag, r);
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
