/**
 * Live check: a study guide keeps its answers, flips, steps, open sections, route and scroll when
 * the reader switches away and back (run with: pnpm build && node apps/desktop/scripts/documents-keep-state-live.mjs)
 *
 * The owner's report: doing a generated study guide, switching to another tab or session and back
 * restarted the quiz. The frame is cross-origin and sandboxed, so every switch that unmounts it
 * reloads the guide; only what the runtime snapshots and the pane hands back survives.
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent (nothing is ever sent, so
 * nothing is billed), copies two real guides in — a `rg-*` guide (quizzes, steps, flashcards,
 * reveals, KaTeX) and a scripted "course kit" that keeps its progress in localStorage — and for each
 * one: works through part of it, then switches file tab, session and space, and reads the guide's
 * state back inside the frame after each return. Screenshots before and after every switch.
 * Finally it relaunches the app on the same home and reads the kit's progress again.
 *
 * Env: LIVE_SERVER_PORT (8794), LIVE_CDP_PORT (9234), LIVE_OUT_DIR (screenshots), LIVE_SCRATCH_DIR,
 * LIVE_RG_GUIDE and LIVE_KIT_GUIDE (fixture paths, read-only), LIVE_LABEL (a tag for the run).
 * Kills only what listens on its own ports, and deletes its scratch home.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { openSideTool } from "./lib/side-tools.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9234);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8794);
const LABEL = process.env.LIVE_LABEL ?? "run";
const OUT_DIR = path.join(process.env.LIVE_OUT_DIR ?? os.tmpdir(), `docs-state-${LABEL}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-docs-state-live-"));
const home = path.join(scratch, "home");
const RG_GUIDE = process.env.LIVE_RG_GUIDE;
const KIT_GUIDE = process.env.LIVE_KIT_GUIDE;
const STUDY = "Study", OTHER = "Other work", AWAY = "Elsewhere";
const VIEWPORT = { width: 1560, height: 980 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
let shotN = 0;

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
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(200);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
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
  if (r.exceptionDetails) throw new Error(`exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
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

/** The store, found through React's fiber on the root — how the other live checks reach it. */
const STORE = `(() => {
  const el = document.querySelector('#root > *') ?? document.querySelector('#root');
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  for (let f = key ? el[key] : null; f; f = f.return) {
    const v = f.memoizedProps?.value;
    if (v && typeof v.getState === 'function' && typeof v.subscribe === 'function' && 'activeProfileId' in v.getState()) return v;
  }
  return null; })()`;

async function boot() {
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_FAKE_STANDS_IN: "claude,codex",
      REALM_HTML_MENUS: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  return c;
}

const awake = `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
  new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`;

const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);

/** The guide frame is out of process (an opaque origin), so it is its own CDP target. A remount is a
 *  NEW target, so it is looked up afresh every time, newest last. */
async function frameFor(name, ms = 20_000) {
  const t = await until(async () => (await targets()).filter((x) => x.type === "iframe" && decodeURIComponent(x.url).includes(`/${name}?`)).pop(), ms, `frame ${name}`);
  const fc = cdp(t.webSocketDebuggerUrl);
  await fc.ready;
  await fc.send("Runtime.enable");
  fc.targetId = t.id;
  return fc;
}

