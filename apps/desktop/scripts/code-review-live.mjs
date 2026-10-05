/**
 * Live check for the Code Review page (run with: pnpm build && node apps/desktop/scripts/code-review-live.mjs)
 *
 * Boots the REAL app (built out/main + dist/main.js) on a scratch home with the scripted agent and a
 * FAKE gh — `REALM_GH_BIN` names a wrapper running apps/server/scripts/fixtures/fake-gh.mjs on the
 * fixture pull requests, so nothing here can reach GitHub — and walks the page as a person would:
 *
 *   1. the rail: Code review where Notifications was, and the spaces sidebar away while it is up;
 *   2. setup — gh signed out — and Check again once the fixture signs it in;
 *   3. the column: the three lists, Show more, the team's folded list;
 *   4. a request's Summary, and its Changes side by side with the file tree;
 *   5. Review with… on the scripted agent: the instructions gear, then the findings on the summary
 *      and on their lines in the diff;
 *   6. Submit review: the decision, the comment, a kept finding — and the one POST it makes;
 *   7. the docked prompter: a question and its answer;
 *   8. a 360-file request, windowed;
 *
 * with screenshots of each in dark, then the main ones in light, under LIVE_OUT.
 *
 * Nothing is billed: onboarding's session is never typed into, and every session this check starts
 * is the scripted agent's (the last-used agent is set to it before the page opens).
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8815 / 9255). It touches only its own scratch home and
 * kills only what holds its own two ports.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { buildFixture } from "../../server/scripts/fixtures/code-review-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9255);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8815);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-code-review-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(OUT_DIR, "run-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/* The fake gh and the fixture it answers from. Rewritten between steps to sign in or out. */
const ghDir = path.join(scratch, "gh");
fs.mkdirSync(ghDir, { recursive: true });
const fixturePath = path.join(ghDir, "fixture.json");
const ghLog = path.join(ghDir, "calls.jsonl");
const FIXTURE = buildFixture();
const writeFixture = (auth) => fs.writeFileSync(fixturePath, JSON.stringify({ ...FIXTURE, auth }));
writeFixture("signed-out");
const ghBin = path.join(ghDir, "gh");
fs.writeFileSync(ghBin, `#!/bin/sh\nFAKE_GH_FIXTURE='${fixturePath}' FAKE_GH_LOG='${ghLog}' exec '${process.execPath}' '${path.join(repoRoot, "apps/server/scripts/fixtures/fake-gh.mjs")}' "$@"\n`);
fs.chmodSync(ghBin, 0o755);
const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

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

