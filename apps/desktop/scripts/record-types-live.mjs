/**
 * Live check for dynamic Teams, PR 1 — record types (run with: node apps/desktop/scripts/record-types-live.mjs)
 *
 * Seeds a SCRATCH home with the hand-written v50 fixture (apps/server/scripts/seed-v50-home.ts: RC2's
 * Versed team, Nathan's record in its memory repo) and boots built apps on it with the scripted agent
 * standing in for Claude, so nothing is billed:
 *
 *   R0  the RC2 build (LIVE_RC2_ROOT, a worktree of integration/backlog-oct9 built with `pnpm build`)
 *       draws Nathan's record — the baseline. Skipped, and said, when there is no RC2 build;
 *   R1  this build boots on the SAME home, migrates it to v51, and draws Nathan's record: the pixels
 *       are compared with R0's (the plan: within 1%);
 *   R2  the person makes Leads from "New record type…" — a preset card, landing on its fields;
 *   R3  Creator Manager (the fake engine) calls record_types and record_update create type lead: the
 *       file lands in leads/, committed under the role's name;
 *   R4  moving a folder that holds records is refused, over RPC and on the page (the field is fixed);
 *   R5  every surface in dark and light.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8823 / 9263). Screenshots go to LIVE_OUT. It touches only its
 * own scratch home (LIVE_SCRATCH, default a fresh mktemp folder), and kills only what holds its own two
 * ports. Run `pnpm build` first: it boots the BUILT app.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RC2_ROOT = process.env.LIVE_RC2_ROOT ?? path.resolve(repoRoot, "../integration-oct9");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9263);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8823);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-record-types-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = process.env.LIVE_SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), "realm-record-types-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
let liveC = null;

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
    const v = await fn().catch(() => false);
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
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
  });
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
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  } catch { /* nothing listening */ }
}

const HELPERS = `
globalThis.__live = {
  q: (sel) => document.querySelector(sel),
  qa: (sel) => [...document.querySelectorAll(sel)],
  click(el) { if (!el) throw new Error('nothing to click'); el.click(); return true; },
  button(text, root = document) { return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.disabled) ?? null; },
  named(re, root = document) { return [...root.querySelectorAll('button')].find((b) => new RegExp(re).test(b.getAttribute('aria-label') ?? '')) ?? null; },
  tab(text) { return [...document.querySelectorAll('.sb-page-nav label.settings-tab')].find((l) => l.textContent.trim().startsWith(text)) ?? null; },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception in ${expr.slice(0, 120)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function shot(c, tag) {
  await sleep(1100);
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(OUT_DIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
  return out;
}

/** The share of pixels that differ by more than a hair between two captures, measured in the page. */
async function pixelDiff(c, a, b) {
  const url = (f) => `data:image/png;base64,${fs.readFileSync(f).toString("base64")}`;
  return evalIn(c, `(async () => {
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const [x, y] = await Promise.all([load(${JSON.stringify(url(a))}), load(${JSON.stringify(url(b))})]);
    if (x.width !== y.width || x.height !== y.height) return { share: 1, why: 'sizes differ', a: [x.width, x.height], b: [y.width, y.height] };
    const px = (img) => { const cv = new OffscreenCanvas(img.width, img.height); const g = cv.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
    const p = px(x), q = px(y);
    let diff = 0; let minY = Infinity, maxY = -1;
    for (let i = 0; i < p.length; i += 4) {
      if (Math.abs(p[i] - q[i]) > 16 || Math.abs(p[i + 1] - q[i + 1]) > 16 || Math.abs(p[i + 2] - q[i + 2]) > 16) {
        diff++; const row = Math.floor(i / 4 / x.width); minY = Math.min(minY, row); maxY = Math.max(maxY, row);
      }
    }
    return { share: diff / (p.length / 4), pixels: diff, rows: diff ? [minY, maxY] : null };
  })()`);
}

async function holdKey(c) {
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
}

const SCRIPT = [
  { on: "keep a lead", emit: [
    { kind: "call", tool: "realm-team__record_types", input: {} },
    { kind: "call", tool: "realm-team__record_update", input: { op: "create", type: "lead", name: "Acme Corp" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "replace", path: "leads/acme-corp", match: "Status:", entry: "Status: contacted" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "leads/acme-corp", entry: "Company: Acme Corp" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "leads/acme-corp", entry: "Contact: dana@acme.com" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "leads/acme-corp", section: "Notes", entry: "Runs growth at Acme; wants a pilot before the holidays." } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "leads/acme-corp", section: "Touches", entry: "2026-10-09 first email · sent" } },
    { kind: "text", text: "Kept a lead for Acme Corp." },
  ] },
];

/* ── boot ───────────────────────────────────────────────────────────────────────────────────────── */

async function boot(root, tag) {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(root, "apps/desktop/out/main/index.js");
  const serverEntry = path.join(root, "apps/server/dist/main.js");
  if (!fs.existsSync(mainEntry) || !fs.existsSync(serverEntry)) throw new Error(`${root} has no build — run \`pnpm build\` there first`);
  const scriptFile = path.join(scratch, "fake-script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
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
      REALM_SERVER_ENTRY: serverEntry,
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_FAKE_STANDS_IN: "claude",
      REALM_FAKE_SCRIPT: scriptFile,
      LIVE_USER_DATA: path.join(scratch, `userData-${tag}`),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, `${tag} renderer`);
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await until(() => evalIn(c, `!!__live.named('^More for Versed$')`), 30_000, `${tag} sidebar`);
  await holdKey(c);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  liveC = c;
  return c;
}

