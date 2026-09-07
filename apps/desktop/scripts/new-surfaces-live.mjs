/**
 * Live check for the three surfaces this pass added (run with: node apps/desktop/scripts/new-surfaces-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME and measures what jsdom has no opinion about, because
 * every rect there is zero:
 *
 *   1. **Scheduled tasks.** A row is a block of prose next to a cluster of verbs. jsdom cannot tell
 *      whether the goal's text runs under the buttons, and that is exactly the failure a row like
 *      this has — so the assertion is that the two boxes do not overlap, at a wide pane and at a
 *      narrow one.
 *   2. **The activity calendar.** 53 columns at a 14px pitch do not fit a settings column, so the
 *      graph scrolls. The thing worth proving is that it scrolls rather than SQUASHING: a cell that
 *      compressed below its nominal size would turn the graph into a texture, and a stylesheet read
 *      cannot see it because the squashing would come from the flex parent, not from the rule.
 *   3. **The session summary popover.** It is portalled to `document.body` and placed by measurement,
 *      so whether it lands inside the window is a fact about layout and nothing else.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9351), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8917);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-new-surfaces-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const events = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      events.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });
  return {
    ready, events,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

/** A client for the server's own RPC socket. The fake agent has to be selected over the wire — a
 *  fresh session defaults to an engine this scratch home has no CLI for, and the summary needs an
 *  actual answer to summarise. Same helper `message-actions-live.mjs` uses, for the same reason. */
