/**
 * Live check for a team's Review — run with:
 *   node apps/desktop/scripts/team-review-live.mjs
 *
 * Boots the BUILT app (run `pnpm build` first) on a scratch home. Every role runs on the scripted
 * agent, and the act adapter is the fake one (REALM_FAKE_ACT_ADAPTER=1), so nothing is billed and
 * nothing reaches a platform. It seeds one review in every state a person meets:
 *
 *   waiting — slideshows, an email, a DM, a note in Markdown, a diff, a bundle of files
 *   changes — asked for changes, the role woken and still on it
 *   approved — one post still to press, one pressed for its slot
 *   posted, a failed post, rejected with a reason, closed, and one the role replaced
 *
 * and photographs the empty Review, the inbox, a reader per kind of draft, every state, the send-back
 * flow and a narrow pane, in both faces.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8810 / 9250). Screenshots go to LIVE_OUT. It touches only
 * its own scratch home, and kills only what holds its own two ports AND names its scratch home.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9250);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8810);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-team-review-live");
/** `before` drives the list-and-reader this replaced, for the side-by-side; anything else, this one. */
const BEFORE = process.env.LIVE_MODE === "before";
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-team-review-"));
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

/** Kill what listens on `port` — only a process whose command line names this run's scratch home or
 *  this worktree, so another check's server, or the owner's Realm, is never the one that goes. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) {
      const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (!command.includes(repoRoot) && !command.includes(scratch)) { console.log(`LEFT ${pid} on ${port}: not this run's`); continue; }
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
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
  button(re, root = document) { return [...root.querySelectorAll('button')].find((b) => new RegExp(re).test(b.textContent.trim()) && !b.disabled) ?? null; },
  text: (sel) => document.querySelector(sel)?.textContent ?? null,
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception in ${expr.slice(0, 120)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function shot(c, tag, settle = 900) {
  await sleep(settle);
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(OUT_DIR, `${BEFORE ? "before" : "after"}-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${out}`);
}

async function holdKey(c) {
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
}

const size = (c, width, height = 900) => c.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

/* ── the scripted roles ─────────────────────────────────────────────────────────────────────────── */

const D = "drafts";
const NATHAN_TT = { channel: "TikTok", account: "@versed.nathan" };
const NATHAN_IG = { channel: "Instagram", account: "@versed.nathan" };
/** What a role says about why it made a batch — only the new Review reads it, and the old server
 *  refused the field, so the before run leaves it out. */
const why = (note) => (BEFORE ? {} : { note });
const slides = (show, n) => Array.from({ length: n }, (_, i) => `${D}/slides/${show}-${i + 1}.png`);

