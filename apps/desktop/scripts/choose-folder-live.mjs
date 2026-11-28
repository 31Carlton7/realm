/**
 * Live check: an agent asks the person to choose a folder, and is told only what they chose.
 *
 *   pnpm build && LIVE_OUT=<dir> node apps/desktop/scripts/choose-folder-live.mjs
 *
 * Boots the built app quietly on a scratch home with the scripted agent. The agent calls
 * `ui_choose_folder`; the card is captured in light and dark. Main's folder panel is stood in for
 * (`dialog.showOpenDialog`, through main's inspector) so nothing native opens: the first Choose… is
 * cancelled and the card stays up, the second picks a scratch folder, and the agent's result says that
 * folder and nothing else. The answered card is captured in light and dark. The turn is a
 * `sessions.send`, which is a turn the person started.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const OUT = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-choose-folder-live");
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

const PROMPT = "Which folder should this space work in?";
const SCRIPT = [{ on: "choose a folder", emit: [{ kind: "call", tool: "realm-ui__ui_choose_folder",
  input: { prompt: PROMPT, message: "I'll link it as this space's project." } }] }];
const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "realm-choose-folder-"));
const scriptFile = path.join(scriptDir, "fake-script.json");
fs.writeFileSync(scriptFile, js(SCRIPT));
const chosen = path.join(scriptDir, "Projects", "realm-site");
fs.mkdirSync(chosen, { recursive: true });

const app = await launchLiveApp({ name: "choose-folder", inspect: true, env: { REALM_FAKE_SCRIPT: scriptFile } });
const page = app.page;
const ev = (expr) => page.eval(expr);
let api = null;
const pages = {};
async function shoot(name) {
  for (const theme of ["light", "dark"]) {
    await api.call("settings.set", { key: "ui.theme", value: theme });
    await sleep(2500);
    const file = path.join(OUT, `${name}-${theme}.png`);
    await app.screenshot(file);
    pages[path.basename(file)] = await ev(`getComputedStyle(document.documentElement).getPropertyValue("--page").trim()`);
    console.log(`SCREENSHOT ${file}`);
  }
}
try {
  // The folder panel, stood in for: each open is counted, and answers the next of `answers` (null cancels).
  await app.main.eval(`(() => { const { dialog } = require("electron"); globalThis.__panel = { opened: 0, answers: [null, ${js(chosen)}] };
    dialog.showOpenDialog = async () => { globalThis.__panel.opened++; const next = globalThis.__panel.answers.shift();
      return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] }; };
    return true; })()`);
  const opened = () => app.main.eval(`globalThis.__panel.opened`);

  await until(() => ev(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await ev(`(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm"); input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => ev(`!!document.querySelector('.composer')`), 30_000, "composer");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const [first] = await until(async () => { const all = await api.call("sessions.listAllFull", {}); return all.length ? all : null; }, 15_000, "onboarding session");
  await api.call("sessions.setAgent", { id: first.id, agentKind: "fake" });
  await api.call("sessions.setOptions", { id: first.id, permissionMode: "bypassPermissions" });
  const events = async () => (await api.call("sessions.events", { id: first.id, afterSeq: 0, limit: 5000 })).map((e) => e.event);

  await api.call("sessions.send", { id: first.id, text: "choose a folder" });
  const req = await until(async () => (await events()).find((e) => e.type === "permission_request") ?? null, 30_000, "the folder card");
  log("1-card", req.payload);
  check("the card asks one folder question, in the agent's words, even on Full access",
    req.payload.toolName === "ui_choose_folder" && req.payload.ask?.questions?.length === 1 && req.payload.ask.questions[0].kind === "folder" && req.payload.ask.questions[0].prompt === PROMPT,
    req.payload.ask);
  await until(() => ev(`!!document.querySelector('.question-card')`), 15_000, "the card on screen");
  check("the panel has not opened before the person presses Choose…", await opened() === 0);
  await shoot("choose-card");

  const choose = () => ev(`(() => { const b = [...document.querySelectorAll('.question-card button')].find((x) => /Choose/.test(x.textContent)); b.click(); return !!b; })()`);
  await choose();
  await until(async () => (await opened()) === 1 || null, 10_000, "the first panel");
  await sleep(800);
  const afterCancel = await events();
  check("cancelling the panel leaves the card up and tells the agent nothing",
    !afterCancel.some((e) => e.type === "tool_result") && await ev(`!!document.querySelector('.question-card')`));

  await choose();
  const result = await until(async () => (await events()).find((e) => e.type === "tool_result") ?? null, 15_000, "the agent's result");
  log("2-result", result.payload);
  const real = fs.realpathSync(chosen);
  check("the agent is told the folder the person chose, and nothing else", String(result.payload.content) === `The user chose ${real}` && !result.payload.isError, result.payload.content);
  check("the panel opened once per Choose…", await opened() === 2);
  await until(() => ev(`!!document.querySelector('.question-answered')`), 15_000, "the answered card");
  const answered = await ev(`document.querySelector('.question-answered').innerText`);
  log("3-answered", answered);
  // The card keeps the folder as the panel gave it; the agent was told it resolved (/var is /private/var).
  check("the transcript keeps the question with the folder chosen", answered.includes(PROMPT) && answered.includes(chosen), answered);
  await shoot("chosen");
  log("page-colours", pages);
} finally {
  api?.close();
  await app.stop();
  fs.rmSync(scriptDir, { recursive: true, force: true });
}
