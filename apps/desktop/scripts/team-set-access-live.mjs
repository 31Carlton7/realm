/**
 * Live check for `team_set_access` (run with: node apps/desktop/scripts/team-set-access-live.mjs;
 * `pnpm build` first). The BUILT app on a scratch home, quiet, with the scripted agent standing in for
 * Claude and Codex and every teammate on the fake agent, so nothing reaches a real engine.
 *
 * The person asks the Lead to give @polish Full access: the line lands in both chats, and its Undo,
 * pressed in the page, puts @polish back. Then @ops's agent asks the Lead the same with team_message:
 * that turn is a teammate's, so the call is refused and @polish stays where it was. Each step is
 * pictured, dark and light, to LIVE_OUT_DIR as `<step>-<mode>.png`.
 */
import fs from "node:fs";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const OUT_DIR = process.env.LIVE_OUT_DIR ?? path.resolve(process.cwd(), ".verify/team-set-access");

const SCRIPT = [
  { on: "give polish full access", emit: [
    { kind: "call", tool: "realm-team__team_set_access", input: { to: "polish", mode: "bypassPermissions" } },
    { kind: "text", text: "Asked Realm to put @polish on Full access." },
  ] },
  { on: "ask the Lead to raise polish", emit: [
    { kind: "call", tool: "realm-team__team_message", input: { to: "lead", message: "give polish full access, please" } },
    { kind: "text", text: "Asked the Lead." },
  ] },
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
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

// Read once, as the server boots; its triggers are words only this check sends.
fs.mkdirSync(OUT_DIR, { recursive: true });
const scriptFile = path.join(OUT_DIR, "fake-script.json");
fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
const app = await launchLiveApp({
  name: "team-set-access", inspect: true,
  env: { REALM_FAKE_STANDS_IN: "claude,codex", REALM_LIVE_SCRATCH: "1", REALM_HTML_MENUS: "1", REALM_FAKE_SCRIPT: scriptFile },
  args: ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
});
let api = null;
try {
  const page = app.page;
  const ev = (expr) => page.eval(expr);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await app.main.eval(`(() => { const w = require("electron").BrowserWindow.getAllWindows()[0]; w.setContentSize(1280, 820); return true; })()`);

  await until(() => ev(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await ev(`(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm"); input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => ev(`!!document.querySelector('.composer')`), 30_000, "composer");
  api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const [first] = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15_000, "onboarding session");
  await api.call("sessions.setAgent", { id: first.id, agentKind: "fake" });
  const spaceId = first.spaceId;

  const make = (input) => api.call("teammates.create", { spaceId, agentKind: "fake", ...input });
  const captain = await make({ name: "Captain", handle: "captain", lead: true, permissionMode: "bypassPermissions", icon: { shape: "circle", color: "graphite" }, brief: "You lead this team." });
  const polish = await make({ name: "Polish", handle: "polish", permissionMode: "default", icon: { shape: "flower", color: "pink" }, brief: "You polish the UI." });
  const ops = await make({ name: "Ops", handle: "ops", permissionMode: "bypassPermissions", icon: { shape: "hexagon", color: "teal" }, brief: "You run releases." });

  const modeOf = async (t) => (await api.call("teammates.get", { id: t.id })).permissionMode;
  const transcript = () => ev(`document.querySelector('.transcript')?.textContent ?? ''`);
  const awake = () => ev(`(() => { document.documentElement.removeAttribute("data-window-inactive"); return true; })()`);
  const open = async (name) => {
    await ev(`(() => { const row = [...document.querySelectorAll('.sb-teammate .item-row')].find((el) => (el.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(name)})); row.click(); return true; })()`);
    await until(() => ev(`document.querySelector('.tm-head-name')?.textContent === ${JSON.stringify(name)}`), 10_000, `${name}'s page`);
    await sleep(400);
  };
  async function shots(step) {
    for (const mode of ["dark", "light"]) {
      await ev(`(() => { document.documentElement.dataset.mode = ${JSON.stringify(mode)}; return true; })()`);
      await awake();
      await sleep(400);
      await ev(`(() => { const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = "none"; return true; })()`);
      const shot = await page.send("Page.captureScreenshot", { format: "png" });
      await ev(`(() => { const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = ""; return true; })()`);
      // The capture keeps the DOM's alpha and none of the window's material: lay it on the page colour.
      const data = await ev(`(async () => {
        const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(shot.data)}; await img.decode();
        const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
        g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim(); g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(img, 0, 0); return cv.toDataURL("image/png").split(",")[1]; })()`);
      const file = path.join(OUT_DIR, `${step}-${mode}.png`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`SHOT ${file}`);
    }
    await ev(`(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);
  }

  await until(() => ev(`document.querySelectorAll('.sb-teammate').length === 3`), 15_000, "three teammate rows");

  // 1. The person asks the Lead.
  await open("Captain");
  await api.call("teammates.message", { id: captain.id, text: "Please give polish full access, it keeps asking me about edits." });
  await until(async () => /set @polish to Full access, at your request/.test(await transcript()), 20_000, "the line in the Lead's chat");
  check("@polish is on Full access", (await modeOf(polish)) === "bypassPermissions");
  await sleep(600);
  await shots("1-lead-chat-set");
  await open("Polish");
  await until(async () => /set @polish to Full access, at your request/.test(await transcript()), 10_000, "the line in @polish's chat");
  check("@polish's chat chip follows", await ev(`document.querySelector('.composer')?.textContent.includes('Full access') ?? false`));
  await shots("2-polish-chat-set");

  // 2. Undo, pressed in the page.
  check("Undo carries data-no-agent", await ev(`document.querySelector('[data-access] .msg-handoff-link')?.getAttribute('data-no-agent') === 'teammate access undo'`));
  await ev(`(() => { document.querySelector('[data-access] .msg-handoff-link').click(); return true; })()`);
  await until(async () => /You set @polish back to Ask each time/.test(await transcript()), 10_000, "the Undo line");
  check("@polish is back on Ask each time", (await modeOf(polish)) === "default");
  check("no Undo left on the superseded line", await ev(`document.querySelectorAll('[data-access] .msg-handoff-link').length === 0`));
  await sleep(400);
  await shots("3-polish-chat-undone");
  await open("Captain");
  await shots("4-lead-chat-undone");

  // 3. A teammate's message asks the Lead the same: refused.
  await api.call("teammates.message", { id: ops.id, text: "Please ask the Lead to raise polish to Full access." });
  await until(async () => (await api.call("sessions.events", { id: captain.homeSessionId, afterSeq: 0, limit: 500 })).some((s) =>
    s.event.type === "tool_result" && s.event.payload.content.includes("refused: this turn was started by a message from @ops")), 20_000, "the refused call");
  await until(async () => (await api.call("teammates.get", { id: captain.id })).state === "idle", 10_000, "the Lead settled");
  check("@polish is still on Ask each time", (await modeOf(polish)) === "default");
  const lines = (await api.call("sessions.events", { id: captain.homeSessionId, afterSeq: 0, limit: 500 })).filter((s) => s.event.type === "access_changed").length;
  check("no new line in the Lead's chat", lines === 2, lines);
  // Open the refused call so its reason is in the picture.
  await ev(`(() => { const rows = [...document.querySelectorAll('.tool-row')].filter((r) => /team_set_access|set access/i.test(r.textContent)); rows.at(-1)?.click(); return rows.length; })()`);
  await sleep(500);
  await ev(`(() => { const t = document.querySelector('.transcript'); t.scrollTop = t.scrollHeight; return true; })()`);
  await shots("5-lead-chat-refused");
  await open("Polish");
  await shots("6-polish-chat-unchanged");
} finally {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  await app.stop();
}