async function shot(c, tag) {
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  const file = path.join(OUT_DIR, `${String(++shotN).padStart(2, "0")}-${tag}.png`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${file}`);
  } catch (e) { note("screenshot failed", String(e)); }
  await evalIn(c, `(() => { document.documentElement.style.background = ""; return true; })()`);
}

const clickTab = (name) => `(() => { const b = document.querySelector('.documents-tab-label[title=${JSON.stringify(name)}]'); if (!b) return false; b.click(); return true; })()`;
const clickRow = (title) => `(() => { const r = [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(title)})); if (!r) return false; r.click(); return true; })()`;

/* ── what the reader has done in each guide, read inside the frame ─────────────────────────────── */

const RG_DIGEST = `(() => {
  const quizzes = [...document.querySelectorAll('.rg-quiz')].slice(0, 3).map((q) => ({
    picked: [...q.querySelectorAll('.rg-question')].map((x) => [...x.querySelectorAll('.rg-options > li')].findIndex((li) => li.getAttribute('aria-checked') === 'true')),
    typed: [...q.querySelectorAll('.rg-input')].map((i) => i.value),
    checked: q.getAttribute('data-checked') === 'true',
    score: q.querySelector('.rg-score')?.textContent ?? null,
  }));
  return {
    quizzes,
    steps: [...document.querySelectorAll('.rg-steps-counter')].slice(0, 2).map((s) => s.textContent),
    flipped: [...document.querySelectorAll('.rg-card')].map((c, i) => c.getAttribute('data-flipped') === 'true' ? i : -1).filter((i) => i >= 0),
    open: [...document.querySelectorAll('details')].map((d, i) => d.open ? i : -1).filter((i) => i >= 0),
    top: Math.round(window.scrollY),
  }; })()`;

const KIT_DIGEST = `(() => {
  const S = window.Kit?.state?.() ?? {};
  const unit = document.querySelector('.k-unit.on');
  return {
    hash: location.hash,
    unit: unit?.id ?? null,
    cardsOn: unit ? unit.querySelectorAll(':scope > .card.on').length : 0,
    units: Object.fromEntries(Object.entries(S.u ?? {}).map(([k, v]) => [k, v.cur ?? 0])),
    answered: Object.keys(S.q ?? {}).length,
    hub: document.getElementById('hub')?.style.display !== 'none',
    open: [...document.querySelectorAll('details')].map((d, i) => d.open ? i : -1).filter((i) => i >= 0),
    top: Math.round(window.scrollY),
  }; })()`;

/** Work through part of the rg guide: picks and a typed answer in the first quiz (unchecked), the
 *  second quiz checked, a step-through advanced, a card flipped, a reveal opened, and a scroll. */
const RG_WORK = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const [q1, q2] = document.querySelectorAll('.rg-quiz');
  for (const q of q1.querySelectorAll('.rg-question')) {
    const opts = q.querySelectorAll('.rg-options > li');
    if (opts.length > 1) opts[1].click();
    const input = q.querySelector('.rg-input');
    if (input) { input.value = '0.42'; input.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  await wait(50);
  if (q2) { for (const q of q2.querySelectorAll('.rg-question')) { const o = q.querySelectorAll('.rg-options > li'); if (o.length) o[0].click(); } q2.querySelector('.rg-check')?.click(); }
  const steps = document.querySelector('.rg-steps');
  for (let i = 0; i < 2; i++) [...(steps?.querySelectorAll('.rg-steps-nav button') ?? [])].find((b) => /Next/.test(b.textContent))?.click();
  document.querySelectorAll('.rg-card')[1]?.click();
  const reveal = document.querySelector('details.rg-reveal'); if (reveal) reveal.open = true;
  await wait(50);
  q1.scrollIntoView(); window.scrollBy(0, -24);
  await wait(400);
  return true; })()`;

/** Start the kit's first lesson and pass three cards, the way its own test helper does. */
const KIT_WORK = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector('.k-resume')?.click();
  await wait(300);
  for (let i = 0; i < 3; i++) {
    window.Kit.dev.solveCard();
    const unit = document.querySelector('.k-unit.on');
    const card = [...unit.querySelectorAll(':scope > .card.on')].filter((c) => !c.classList.contains('done')).pop();
    card?.querySelector(':scope > .k-next .k-btn')?.click();
    await wait(250);
  }
  const reveal = [...document.querySelectorAll('.k-unit.on details')][0]; if (reveal) reveal.open = true;
  await wait(800);
  // The newest card's smooth scroll has settled; park the reader a little above it, by hand.
  const cards = [...document.querySelectorAll('.k-unit.on > .card.on')];
  cards[cards.length - 2]?.scrollIntoView();
  window.scrollBy(0, -40);
  await wait(400);
  return true; })()`;

/** A PDF of one page per title, written by hand so the check needs nothing installed. */
function makePdf(titles) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", null];
  const kids = [];
  for (const t of titles) {
    const content = `BT /F1 28 Tf 72 700 Td (${t}) Tj ET`;
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R /Resources << /Font << /F1 ${titles.length * 2 + 3} 0 R >> >> >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${titles.length} >>`;
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n"; const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b) => Math.abs(a - b) <= 4;

