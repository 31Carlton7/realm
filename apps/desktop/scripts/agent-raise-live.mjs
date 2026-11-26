/**
 * Live check that an agent's request never pulls Realm in front of the app the person is in (run with:
 * node apps/desktop/scripts/agent-raise-live.mjs; `pnpm build` first). The BUILT app on a scratch home,
 * quiet, with the scripted agent standing in for a real engine.
 *
 * Two windows, each on a space of its own. The person's way to the second window (`focusSpace`, as a
 * click on its space in the rail asks) activates the app: quiet mode writes that `app.focus` down in
 * the log instead of doing it. Then an agent's `space_switch` to the same space: the window that shows
 * it may come up inside Realm, and the log gains no `app.focus`. `lsappinfo front` is sampled every
 * 100 ms throughout, and Realm's Electron is never the front app.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const run = promisify(execFile);
const js = (v) => JSON.stringify(v);
const SCRIPT = [
  { on: "switch space", emit: [{ kind: "call", tool: "realm-workspace__space_switch", input: {}, argsFromMessage: true }] },
];

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

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${js(detail)}` : ""}`);
};

/** The front app's pid every 100 ms until `stop`, with how many samples were taken. */
function sampleFront() {
  const pids = [];
  let on = true;
  const done = (async () => {
    while (on) {
      const { stdout: asn } = await run("lsappinfo", ["front"]);
      const { stdout } = await run("lsappinfo", ["info", "-only", "pid", asn.trim()]);
      pids.push(Number(/\bpid\s*=\s*(\d+)/.exec(stdout)?.[1] ?? -1));
      await sleep(100);
    }
  })();
  return { pids, stop: async () => { on = false; await done; } };
}

const scriptFile = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "realm-agent-raise-")), "fake-script.json");
fs.writeFileSync(scriptFile, js(SCRIPT));
const front = sampleFront();
const app = await launchLiveApp({ name: "agent-raise", inspect: true, env: { REALM_FAKE_SCRIPT: scriptFile } });
const focusLog = () => fs.readFileSync(path.join(app.scratch, "electron.log"), "utf8").split("\n").filter((l) => l.startsWith("[quiet-windows] app focus"));
let api = null;
try {
  const ev = (expr) => app.page.eval(expr);
  await until(() => ev(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await ev(`(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm"); input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => ev(`!!document.querySelector('.composer')`), 30_000, "composer");
  api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const [first] = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15_000, "onboarding session");
  await api.call("sessions.setAgent", { id: first.id, agentKind: "fake" });
  await api.call("sessions.setOptions", { id: first.id, permissionMode: "bypassPermissions" });
  const home = (await api.call("spaces.list", {})).find((s) => s.id === first.spaceId);
  const other = await api.call("spaces.create", { profileId: home.profileId, name: "Elsewhere", icon: "folder" });

  await ev(`window.realm.windows.openSpace(${js(other.id)}).then(() => true)`);
  await until(async () => (await app.targets()).filter((t) => t.type === "page" && t.url.startsWith("file://")).length >= 2 || null, 30_000, "the second window");
  await sleep(1500);
  const atStart = focusLog().length;

  // The person's request: the window on that space comes forward, and Realm with it.
  check("the person's way to another window's space answers that the window has it", await ev(`window.realm.windows.focusSpace(${js(other.id)})`) === true);
  await sleep(500);
  const byPerson = focusLog().slice(atStart);
  check("the person's request activates the app (control)", byPerson.some((l) => l.includes('"steal":true')), byPerson);

  // The agent's request for the same space, through the real tool, with the first window key again.
  const windowIds = `require("electron").BrowserWindow.getAllWindows().filter((w) => w.isResizable()).map((w) => w.id).sort((a, b) => a - b)`;
  const [firstWindow, secondWindow] = await app.main.eval(`(() => { const ids = ${windowIds}; require("electron").BrowserWindow.fromId(ids[0]).focus(); return ids; })()`);
  const keyWindow = () => app.main.eval(`require("electron").BrowserWindow.getFocusedWindow()?.id ?? null`);
  check("the first window is key before the agent asks", await keyWindow() === firstWindow);
  await api.call("settings.set", { key: "ui.activeSpaceId", value: home.id });
  const beforeAgent = focusLog().length;
  await api.call("sessions.send", { id: first.id, text: `switch space ${js({ spaceId: other.id })}` });
  const result = await until(async () => {
    const events = (await api.call("sessions.events", { id: first.id, afterSeq: 0, limit: 2000 })).map((e) => e.event);
    const call = events.find((e) => e.type === "tool_call" && e.payload.name.endsWith("space_switch"));
    return call && events.find((e) => e.type === "tool_result" && e.payload.toolUseId === call.payload.toolUseId);
  }, 30_000, "the space_switch result");
  console.log(`     space_switch answered: ${js(result.payload.content)}`);
  await sleep(500);
  const byAgent = focusLog().slice(beforeAgent);
  check("the agent's request never activates the app", byAgent.length === 0, byAgent);
  check("the window on that space came up inside Realm all the same", await keyWindow() === secondWindow, { key: await keyWindow(), secondWindow });
} finally {
  api?.close();
  await front.stop();
  const ours = front.pids.filter((p) => p === app.electron.pid).length;
  check("Realm's Electron was never the front app", ours === 0, { samples: front.pids.length, realmInFront: ours, frontPids: [...new Set(front.pids)] });
  await app.stop();
}
