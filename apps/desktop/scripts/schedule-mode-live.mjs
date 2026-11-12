/**
 * Live check: a task an agent schedules runs no higher than the session that made it (SEC-08).
 *
 *   pnpm build && node apps/desktop/scripts/schedule-mode-live.mjs
 *
 * Boots the built app quietly on a scratch home with the scripted agent. For an Ask-each-time
 * session and a Full-access one, the agent's `schedule_create` makes a task, the task is fired with
 * Run now, and the run's session is read over RPC and opened on the Scheduled page, where its
 * permission chip is captured. Every poll writes what RPC said to LIVE_OUT, since the scratch home
 * is gone when the app stops.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const OUT = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-schedule-mode-live");
fs.mkdirSync(OUT, { recursive: true });
const log = (name, value) => fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(value, null, 2));

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
  });
  return {
    ready: new Promise((res) => ws.addEventListener("open", res)),
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

const app = await launchLiveApp({ name: "schedule-mode", env: { REALM_HTML_MENUS: "1" } });
const page = app.page;
try {
  // Onboarding makes the space. Its first session runs a real engine, so nothing is typed there.
  await until(() => page.eval(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await page.eval(`(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => page.eval(`!!document.querySelector('.composer')`), 30_000, "composer");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  const api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const space = (await api.call("spaces.list", {}))[0];

  for (const [mode, label] of [["default", "Ask each time"], ["bypassPermissions", "Full access"]]) {
    const tag = mode === "default" ? "ask" : "full";
    const before = new Set((await api.call("schedules.list", { spaceId: space.id })).map((s) => s.id));
    const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", permissionMode: mode, title: `Planning (${label})` });
    await api.call("sessions.send", { id: session.id, text: "Please schedule the weekly review for Fridays." });
    const task = await until(async () => {
      const all = await api.call("schedules.list", { spaceId: space.id });
      const asking = await api.call("sessions.get", { id: session.id });
      log(`${tag}-1-schedules`, { askingSession: asking, schedules: all });
      return all.find((s) => !before.has(s.id)) ?? null;
    }, 30_000, `the task the ${label} session's agent made`);
    check(`the ${label} session's task holds ${mode}`, task.permissionMode === mode, { id: task.id, permissionMode: task.permissionMode });

    const fired = await api.call("schedules.runNow", { id: task.id });
    const run = await until(async () => {
      const { runs } = await api.call("runs.list", { spaceId: space.id, scheduleId: task.id });
      const r = runs[0];
      const runSession = r?.sessionId ? await api.call("sessions.get", { id: r.sessionId }) : null;
      log(`${tag}-2-run`, { fired, runs, runSession });
      return r?.sessionId && runSession && ["succeeded", "failed"].includes(r.state) ? { run: r, runSession } : null;
    }, 60_000, `the ${label} task's run`);
    check(`the ${label} task's run is a session on ${mode}`, run.runSession.permissionMode === mode,
      { run: run.run.id, state: run.run.state, session: run.runSession.id, permissionMode: run.runSession.permissionMode });

    await page.eval(`(() => {
      const btn = [...document.querySelectorAll('.app-rail .rail-btn')].find((b) => b.getAttribute('aria-label') === 'Scheduled tasks');
      if (btn.getAttribute('aria-pressed') !== 'true') btn.click();
      return true; })()`);
    await until(() => page.eval(`!!document.querySelector('.sched-col')`), 15_000, "the Scheduled page");
    // One task in the column at a time: each pass deletes its own when it is done.
    const row = `[...document.querySelectorAll('.sched-task')].find((t) => t.querySelector('.sched-task-name')?.textContent === 'Weekly review')`;
    await until(() => page.eval(`!!${row}`), 15_000, "the task in the column");
    await page.eval(`(() => { ${row}.querySelector('.sched-task-hit').click(); return true; })()`);
    await until(() => page.eval(`${row}.querySelectorAll('.sched-run').length === 1`), 15_000, "the task's run listed");
    await page.eval(`(() => { ${row}.querySelector('.sched-run').click(); return true; })()`);
    const readChip = () => page.eval(`(() => {
      const c = document.querySelector('.sched-view .session-pane button[aria-label="Permission mode"]');
      if (!c) return null;
      const b = c.getBoundingClientRect();
      return { text: c.textContent, title: c.getAttribute('title'), x: b.left, y: b.top, width: b.width, height: b.height };
    })()`);
    await until(readChip, 20_000, "the run's permission chip");
    // Measured once the pane has settled: the composer lands at the bottom after the transcript.
    await sleep(600);
    const chip = await readChip();
    log(`${tag}-3-chip`, chip);
    check(`the run's chip reads ${label}`, (chip.title ?? "").endsWith(label), chip);
    await app.screenshot(path.join(OUT, `${tag}-run-view.png`));
    const pad = 120;
    await app.screenshot(path.join(OUT, `${tag}-run-chip.png`), { x: Math.max(0, chip.x - pad), y: Math.max(0, chip.y - 60), width: chip.width + pad * 2, height: chip.height + 120 });
    console.log(`SCREENSHOT ${path.join(OUT, `${tag}-run-chip.png`)}`);
    await api.call("schedules.delete", { id: task.id });
    await until(() => page.eval(`!${row}`), 15_000, "the task gone from the column");
  }
  api.close();
} finally {
  await app.stop();
}