const PRODUCER = [
  { title: "3 slideshows for Nathan", kind: "slideshows", record: "nathan-beyenhof", ...why("Nathan's Sunday sermon on patience did well in his comments, so each of these opens on a question from it. The third leans on the journaling clip he liked."),
    items: [1, 2, 3].map((n) => ({ files: slides(n, 4), body: [
      "patience isn't waiting, it's how you wait 🌿 day 1 of reading James with me #ad",
      "the verse I keep on my lock screen this month. which one is yours? #ad",
      "journaling James 1:19 — slow to speak is harder than it sounds #ad"][n - 1], target: NATHAN_TT })) },
  { title: "Launch post for Friday", kind: "slideshows", record: "nathan-beyenhof", items: [{ files: slides(4, 3), body: "versed is live 🎉 a verse a day, read out loud with me #ad", target: NATHAN_TT }] },
  { title: "Sunday recap slideshow", kind: "slideshows", record: "nathan-beyenhof", items: [{ files: slides(5, 3), body: "this week's verses, in one place #ad", target: NATHAN_IG }] },
  { title: "Two slideshows for next week", kind: "slideshows", record: "nathan-beyenhof", items: [5, 6].map((n) => ({ files: slides(n, 3), body: `week 2, part ${n - 4}: read it out loud, twice #ad`, target: NATHAN_TT })) },
  { title: "Hook test, round 1", kind: "slideshows", items: [{ files: slides(6, 2), body: "three hooks for the patience series" }] },
];
const OUTREACH = [
  { title: "Reply to Dana at Acme", label: "replies", ...why("Dana asked on Monday's call for the pilot's start date in writing. Legal sends the contract Friday, so this only confirms the date."),
    items: [{ files: [], body: "Hi Dana,\n\nThanks for the call on Monday. The pilot starts on Wednesday the 14th, as we agreed. The contract comes from legal on Friday; I'll forward it the moment it lands.\n\nCarlton", meta: { Subject: "Pilot start date", Due: "Tuesday" }, action: { connector: "mcp:gmail", tool: "send_message", verb: "send", account: "carlton@versed.app", to: "dana@acme.com" } }] },
  { title: "Thank-you DM to @reader", label: "DM", ...why("@reader reposted Friday's slideshow to 40k followers."),
    items: [{ files: [], body: "thank you for the repost! the verse-a-day trick is in the next video 🙏", action: { connector: "channel:instagram", verb: "dm", account: "@versed.nathan", to: "@reader" } }] },
  { title: "Weekly check-in with Nathan", label: "replies", items: [{ files: [], body: "Hey Nathan! Huge week — want to lock in a bonus tier for November? Let's hop on a call.", meta: { Subject: "This week" }, action: { connector: "mcp:gmail", verb: "send", account: "carlton@versed.app", to: "nathan@example.com" } }] },
  { title: "Follow-up to Priya", label: "replies", items: [{ files: [], body: "Hi Priya, circling back on the podcast swap. Does the 30th still work?", meta: { Subject: "Podcast swap" }, action: { connector: "mcp:gmail", verb: "send", account: "carlton@versed.app", to: "priya@ff.show" } }] },
];
const ANALYST = [
  { title: "Does a 7-day streak predict retention?", label: "answer", ...why("You asked in Tuesday's planning note whether streaks are worth a reminder. This is the short answer from September's cohort."),
    items: [{ files: [], body: "# Short answer: yes, but not on its own\n\nPeople who keep a **7-day streak** in their first two weeks are still reading at day 30 at **2.3×** the rate of those who don't.\n\n- Source: PostHog cohort, Sept 1–30 (n = 4,812)\n- Caveat: streak keepers also opened notifications more often\n\n> Worth testing a streak reminder before calling it causal." }] },
  { title: "v2.4 release notes patch", label: "release notes", items: [{ files: [`${D}/notes.patch`], meta: { Version: "2.4.0" } }] },
  { title: "Press kit bundle", label: "assets", ...why("Everything a podcast host asked for in one place: the logo, the one-pager and two screenshots."),
    items: [{ files: [`${D}/press-kit.zip`, `${D}/one-pager.pdf`, `${D}/hero.png`, `${D}/leads.csv`] }] },
  { title: "Retention report, week 41", label: "report", items: [{ files: [`${D}/retention-week-41.md`] }] },
];

const call = (input) => ({ kind: "call", tool: "realm-team__review_submit", input });
const SCRIPT = [
  { on: "send a placeholder", emit: [call({ title: "Placeholder", label: "note", items: [{ files: [], body: "nothing yet" }] })] },
  { on: "make this week's slideshows", emit: [...PRODUCER.map(call), { kind: "usage", costUsd: 0.84 }, { kind: "text", text: "Sent five batches to Review." }] },
  { on: "draft the replies", emit: [...OUTREACH.map(call), { kind: "usage", costUsd: 0.12 }, { kind: "text", text: "Four drafts are in Review." }] },
  { on: "write up retention", emit: [...ANALYST.map(call), { kind: "usage", costUsd: 0.37 }, { kind: "text", text: "The answer, the patch, the press kit and the week's report are in Review." }] },
  // Woken by "Request changes": it says so and stays on it, so the batch rests in "changes".
  { on: "asked for changes", emit: [{ kind: "text", text: "On it — adding the cohort sizes." }] },
];

