/**
 * Live check for the one-shot row on the Scheduled tasks page
 * (run with: node apps/desktop/scripts/schedules-once-live.mjs)
 *
 * What this is here to catch: picking "Once, at a time…" swaps the cron box for a native
 * `<input type="datetime-local">`, and a native date input is the one control whose width is the
 * platform's business rather than the stylesheet's. jsdom has no layout, so the unit tests can prove
 * the right element is mounted and nothing at all about whether it fits — and `.sched-when` is a flex
 * row holding a select that already wants to grow. An input that overflows its row, or drops to a
 * second line, is invisible to every test in the suite.
 *
 * So the measurements are boxes, not classes: the control stays inside the row it is in, it stays on
 * the same line as the select beside it, and the row does not get taller than the cron form it
 * replaces. The fired-one-shot row is checked for the thing the sentence exists for — after a
 * one-shot runs there is no next time, and the moment survives only in its own description.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9374), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8941);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-sched-once-"));
let electron = null, api = null;
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

const HELPERS = `
globalThis.__live = {
  dest(label) {
    const row = [...document.querySelectorAll('.sb-destinations .dest-row')].find((b) => b.textContent.trim().startsWith(label));
    if (!row) throw new Error('no destination: ' + label);
    row.click();
    return true;
  },
  /* React listens on its own value setter, so the native one has to be called first or the change
     event arrives with the old value and the form never re-renders. */
  set(sel, value) {
    const el = document.querySelector(sel);
    if (!el) throw new Error('no element: ' + sel);
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
  click(sel) {
    const el = [...document.querySelectorAll(sel)].find((x) => !x.disabled);
    if (!el) throw new Error('no clickable: ' + sel);
    el.click();
    return true;
  },
  /* The boxes the check is about. Everything is rounded, because a sub-pixel difference between a
     select and an input is the browser's business and not a layout bug. */
  whenRow() {
    const row = document.querySelector('.sched-when');
    const form = document.querySelector('.sched-form');
    const select = row.querySelector('select');
    const field = row.querySelector('.sched-once-input, .sched-cron-input');
    const r = row.getBoundingClientRect(), s = select.getBoundingClientRect(), f = field.getBoundingClientRect();
    return {
      kind: field.type === 'datetime-local' ? 'once' : 'cron',
      rowW: Math.round(r.width), rowH: Math.round(r.height), formH: Math.round(form.getBoundingClientRect().height),
      selectRight: Math.round(s.right), fieldLeft: Math.round(f.left), fieldRight: Math.round(f.right),
      rowRight: Math.round(r.right), rowLeft: Math.round(r.left),
      sameLine: Math.abs(Math.round(s.top) - Math.round(f.top)) <= 2,
      fieldW: Math.round(f.width), fieldH: Math.round(f.height), selectH: Math.round(s.height),
      preview: document.querySelector('.sched-preview').textContent.trim(),
      invalid: document.querySelector('.sched-preview').hasAttribute('data-invalid'),
      submitDisabled: document.querySelector('.sched-form-actions .btn.primary').disabled,
    };
  },
  formClip() {
    const f = document.querySelector('.sched-form').getBoundingClientRect();
    return { x: Math.round(f.left) - 8, y: Math.round(f.top) - 8, width: Math.round(f.width) + 16, height: Math.round(f.height) + 16 };
  },
  rowRead(title) {
    const el = [...document.querySelectorAll('.sched-row')].find((r) => r.querySelector('.sched-name').textContent.trim() === title);
    if (!el) throw new Error('no row: ' + title);
    const b = el.getBoundingClientRect();
    return {
      cron: el.querySelector('.sched-cron').textContent.trim(),
      next: el.querySelector('.sched-next').textContent.trim(),
      clip: { x: Math.round(b.left) - 6, y: Math.round(b.top) - 6, width: Math.round(b.width) + 12, height: Math.round(b.height) + 12 },
    };
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

async function shot(c, clip, tag) {
  const r = await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
  const out = path.join(os.tmpdir(), `realm-sched-once-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}

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

  await c.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 760, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  /* Seed through the real RPC rather than by poking a row in: `schedules.create` is what derives
     `next_run_at` from the expression, which is the column both rows below are read for. A one-shot
     far enough out that the moment is stable whenever this runs. */
  api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const space = (await api.call("spaces.list", {}))[0];
  const moment = new Date();
  moment.setFullYear(moment.getFullYear() + 1);
  moment.setMonth(8, 30); moment.setHours(13, 0, 0, 0);
  await api.call("schedules.create", { spaceId: space.id, title: "Drop the badge", enabled: true, constraints: null,
    goal: "Open a PR removing the new badge from the memory sidebar tab.", cron: `once:${moment.getTime()}` });
  await api.call("schedules.create", { spaceId: space.id, title: "Morning triage", enabled: true, constraints: null,
    goal: "Read the new issues and group them by area.", cron: "0 9 * * 1-5" });

  await evalIn(c, `__live.dest("Scheduled tasks")`);
  await until(() => evalIn(c, `document.querySelectorAll('.sched-row').length >= 2`), 20000, "seeded schedules");
  await sleep(400);

  /* The row a one-shot leaves behind. Its moment lives in the description, not in a next time — that
     is the whole reason `describeSchedule` gets a sentence for it. */
  const cronRow = await evalIn(c, `__live.rowRead("Morning triage")`);
  const once = await evalIn(c, `__live.rowRead("Drop the badge")`);
  check("a one-shot's row names its moment in words", /^Once, on /.test(once.cron), { cron: once.cron, next: once.next });
  /* The row lowercases its next time so it reads as a sentence after "Next". A blanket lowercase is
     invisible while every next run is "tomorrow" — true of every cron schedule — and a one-shot a
     fortnight out is the first row that ever reaches the dated branch. */
  check("a dated next time keeps its capital, where a relative one does not",
    /^Next [A-Z][a-z]{2} \d+ at \d+:\d\d (am|pm)$/.test(once.next) && /^Next tomorrow at /.test(cronRow.next),
    { once: once.next, cron: cronRow.next });
  await shot(c, once.clip, "row-once");
  check("a recurring row is untouched beside it", cronRow.cron === "Weekdays at 09:00", cronRow);
  await shot(c, cronRow.clip, "row-cron");

  // The form, in both modes. The cron form is the baseline: whatever Once does, it must not cost the
  // row its line or the form its shape.
  await evalIn(c, `__live.click('.sched-new')`);
  await until(() => evalIn(c, `!!document.querySelector('.sched-form')`), 10000, "form");
  await sleep(300);
  const cronMode = await evalIn(c, `__live.whenRow()`);
  check("baseline: the cron form's row holds a select and its expression on one line",
    cronMode.kind === "cron" && cronMode.sameLine && cronMode.fieldRight <= cronMode.rowRight, cronMode);
  await shot(c, await evalIn(c, `__live.formClip()`), "form-cron");

  await evalIn(c, `__live.set('.sched-when select', 'once')`);
  await until(() => evalIn(c, `!!document.querySelector('.sched-once-input')`), 10000, "once input");
  await sleep(300);
  const onceMode = await evalIn(c, `__live.whenRow()`);

  // THE CHECK. A native datetime input sizes itself to the platform's own date text, and nothing in
  // the stylesheet constrains that — so this is the only place it can be asked whether it fits.
  check("the date picker stays inside the row it is in",
    onceMode.fieldRight <= onceMode.rowRight && onceMode.fieldLeft >= onceMode.rowLeft, onceMode);
  check("it stays on the same line as the select, rather than wrapping under it",
    onceMode.sameLine && onceMode.fieldLeft >= onceMode.selectRight, onceMode);
  check("it is a real control's height, matching the select beside it",
    Math.abs(onceMode.fieldH - onceMode.selectH) <= 3 && onceMode.fieldH >= 18, onceMode);
  check("swapping the field does not resize the row or the form around it",
    onceMode.rowH === cronMode.rowH && Math.abs(onceMode.formH - cronMode.formH) <= 2, { once: onceMode.rowH, cron: cronMode.rowH, onceForm: onceMode.formH, cronForm: cronMode.formH });
  check("the preview reads as one run rather than a first one", /^Runs once, /.test(onceMode.preview), onceMode.preview);
  await shot(c, await evalIn(c, `__live.formClip()`), "form-once");

  // A moment behind you is refused in its own terms, and the button goes with it.
  await evalIn(c, `__live.set('.sched-once-input', '2020-01-02T09:00')`);
  await sleep(300);
  const past = await evalIn(c, `__live.whenRow()`);
  check("a moment already gone is refused as a date, not as a syntax error",
    past.invalid && /already passed/.test(past.preview) && past.submitDisabled, past);
  await shot(c, await evalIn(c, `__live.formClip()`), "form-once-past");

  c.close();
}

main()
  .catch((e) => { console.log(`FAIL harness ${e.message}`); process.exitCode = 1; })
  .finally(async () => {
    /* The daemon is the thing that actually has to be asked. It is spawned by the app and re-parented
       to init, so it OUTLIVES the Electron this script kills — and it keeps the server port, which
       makes the next run refuse to start with a message about a port rather than about a daemon. */
    try { await api?.call("daemon.stop", {}); } catch {}
    try { api?.close(); } catch {}
    electron?.kill("SIGTERM");
    // SIGKILL after the grace period, not instead of it: an Electron holding an open window does not
    // always take the polite signal, and a survivor keeps the CDP port and makes the NEXT run refuse
    // to start — which reads as a broken harness rather than as a process that outlived its check.
    setTimeout(() => {
      try { electron?.kill("SIGKILL"); } catch {}
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
      process.exit(process.exitCode ?? 0);
    }, 800);
  });
