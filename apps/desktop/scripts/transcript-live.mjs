/**
 * Live check: a turn's timestamps, the files its prose names, and its "Edited N files" card
 * (run with: pnpm build && node apps/desktop/scripts/transcript-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, makes the onboarding session's folder a real git
 * checkout with two seeded files, and sends the scripted agent's "fix the org access" turn — which
 * really edits both files — so everything the card claims has a checkpoint and a measurement behind
 * it. Then: the card's rows and counts against git's, the prose's file links and where a click on
 * one lands (the documents pane, beside the session, at the line it named), Review's one-turn diff,
 * the sent-time under a message on hover, and Undo through the checkpoint restore. A second session
 * is seeded with events dated days back — a failed turn, a stopped one, one past the hour, one
 * across midnight — for what an old transcript's lines say. Both faces are captured.
 *
 * Ports: LIVE_SERVER_PORT (8800), LIVE_CDP_PORT (9240). Writes only under LIVE_SCRATCH (the OS temp
 * dir by default). Nothing is billed: the onboarding session is switched to the fake agent before the
 * one message is sent, and the built server skips the titler and the recap under the fake agent.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9240);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8800);
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-transcript-live-"));
const home = path.join(scratch, "home");
const OUTDIR = process.env.LIVE_OUT ?? path.join(scratch, "shots");
fs.mkdirSync(OUTDIR, { recursive: true });
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

/** The editing session's message, and the old session's first — how each one's pane is found once
 *  several are on screen. */
const ASKED = "Please fix the org access crash path";
const OLD_ASKED = "Draft the onboarding copy";

const HELPERS = `
globalThis.__live = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) }; },
  centre(el) { if (!el) return null; const r = el.getClientRects()[0] ?? el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2) }; },
  pane: (asked) => [...document.querySelectorAll(".session-pane")].find((p) => [...p.querySelectorAll(".msg-user")].some((m) => m.textContent.includes(asked))) ?? null,
  card: () => __live.pane(${JSON.stringify(ASKED)})?.querySelector(".edit-summary") ?? null,
  /** Bring an element to the middle of its scroller, for a capture that has to see it. */
  async show(el) { el?.scrollIntoView({ block: "center" }); await new Promise((r) => setTimeout(r, 350)); return __live.box(el); },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function clickAt(c, at) {
  if (!at) throw new Error("nothing to click");
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}

async function shoot(c, tag, clip) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 2 } } : {}) });
  const out = path.join(OUTDIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}
const pad = (b, n = 16) => (b ? { x: Math.max(0, b.x - n), y: Math.max(0, b.y - n), w: b.w + 2 * n, h: b.h + 2 * n } : null);

async function paletteRow(c, label) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!hit) return null; hit.click(); return true; })()`), 3000, `palette row ${label}`);
}

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=live@example.com", "-c", "user.name=live", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

/** The two files the scripted turn edits, each with the line its prose names (83, 67) in reach. */
function seedCheckout(dir) {
  const helpers = (n, stem) => Array.from({ length: n }, (_, i) => [
    `export function ${stem}${i}(name: string): string {`, `  return name.trim().toLowerCase().replace(/\\s+/g, "-${i}");`, "}", "",
  ]).flat();
  const orgs = [
    'import { and, eq } from "drizzle-orm";', 'import { db } from "./db";', 'import { organizationMember, withInviteDefaults } from "./schema";', "",
    ...helpers(19, "orgSlug"),
    "/** The caller's membership in an organisation, or null. */",
    "export async function getOrgMembership(orgId: string, userId: string) {",
    "  const rows = await db.select().from(organizationMember)",
    "    .where(and(eq(organizationMember.organizationId, orgId), eq(organizationMember.userId, userId)));",
    "  return rows[0] ?? null;", "}", "", ...helpers(6, "orgLabel"),
  ];
  const compact = [...helpers(16, "chunkName"), "", "", "export function shouldCompact(tokens: number, limit: number) {", "  return tokens > limit * 0.85;", "}", ""];
  fs.mkdirSync(path.join(dir, "web/lib/agent/chat-runtime/compaction"), { recursive: true });
  fs.writeFileSync(path.join(dir, "web/lib/orgs.ts"), `${orgs.join("\n")}\n`);
  fs.writeFileSync(path.join(dir, "web/lib/agent/chat-runtime/compaction/auto-compact.ts"), `${compact.join("\n")}\n`);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  return { orgsLine: orgs.indexOf("    .where(and(eq(organizationMember.organizationId, orgId), eq(organizationMember.userId, userId)));") + 1,
    compactLine: compact.indexOf("export function shouldCompact(tokens: number, limit: number) {") + 1 };
}

