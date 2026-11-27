/**
 * Live check: an agent changes the schedules it made, and asks before touching the person's.
 *
 *   pnpm build && LIVE_OUT=<dir> node apps/desktop/scripts/schedule-tools-live.mjs
 *
 * Boots the built app quietly on a scratch home with the scripted agent, on Ask each time. The person
 * makes a task on their own path (`schedules.create`, Full access); the agent makes one with
 * `schedule_create`, lists both with `schedule_list`, pauses its own with no card, and then asks to
 * delete the person's: the card is captured in light and dark, approved, and the Scheduled page is
 * captured without it. Every turn is a `sessions.send`, which is a turn the person started.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const OUT = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-schedule-tools-live");
fs.mkdirSync(OUT, { recursive: true });
const js = (v) => JSON.stringify(v);
const log = (name, value) => fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(value, null, 2));

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${js(detail)}` : ""}`);
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

const call = (on, tool, input = {}) => ({ on, emit: [{ kind: "call", tool: `realm-schedule__${tool}`, input, argsFromMessage: true }] });
const SCRIPT = [
  call("make the reminder", "schedule_create", { title: "Check the badge PR", goal: "Open realm's PR list and say whether the new-badge removal PR has merged.", at: "2026-12-10T09:00" }),
  call("list the schedules", "schedule_list"),
  call("pause my reminder", "schedule_pause"),
  call("delete the invoice task", "schedule_delete"),
];

const scriptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "realm-schedule-tools-")), "fake-script.json");
fs.writeFileSync(scriptFile, js(SCRIPT));
const app = await launchLiveApp({ name: "schedule-tools", env: { REALM_FAKE_SCRIPT: scriptFile, REALM_HTML_MENUS: "1" } });
const page = app.page;
const ev = (expr) => page.eval(expr);
let api = null;
/** Each capture's `--page`, which a viewer needs under the pane's alpha: the PNGs keep it unflattened. */
const pages = {};
try {
  await until(() => ev(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await ev(`(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm"); input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => ev(`!!document.querySelector('.composer')`), 30_000, "composer");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const [first] = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15_000, "onboarding session");
  await api.call("sessions.setAgent", { id: first.id, agentKind: "fake" });
  await api.call("sessions.setOptions", { id: first.id, permissionMode: "default" });
  const spaceId = first.spaceId;

  // The person's own task, the way the Schedules page makes one.
  const invoice = await api.call("schedules.create", { spaceId, title: "Persona invoice", goal: "Send the November invoice.", cron: "0 9 30 11 *" });

  let seen = 0;
  /** Send one turn as the person, and wait for the tool's answer (or, with `card`, for the card). */
  async function turn(text, { card = false } = {}) {
    await api.call("sessions.send", { id: first.id, text });
    return until(async () => {
      const events = (await api.call("sessions.events", { id: first.id, afterSeq: 0, limit: 5000 })).map((e) => e.event);
      const fresh = events.slice(seen);
      if (card) {
        const req = fresh.find((e) => e.type === "permission_request");
        return req ?? null;
      }
      const result = fresh.find((e) => e.type === "tool_result");
      if (!result) return null;
      seen = events.length;
      return result;
    }, 30_000, text);
  }
  const said = (r) => String(r.payload.content);

  const made = await turn("make the reminder");
  log("1-create", made.payload);
  const mine = (await api.call("schedules.list", { spaceId })).find((s) => s.title === "Check the badge PR");
  check("schedule_create records this session as the task's maker", mine?.createdBySession === first.id, { createdBySession: mine?.createdBySession, session: first.id });

  const listed = said(await turn(`list the schedules ${js({ teammateClocks: true })}`));
  log("2-list", listed);
  console.log(listed.split("\n").map((l) => `     ${l}`).join("\n"));
  check("schedule_list shows each task's id and who made it",
    listed.includes(`[id ${mine.id}]`) && listed.includes(`[id ${invoice.id}]`) && listed.includes("made by this session") && listed.includes("made by the user"));

  const paused = await turn(`pause my reminder ${js({ id: mine.id })}`);
  log("3-pause", paused.payload);
  check("schedule_pause pauses its own task with no card", !paused.payload.isError && (await api.call("schedules.list", { spaceId })).find((s) => s.id === mine.id)?.enabled === false, said(paused));

  const req = await turn(`delete the invoice task ${js({ id: invoice.id })}`, { card: true });
  log("4-card", req.payload);
  check("schedule_delete of the person's task asks first, even off Full access, naming it",
    req.payload.toolName === "schedule_delete" && req.payload.title.startsWith('Delete the scheduled task "Persona invoice"'), req.payload.title);
  await until(() => ev(`!!document.querySelector('.permission-card')`), 15_000, "the card on screen");
  for (const theme of ["light", "dark"]) {
    await api.call("settings.set", { key: "ui.theme", value: theme });
    await sleep(2500);
    await app.screenshot(path.join(OUT, `delete-card-${theme}.png`));
    pages[`delete-card-${theme}.png`] = await ev(`getComputedStyle(document.documentElement).getPropertyValue("--page").trim()`);
    console.log(`SCREENSHOT ${path.join(OUT, `delete-card-${theme}.png`)}`);
  }
  check("the person's task is still there while the card waits", (await api.call("schedules.list", { spaceId })).some((s) => s.id === invoice.id));
  await api.call("sessions.respondPermission", { id: first.id, requestId: req.payload.requestId, decision: "allow" });
  const deleted = await until(async () => {
    const events = (await api.call("sessions.events", { id: first.id, afterSeq: 0, limit: 5000 })).map((e) => e.event);
    return events.slice(seen).find((e) => e.type === "tool_result") ?? null;
  }, 30_000, "the delete's answer");
  log("5-delete", deleted.payload);
  check("approved, the person's task is deleted", !deleted.payload.isError && !(await api.call("schedules.list", { spaceId })).some((s) => s.id === invoice.id), said(deleted));

  await ev(`(() => {
    const btn = [...document.querySelectorAll('.app-rail .rail-btn')].find((b) => b.getAttribute('aria-label') === 'Scheduled tasks');
    if (btn.getAttribute('aria-pressed') !== 'true') btn.click();
    return true; })()`);
  await until(() => ev(`!!document.querySelector('.sched-col')`), 15_000, "the Scheduled page");
  const names = () => ev(`[...document.querySelectorAll('.sched-task-name')].map((n) => n.textContent)`);
  await until(async () => (await names()).includes("Check the badge PR") || null, 15_000, "the agent's task in the column");
  const shown = await names();
  log("6-page", shown);
  check("the Scheduled page lists the paused reminder and not the deleted invoice", shown.includes("Check the badge PR") && !shown.includes("Persona invoice"), shown);
  for (const theme of ["light", "dark"]) {
    await api.call("settings.set", { key: "ui.theme", value: theme });
    await sleep(2500);
    await app.screenshot(path.join(OUT, `schedules-page-${theme}.png`));
    pages[`schedules-page-${theme}.png`] = await ev(`getComputedStyle(document.documentElement).getPropertyValue("--page").trim()`);
    console.log(`SCREENSHOT ${path.join(OUT, `schedules-page-${theme}.png`)}`);
  }
  log("page-colours", pages);
} finally {
  api?.close();
  await app.stop();
  fs.rmSync(path.dirname(scriptFile), { recursive: true, force: true });
}
