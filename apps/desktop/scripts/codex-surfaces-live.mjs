/**
 * Live check: the surfaces redrawn in Codex's grammar — Settings' cards and type, Sign-ins, the
 * Library's files, and Memory (run with: pnpm build && node apps/desktop/scripts/codex-surfaces-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, seeds the Library with real files on disk (pictures,
 * a PDF, code, data) and the space with a memory document, then captures each surface in both faces
 * and measures what the redesign claims.
 *
 * Ports: LIVE_SERVER_PORT (8975), LIVE_CDP_PORT (9375). Touches only a scratch dir. Nothing is billed:
 * the onboarding session is switched to the fake agent before anything else, and no message is sent.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9375);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8975);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-codex-surfaces-live-"));
const home = path.join(scratch, "home");
const OUTDIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-codex-surfaces");
fs.mkdirSync(OUTDIR, { recursive: true });
const OUT = (tag) => path.join(OUTDIR, `${tag}.png`);
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

const HELPERS = `
globalThis.__live = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; },
  async page(value) {
    const input = document.querySelector('.settings-rail input[value="' + value + '"]');
    if (!input) throw new Error('no settings page ' + value);
    input.click();
    await new Promise((r) => setTimeout(r, 300));
    return true;
  },
  async library(value) {
    const input = [...document.querySelectorAll('input[name^="library-tab-"]')].find((i) => i.value === value);
    if (!input) throw new Error('no library section ' + value);
    input.click();
    await new Promise((r) => setTimeout(r, 400));
    return true;
  },
  rail(label) {
    const b = [...document.querySelectorAll('.app-rail .rail-btn')].find((x) => (x.getAttribute('aria-label') ?? '').startsWith(label));
    if (!b) throw new Error('no destination: ' + label);
    b.click();
    return true;
  },
  /** Every element under root whose own text is set below the floor, by computed size. */
  small(root, floor) {
    const out = [];
    for (const el of root.querySelectorAll('*')) {
      if (el.closest('svg, code, pre, kbd, .visually-hidden')) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const size = parseFloat(cs.fontSize);
      if (size < floor) out.push({ cls: el.className?.baseVal ?? el.className, tag: el.tagName, size, text: el.textContent.trim().slice(0, 40) });
    }
    return out;
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function shoot(c, tag, clip) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
  fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  return data;
}

/** Short synchronous steps driven from here: a long in-page wait on the palette's first opening in a
 *  fresh window can be collected mid-wait ("Promise was collected"). */