function rpc(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
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

const HELPERS = `
globalThis.__live = {
  box: (n) => { const b = n.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; },
  type(sel, value) {
    const el = document.querySelector(sel);
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  dest(label) {
    const row = [...document.querySelectorAll('.sb-destinations .dest-row')].find((b) => b.textContent.trim().startsWith(label));
    if (!row) throw new Error('no destination: ' + label);
    row.click();
    return true;
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

const shot = async (c, tag, clip) => {
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
  const out = path.join(os.tmpdir(), `realm-new-surfaces-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
};

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper], {
    env: {
      ...process.env,
      REALM_HOME: path.join(scratch, "home"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  /* ── 1. The session summary popover ─────────────────────────────────────── */
  // On the session the app booted into: that is the one the fake agent backs, and it is already on
  // screen. A session opened later defaults to an engine this scratch home has no CLI for and would
  // answer nothing at all — which is why this section runs before anything navigates away.
  //
  // A session with nothing to summarise draws no button, so the message has to give the summary
  // something. The fake agent echoes what it is sent, and a url in the ANSWER is an output by the
  // rule in session-summary.ts: the agent typed it and no tool fetched it.
  const api = rpc(SERVER_PORT);
  await api.ready;
  const sessions = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15000, "a session to drive");
  await api.call("sessions.setAgent", { id: sessions[0].id, agentKind: "fake" });
  const empty = await evalIn(c, `!!document.querySelector('.panel-actions [aria-label^="Summary of"]')`);
  check("a session with nothing to summarise draws no button at all", !empty, undefined);
  await api.call("sessions.send", { id: sessions[0].id, text: "shipped to https://app.test/live", attachments: [], mentions: [] });
  await until(() => evalIn(c, `!!document.querySelector('.panel-actions [aria-label^="Summary of"]')`), 25000, "summary button");
  await evalIn(c, `(() => { document.querySelector('.panel-actions [aria-label^="Summary of"]').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.session-summary')`), 10000, "summary panel");
  await sleep(300);

  const panel = await evalIn(c, `(() => {
    const p = document.querySelector('.session-summary');
    return { box: __live.box(p), win: { w: window.innerWidth, h: window.innerHeight },
             sections: [...p.querySelectorAll('.summary-head')].map((h) => h.textContent.trim()),
             rows: p.querySelectorAll('.summary-row').length };
  })()`);
  check("the summary panel lands wholly inside the window",
    panel.box.l >= 0 && panel.box.t >= 0 && panel.box.r <= panel.win.w && panel.box.b <= panel.win.h, panel);
  check("it shows only the sections that have something in them", panel.sections.length > 0 && panel.rows > 0, panel.sections);
  await shot(c, "summary", { x: panel.box.l - 24, y: panel.box.t - 24, width: panel.box.w + 48, height: panel.box.h + 48 });


  /* ── 2. Scheduled tasks ─────────────────────────────────────────────────── */
  await evalIn(c, `__live.dest("Scheduled tasks")`);
  await until(() => evalIn(c, `!!document.querySelector('.schedules-page')`), 15000, "schedules page");
  await sleep(300);

  check("the empty state says what the page is for rather than showing a bare list",
    await evalIn(c, `!!document.querySelector('.schedules-page .env-empty')`), undefined);

  // Make one, through the real form — the preview line is the thing worth seeing before saving.
  await evalIn(c, `(() => { document.querySelector('.sched-new').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.sched-form')`), 10000, "form");
  await evalIn(c, `(() => {
    __live.type('.sched-form input', 'Morning triage');
    __live.type('.sched-form textarea', 'Read the new issues, group them by area, and open a draft summary of what changed since yesterday.');
    return true; })()`);
  await sleep(200);
  const preview = await evalIn(c, `document.querySelector('.sched-preview').textContent.trim()`);
  check("the form previews the first run before it is saved", /^First run /.test(preview), { preview });

  await evalIn(c, `(() => { [...document.querySelectorAll('.sched-form button')].find((b) => /Create schedule/.test(b.textContent)).click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.sched-row')`), 15000, "row");
  await sleep(400);

  const rowAt = async (width) => {
    await c.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(350);
    return evalIn(c, `(() => {
      const row = document.querySelector('.sched-row');
      const goal = row.querySelector('.sched-goal'), acts = row.querySelector('.sched-actions');
      const meta = row.querySelector('.sched-meta');
      return { pane: __live.box(document.querySelector('.schedules-page')).w,
               row: __live.box(row), goal: __live.box(goal), acts: __live.box(acts), meta: __live.box(meta),
               next: (row.querySelector('.sched-next') || {}).textContent, cron: row.querySelector('.sched-cron').textContent };
    })()`);
  };
  const wide = await rowAt(1400), narrow = await rowAt(900);
  for (const [tag, r] of [["wide", wide], ["narrow", narrow]]) {
    check(`schedules (${tag}): the goal never runs under the action cluster`, r.goal.r <= r.acts.l, { pane: r.pane, goalR: r.goal.r, actsL: r.acts.l });
    check(`schedules (${tag}): every part of the row is inside the row`, r.goal.b <= r.row.b && r.meta.b <= r.row.b, { row: r.row, goal: r.goal, meta: r.meta });
  }
  check("the recurrence is read back in words, not left as five numbers", wide.cron === "Every day at 09:00", { cron: wide.cron });
  check("the row says when it will next run", /^Next /.test(wide.next ?? ""), { next: wide.next });
  await shot(c, "schedules", { x: 280, y: 0, width: 620, height: 420 });

  /* ── 3. The activity calendar ───────────────────────────────────────────── */
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
  await evalIn(c, `__live.dest("Settings")`);
  await until(() => evalIn(c, `!!document.querySelector('.page-rail .settings-tab')`), 15000, "settings");
  await evalIn(c, `(() => { [...document.querySelectorAll('.page-rail .settings-tab')].find((l) => l.textContent.trim() === 'Usage').querySelector('input').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.cal-grid')`), 20000, "calendar");
  await sleep(500);

  const cal = await evalIn(c, `(() => {
    const scroll = document.querySelector('.cal-scroll'), grid = document.querySelector('.cal-grid');
    const cells = [...grid.querySelectorAll('.cal-cell:not([data-empty])')];
    const rows = grid.querySelectorAll('tr').length;
    const cols = grid.querySelectorAll('tr:first-child td').length;
    const sizes = cells.map((n) => Math.round(n.getBoundingClientRect().width));
    return { scroll: __live.box(scroll), grid: __live.box(grid), rows, cols, cells: cells.length,
             minW: Math.min(...sizes), maxW: Math.max(...sizes),
             overflows: grid.getBoundingClientRect().width > scroll.clientWidth + 1,
             // Opened on THIS week, not on last September: the days a reader came for are the
             // recent ones, and the scrollbar that would take them there is deliberately not drawn.
             atEnd: scroll.scrollLeft >= scroll.scrollWidth - scroll.clientWidth - 2,
             legend: !!document.querySelector('.cal-legend'), months: document.querySelectorAll('.cal-month').length };
  })()`);
  check("the calendar is seven weekday rows of whole weeks", cal.rows === 7 && cal.cols >= 52, { rows: cal.rows, cols: cal.cols });
  check("a year of days is drawn", cal.cells >= 365, { cells: cal.cells });
  // The named failure: a cell squashed by the flex parent instead of the graph scrolling. A
  // stylesheet read cannot see it, because the rule still says 12px.
  check("cells keep their nominal size — the graph scrolls rather than squashing",
    cal.minW === 12 && cal.maxW === 12, { minW: cal.minW, maxW: cal.maxW, overflows: cal.overflows });
  check("the graph opens on this week, not on the far end of last year", cal.atEnd, { atEnd: cal.atEnd });
  check("the months are labelled once each, not once per week", cal.months >= 12 && cal.months <= 13, { months: cal.months });
  check("the intensity scale is spelled out beside the graph", cal.legend, undefined);
  await shot(c, "calendar", { x: cal.scroll.l - 20, y: cal.scroll.t - 60, width: 760, height: 220 });

  check("no renderer console errors", c.events.length === 0, c.events.slice(0, 5));
  api.close();
  c.close();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { electron?.kill("SIGKILL"); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 800);
  });