async function main() {
  if (!RG_GUIDE || !KIT_GUIDE) throw new Error("set LIVE_RG_GUIDE and LIVE_KIT_GUIDE to the two fixture guides");
  let c = await boot();
  await evalIn(c, awake);
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "School");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await evalIn(c, awake);

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  // Every session on the scripted agent before anything else, and nothing is ever sent.
  for (const s of await api.call("sessions.listAll", {})) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  const [school] = await api.call("spaces.list", {});
  fs.mkdirSync(path.join(school.folderPath, "guides"), { recursive: true });
  fs.copyFileSync(RG_GUIDE, path.join(school.folderPath, "guides", path.basename(RG_GUIDE)));
  fs.copyFileSync(KIT_GUIDE, path.join(school.folderPath, "guides", path.basename(KIT_GUIDE)));
  fs.writeFileSync(path.join(school.folderPath, "notes.md"), `# Notes\n\n${Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the lecture notes.`).join("\n\n")}\n`);
  fs.writeFileSync(path.join(school.folderPath, "sheet.csv"), `n,square\n${Array.from({ length: 300 }, (_, i) => `${i + 1},${(i + 1) ** 2}`).join("\n")}\n`);
  fs.writeFileSync(path.join(school.folderPath, "code.ts"), Array.from({ length: 300 }, (_, i) => `export const value${i} = ${i};`).join("\n") + "\n");
  fs.writeFileSync(path.join(school.folderPath, "slides.pdf"), makePdf(["Lecture 4", "Pipelines", "Hazards", "Forwarding"]));
  await api.call("sessions.create", { spaceId: school.id, agentKind: "fake", title: OTHER, permissionMode: "default" });
  await api.call("sessions.create", { spaceId: school.id, agentKind: "fake", title: STUDY, permissionMode: "default" });
  const away = await api.call("spaces.create", { profileId: school.profileId, name: AWAY });
  await api.call("sessions.create", { spaceId: away.id, agentKind: "fake", title: "Away session", permissionMode: "default" });
  for (const s of await api.call("sessions.listAll", {})) if (s.agentKind !== "fake") await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });

  await until(() => evalIn(c, clickRow(STUDY)), 20_000, "Study row");
  await sleep(800);
  await openSideTool(c, STUDY, "Documents");
  await until(() => evalIn(c, `!!document.querySelector('.documents-pane')`), 10_000, "documents pane");
  const rgName = path.basename(RG_GUIDE), kitName = path.basename(KIT_GUIDE);
  for (const p of ["notes.md", `guides/${kitName}`, `guides/${rgName}`]) {
    await api.call("documents.openPath", { spaceId: school.id, path: p });
    await sleep(500);
  }
  await until(() => evalIn(c, `document.querySelectorAll('.documents-tab-label[title]').length >= 3`), 10_000, "three tabs");

  /** Leave the guide by `leave`, come back by `back`, and compare what the frame holds. Each trip
   *  starts from the worked state: where an earlier trip lost it (the build before the fix), the
   *  work is done again first, so every switch is measured on its own. */
  async function roundTrip(kind, name, digest, label, leave, back, work, worked) {
    let fc = await frameFor(name);
    const targetBefore = fc.targetId;
    let before = await evalIn(fc, digest);
    if (!same(before, worked)) {
      note(`${kind} ${label}: starting state was lost — working it again`, before);
      await evalIn(fc, work);
      before = await evalIn(fc, digest);
    }
    await shot(c, `${kind}-${label}-before`);
    fc.close();
    await leave();
    await sleep(900);
    await shot(c, `${kind}-${label}-away`);
    await back();
    fc = await frameFor(name);
    await until(() => evalIn(fc, kind === "rg" ? `!!document.querySelector('.rg-progress')` : `!!window.Kit`), 15_000, "runtime after return");
    await sleep(1500);
    const after = await evalIn(fc, digest);
    await shot(c, `${kind}-${label}-back`);
    const kept = fc.targetId === targetBefore;
    fc.close();
    note(`${kind} ${label}`, { before, after, sameFrame: kept });
    return { before, after, kept };
  }

  /* ── the rg guide ───────────────────────────────────────────────────────────────────────── */
  await evalIn(c, clickTab(`guides/${rgName}`));
  let fc = await frameFor(rgName);
  await until(() => evalIn(fc, `!!document.querySelector('.rg-progress')`), 20_000, "rg runtime");
  await evalIn(fc, RG_WORK);
  const worked = await evalIn(fc, RG_DIGEST);
  fc.close();
  note("rg worked", worked);

  const rgChecks = (label, { before, after }) => {
    check(`rg ${label}: first quiz's picks and typed answers come back`, same(before.quizzes[0], after.quizzes[0]), { before: before.quizzes[0], after: after.quizzes[0] });
    check(`rg ${label}: the checked quiz is still checked, with its score`, same(before.quizzes[1], after.quizzes[1]), { before: before.quizzes[1], after: after.quizzes[1] });
    check(`rg ${label}: step-through position`, same(before.steps, after.steps), { before: before.steps, after: after.steps });
    check(`rg ${label}: flipped flashcards`, same(before.flipped, after.flipped), { before: before.flipped, after: after.flipped });
    check(`rg ${label}: open sections`, same(before.open, after.open), { before: before.open, after: after.open });
    check(`rg ${label}: scroll position`, near(before.top, after.top), { before: before.top, after: after.top });
  };
  const rgTab = await roundTrip("rg", rgName, RG_DIGEST, "tab", () => evalIn(c, clickTab("notes.md")), () => evalIn(c, clickTab(`guides/${rgName}`)), RG_WORK, worked);
  rgChecks("file tab", rgTab);
  check("rg file tab: the guide's frame was kept alive behind the other tab, not reloaded", rgTab.kept);
  rgChecks("session", await roundTrip("rg", rgName, RG_DIGEST, "session", () => evalIn(c, clickRow(OTHER)), async () => {
    await evalIn(c, clickRow(STUDY));
    await until(() => evalIn(c, `!!document.querySelector('.documents-pane')`), 10_000, "pane back");
  }, RG_WORK, worked));
  rgChecks("space", await roundTrip("rg", rgName, RG_DIGEST, "space", () => evalIn(c, `${STORE}.getState().selectSpace(${JSON.stringify(away.id)}).then(() => true)`), async () => {
    await evalIn(c, `${STORE}.getState().selectSpace(${JSON.stringify(school.id)}).then(() => true)`);
    await sleep(600);
    if (!(await evalIn(c, `!!document.querySelector('.documents-pane')`))) await evalIn(c, clickRow(STUDY));
    await until(() => evalIn(c, `!!document.querySelector('.documents-pane')`), 10_000, "pane back");
  }, RG_WORK, worked));

  /* ── the course kit ─────────────────────────────────────────────────────────────────────── */
  await evalIn(c, clickTab(`guides/${kitName}`));
  fc = await frameFor(kitName);
  await until(() => evalIn(fc, `!!window.Kit && !!document.querySelector('.k-resume')`), 20_000, "kit");
  await evalIn(fc, KIT_WORK);
  const kitWorked = await evalIn(fc, KIT_DIGEST);
  fc.close();
  note("kit worked", kitWorked);
  const kitChecks = (label, { before, after }) => {
    check(`kit ${label}: still in the lesson, at the same card`, before.unit === after.unit && before.cardsOn === after.cardsOn && !after.hub, { before: [before.unit, before.cardsOn], after: [after.unit, after.cardsOn, after.hub ? "hub" : "lesson"] });
    check(`kit ${label}: its saved progress (cards passed, answers) is intact`, same(before.units, after.units) && before.answered === after.answered, { before: [before.units, before.answered], after: [after.units, after.answered] });
    check(`kit ${label}: open sections`, same(before.open, after.open), { before: before.open, after: after.open });
    check(`kit ${label}: scroll position`, near(before.top, after.top), { before: before.top, after: after.top });
  };
  const kitTab = await roundTrip("kit", kitName, KIT_DIGEST, "tab", () => evalIn(c, clickTab("notes.md")), () => evalIn(c, clickTab(`guides/${kitName}`)), KIT_WORK, kitWorked);
  kitChecks("file tab", kitTab);
  check("kit file tab: the guide's frame was kept alive behind the other tab, not reloaded", kitTab.kept);
  kitChecks("session", await roundTrip("kit", kitName, KIT_DIGEST, "session", () => evalIn(c, clickRow(OTHER)), async () => {
    await evalIn(c, clickRow(STUDY));
    await until(() => evalIn(c, `!!document.querySelector('.documents-pane')`), 10_000, "pane back");
  }, KIT_WORK, kitWorked));
  const kitSpace = await roundTrip("kit", kitName, KIT_DIGEST, "space", () => evalIn(c, `${STORE}.getState().selectSpace(${JSON.stringify(away.id)}).then(() => true)`), async () => {
    await evalIn(c, `${STORE}.getState().selectSpace(${JSON.stringify(school.id)}).then(() => true)`);
    await sleep(600);
    if (!(await evalIn(c, `!!document.querySelector('.documents-pane')`))) await evalIn(c, clickRow(STUDY));
    await until(() => evalIn(c, `!!document.querySelector('.documents-pane')`), 10_000, "pane back");
  }, KIT_WORK, kitWorked);
  kitChecks("space", kitSpace);

  /* ── the other kinds: a Markdown file in Source, a sheet, a PDF, a code file ─────────────────── */
  for (const p of ["sheet.csv", "slides.pdf", "code.ts"]) {
    await api.call("documents.openPath", { spaceId: school.id, path: p });
    await sleep(400);
  }
  /* The view (Rich/Grid or Source) is the PANE's, so the sheet is placed in Grid first and the notes
     are put in Source last — which is the view the pane is then left in, and has to come back in. */
  const grid = `document.querySelector('.dsg-container')`;
  const ta = `document.querySelector('textarea.documents-source')`;
  const cm = `document.querySelector('.cm-scroller')`;
  const pressMode = (label) => `(() => { const b = [...document.querySelectorAll('.documents-modes button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`;
  await evalIn(c, clickTab("sheet.csv"));
  await until(() => evalIn(c, `!!${grid} && ${grid}.scrollHeight > 2000`), 20_000, "sheet grid");
  await evalIn(c, `(() => { const g = ${grid}; g.scrollTop = 900; g.dispatchEvent(new Event('scroll')); return true; })()`);
  await sleep(300);
  const kindsBefore = { sheet: { top: await evalIn(c, `Math.round(${grid}.scrollTop)`) } };
  await evalIn(c, clickTab("slides.pdf"));
  await until(() => evalIn(c, `!!document.querySelector('.pdf-page-field') && !!document.querySelector('.pdf-page[data-painted]')`), 20_000, "pdf");
  for (let i = 0; i < 2; i++) { await evalIn(c, `(() => { document.querySelector('button[aria-label="Next page"]').click(); return true; })()`); await sleep(500); }
  kindsBefore.pdf = { page: await evalIn(c, `document.querySelector('.pdf-page-field')?.value ?? null`) };
  await evalIn(c, clickTab("code.ts"));
  await until(() => evalIn(c, `!!${cm} && ${cm}.scrollHeight > 2000`), 15_000, "code editor");
  await evalIn(c, `(() => { const s = ${cm}; s.scrollTop = 1200; s.dispatchEvent(new Event('scroll')); return true; })()`);
  await sleep(300);
  kindsBefore.code = { top: await evalIn(c, `Math.round(${cm}.scrollTop)`) };
  await evalIn(c, clickTab("notes.md"));
  await until(() => evalIn(c, pressMode("Source")), 10_000, "notes Source");
  await until(() => evalIn(c, `!!${ta}`), 10_000, "notes source");
  await evalIn(c, `(() => { const t = ${ta}; t.setSelectionRange(120, 131); t.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' })); t.scrollTop = 600; t.dispatchEvent(new Event('scroll')); return true; })()`);
  await sleep(300);
  const NOTES = `(() => { const t = ${ta}; return { mode: document.querySelector('.documents-modes button[aria-pressed="true"]')?.textContent ?? null, top: t ? Math.round(t.scrollTop) : null, caret: t ? [t.selectionStart, t.selectionEnd] : null }; })()`;
  kindsBefore.notes = await evalIn(c, NOTES);
  await shot(c, "kinds-before");

  await evalIn(c, clickRow(OTHER));
  await sleep(900);
  await shot(c, "kinds-away");
  await evalIn(c, clickRow(STUDY));
  await until(() => evalIn(c, `!!document.querySelector('.documents-pane')`), 10_000, "pane back");
  await sleep(1200);
  const kindsAfter = { notes: await evalIn(c, NOTES) };
  await shot(c, "kinds-back-notes");
  await evalIn(c, clickTab("slides.pdf"));
  await sleep(2500);
  kindsAfter.pdf = { page: await evalIn(c, `document.querySelector('.pdf-page-field')?.value ?? null`) };
  await shot(c, "kinds-back-pdf");
  await evalIn(c, clickTab("code.ts"));
  await until(() => evalIn(c, `!!${cm}`), 15_000, "code back");
  await sleep(1500);
  kindsAfter.code = { top: await evalIn(c, `Math.round(${cm}.scrollTop)`) };
  await evalIn(c, clickTab("sheet.csv"));
  await until(() => evalIn(c, pressMode("Grid")), 10_000, "sheet Grid");
  await until(() => evalIn(c, `!!${grid}`), 15_000, "sheet back");
  await sleep(1500);
  kindsAfter.sheet = { top: await evalIn(c, `Math.round(${grid}.scrollTop)`) };
  await shot(c, "kinds-back-sheet");
  note("other kinds", { before: kindsBefore, after: kindsAfter });
  check("markdown: comes back in Source, at its scroll and its caret", same(kindsBefore.notes, kindsAfter.notes) && kindsAfter.notes.mode === "Source", { before: kindsBefore.notes, after: kindsAfter.notes });
  check("sheet: comes back at its scroll", near(kindsBefore.sheet.top, kindsAfter.sheet.top) && kindsAfter.sheet.top > 0, { before: kindsBefore.sheet, after: kindsAfter.sheet });
  check("pdf: comes back on its page", kindsBefore.pdf.page === kindsAfter.pdf.page && kindsAfter.pdf.page !== "1", { before: kindsBefore.pdf, after: kindsAfter.pdf });
  check("code: comes back at its scroll", near(kindsBefore.code.top, kindsAfter.code.top) && kindsAfter.code.top > 0, { before: kindsBefore.code, after: kindsAfter.code });

  /* ── a relaunch: the kit's own saved progress is the part that should outlive it ───────────── */
  await sleep(1500); // the sidecar write is debounced
  const sidecar = path.join(school.folderPath, "guides", `.${kitName}.progress.json`);
  note("kit sidecar", fs.existsSync(sidecar) ? Object.keys(JSON.parse(fs.readFileSync(sidecar, "utf8"))) : null);
  try { await api.call("daemon.stop", {}); } catch { /* going anyway */ }
  api.close(); api = null;
  c.close();
  electron.kill("SIGKILL");
  await sleep(800);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  await sleep(500);
  c = await boot();
  await evalIn(c, awake);
  await until(() => evalIn(c, `!!document.querySelector('.panel')`), 30_000, "relaunched window");
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  if (!(await evalIn(c, `!!document.querySelector('.documents-pane')`))) {
    await until(() => evalIn(c, clickRow(STUDY)), 20_000, "Study row after relaunch");
    await sleep(800);
  }
  if (!(await evalIn(c, `!!document.querySelector('.documents-pane')`))) await openSideTool(c, STUDY, "Documents");
  await until(() => evalIn(c, `!!document.querySelector('.documents-pane')`), 10_000, "documents pane after relaunch");
  // The relaunched pane reads its tabs back a beat after it mounts.
  await until(() => evalIn(c, clickTab(`guides/${kitName}`)), 10_000, "kit tab after relaunch");
  fc = await frameFor(kitName);
  await until(() => evalIn(fc, `!!window.Kit`), 20_000, "kit after relaunch");
  await sleep(1200);
  const relaunched = await evalIn(fc, KIT_DIGEST);
  fc.close();
  await shot(c, "kit-relaunch-back");
  note("kit relaunch", { before: kitSpace.after, after: relaunched });
  check("kit relaunch: its saved progress (cards passed, answers) outlives the app", same(kitSpace.after.units, relaunched.units) && kitSpace.after.answered === relaunched.answered,
    { before: [kitSpace.after.units, kitSpace.after.answered], after: [relaunched.units, relaunched.answered] });
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
await main().catch((e) => { process.exitCode = 1; console.error(`FATAL ${e?.stack ?? e}`); }).finally(teardown);