async function paletteRow(c, label) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const picked = await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => (o.querySelector(".palette-label")?.textContent.trim() ?? o.textContent.trim()) === ${JSON.stringify(label)} || o.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!hit) return null; hit.click(); return true; })()`), 3000, `palette row ${label}`).catch(() => false);
  if (picked) return true;
  await evalIn(c, `(() => { document.querySelector(".palette input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  throw new Error(`no palette row: ${label}`);
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

async function boot() {
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
      REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
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
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Homework");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

/** Real files, so a picture has pixels to be minted from and a PDF opens. */
function seedFiles() {
  const dir = path.join(scratch, "files");
  fs.mkdirSync(dir, { recursive: true });
  const ref = path.join(repoRoot, "..", ".verify", "ref");
  const pictures = ["codex-settings-cards.png", "codex-library-half.png", "codex-prs-half.png"].map((f) => path.join(ref, f)).filter((f) => fs.existsSync(f));
  const files = [];
  const put = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); files.push(p); };
  pictures.forEach((p, i) => { const to = path.join(dir, ["dashboard-dark.png", "library-mockup.png", "review-screen.png"][i]); fs.copyFileSync(p, to); files.push(to); });
  put("NextGen_Fellows_2026_application.pdf", "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  put("release-notes.md", "# Release notes\n\n- The window is chrome round a sheet.\n");
  put("Pasted text.txt", "Pasted from a message.\n");
  put("sidebar-spaces.tsx", "export const x = 1;\n");
  put("usage-by-day.csv", "day,turns\n2026-10-01,12\n");
  put("theme.json", "{\"accent\":\"blue\"}\n");
  put("capture-bundle.zip", "PK");
  return files;
}

function seedArtifacts(sessionId, files) {
  const db = path.join(home, "realm.db");
  const now = Date.now();
  const day = 86_400_000;
  const when = [0, 0.02, 0.05, 0.3, 1.1, 1.2, 2.5, 3.4, 9, 40, 41].map((d) => Math.round(now - d * day));
  const rows = files.map((p, i) => {
    const name = path.basename(p);
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    const kind = i % 3 === 1 ? "upload" : "output";
    const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
    return `INSERT INTO artifacts (id, session_id, seq, kind, path, name, ext, ts) VALUES (${q(`${sessionId}:${i + 1}:${p}`)}, ${q(sessionId)}, ${i + 1}, ${q(kind)}, ${q(p)}, ${q(name)}, ${q(ext)}, ${when[i % when.length]});`;
  });
  execFileSync("sqlite3", ["-cmd", ".timeout 5000", db, rows.join("\n")]);
}

const MEMORY_DOC = `# How we work in Homework

Every session here is working on the fellowship application and its site.

- Use pnpm, never npm.
- Run the suite as \`SHELL=/bin/bash pnpm vitest run\` — one test flakes under zsh.
- Commit by path; never \`git add -A\` in a shared worktree.
- Drafts go in \`drafts/\`, finished pages in \`site/\`.

Links: the [brief](https://example.com/brief) and the [style guide](https://example.com/style).
`;

async function main() {
  const c = await boot();
  const size = (width, height = 900) => c.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
  await size(1440, 900);

  const sessions = await api.call("sessions.listAll", {});
  const session = sessions[0];
  // Before anything else: the onboarding session runs a REAL engine.
  await api.call("sessions.setAgent", { id: session.id, agentKind: "fake" });
  seedArtifacts(session.id, seedFiles());
  await api.call("memory.set", { spaceId: session.spaceId, doc: MEMORY_DOC });
  note("seeded", { session: session.id, space: session.spaceId });

  for (const face of ["dark", "light"]) {
    if (face === "light") { await paletteRow(c, "Theme: Light"); await sleep(500); }

    await paletteRow(c, "Open settings");
    await until(() => evalIn(c, `!!document.querySelector('.settings-page-pane')`), 15_000, "settings");
    await sleep(600);
    for (const page of ["general", "appearance", "signins", "permissions"]) {
      await evalIn(c, `__live.page(${JSON.stringify(page)})`);
      await sleep(400);
      await shoot(c, `settings-${page}-${face}`);
      if (face === "dark") {
        const small = await evalIn(c, `__live.small(document.querySelector('.settings-page-pane .page-content') ?? document.body, 12.5)`);
        note(`settings ${page}: text under 12.5px`, small.slice(0, 12));
      }
    }
    await evalIn(c, `(() => { document.querySelector('.sb-page-back')?.click(); return true; })()`);
    await sleep(400);

    await evalIn(c, `__live.rail("Library")`);
    await until(() => evalIn(c, `!!document.querySelector('.library-page-pane')`), 15_000, "library");
    await sleep(1200);
    await shoot(c, `library-files-${face}`);
    await evalIn(c, `__live.library("memory")`);
    await sleep(800);
    await shoot(c, `library-memory-${face}`);
    await evalIn(c, `__live.library("skills")`);
    await sleep(500);
    await shoot(c, `library-skills-${face}`);
    await evalIn(c, `(() => { document.querySelector('.sb-page-back')?.click(); return true; })()`);
    await sleep(400);
  }
}

async function teardown() {
  try { api?.close(); } catch { /* gone */ }
  await stopDaemons(home).catch(() => {});
  try { electron?.kill("SIGTERM"); } catch { /* gone */ }
  await sleep(800);
  try { electron?.kill("SIGKILL"); } catch { /* gone */ }
  killPort(SERVER_PORT);
  killPort(CDP_PORT);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
process.exit(process.exitCode ?? 0);
