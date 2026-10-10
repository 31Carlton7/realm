/**
 * Live check for generic deliverables in Review (dynamic Teams, PR 2) — run with:
 *   node apps/desktop/scripts/review-formats-live.mjs
 *
 * Boots the BUILT app (run `pnpm build` first) on a scratch home with the scripted agent standing in
 * for Claude, so nothing is billed, and:
 *
 *   F1  a role submits one review per format — images, pdf, markdown, email, message, diff, links,
 *       table, text, files — and one slideshow batch the old way (`kind: slideshows`, `target`);
 *   F2  each review draws in its own renderer, in both faces, screenshot by screenshot;
 *   F3  the email's text is edited in place: version 2, marked the person's, and Approve covers it;
 *   F4  the legacy slideshow batch still draws its strip under "Caption", and approving it offers Post….
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8824 / 9264). Screenshots go to LIVE_OUT. It touches only
 * its own scratch home, and kills only what holds its own two ports. Pictures are cut from the site's
 * own product captures, the PDF printed from text by cupsfilter.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9264);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8824);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-review-formats-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const SCRATCH_ROOT = process.env.LIVE_SCRATCH ?? OUT_DIR;
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SCRATCH_ROOT, "run-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

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
  set(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
  click(el) { if (!el) throw new Error('nothing to click'); el.click(); return true; },
  button(text, root = document) { return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.disabled) ?? null; },
  named(re, root = document) { return [...root.querySelectorAll('button')].find((b) => new RegExp(re).test(b.getAttribute('aria-label') ?? '')) ?? null; },
  tab(text) { return [...document.querySelectorAll('.sb-page-nav label.settings-tab')].find((l) => l.textContent.trim().startsWith(text)) ?? null; },
  text: (sel) => document.querySelector(sel)?.textContent ?? null,
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception in ${expr.slice(0, 120)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function shot(c, tag) {
  // Past every entrance (the column's slide, a sheet's spring), so the frame is the surface at rest.
  await sleep(1100);
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(OUT_DIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}

async function holdKey(c) {
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
}

/* ── the scripted agent ─────────────────────────────────────────────────────────────────────────── */

const D = "deliverables";
const SUBMITS = [
  { label: "hero picture", title: "Hero picture for the launch post", items: [{ files: [`${D}/hero.png`] }] },
  { label: "brief", title: "Creator brief, October", items: [{ files: [`${D}/brief.pdf`], body: "The brief Nathan signs before his next three posts." }] },
  { label: "answer", title: "Does a 7-day streak predict retention?", items: [{ files: [], body: "# Short answer: yes\n\nUsers who keep a **7-day streak** retain at 2.3× the rate of those who do not.\n\n- Source: PostHog cohort, Sept 1–30\n- Caveat: streak users also opened notifications more often\n\n> Worth testing a streak reminder before calling it causal." }] },
  { label: "replies", title: "Reply to Dana at Acme", items: [{ files: [], body: "Hi Dana,\n\nThanks for the call on Monday. The pilot can start on the 14th; I've attached nothing yet, the contract comes from legal on Friday.\n\nCarlton", meta: { Subject: "Following up on the pilot", Due: "Tuesday" }, action: { connector: "mcp:gmail", tool: "send_message", verb: "send", account: "carlton@versed.app", to: "dana@acme.com" } }] },
  { label: "DM", title: "Thank-you DM to @reader", items: [{ files: [], body: "thank you for the repost! the verse-a-day trick is in the next video 🙏", action: { connector: "channel:instagram", verb: "dm", account: "@versed.nathan", to: "@reader" } }] },
  { label: "release notes", title: "v2.4 release notes patch", items: [{ files: [`${D}/notes.patch`], meta: { Version: "2.4.0" } }] },
  { label: "reading list", title: "Reading for the retention review", items: [{ files: [], body: "- [Retention curves, explained](https://www.lennysnewsletter.com/p/retention)\n- https://posthog.com/docs/product-analytics/retention\n- [Streaks in Duolingo](https://blog.duolingo.com/how-duolingo-streak-builds-habit/)" }] },
  { label: "leads", title: "Leads from the podcast list", items: [{ files: [`${D}/leads.csv`] }] },
  { label: "note", title: "Call Dana back", items: [{ files: [], body: "Dana asked for the pilot's start date in writing. Call her back Tuesday morning with the 14th." }] },
  { label: "assets", title: "Press kit bundle", items: [{ files: [`${D}/press-kit.zip`] }] },
];
const EXPECT = ["images", "pdf", "markdown", "email", "message", "diff", "links", "table", "text", "files"];
const LEGACY = { kind: "slideshows", title: "3 slideshows for Nathan", record: "nathan-beyenhof",
  items: [1, 2, 3].map((n) => ({ files: [1, 2, 3].map((s) => `${D}/slides/${n}-${s}.png`), body: `slideshow ${n}: read it out loud, twice #ad`, target: { channel: "TikTok", account: "@versed.nathan" } })) };