async function stop() {
  try { await api?.call("daemon.stop", {}); } catch { /* gone */ }
  try { api?.close(); } catch { /* gone */ }
  electron?.kill("SIGTERM");
  await sleep(800);
  try { electron?.kill("SIGKILL"); } catch { /* gone */ }
  await stopDaemons(home);
  killPort(SERVER_PORT); killPort(CDP_PORT);
  await until(async () => (await portFree(SERVER_PORT)) && (await portFree(CDP_PORT)), 15_000, "ports free");
  electron = null; api = null; liveC = null;
}

async function openTeam(c) {
  await evalIn(c, `__live.click(__live.named('^More for Versed$'))`);
  const row = `[...document.querySelectorAll('[role=menu] [role=menuitem], [role=menu] button')].find((b) => b.textContent.trim() === 'Team')`;
  await until(() => evalIn(c, `!!${row}`), 5_000, "menu row Team");
  await evalIn(c, `__live.click(${row})`);
  await until(() => evalIn(c, `!!__live.q('.sb-page-nav .page-rail')`), 8_000, "team page");
}

async function openNathan(c) {
  await openTeam(c);
  await until(() => evalIn(c, `!!__live.tab('Creators')`), 8_000, "Creators row");
  await evalIn(c, `__live.click(__live.tab('Creators'))`);
  await until(() => evalIn(c, `!!__live.tab('Nathan Beyenhof')`), 8_000, "Nathan row");
  await evalIn(c, `__live.click(__live.tab('Nathan Beyenhof'))`);
  await until(() => evalIn(c, `__live.qa('.tp-props > div').length >= 8 && document.querySelector('.page-title h1')?.textContent === 'Nathan Beyenhof'`), 8_000, "Nathan's record");
}

const spaceOf = async () => (await api.call("spaces.list", {})).find((s) => s.name === "Versed");