/** Whatever is listening on a port this script started. Never a name match. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

const HELPERS = `
globalThis.__live = {
  q: (sel, root = document) => root.querySelector(sel),
  qa: (sel, root = document) => [...root.querySelectorAll(sel)],
  set(sel, value, root = document) {
    const el = typeof sel === "string" ? root.querySelector(sel) : sel;
    if (!el) throw new Error('no element: ' + sel);
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  byLabel(label, root = document) { return root.querySelector('[aria-label="' + label + '"]'); },
  click(el) { if (!el) throw new Error('nothing to click'); el.click(); return true; },
  button(text, root = document) {
    return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.disabled) ?? null;
  },
  buttonStarting(text, root = document) { return [...root.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent).trim().startsWith(text)) ?? null; },
  dialog(name) { return document.querySelector('[role=dialog][aria-label="' + name + '"]'); },
  rect(el) { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) }; },
  row(title) { return [...document.querySelectorAll('.cr-row')].find((r) => r.querySelector('.cr-row-title')?.textContent === title) ?? null; },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function shot(c, tag, clip) {
  const params = { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) };
  const r = await c.send("Page.captureScreenshot", params);
  const out = path.join(OUT_DIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
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
      REALM_GH_BIN: ghBin,
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
  // Onboarding makes the space. Its first session runs a REAL engine, so nothing is ever typed there.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  // Every session this check starts is the scripted agent's: the prompter and Review with… both take
  // the last-used agent, read at boot — so it is set, and the window reloaded to read it.
  await api.call("settings.set", { key: "ui.lastAgentKind", value: "fake" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.app-rail')`).catch(() => false), 30_000, "reload");
  await holdKey(c);
  return c;
}

async function holdKey(c) {
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
}

async function openPage(c) {
  await evalIn(c, `(() => { const b = __live.byLabel('Code review', __live.q('.app-rail')); if (b.getAttribute('aria-pressed') !== 'true') b.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.code-review-page')`), 15_000, "code review page");
  await sleep(600);
}

const clipOf = (c, sel, pad = 16) => evalIn(c, `(() => { const r = __live.rect(__live.q(${JSON.stringify(sel)})); return { x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y - ${pad}), width: r.width + ${pad * 2}, height: r.height + ${pad * 2} }; })()`);

async function openRequest(c, title) {
  await evalIn(c, `__live.click(__live.row(${JSON.stringify(title)}))`);
  await until(() => evalIn(c, `__live.q('.cr-title')?.textContent === ${JSON.stringify(title)}`), 15_000, `request ${title}`);
  await sleep(500);
}
async function tab(c, name) {
  await evalIn(c, `(() => { const l = [...document.querySelectorAll('.cr-tabs .seg-opt')].find((x) => x.textContent.startsWith(${JSON.stringify(name)})); l.querySelector('input').click(); return true; })()`);
  await sleep(500);
}

async function main() {
  const c = await boot();
  const space = (await api.call("spaces.list", {}))[0];

  /* ── 1. The rail ───────────────────────────────────────────────────────────────────────────── */
  const rail = await evalIn(c, `(() => ({ names: __live.qa('.app-rail .rail-group .rail-btn').map((b) => b.getAttribute('aria-label')) }))()`);
  check("the rail holds Code review where Notifications was", rail.names.includes("Code review") && !rail.names.some((n) => /^Notifications/.test(n)), rail.names);
  await openPage(c);
  const shell = await evalIn(c, `(() => ({ collapsed: document.querySelector('.app').hasAttribute('data-sidebar-collapsed'),
    pressed: __live.byLabel('Code review', __live.q('.app-rail')).getAttribute('aria-pressed') }))()`);
  check("the spaces sidebar is away while the page is up, and the rail's button is lit", shell.collapsed && shell.pressed === "true", shell);

  /* ── 2. Setup ──────────────────────────────────────────────────────────────────────────────── */
  await until(() => evalIn(c, `!!__live.button('Set up GitHub')`), 15_000, "setup");
  const setup = await evalIn(c, `(() => ({ title: __live.q('.cr-setup .pane-empty-title')?.textContent, how: __live.q('.cr-setup-how')?.textContent }))()`);
  check("signed out, the page says what is missing and offers Set up GitHub with the command it will type", setup.title === "Code review" && /gh auth login/.test(setup.how ?? ""), setup);
  await shot(c, "01-setup-dark");
  writeFixture("ready");
  await evalIn(c, `__live.click(__live.button('Check again'))`);
  await until(() => evalIn(c, `!!__live.q('.cr-col')`), 15_000, "the column once signed in");

  /* ── 3. The column ─────────────────────────────────────────────────────────────────────────── */
  await until(() => evalIn(c, `__live.qa('.cr-row').length >= 12`), 15_000, "rows");
  const col = await evalIn(c, `(() => ({
    sections: __live.qa('.cr-section-label').map((h) => h.textContent),
    rows: __live.qa('.cr-row').length, more: !!__live.button('Show more'),
    team: __live.q('.cr-section-toggle')?.getAttribute('aria-expanded'),
    width: __live.rect(__live.q('.cr-col')).width, empty: __live.q('.cr-empty-title')?.textContent,
  }))()`);
  check("the column lists Authored by me and Needs my review, a page of each, the team's folded", col.sections.join() === "Authored by me,Needs my review" && col.more && col.team === "false" && col.width === 300, col);
  check("nothing selected is the place to start", col.empty === "Select a pull request", col.empty);
  await shot(c, "02-list-dark");
  await evalIn(c, `__live.click(__live.button('Show more'))`);
  await until(() => evalIn(c, `!!__live.row('Remember the last tab')`), 10_000, "the next page");
  await evalIn(c, `__live.click(__live.q('.cr-section-toggle'))`);
  await until(() => evalIn(c, `!!__live.row('Split the billing service out of the monolith')`), 10_000, "the team's list");
  check("Show more brought the rest, and the team's list opened on its own request", true);

  /* ── 4. A request: Summary, then Changes ───────────────────────────────────────────────────── */
  await openRequest(c, "Stream the tokenizer instead of buffering its input");
  const summary = await evalIn(c, `(() => ({
    pill: __live.q('.cr-pill')?.textContent, repo: __live.q('.cr-head-repo')?.textContent,
    merge: __live.q('.cr-fact-line')?.textContent, reviewers: __live.qa('.cr-reviewer-name').map((n) => n.textContent),
    body: !!__live.q('.cr-body .md h2'), ask: !!__live.q('.cr-ask .composer'),
    bar: (() => { const b = __live.q('.cr-bar'); return b.scrollWidth <= b.clientWidth + 1; })(),
  }))()`);
  check("the Summary reads its state, the merge status, its reviewers and its description as markdown",
    summary.pill === "Open" && summary.repo === "acme/widgets #42" && summary.merge === "Blocked until it has an approving review" && summary.reviewers.join() === "carlton,core (team),jo-park" && summary.body, summary);
  check("the bar fits its pane, and the prompter is docked at the foot", summary.bar && summary.ask, summary);
  await shot(c, "03-summary-dark");
  await tab(c, "Changes");
  await until(() => evalIn(c, `__live.qa('.cr-file .diff-split').length >= 2`), 15_000, "split patches");
  const changes = await evalIn(c, `(() => ({
    files: __live.qa('.cr-file').length, tree: __live.qa('.cr-tree-row[data-kind=file]').map((r) => r.querySelector('.cr-tree-name').textContent),
    bands: __live.qa('.diff-band').map((b) => b.textContent), hatched: __live.qa('.diff-split-cell[data-kind=empty]').length,
    none: __live.qa('.cr-file .diff-note').map((n) => n.textContent),
  }))()`);
  check("Changes draws the files side by side, hatching what one side lacks, folding what neither changed", changes.hatched > 0 && changes.bands.length > 0, changes.bands);
  check("the tree lists all seven files beside them", changes.tree.length === 7, changes.tree);
  await shot(c, "04-changes-dark");
  // Open a band from the head's own text: the band goes, and its ten lines stand in its place.
  const band = (expr) => evalIn(c, `(() => { const f = __live.q('.cr-file[data-file="src/parser.ts"]'); return ${expr}; })()`);
  const before = await band(`{ bands: f.querySelectorAll('.diff-band').length, rows: f.querySelectorAll('.diff-split-row').length }`);
  await band(`(__live.qa('.diff-band', f).find((b) => b.textContent.includes('unchanged lines')).click(), true)`);
  const after = await until(async () => { const a = await band(`{ bands: f.querySelectorAll('.diff-band').length, rows: f.querySelectorAll('.diff-split-row').length }`); return a.bands < before.bands ? a : null; }, 10_000, "an opened band").catch(() => null);
  check("a band opens in place from the head's text — ten unchanged lines where it was", after?.rows === before.rows + 10
    && ghCalls().some((x) => (x.args[3] ?? "").includes("/contents/src/parser.ts")), { before, after });

  /* ── 5. Review with… ───────────────────────────────────────────────────────────────────────── */
  await evalIn(c, `__live.click(__live.byLabel('Review instructions'))`);
  await until(() => evalIn(c, `!!__live.dialog('Review instructions') && !__live.dialog('Review instructions').querySelector('textarea').disabled`), 10_000, "instructions");
  await evalIn(c, `(() => { const d = __live.dialog('Review instructions');
    __live.set(d.querySelector('textarea'), 'Flag error paths that swallow a failure.');
    __live.click(__live.button('Add example', d)); return true; })()`);
  await sleep(500);
  await shot(c, "05-review-instructions-dark", await clipOf(c, '[role=dialog][aria-label="Review instructions"]', 24));
  await evalIn(c, `__live.click(__live.button('Save and run', __live.dialog('Review instructions')))`);
  await until(() => evalIn(c, `!!__live.q('.cr-review[data-state=done]') || __live.q('.cr-file .cr-note') !== null`), 30_000, "findings");
  const saved = await api.call("codeReview.instructions", { profileId: space.profileId });
  check("the gear saved the profile's instructions, the example appended", saved.text === "Flag error paths that swallow a failure.\nI care most about the data model. Tell me where we might be overcomplicating things.", saved.text);
  await until(() => evalIn(c, `__live.qa('.cr-note').length >= 2`), 15_000, "inline findings");
  await evalIn(c, `(() => { const n = __live.q('.cr-file[data-file="src/tokenizer.ts"] .cr-note'); n.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(400);
  check("its findings sit under their lines in the diff", await evalIn(c, `__live.qa('.cr-note').length`) >= 2);
  await shot(c, "06-finding-in-changes-dark");
  await tab(c, "Summary");
  await until(() => evalIn(c, `!!__live.q('.cr-review[data-state=done]')`), 10_000, "the review panel");
  const panel = await evalIn(c, `(() => ({ title: __live.q('.cr-review-title')?.textContent, findings: __live.qa('.cr-finding').length,
    off: __live.qa('.cr-finding-where').map((w) => w.textContent) }))()`);
  check("the summary carries the review: its account and its three findings, one off the diff", panel.findings === 3 && panel.off.some((w) => w.includes("not in the diff")), panel);
  await shot(c, "07-review-summary-dark");

  /* ── 6. Submit review ──────────────────────────────────────────────────────────────────────── */
  await evalIn(c, `__live.click(__live.qa('.cr-finding').find((f) => f.textContent.includes('src/tokenizer.ts')).querySelector('button.btn-quiet'))`);
  await evalIn(c, `__live.click(__live.buttonStarting('Submit review'))`);
  await until(() => evalIn(c, `!!__live.dialog('Submit review')`), 10_000, "submit sheet");
  await evalIn(c, `(() => { const d = __live.dialog('Submit review');
    __live.set(d.querySelector('textarea'), 'Two things before this lands — see the comment on the tokenizer.');
    return true; })()`);
  await sleep(400);
  const sheet = await evalIn(c, `(() => { const d = __live.dialog('Submit review'); return { posts: d.querySelector('.cr-posts')?.textContent,
    pending: [...d.querySelectorAll('.cr-pending-where')].map((p) => p.textContent), submit: !d.querySelector('.cr-pop-actions .btn.primary').disabled }; })()`);
  check("Submit review says what it will post before it does: a comment with one line comment, where and as whom",
    sheet.posts === "Posts a comment with 1 line comment to acme/widgets#42 as @carlton." && sheet.pending.join() === "src/tokenizer.ts:14" && sheet.submit, sheet);
  check("…and nothing has been posted yet", !ghCalls().some((x) => x.args.includes("POST")));
  await shot(c, "08-submit-dark", await clipOf(c, '[role=dialog][aria-label="Submit review"]', 24));
  await evalIn(c, `__live.click(__live.q('[role=dialog][aria-label="Submit review"] .cr-pop-actions .btn.primary'))`);
  await until(() => ghCalls().some((x) => x.args.includes("POST")), 15_000, "the post");
  const post = ghCalls().filter((x) => x.args.includes("POST"));
  check("Submit made ONE post, with exactly what the sheet showed", post.length === 1 && post[0].stdin === JSON.stringify({
    commit_id: FIXTURE.prs["acme/widgets#42"].view.headRefOid, event: "COMMENT", body: "Two things before this lands — see the comment on the tokenizer.",
    comments: [{ path: "src/tokenizer.ts", line: 14, side: "RIGHT", body: "A token that ends exactly at a chunk boundary is pushed before the next chunk arrives, so `ab|cd` comes out as two tokens. Carry the partial token into the next `feed`." }] }), post[0]?.stdin);
  await sleep(600);

  /* ── 7. Ask about this pull request ────────────────────────────────────────────────────────── */
  await evalIn(c, `(() => { const ta = __live.q('.cr-ask .composer textarea'); ta.focus(); __live.set(ta, 'What does this change for callers?'); return true; })()`);
  await sleep(200);
  await evalIn(c, `__live.click(__live.q('.cr-ask .composer-send'))`);
  await until(() => evalIn(c, `[...document.querySelectorAll('.cr-ask-thread .md')].some((m) => m.textContent.includes('Tokenizer.feed'))`), 20_000, "the answer");
  await sleep(800);
  const thread = await api.call("codeReview.thread", { ref: { owner: "acme", repo: "widgets", number: 42 } });
  const sessions = await api.call("sessions.list", { spaceId: space.id });
  const asked = sessions.find((s) => s.id === thread.sessionId);
  check("the question started a session on the scripted agent, with the request attached, and its answer reads above the prompter", asked?.agentKind === "fake", asked?.agentKind);
  await shot(c, "09-ask-dark");

  /* ── 8. A wide request, windowed ───────────────────────────────────────────────────────────── */
  await openRequest(c, "Regenerate the grammar tables");
  await tab(c, "Changes");
  await until(() => evalIn(c, `__live.qa('.cr-file').length > 0 && __live.qa('.cr-tree-row[data-kind=file]').length === 360`), 20_000, "the wide tree");
  const wide = await evalIn(c, `(() => ({ drawn: __live.qa('.cr-file').length, height: __live.q('.cr-diffs').scrollHeight }))()`);
  check("360 files, and only those near the view drawn", wide.drawn > 0 && wide.drawn < 60 && wide.height > 20_000, wide);
  await evalIn(c, `(() => { const d = __live.q('.cr-diffs'); d.scrollTop = d.scrollHeight; return true; })()`);
  const atEnd = await until(() => evalIn(c, `!!__live.q('.cr-file[data-file="grammar/tables/table-359.ts"] .diff-split')`), 15_000, "the last file drawn").catch(() => false);
  const where = await evalIn(c, `(() => { const d = __live.q('.cr-diffs'); const f = __live.qa('.cr-file');
    return { top: Math.round(d.scrollTop), height: d.scrollHeight, view: d.clientHeight, first: f[0]?.dataset.file, last: f.at(-1)?.dataset.file,
      loading: __live.qa('.cr-file .diff-loading').length, drawn: f.length }; })()`);
  check("…scrolled to the end, the last file is drawn with its patch", atEnd, where);
  await shot(c, "10-wide-dark");

  /* ── Light ─────────────────────────────────────────────────────────────────────────────────── */
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  writeFixture("signed-out");
  // The server holds a signed-in answer for a minute; ask it fresh, as Check again would.
  await api.call("codeReview.status", { force: true });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
  await holdKey(c);
  await openPage(c);
  await until(() => evalIn(c, `!!__live.button('Set up GitHub')`), 15_000, "setup in light");
  await shot(c, "11-setup-light");
  writeFixture("ready");
  await evalIn(c, `__live.click(__live.button('Check again'))`);
  await until(() => evalIn(c, `__live.qa('.cr-row').length >= 12`), 15_000, "rows in light");
  await shot(c, "12-list-light");
  await openRequest(c, "Stream the tokenizer instead of buffering its input");
  await until(() => evalIn(c, `!!__live.q('.cr-review[data-state=done]')`), 10_000, "the review in light");
  await shot(c, "13-summary-light");
  await tab(c, "Changes");
  await until(() => evalIn(c, `__live.qa('.cr-note').length >= 2`), 15_000, "findings in light");
  await evalIn(c, `(() => { const n = __live.q('.cr-file[data-file="src/tokenizer.ts"] .cr-note'); n.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(400);
  await shot(c, "14-changes-light");
  await evalIn(c, `__live.click(__live.byLabel('Review instructions'))`);
  await until(() => evalIn(c, `!!__live.dialog('Review instructions')`), 10_000, "instructions in light");
  await sleep(500);
  await shot(c, "15-review-instructions-light", await clipOf(c, '[role=dialog][aria-label="Review instructions"]', 24));
  await evalIn(c, `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  await sleep(300);
  await evalIn(c, `__live.click(__live.buttonStarting('Submit review'))`);
  await until(() => evalIn(c, `!!__live.dialog('Submit review')`), 10_000, "submit in light");
  await evalIn(c, `__live.set(__live.dialog('Submit review').querySelector('textarea'), 'Looks right to me.')`);
  await evalIn(c, `__live.click(__live.dialog('Submit review').querySelectorAll('input[type=radio]')[1])`);
  await sleep(400);
  await shot(c, "16-submit-light", await clipOf(c, '[role=dialog][aria-label="Submit review"]', 24));
  await evalIn(c, `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  await sleep(300);
  await tab(c, "Summary");
  await until(() => evalIn(c, `[...document.querySelectorAll('.cr-ask-thread .md')].some((m) => m.textContent.includes('Tokenizer.feed'))`), 20_000, "the thread in light");
  await sleep(500);
  await shot(c, "17-ask-light");
  check("only the one POST ever reached the fake gh", ghCalls().filter((x) => x.args.includes("POST")).length === 1);
  c.close();
}

main()
  .catch((e) => { console.log(`FAIL harness ${e.message}`); process.exitCode = 1; })
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