const SCRIPT = [
  { on: "deliver every format", emit: [
    ...SUBMITS.map((s) => ({ kind: "call", tool: "realm-team__review_submit", input: s })),
    { kind: "call", tool: "realm-team__review_submit", input: LEGACY },
    { kind: "usage", costUsd: 0.42 },
    { kind: "text", text: "Sent eleven reviews." },
  ] },
];

/* ── the fixture files ──────────────────────────────────────────────────────────────────────────── */

function makeFiles(folder) {
  const dir = path.join(folder, D);
  fs.mkdirSync(path.join(dir, "slides"), { recursive: true });
  const product = path.join(repoRoot, "site/public/product");
  const caps = fs.readdirSync(product).filter((f) => f.endsWith("-1440.webp")).sort();
  execFileSync("sips", ["-s", "format", "png", "-Z", "1600", path.join(product, caps[0]), "--out", path.join(dir, "hero.png")], { stdio: "ignore" });
  let n = 1;
  for (let show = 1; show <= 3; show++) for (let s = 1; s <= 3; s++) {
    const from = path.join(product, caps[n++ % caps.length]);
    const out = path.join(dir, "slides", `${show}-${s}.png`);
    execFileSync("sips", ["-s", "format", "png", "-c", "1280", "720", from, "--out", out], { stdio: "ignore" });
  }
  const txt = path.join(dir, "brief.txt");
  fs.writeFileSync(txt, ["CREATOR BRIEF — OCTOBER", "", "Three posts a week, Monday, Wednesday and Friday.", "Every caption carries #ad or the platform's paid-partnership label.", "Talk to camera or Bible journaling; new formats by approval.", "", "Rate: $5 per video plus $2.50 CPM, paid by Venmo on the 1st."].join("\n"));
  fs.writeFileSync(path.join(dir, "brief.pdf"), execFileSync("/usr/sbin/cupsfilter", ["-m", "application/pdf", txt], { stdio: ["ignore", "pipe", "ignore"] }));
  fs.rmSync(txt);
  fs.writeFileSync(path.join(dir, "notes.patch"), [
    "diff --git a/CHANGELOG.md b/CHANGELOG.md", "--- a/CHANGELOG.md", "+++ b/CHANGELOG.md", "@@ -1,4 +1,7 @@", " # Changelog", " ",
    "+## 2.4.0", "+- Review draws PDFs, diffs, tables and links as what they are.", "+", " ## 2.3.1", "-- Fixed a crash on launch.", "+- Fixed a crash on launch when the Library was empty.", "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "leads.csv"), ["Name,Show,Listeners,Contact", "Dana Ruiz,Morning Pages,48000,dana@acme.com", "\"Lee, Jr\",Verse by Verse,12500,lee@vbv.fm", "Sam Ortiz,Quiet Time,9100,sam@quiet.time", "Priya Nair,Faith & Focus,23000,priya@ff.show"].join("\n") + "\n");
  execFileSync("zip", ["-q", "-j", path.join(dir, "press-kit.zip"), path.join(dir, "hero.png")]);
}

const NATHAN = [
  "# Nathan Beyenhof", "- Status: signed · contract v3", "", "## Accounts",
  "- TikTok @versed.nathan · vault: tiktok.com/nathan · device: Lab iPhone 2 · consent: contract §4",
  "- Instagram @versed.nathan · vault: instagram.com/nathan · device: Lab iPhone 2 · consent: contract §4", "",
].join("\n");

/* ── boot ───────────────────────────────────────────────────────────────────────────────────────── */

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
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
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_FAKE_STANDS_IN: "claude",
      REALM_FAKE_SCRIPT: scriptFile,
      REALM_FAKE_ACT_ADAPTER: "1",
      REALM_MEMORY_FALLBACK_DIR: path.join(scratch, "memory-fallback"),
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
  await c.send("Page.enable");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Versed");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await holdKey(c);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

const runsOf = async (roleId) => api.call("team.roleRuns", { id: roleId, limit: 30 });
const settled = (r) => !["queued", "running", "blocked"].includes(r.state);