async function main() {
  const seed = JSON.parse(execFileSync(path.join(repoRoot, "apps/server/node_modules/.bin/tsx"), ["scripts/seed-v50-home.ts", home, "--no-leads", "--theme", "dark"],
    { cwd: path.join(repoRoot, "apps/server"), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").at(-1));
  check("seed: a v50 home with RC2's Versed team", seed.version === 50, seed);

  /* ── R0: RC2 draws Nathan ─────────────────────────────────────────────────────────────────────── */
  let baseline = null;
  if (fs.existsSync(path.join(RC2_ROOT, "apps/desktop/out/main/index.js"))) {
    const c = await boot(RC2_ROOT, "rc2");
    const v = Number(execFileSync("sqlite3", [path.join(home, "realm.db"), "SELECT MAX(version) FROM schema_version"], { encoding: "utf8" }).trim());
    check("R0 RC2 leaves the home at v50", v === 50, { version: v });
    await openNathan(c);
    baseline = await shot(c, "00-nathan-rc2-dark");
    c.close();
    await stop();
  } else console.log(`SKIP R0 no RC2 build at ${RC2_ROOT}`);

  /* ── R1: this build, on the same home ────────────────────────────────────────────────────────── */
  const c = await boot(repoRoot, "pr1");
  const db = (sql) => execFileSync("sqlite3", [path.join(home, "realm.db"), sql], { encoding: "utf8" }).trim();
  check("R1 the home is migrated to v51, Versed classed creator-campaigns with one Creator type",
    db("SELECT MAX(version) FROM schema_version") === "51" && db("SELECT template FROM team_meta m JOIN spaces s ON s.id = m.space_id WHERE s.name = 'Versed'") === "creator-campaigns"
      && db("SELECT group_concat(key) FROM team_record_types t JOIN spaces s ON s.id = t.space_id WHERE s.name = 'Versed'") === "creator",
    { version: db("SELECT MAX(version) FROM schema_version"), types: db("SELECT group_concat(s.name || ':' || key) FROM team_record_types t JOIN spaces s ON s.id = t.space_id") });
  await openNathan(c);
  const mine = await shot(c, "01-nathan-dark");
  if (baseline) {
    const d = await pixelDiff(c, baseline, mine);
    check("R1 Nathan's record draws as RC2 drew it (within 1% of pixels)", d.share <= 0.01, d);
  }
  const rail = await evalIn(c, `__live.qa('.sb-page-nav label.settings-tab').map((l) => l.textContent.trim())`);
  check("R1 the column names Creators from the type, and Nathan under it", rail.includes("Nathan Beyenhof") && rail.some((t) => t.startsWith("Creators")), rail);

  /* ── R2: the person makes Leads ──────────────────────────────────────────────────────────────── */
  await evalIn(c, `__live.click(__live.tab('Creators'))`);
  await until(() => evalIn(c, `!!__live.button('Edit fields…')`), 8_000, "Creators list");
  await shot(c, "02-creators-dark");
  await evalIn(c, `__live.click(__live.button('Edit fields…'))`);
  await until(() => evalIn(c, `!!document.querySelector('pre[aria-label="Preview"]')`), 8_000, "Creator's fields");
  const creatorPage = await evalIn(c, `({ folderFixed: document.querySelector('input[aria-label="Folder"]').disabled, consent: document.body.textContent.includes('Review reads consent: here'),
    preview: document.querySelector('pre[aria-label="Preview"]').textContent })`);
  check("R4 the Creators folder is fixed on the page while records use it; the consent check is named on Accounts", creatorPage.folderFixed && creatorPage.consent, creatorPage);
  check("R2 the preview is v50's creator template", creatorPage.preview === "# Jane Doe\n- Status: prospect\n\n## Deal\n\n## Accounts\n\n## Deadlines\n\n## Content\n", creatorPage.preview);
  await shot(c, "05-creator-type-dark");
  await evalIn(c, `__live.click(__live.tab('Creators'))`);
  await until(() => evalIn(c, `!!__live.button('New record type…')`), 8_000, "new type button");
  await evalIn(c, `__live.click(__live.button('New record type…'))`);
  await until(() => evalIn(c, `__live.qa('.tp-type-card').length > 3`), 8_000, "preset cards");
  await shot(c, "03-new-type-dark");
  await evalIn(c, `__live.click(__live.qa('.tp-type-card').find((b) => b.querySelector('.tp-card-name')?.textContent === 'Leads'))`);
  await until(() => evalIn(c, `document.querySelector('.page-title h1')?.textContent === 'Lead' && !!document.querySelector('pre[aria-label="Preview"]')`), 8_000, "Lead's fields");
  await shot(c, "04-lead-type-dark");
  const space = await spaceOf();
  const types = await api.call("team.recordTypes.list", { spaceId: space.id });
  check("R2 Versed keeps creators and leads", types.map((t) => t.key).join() === "creator,lead", types.map((t) => [t.key, t.folder, t.count]));

  /* ── R3: a role makes a lead ─────────────────────────────────────────────────────────────────── */
  const team = await api.call("team.space", { spaceId: space.id });
  const manager = team.roles.find((r) => r.name === "Creator Manager");
  await api.call("team.roleRun", { id: manager.id, message: "keep a lead for Acme" });
  await until(async () => (await api.call("team.roleRuns", { id: manager.id, limit: 5 })).every((r) => !["queued", "running", "blocked"].includes(r.state)), 30_000, "role run");
  const runs = await api.call("team.roleRuns", { id: manager.id, limit: 5 });
  const repo = team.repoPath;
  const file = path.join(repo, "leads/acme-corp.md");
  const author = fs.existsSync(file) ? execFileSync("git", ["-C", repo, "log", "-1", "--format=%an", "--", "leads/acme-corp.md"], { encoding: "utf8" }).trim() : null;
  check("R3 the role's record_update create type lead wrote leads/acme-corp.md, committed under its name",
    fs.existsSync(file) && author === "Creator Manager" && runs[0]?.state === "succeeded", { exists: fs.existsSync(file), author, run: runs[0]?.state, summary: runs[0]?.summary });
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const stamped = (line) => new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[source: realm:session/[0-9A-Z]{26}; added: `, "m").test(text);
  check("R3 it starts from the Lead template (title, status, Notes, Touches), each role line stamped with its session",
    text.startsWith("# Acme Corp\n- Status: contacted [source: realm:session/") && /\n## Notes\n/.test(text) && /\n## Touches\n/.test(text)
      && ["- Company: Acme Corp", "- Contact: dana@acme.com", "- 2026-10-09 first email · sent"].every(stamped), text);

  /* ── R4: a folder that holds records stays ───────────────────────────────────────────────────── */
  const lead = (await api.call("team.recordTypes.list", { spaceId: space.id })).find((t) => t.key === "lead");
  const refused = await api.call("team.recordTypes.update", { id: lead.id, folder: "prospects" }).then(() => null, (e) => e.message);
  check("R4 renaming leads/ while it holds a record is refused over RPC", !!refused && /holds 1 record, so its folder stays/.test(refused), refused);

  await evalIn(c, `__live.click(__live.tab('Leads'))`);
  await until(() => evalIn(c, `!!__live.tab('Acme Corp')`), 8_000, "Leads list");
  await shot(c, "06-leads-dark");
  await evalIn(c, `__live.click(__live.tab('Acme Corp'))`);
  await until(() => evalIn(c, `document.querySelector('.page-title h1')?.textContent === 'Acme Corp' && document.body.textContent.includes('Runs growth at Acme')`), 8_000, "Acme's record");
  await shot(c, "07-acme-dark");
  await evalIn(c, `__live.click(__live.tab('Activity'))`);
  await until(() => evalIn(c, `__live.qa('.tp-feed li').length > 5`), 8_000, "activity");
  const feed = await evalIn(c, `__live.qa('.tp-feed li').map((l) => l.textContent)`);
  check("R2 the log says Leads was made, by you", feed.some((l) => l.includes("You made a kind of record: Leads")), feed.slice(0, 6));
  await shot(c, "08-activity-dark");

  /* ── R5: light ───────────────────────────────────────────────────────────────────────────────── */
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!__live.named('^More for Versed$')`), 30_000, "light");
  await holdKey(c);
  await openNathan(c);
  await shot(c, "01-nathan-light");
  await evalIn(c, `__live.click(__live.tab('Creators'))`);
  await until(() => evalIn(c, `!!__live.button('Edit fields…')`), 8_000, "Creators list light");
  await shot(c, "02-creators-light");
  await evalIn(c, `__live.click(__live.button('Edit fields…'))`);
  await until(() => evalIn(c, `!!document.querySelector('pre[aria-label="Preview"]')`), 8_000, "Creator fields light");
  await shot(c, "05-creator-type-light");
  await evalIn(c, `__live.click(__live.tab('Leads'))`);
  await until(() => evalIn(c, `!!__live.button('New record type…')`), 8_000, "Leads light");
  await shot(c, "06-leads-light");
  await evalIn(c, `__live.click(__live.button('New record type…'))`);
  await until(() => evalIn(c, `__live.qa('.tp-type-card').length > 3`), 8_000, "new type light");
  await shot(c, "03-new-type-light");
  await evalIn(c, `__live.click(__live.tab('Leads'))`);
  await until(() => evalIn(c, `!!__live.tab('Acme Corp')`), 8_000, "Acme row light");
  await evalIn(c, `__live.click(__live.tab('Acme Corp'))`);
  await until(() => evalIn(c, `document.querySelector('.page-title h1')?.textContent === 'Acme Corp'`), 8_000, "Acme light");
  await shot(c, "07-acme-light");
  await evalIn(c, `__live.click(__live.tab('Leads'))`);
  await until(() => evalIn(c, `!!__live.button('Edit fields…')`), 8_000, "Leads list light 2");
  await evalIn(c, `__live.click(__live.button('Edit fields…'))`);
  await until(() => evalIn(c, `document.querySelector('.page-title h1')?.textContent === 'Lead'`), 8_000, "Lead fields light");
  const leadField = await evalIn(c, `document.querySelector('input[aria-label="Folder"]').disabled`);
  check("R4 on the page, leads/ is fixed once a record uses it", leadField === true, leadField);
  await shot(c, "04-lead-type-light");
  c.close();
}

main()
  .catch(async (e) => {
    console.log(`FAIL harness ${e.message}`); process.exitCode = 1;
    try { console.log("ALERTS", JSON.stringify(await evalIn(liveC, `[...document.querySelectorAll('[role=alert], .toast, [class*=toast]')].map((t) => t.textContent)`))); await shot(liveC, "zz-failed"); } catch { /* the window is gone */ }
  })
  .finally(async () => {
    await stop().catch(() => {});
    killPort(SERVER_PORT); killPort(CDP_PORT);
    console.log(`SCRATCH ${scratch}`);
    process.exit(process.exitCode ?? 0);
  });