/* ── the fixture files ──────────────────────────────────────────────────────────────────────────── */

function makeFiles(folder) {
  const dir = path.join(folder, D);
  fs.mkdirSync(path.join(dir, "slides"), { recursive: true });
  const product = path.join(repoRoot, "site/public/product");
  const caps = fs.readdirSync(product).filter((f) => f.endsWith("-1440.webp")).sort();
  execFileSync("sips", ["-s", "format", "png", "-Z", "1440", path.join(product, caps[0]), "--out", path.join(dir, "hero.png")], { stdio: "ignore" });
  let n = 0;
  for (let show = 1; show <= 6; show++) for (let s = 1; s <= 4; s++) {
    const from = path.join(product, caps[n++ % caps.length]);
    // A 9:16 slide, cut from the middle of a product capture.
    execFileSync("sips", ["-s", "format", "png", "-c", "900", "506", from, "--out", path.join(dir, "slides", `${show}-${s}.png`)], { stdio: "ignore" });
  }
  const txt = path.join(dir, "one-pager.txt");
  fs.writeFileSync(txt, ["VERSED — ONE PAGER", "", "A verse a day, read out loud.", "", "Readers: 48,000 a week", "Streak keepers: 2.3x day-30 retention", "", "press@versed.app"].join("\n"));
  fs.writeFileSync(path.join(dir, "one-pager.pdf"), execFileSync("/usr/sbin/cupsfilter", ["-m", "application/pdf", txt], { stdio: ["ignore", "pipe", "ignore"] }));
  fs.rmSync(txt);
  fs.writeFileSync(path.join(dir, "notes.patch"), [
    "diff --git a/CHANGELOG.md b/CHANGELOG.md", "--- a/CHANGELOG.md", "+++ b/CHANGELOG.md", "@@ -1,4 +1,7 @@", " # Changelog", " ",
    "+## 2.4.0", "+- Streak reminders, at the hour you usually read.", "+", " ## 2.3.1", "-- Fixed a crash on launch.", "+- Fixed a crash on launch when the library was empty.", "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "leads.csv"), ["Name,Show,Listeners", "Dana Ruiz,Morning Pages,48000", "Sam Ortiz,Quiet Time,9100", "Priya Nair,Faith & Focus,23000"].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "retention-week-41.md"), "# Retention, week 41\n\nDay-7 retention held at 41%. Day-30 rose two points, to 18%.\n\n| Cohort | Day 7 | Day 30 |\n|---|---|---|\n| Sept 1 | 40% | 17% |\n| Sept 8 | 41% | 18% |\n");
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
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
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
  // The renderer is listed before its document exists, and holding the key needs the document's root.
  await until(() => evalIn(c, `!!document.documentElement`).catch(() => false), 30_000, "document");
  await holdKey(c);
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  // The space's name, and nothing typed into onboarding's own session: its engine is a real one.
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Versed");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await size(c, 1440);
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

async function reload(c) {
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.app-rail')`).catch(() => false), 30_000, "reload");
  await holdKey(c);
}

async function theme(c, mode) {
  await api.call("settings.set", { key: "ui.theme", value: mode });
  await reload(c);
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === '${mode}'`).catch(() => false), 10_000, `${mode} face`);
}

const runsOf = (roleId) => api.call("team.roleRuns", { id: roleId, limit: 30 });
const settled = (r) => !["queued", "running", "blocked"].includes(r.state);
async function runRole(role, message) {
  const before = (await runsOf(role.id)).length;
  await api.call("team.roleRun", { id: role.id, message });
  await until(async () => { const runs = await runsOf(role.id); return runs.length > before && runs.every(settled); }, 40_000, `${role.name} settles`);
}

/** Read one review: its row clicked, and its drafting drawn (pictures decoded, a PDF's page in). */
async function read(c, id) {
  await evalIn(c, `__live.click(__live.q('[data-review="${id}"]'))`);
  await until(() => evalIn(c, `(() => { const d = __live.q('.rv-deliverable'); if (!d) return false;
    const imgs = [...d.querySelectorAll('img')]; return imgs.every((i) => i.complete && i.naturalWidth > 0) && !d.querySelector('.rv-pdf-blank'); })()`), 15_000, `review ${id} drawn`);
}

async function main() {
  const c = await boot();
  liveC = c;
  const space = (await api.call("spaces.list", {})).find((s) => s.name === "Versed");
  check("onboarding made Versed", !!space);
  makeFiles(space.folderPath);

  await api.call("team.make", { spaceId: space.id, templates: [] });
  const role = (name, seed, brief) => api.call("team.roleCreate", { spaceId: space.id, name, brief, realmite: { seed }, agentKind: "fake", model: "sonnet", cron: "0 9 * * 1-5" });
  const producer = await role("Content Producer", "content-producer-32", "Make slideshows for each signed creator and send each batch to Review.");
  const outreach = await role("Outreach", "outreach-7", "Draft replies and DMs and send them to Review.");
  const analyst = await role("Analyst", "analyst-3", "Answer the team's questions about the numbers and send each answer to Review.");
  await api.call("team.recordCreate", { spaceId: space.id, name: "Nathan Beyenhof" });
  await api.call("team.recordWrite", { spaceId: space.id, path: "creators/nathan-beyenhof.md", markdown: NATHAN });

  /* ── the empty Review: a team whose roles have sent nothing yet ──────────────────────────────────
     The sidebar offers Review only while something waits, so one placeholder opens the pane and is
     then taken out of the database; a change to the team's week makes the window read it again. */
  await runRole(analyst, "Please send a placeholder.");
  await until(() => evalIn(c, `!!__live.q('[aria-label^="Review"]')`), 15_000, "review row");
  await evalIn(c, `__live.click(__live.q('[aria-label^="Review"]'))`);
  await until(() => evalIn(c, `!!__live.q('.rv')`), 15_000, "review pane");
  execFileSync("sqlite3", [path.join(home, "realm.db"), "DELETE FROM team_review_items; DELETE FROM team_reviews;"]);
  await api.call("team.setBudget", { spaceId: space.id, weekBudgetUsd: 60 });
  await until(() => evalIn(c, `__live.qa('[data-review]').length === 0`), 15_000, "review emptied");
  await shot(c, "00-empty-dark");
  await theme(c, "light");
  await until(() => evalIn(c, `!!__live.q('.rv')`), 15_000, "review pane light");
  await shot(c, "00-empty-light");
  await theme(c, "dark");

  /* ── every state ──────────────────────────────────────────────────────────────────────────────── */
  await runRole(producer, "Please make this week's slideshows.");
  await runRole(outreach, "Please draft the replies.");
  await runRole(analyst, "Please write up retention.");
  let reviews = (await api.call("team.space", { spaceId: space.id })).reviews;
  const by = (title) => reviews.find((r) => r.title === title);
  check("thirteen reviews arrived, all waiting", reviews.length === 13 && reviews.every((r) => r.state === "waiting"), reviews.map((r) => `${r.title}:${r.state}`));

  // The role replaces its own first try: written as `review_close` leaves it (the scripted agent can
  // only learn the id from the message, and a role's run wraps the message in its own words).
  const hook = by("Hook test, round 1");
  const reason = "The hooks in “3 slideshows for Nathan” replace these.";
  execFileSync("sqlite3", [path.join(home, "realm.db"), `UPDATE team_reviews SET state = 'dismissed', note = '${reason}', decided_at = ${Date.now()}, updated_at = ${Date.now()} WHERE id = '${hook.id}';
    INSERT INTO team_activity (id, space_id, ts, actor, run_id, session_id, verb, object, detail_json) VALUES ('${hook.id.slice(0, 25)}Z', '${space.id}', ${Date.now()}, 'role:${producer.id}', NULL, NULL, 'closed', 'Hook test, round 1', '${JSON.stringify({ reviewId: hook.id, outcome: "superseded", reason })}');`]);
  // Asked for changes: the analyst wakes, says so, and the batch rests with it.
  await api.call("team.reviewRequestChanges", { id: by("Retention report, week 41").id, note: "Add the cohort sizes next to each row." });
  await until(async () => (await runsOf(analyst.id)).every(settled), 20_000, "analyst on it");
  await api.call("team.reviewReject", { id: by("Weekly check-in with Nathan").id, reason: "Too salesy. He asked us to keep these to a line." });
  await api.call("team.reviewClose", { id: by("Follow-up to Priya").id });

  // Approved: tickets issued. Pressing needs main's record of a click, which only the window holds.
  for (const t of ["Launch post for Friday", "Sunday recap slideshow", "Two slideshows for next week"]) await api.call("team.reviewApprove", { id: by(t).id });
  const ticketsOf = async (title) => (await api.call("team.tickets", { spaceId: space.id, reviewId: by(title).id })).sort((a, b) => a.ord - b.ord);
  const db = path.join(home, "realm.db");
  // Posted, and a post the platform refused: written as the act would leave them, so the frame does
  // not depend on the hour (posts are planned between 8 AM and 10 PM).
  const [launch] = await ticketsOf("Launch post for Friday");
  const proof = path.join(scratch, "proof.png");
  fs.copyFileSync(path.join(space.folderPath, D, "slides", "4-1.png"), proof);
  const posted = Date.now() - 50 * 60_000;
  execFileSync("sqlite3", [db, `UPDATE team_act_tickets SET state = 'done', pressed_at = ${posted - 60_000}, acted_at = ${posted}, proof_url = 'https://fake-platform.invalid/tiktok/versed.nathan/1', screenshot = '${proof}' WHERE id = '${launch.id}';
    UPDATE team_reviews SET state = 'done', updated_at = ${posted} WHERE id = '${by("Launch post for Friday").id}';`]);
  const [recap] = await ticketsOf("Sunday recap slideshow");
  execFileSync("sqlite3", [db, `UPDATE team_act_tickets SET error = 'Instagram asked to confirm the sign-in on Lab iPhone 2. Nothing was posted.', screenshot = '${proof}', updated_at = ${Date.now() - 20 * 60_000} WHERE id = '${recap.id}';`]);
  // One of next week's pressed for its slot, the other still waiting for its press.
  const [nextWeek] = await ticketsOf("Two slideshows for next week");
  const slot = new Date(); slot.setDate(slot.getDate() + 1); slot.setHours(10, 0, 0, 0);
  execFileSync("sqlite3", [db, `UPDATE team_act_tickets SET state = 'scheduled', pressed_at = ${Date.now()}, slot_at = ${slot.getTime()} WHERE id = '${nextWeek.id}';`]);
  // Rows written behind the server's back: a change to the team's week makes every window read the team again.
  await api.call("team.setBudget", { spaceId: space.id, weekBudgetUsd: 60 });
  reviews = (await api.call("team.space", { spaceId: space.id })).reviews;
  const states = Object.fromEntries(reviews.map((r) => [r.title, r.state]));
  check("every state is seeded", states["Hook test, round 1"] === "dismissed" && states["Retention report, week 41"] === "changes" && states["Weekly check-in with Nathan"] === "rejected"
    && states["Follow-up to Priya"] === "closed" && states["Launch post for Friday"] === "done" && states["Two slideshows for next week"] === "approved", states);

  /* ── the inbox and a reader per draft, dark then light ─────────────────────────────────────────── */
  const READERS = [
    ["10-slideshows", "3 slideshows for Nathan"], ["11-email", "Reply to Dana at Acme"], ["12-dm", "Thank-you DM to @reader"],
    ["13-markdown", "Does a 7-day streak predict retention?"], ["14-diff", "v2.4 release notes patch"], ["15-files", "Press kit bundle"],
    ["20-changes", "Retention report, week 41"], ["21-approved-scheduled", "Two slideshows for next week"], ["22-posted", "Launch post for Friday"],
    ["23-failed", "Sunday recap slideshow"], ["24-rejected", "Weekly check-in with Nathan"], ["25-closed", "Follow-up to Priya"], ["26-superseded", "Hook test, round 1"],
  ];
  for (const mode of ["dark", "light"]) {
    if (mode === "light") await theme(c, "light");
    await until(() => evalIn(c, `__live.qa('[data-review]').length >= 10`), 15_000, "inbox rows");
    await shot(c, `01-inbox-${mode}`);
    for (const [tag, title] of READERS) {
      await read(c, by(title).id);
      await shot(c, `${tag}-${mode}`);
    }
    await sendBack(c, by("Reply to Dana at Acme").id, mode);
    if (!BEFORE) await decide(c, by(mode === "dark" ? "Does a 7-day streak predict retention?" : "v2.4 release notes patch").id, mode);
    await narrow(c, by("3 slideshows for Nathan").id, mode);
  }
  c.close();
}

/** The send-back flow on the email, up to the press that would send it — and not the press. */
async function sendBack(c, id, mode) {
  await read(c, id);
  if (BEFORE) {
    await evalIn(c, `__live.click(__live.button('^Request changes$'))`);
    await until(() => evalIn(c, `!!__live.q('.rv-ask-field')`), 5_000, "ask field");
    await evalIn(c, `__live.set(__live.q('.rv-ask-field'), 'Say the 14th is a Wednesday, and drop the line about legal.')`);
  } else {
    await evalIn(c, `__live.click(__live.button('^Send back'))`);
    await until(() => evalIn(c, `!!__live.q('.rv-sendback textarea')`), 5_000, "send-back field");
    await evalIn(c, `__live.set(__live.q('.rv-sendback textarea'), 'Say the 14th is a Wednesday, and drop the line about legal.')`);
  }
  await shot(c, `30-send-back-${mode}`);
  await evalIn(c, `(() => { const f = document.activeElement; f?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
}

/** Approve a draft that goes nowhere: its row folds out of Waiting for you into Recent, the receipt
 *  comes up at the window's foot, and the next draft waiting is put in front. */
async function decide(c, id, mode) {
  await read(c, id);
  await sleep(500);
  const title = await evalIn(c, `__live.text('.rv-title')`);
  await evalIn(c, `__live.click(__live.button('^Approve'))`);
  await sleep(90);
  await shot(c, `31-deciding-${mode}`, 0);
  await until(() => evalIn(c, `[...document.querySelectorAll('.toast')].some((t) => /Approved/.test(t.textContent))`), 5_000, "receipt");
  const after = await evalIn(c, `({ title: __live.text('.rv-title'), recent: [...document.querySelectorAll('.rv-group[data-group="recent"] [data-review]')].map((r) => r.dataset.review) })`);
  check(`${mode}: the approved draft moved to Recent and the next one is in front`, after.recent.includes(id) && after.title !== title, after);
  await shot(c, `32-decided-${mode}`);
}

/** The pane at a side panel's width. */
async function narrow(c, id, mode) {
  await size(c, 860);
  await sleep(400);
  if (!BEFORE) await evalIn(c, `(() => { const back = __live.button('All reviews'); if (back) back.click(); return true; })()`);
  await shot(c, `40-narrow-list-${mode}`);
  await evalIn(c, `__live.click(__live.q('[data-review="${id}"]'))`);
  await shot(c, `41-narrow-reader-${mode}`, 1400);
  await size(c, 1440);
}

main()
  .catch(async (e) => {
    console.log(`FAIL harness ${e.message}`); process.exitCode = 1;
    try { await shot(liveC, "zz-failed"); } catch { /* the window is gone */ }
  })
  .finally(async () => {
    try { await api?.call("daemon.stop", {}); } catch {}
    try { api?.close(); } catch {}
    electron?.kill("SIGTERM");
    await sleep(800);
    try { electron?.kill("SIGKILL"); } catch {}
    await stopDaemons(home);
    killPort(SERVER_PORT); killPort(CDP_PORT);
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