/** The Review pane, from the sidebar's Review row. */
async function openReview(c) {
  await until(() => evalIn(c, `!!__live.named('^Review — ')`), 15_000, "review row");
  await evalIn(c, `__live.click(__live.named('^Review — '))`);
  await until(() => evalIn(c, `!!__live.q('.rv-list')`), 10_000, "review pane");
}

/** Read one review, and wait until its deliverable has drawn (its pictures decoded, its page in). */
async function readReview(c, id) {
  await evalIn(c, `__live.click(__live.q('[data-review="${id}"]'))`);
  await until(() => evalIn(c, `(() => { const d = __live.q('.rv-deliverable'); if (!d) return false;
    const imgs = [...d.querySelectorAll('img')]; return imgs.every((i) => i.complete && i.naturalWidth > 0) && !d.querySelector('.rv-pdf-blank'); })()`), 15_000, `review ${id} drawn`);
  return evalIn(c, `({ format: __live.q('.rv-deliverable')?.dataset.format, h1: __live.text('.rv-head h1'), heads: __live.qa('.rv-section h3').map((h) => h.textContent), note: __live.text('.rv-decide-note') })`);
}

let liveC = null;
async function main() {
  const c = await boot();
  liveC = c;
  const space = (await api.call("spaces.list", {})).find((s) => s.name === "Versed");
  check("onboarding made Versed", !!space);
  makeFiles(space.folderPath);

  await api.call("team.make", { spaceId: space.id, templates: [] });
  const role = await api.call("team.roleCreate", { spaceId: space.id, name: "Content Producer", brief: "Make what the team asks for and send it to Review.", realmite: { seed: "content-producer-32" }, agentKind: "fake", model: "sonnet" });
  await api.call("team.recordCreate", { spaceId: space.id, name: "Nathan Beyenhof" });
  await api.call("team.recordWrite", { spaceId: space.id, path: "creators/nathan-beyenhof.md", markdown: NATHAN });

  /* ── F1: one review per format, and one the old way ──────────────────────────────────────────── */
  await api.call("team.roleRun", { id: role.id, message: "Please deliver every format for the review check." });
  await until(async () => (await runsOf(role.id)).every(settled) && (await runsOf(role.id)).length > 0, 40_000, "run settles");
  const team = await api.call("team.space", { spaceId: space.id });
  const byTitle = Object.fromEntries(team.reviews.map((r) => [r.title, r]));
  check("F1 eleven reviews arrived, all waiting", team.reviews.length === 11 && team.reviews.every((r) => r.state === "waiting"), team.reviews.map((r) => `${r.title}:${r.state}`));
  check("F1 each keeps its label as written, and the legacy one its kind", SUBMITS.every((s) => byTitle[s.title]?.kind === s.label) && byTitle[LEGACY.title]?.kind === "slideshows");

  /* ── F2: each format in its renderer, dark ───────────────────────────────────────────────────── */
  await openReview(c);
  const formats = {};
  for (const [i, s] of SUBMITS.entries()) {
    const r = await readReview(c, byTitle[s.title].id);
    formats[s.title] = r.format;
    check(`F2 ${s.title} draws as ${EXPECT[i]}`, r.format === EXPECT[i], r);
    await shot(c, `${String(i + 1).padStart(2, "0")}-${EXPECT[i]}-dark`);
  }
  const card = await evalIn(c, `__live.qa('.rv-card .rv-meta').map((m) => m.textContent)`);
  // A card names where its batch goes when it goes somewhere (the channel), and otherwise its label as written.
  check("F2 every card says its label as written, or its channel", SUBMITS.every((s) => card.some((m) => m.includes(s.label) || (s.items[0].action?.connector.startsWith("channel:") && m.includes(s.items[0].action.connector.slice(8))))), card);
  const states = await evalIn(c, `__live.qa('.rv-card .rv-state').map((m) => m.textContent)`);
  check("F2 a batch that goes nowhere promises no post", states.filter((t) => /leaves Realm/.test(t)).length === 7 && states.filter((t) => /anything posts/.test(t)).length === 1, states);

  /* ── F3: edit the email, then approve ─────────────────────────────────────────────────────────── */
  const mail = byTitle["Reply to Dana at Acme"];
  await readReview(c, mail.id);
  await evalIn(c, `__live.click(__live.button('Edit'))`);
  await until(() => evalIn(c, `!!__live.q('.rv-edit-field')`), 5_000, "edit field");
  await evalIn(c, `__live.set(__live.q('.rv-edit-field'), __live.q('.rv-edit-field').value.replace('The pilot can start on the 14th', 'The pilot starts on Wednesday the 14th, as we agreed'))`);
  await shot(c, "20-email-editing-dark");
  await evalIn(c, `__live.click(__live.button('Save edit'))`);
  await until(() => evalIn(c, `/with your edit/.test(__live.text('.rv-version') ?? '')`), 10_000, "version 2 drawn");
  const v2 = await api.call("team.review", { id: mail.id });
  check("F3 the edit is version 2, the item the person's, its text the new words", v2.version === 2 && v2.items[0].editedBy === "user" && /Wednesday the 14th/.test(v2.items[0].body) && v2.previous.length === 1, { version: v2.version, editedBy: v2.items[0].editedBy });
  const log = await api.call("team.activity", { spaceId: space.id, limit: 50 });
  check("F3 the edit is a line in the log, with its diff", log.some((a) => a.verb === "edited_item" && /\+.*Wednesday the 14th/.test(a.detail.diff ?? "")));
  await shot(c, "21-email-edited-dark");
  await evalIn(c, `__live.click(__live.qa('.rv-decide .btn.primary')[0])`);
  await until(() => evalIn(c, `/Approved by you/.test(__live.text('.rv-decide-note') ?? '')`), 8_000, "approved");
  const approved = await api.call("team.review", { id: mail.id });
  check("F3 Approve covers the edited bytes", approved.state === "approved" && approved.items[0].approvedHash === approved.items[0].contentHash && /Wednesday the 14th/.test(approved.items[0].body));

  /* ── F4: the slideshows sent the old way ──────────────────────────────────────────────────────── */
  const legacy = byTitle[LEGACY.title];
  const lr = await readReview(c, legacy.id);
  const strip = await evalIn(c, `({ slides: __live.qa('.rv-strip .rv-slide').length, caption: __live.qa('.rv-section h3').map((h) => h.textContent) })`);
  check("F4 the legacy batch still draws its strip, under Caption", lr.format === "images" && strip.slides === 3 && strip.caption.includes("Caption") && strip.caption.includes("Before it can post"), { lr, strip });
  const legacyDetail = await api.call("team.review", { id: legacy.id });
  check("F4 stored as the backfill would have: a legacy post action, drawn as images", legacyDetail.items.every((i) => i.action?.verb === "post" && i.action?.connector === "channel:tiktok" && i.action?.legacy === 1 && i.target?.channel === "TikTok"));
  await shot(c, "30-legacy-slideshows-dark");
  await evalIn(c, `__live.click(__live.qa('.rv-decide .btn.primary')[0])`);
  await until(() => evalIn(c, `!!__live.button('Post…')`), 10_000, "Post… offered");
  const tickets = (await api.call("team.review", { id: legacy.id })).tickets;
  check("F4 approving issues one ticket per slideshow, channel as written, and offers Post…", tickets.length === 3 && tickets.every((t) => t.kind === "post" && t.channel === "TikTok"), tickets.map((t) => `${t.kind}:${t.channel}`));
  await shot(c, "31-legacy-approved-post-dark");

  /* ── light ──────────────────────────────────────────────────────────────────────────────────── */
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
  await holdKey(c);
  await openReview(c);
  for (const [i, s] of SUBMITS.entries()) {
    await readReview(c, byTitle[s.title].id);
    await shot(c, `${String(i + 1).padStart(2, "0")}-${EXPECT[i]}-light`);
  }
  await readReview(c, legacy.id);
  await shot(c, "31-legacy-approved-post-light");
  c.close();
}

main()
  .catch(async (e) => {
    console.log(`FAIL harness ${e.message}`); process.exitCode = 1;
    try { console.log("ALERTS", JSON.stringify(await evalIn(liveC, `[...document.querySelectorAll('[role=alert], .toast, [class*=toast]')].map((t) => t.textContent)`))); await shot(liveC, "zz-failed"); } catch { /* the window is gone */ }
  })
  .finally(async () => {
    try { await api?.call("daemon.stop", {}); } catch {}
    try { api?.close(); } catch {}
    electron?.kill("SIGTERM");
    await sleep(800);
    try { electron?.kill("SIGKILL"); } catch {}
    await stopDaemons(home);
    killPort(SERVER_PORT); killPort(CDP_PORT);
    process.exit(process.exitCode ?? 0);
  });