/** A session from days ago, written straight into the scratch DB with its own timestamps — what a
 *  transcript replayed long after the fact draws its lines from. */
function seedOldSession(sessionId) {
  const day = (back, h, m, s = 0) => { const d = new Date(); d.setDate(d.getDate() - back); d.setHours(h, m, s, 0); return d.getTime(); };
  const ev = [];
  const turn = (asked, start, end, how) => {
    ev.push([start, "user_message", { text: asked, attachments: [] }]);
    ev.push([start + 2_000, "status", { status: "running" }]);
    if (how === "failed") { ev.push([end - 500, "error", { message: "The agent's CLI exited before it answered." }]); ev.push([end, "status", { status: "error" }]); return; }
    ev.push([end - 1_000, "assistant_text", { messageId: `m${ev.length}`, text: how === "stopped" ? "Starting on" : `Done: ${asked.toLowerCase()}.` }]);
    ev.push([end, "status", how === "stopped" ? { status: "idle", interrupted: true } : { status: "idle" }]);
  };
  turn("Draft the onboarding copy", day(3, 19, 38), day(3, 19, 40, 12));
  turn("Rebuild the search index overnight", day(2, 23, 50), day(1, 0, 20, 2));
  turn("Run the migrations", day(1, 19, 38), day(1, 19, 38, 14), "failed");
  turn("Rename the tables", day(1, 21, 0), day(1, 21, 0, 5), "stopped");
  turn("Profile the slow import", day(1, 22, 0), day(1, 23, 4, 2));
  const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
  const sql = ev.map(([ts, type, payload]) => `INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (${q(sessionId)}, ${ts}, ${q(type)}, ${q(JSON.stringify(payload))});`);
  execFileSync("sqlite3", ["-cmd", ".timeout 5000", path.join(home, "realm.db"), sql.join("\n")]);
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
      REALM_HOME: home, REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
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
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Org app");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

async function main() {
  const c = await boot();
  const [session] = await api.call("sessions.listAll", {});
  // Before anything else: the onboarding session runs a REAL engine.
  await api.call("sessions.setAgent", { id: session.id, agentKind: "fake" });
  fs.mkdirSync(session.cwd, { recursive: true });
  const lines = seedCheckout(session.cwd);
  note("seeded", { cwd: session.cwd, ...lines });

  const asked = ASKED;
  const sentAt = Date.now();
  await api.call("sessions.send", { id: session.id, text: asked, attachments: [], mentions: [] });
  const measured = await until(async () => {
    const evs = await api.call("sessions.events", { id: session.id, afterSeq: 0, limit: 2000 });
    return evs.find((e) => e.event.type === "turn_changes")?.event.payload ?? null;
  }, 45_000, "the turn's measurement");
  const byGit = git(session.cwd, "diff", "--numstat").trim().split("\n").map((l) => l.split("\t")).map(([a, d, p]) => ({ path: p, additions: Number(a), deletions: Number(d) }));
  check("the server's measurement is git's own account of the turn",
    JSON.stringify([...measured.files].map(({ path: p, additions, deletions }) => ({ path: p, additions, deletions })).sort((a, b) => a.path.localeCompare(b.path)))
      === JSON.stringify(byGit.sort((a, b) => a.path.localeCompare(b.path))), { measured: measured.files, byGit });

  // ── The card ──
  const card = await until(() => evalIn(c, `(() => { const k = __live.card(); if (!k) return null;
    return { box: __live.box(k), title: k.querySelector(".edit-summary-title")?.textContent, head: k.querySelector(".edit-summary-head .edit-counts")?.textContent,
      rows: [...k.querySelectorAll(".edit-file")].map((r) => ({ dir: r.querySelector(".edit-file-dir")?.textContent ?? "", name: r.querySelector(".edit-file-name")?.textContent, n: r.querySelector(".edit-counts")?.textContent ?? "" })),
      undo: !!k.querySelector(".edit-summary-undo"), review: !!k.querySelector(".btn"),
      next: k.nextElementSibling?.className ?? null }; })()`), 20_000, "the edit card");
  check("the turn ends with an Edited 2 files card, its totals the sum of its rows", card.title === "Edited 2 files" && card.head === "+20−3", card);
  check("each row is the dimmed directory, the name, and that file's own counts — in the order the turn edited them", JSON.stringify(card.rows) === JSON.stringify([
    { dir: "web/lib/", name: "orgs.ts", n: "+17−2" }, { dir: "web/lib/agent/chat-runtime/compaction/", name: "auto-compact.ts", n: "+3−1" }]), card.rows);
  check("Undo is offered (the turn's checkpoint is the newest) beside Review", card.undo && card.review, card);
  check("the card sits directly above the line that closes the turn", String(card.next).startsWith("msg-run"), card.next);

  // ── The line that closes the turn, and the time under the message ──
  const run = await evalIn(c, `(() => { const l = [...document.querySelectorAll(".session-pane .msg-run")].pop(); const at = l?.querySelector("time");
    return { text: l?.querySelector("span")?.textContent, at: at?.textContent, title: at?.title, iso: at?.getAttribute("datetime") }; })()`);
  check("the turn's line says how long it ran and when it ended, from the settle's own timestamp",
    /for \d+s|for <1s/.test(run.text ?? "") && run.at === new Date(Date.parse(run.iso)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) && Date.parse(run.iso) >= sentAt, run);

  const userRow = await evalIn(c, `__live.show(__live.pane(${JSON.stringify(ASKED)}).querySelector(".msg-user-row"))`);
  const resting = await evalIn(c, `getComputedStyle(document.querySelector(".session-pane .msg-user-at")).opacity`);
  const { root } = await c.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await c.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".session-pane .msg-user-row" });
  await c.send("CSS.enable");
  await c.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
  await sleep(250);
  const hovered = await evalIn(c, `(() => { const t = document.querySelector(".session-pane .msg-user-at"); return { opacity: getComputedStyle(t).opacity, text: t.textContent, title: t.title }; })()`);
  check("the time a message was sent is hidden at rest and shown under the pointer", resting === "0" && hovered.opacity === "1" && hovered.text.length > 3, { resting, hovered });
  await shoot(c, "user-sent-time-dark", pad({ ...userRow, x: userRow.x - 200, w: userRow.w + 200, h: userRow.h + 4 }, 20));
  await c.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });

  // ── The prose's files ──
  const links = await until(() => evalIn(c, `(() => { const ls = [...document.querySelectorAll(".session-pane .md-file")]; if (ls.length < 2) return null;
    return ls.map((l) => ({ text: l.textContent, file: l.dataset.file, line: l.dataset.line ?? null, icon: !!l.querySelector("svg.md-file-mark") })); })()`), 15_000, "file links");
  check("a path in the prose and a backticked name both become links to real files in the checkout, with their lines",
    links.length === 2 && links[0].text === "web/lib/orgs.ts (line 83)" && links[0].file === path.join(session.cwd, "web/lib/orgs.ts") && links[0].line === "83"
      && links[1].text === "auto-compact.ts (line 67)" && links[1].file.endsWith("compaction/auto-compact.ts") && links.every((l) => l.icon), links);
  const turnShot = async (face) => {
    await evalIn(c, `__live.show(__live.card())`);
    const at = await evalIn(c, `(() => { const p = __live.pane(${JSON.stringify(ASKED)}); return { prose: __live.box([...p.querySelectorAll(".msg-assistant-row")].pop()),
      card: __live.box(__live.card()), col: __live.box(p.querySelector(".transcript-col")), run: __live.box([...p.querySelectorAll(".msg-run")].pop()) }; })()`);
    const top = Math.max(at.prose.y, at.card.y - 700);
    await shoot(c, `turn-card-${face}`, pad({ x: at.col.x, y: top, w: at.col.w, h: at.run.b - top + 8 }, 12));
  };
  await shoot(c, "turn-dark");
  await turnShot("dark");

  // The tool rows, opened: an edit names its file the way the card does.
  await evalIn(c, `(() => { const g = __live.pane(${JSON.stringify(ASKED)}).querySelector(".tool-group-row"); if (g && g.getAttribute("aria-expanded") !== "true") g.click(); return true; })()`);
  await sleep(400);
  const rows = await evalIn(c, `[...__live.pane(${JSON.stringify(ASKED)}).querySelectorAll(".tool-row")].map((r) => ({ name: r.querySelector(".tool-name")?.textContent,
    file: r.querySelector(".tool-file-name")?.textContent ?? null, dir: r.querySelector(".tool-file-dir")?.textContent ?? null, stat: r.querySelector(".tool-stat")?.textContent ?? null }))`);
  check("each edit's tool row shows the file's mark, its path and its counts", rows.some((r) => r.name === "Edit" && r.file === "orgs.ts" && r.dir === "web/lib/" && r.stat === "+17−2")
    && rows.some((r) => r.name === "Edit" && r.file === "auto-compact.ts" && r.stat === "+3−1") && rows.some((r) => r.name === "Run" && r.file === null), rows);
  const groupShot = async (face) => {
    const g = await evalIn(c, `__live.show(__live.pane(${JSON.stringify(ASKED)}).querySelector(".tool-group"))`);
    await shoot(c, `tool-rows-${face}`, pad(g, 12));
  };
  await groupShot("dark");

  // The same turn in the light face, while the session still has the window to itself.
  await paletteRow(c, "Theme: Light");
  await sleep(700);
  await evalIn(c, `__live.show(__live.card())`);
  await shoot(c, "turn-light");
  await turnShot("light");
  await groupShot("light");
  await paletteRow(c, "Theme: Dark");
  await sleep(600);

  // ── A click on the link lands the documents pane, beside the session, on the line ──
  await clickAt(c, await evalIn(c, `(async () => { const l = __live.pane(${JSON.stringify(ASKED)}).querySelector(".md-file"); await __live.show(l); return __live.centre(l); })()`));
  const landed = await until(() => evalIn(c, `(() => { const ed = document.querySelector(".documents-pane .cm-editor"); if (!ed) return null;
    const g = ed.querySelector(".cm-activeLineGutter"); return { line: g?.textContent ?? null, tab: document.querySelector(".documents-pane .documents-tab[data-active] .documents-tab-label")?.textContent ?? null,
      session: !!document.querySelector(".session-pane .transcript") }; })()`), 20_000, "the documents pane at the line");
  check("the file opens in the code editor at the line the prose named, and the session stays on screen", landed.line === "83" && landed.session, landed);
  await sleep(500);
  await shoot(c, "documents-at-line-dark");

  // ── Review: the turn's own diff ──
  await clickAt(c, await evalIn(c, `(async () => { await __live.show(__live.card()); return __live.centre([...__live.card().querySelectorAll(".btn")].find((b) => b.textContent === "Review")); })()`));
  const review = await until(() => evalIn(c, `(() => { const p = document.querySelector(".diff-pane"); const head = p?.querySelector(".diff-head-count")?.textContent;
    if (!head || !p.querySelector(".diff-line")) return null; return { head, asked: p.querySelector(".diff-turn-asked")?.textContent, adds: p.querySelectorAll('.diff-line[data-kind="add"]').length, dels: p.querySelectorAll('.diff-line[data-kind="del"]').length }; })()`), 20_000, "the review");
  check("Review opens the diff pane on that turn's changes alone, named by the message that asked", review.head === "2 files changed in one turn" && review.asked === asked && review.adds === 20 && review.dels === 3, review);
  await sleep(400);
  await shoot(c, "review-dark");

  // ── An old session's lines ──
  const old = await api.call("sessions.create", { spaceId: session.spaceId, agentKind: "fake" });
  const oldId = old.session?.id ?? old.id;
  seedOldSession(oldId);
  await api.call("items.update", { id: old.itemId, title: "Earlier work" }).catch(() => {});
  await sleep(300);
  await evalIn(c, `(() => { const row = [...document.querySelectorAll(".item-row")].find((r) => r.textContent.includes("Earlier work")); row?.click(); return !!row; })()`);
  const oldLines = await until(() => evalIn(c, `(() => { const ls = [...(__live.pane(${JSON.stringify(OLD_ASKED)})?.querySelectorAll(".msg-run") ?? [])]; if (ls.length < 5) return null;
    return ls.map((l) => ({ said: l.querySelector("span")?.textContent, at: l.querySelector("time")?.textContent })); })()`), 20_000, "the old session's lines");
  note("old session lines", oldLines);
  const [draft, overnight, failed, stopped, long] = oldLines;
  check("an old turn is dated with its day, and yesterday's say Yesterday", /^[A-Z][a-z]{2} \d+, 7:40/.test(draft.at) && /^Yesterday /.test(failed.at), { draft, failed });
  check("a turn across midnight is dated by when it ended", /^Yesterday 12:20/.test(overnight.at) && / for 30m 0s$/.test(overnight.said), overnight);
  check("a failed turn says it failed, a stopped one that it stopped, and a long one reads in hours",
    failed.said === "Failed after 12s" && stopped.said === "Stopped after 3s" && / for 1h 4m$/.test(long.said), { failed, stopped, long });
  const oldShot = async (face) => {
    const p = await evalIn(c, `(async () => { const p = __live.pane(${JSON.stringify(OLD_ASKED)}); p.querySelector(".transcript").scrollTop = 0; await new Promise((r) => setTimeout(r, 300));
      return __live.box(p.querySelector(".transcript")); })()`);
    await shoot(c, `old-session-${face}`, p);
  };
  await oldShot("dark");
  note("old session layout", await evalIn(c, `({ viewport: [innerWidth, innerHeight], panes: [...document.querySelectorAll(".session-pane")].map((p) =>
    ({ asked: p.querySelector(".msg-user")?.textContent?.slice(0, 30) ?? null, box: __live.box(p), transcript: __live.box(p.querySelector(".transcript")) })) })`));
  await shoot(c, "old-session-window-dark");
  await paletteRow(c, "Theme: Light");
  await sleep(700);
  await oldShot("light");
  await paletteRow(c, "Theme: Dark");
  await sleep(600);

  // Back to the session that edited: a sidebar row puts its session in the pane it is opened into,
  // and the session's side pane — Documents, Changes — comes back with it.
  await evalIn(c, `(() => { const row = [...document.querySelectorAll(".item-row")].find((r) => r.textContent.includes(${JSON.stringify(ASKED.slice(0, 18))})); row?.click(); return !!row; })()`);
  await until(() => evalIn(c, `!!__live.card()`), 15_000, "the editing session, back");

  // ── The card in a pane made narrow: nothing leaves it, and no name is lost ──
  // Its side pane's tabs no longer split the window as panes did, so the window itself is narrowed.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 940, deviceScaleFactor: 2, mobile: false });
  await sleep(600);
  const narrow = await evalIn(c, `(async () => { const k = __live.card(); await __live.show(k); const box = __live.box(k);
    const review = __live.box([...k.querySelectorAll(".btn")].find((b) => b.textContent === "Review"));
    const names = [...k.querySelectorAll(".edit-file-name")].map((n) => ({ text: n.textContent, cut: n.scrollWidth > n.clientWidth + 1, w: n.clientWidth }));
    const title = k.querySelector(".edit-summary-title"); return { pane: __live.box(__live.pane(${JSON.stringify(ASKED)})), box, review, names,
      titleLines: Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight || "20")) }; })()`);
  check("in a narrow pane the card keeps Review inside it, its title on one line, and every file's whole name",
    narrow.review.r <= narrow.box.r && narrow.titleLines <= 1 && narrow.names.every((n) => !n.cut && n.w > 0), narrow);
  await shoot(c, "turn-card-narrow-dark", pad(narrow.box, 12));
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  await sleep(600);

  // ── Review in the light face ──
  await paletteRow(c, "Theme: Light");
  await sleep(700);
  await clickAt(c, await evalIn(c, `(async () => { await __live.show(__live.card()); return __live.centre([...__live.card().querySelectorAll(".btn")].find((b) => b.textContent === "Review")); })()`));
  await until(() => evalIn(c, `!!document.querySelector(".diff-pane .diff-line")`), 15_000, "the review, again");
  await sleep(500);
  await shoot(c, "review-light");
  await paletteRow(c, "Theme: Dark");
  await sleep(600);

  // ── Undo: the checkpoint restore's own confirmation, and the files back as they were ──
  await clickAt(c, await evalIn(c, `(async () => { await __live.show(__live.card()); return __live.centre(__live.card()?.querySelector(".edit-summary-undo")); })()`));
  const sheet = await until(() => evalIn(c, `(() => { const s = [...document.querySelectorAll(".sheet, [role=dialog]")].find((d) => d.textContent.includes("Restore this checkpoint")); if (!s) return null;
    return { text: s.textContent.slice(0, 400), confirm: [...s.querySelectorAll("button")].map((b) => b.textContent) }; })()`), 15_000, "the restore confirmation");
  check("Undo asks first, saying what it will rewrite and that it can be undone", /rewrites 2 files/.test(sheet.text) && /Nothing is lost/.test(sheet.text), sheet);
  await shoot(c, "undo-confirm-dark");
  await evalIn(c, `(() => { const b = [...document.querySelectorAll("button")].find((x) => /^Restore( and overwrite)?$/.test(x.textContent.trim())); b?.click(); return !!b; })()`);
  await until(() => evalIn(c, `[...document.querySelectorAll("p.cp-report")].some((p) => /Restored 2 files/.test(p.textContent))`), 20_000, "the restore report");
  const status = git(session.cwd, "status", "--porcelain").trim();
  check("the turn's edits are gone from the checkout", status === "", status);
  await shoot(c, "undo-done-dark");

  check("no uncaught renderer exceptions", c.errors.length === 0, c.errors.slice(0, 3));
}

async function teardown() {
  try { api?.close(); } catch { /* gone */ }
  await stopDaemons(home).catch(() => {});
  try { electron?.kill("SIGTERM"); } catch { /* gone */ }
  await sleep(800);
  try { electron?.kill("SIGKILL"); } catch { /* gone */ }
  killPort(SERVER_PORT);
  killPort(CDP_PORT);
  if (!process.env.LIVE_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
process.exit(process.exitCode ?? 0);
