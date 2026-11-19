/**
 * Live check for what a queued message runs on (run with: node apps/desktop/scripts/queued-runs-on-live.mjs).
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent standing in for Claude, so the
 * picker names real models and nothing is billed. A long turn runs on Opus 5.5 · Medium. The picker
 * moves to Sonnet and a message is queued, which names Sonnet: what the picker says, but not what is
 * running. Three more queue behind it with the picker moved between them — another level, another
 * model and level, and one on what the turn runs on, which says nothing — and the picker ends where the
 * turn is. Then the first is sent early (the session goes to Sonnet), stopped (the picker comes back
 * to Opus), and the rest drain on their own, leaving the picker on Opus.
 *
 * Each state is photographed into LIVE_SHOT_DIR, the main ones dark and light, plain and Glass, at a
 * normal window and a narrow one: "before" with the new line hidden (the row as it was drawn until
 * now) and "after" as it is.
 *
 * Ports: LIVE_CDP_PORT / LIVE_SERVER_PORT, defaulting to a pair a running Realm does not use. Touches
 * only its scratch dir; reaps what it started by port.
 */
import { execSync } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { spawnLiveElectron } from "./lib/live-app.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9274), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8834);
const shots = process.env.LIVE_SHOT_DIR ?? path.join(os.tmpdir(), "realm-queued-runs-on");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-queued-runs-on-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portFree = (port) => new Promise((resolve) => {
  const s = connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});

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
  const events = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") events.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  });
  return { ws, ready, events, pending, next: () => ++id };
}

function cdp(url) {
  const s = socket(url);
  return {
    ready: s.ready, events: s.events,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

const LONG_TURN = "Start the long refactor";
const MESSAGES = [
  "Check where the sidebar reads the space's icon from and make it use the new one everywhere.",
  "Also run the queue tests again once that lands.",
  "Then update the changelog with both fixes, in the voice the last three entries use.",
  "And open a draft PR when it is all green.",
];
/** What the long turn goes out on, and what the picker is set to as each message is queued; the
 *  last is the turn's own, so the picker ends where the turn is. */
const TURN_ON = { model: "claude-opus-5-5", effort: "medium" };
const QUEUED_ON = [
  { model: "claude-sonnet-5-5", effort: "medium" },
  { model: "claude-opus-5-5", effort: "high" },
  { model: "claude-sonnet-5-5", effort: "xhigh" },
  TURN_ON,
];

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);

  const words = Array.from({ length: 400 }, (_, i) => `step${i}`).join(" ");
  const script = path.join(scratch, "fake-script.json");
  fs.writeFileSync(script, JSON.stringify([
    { on: LONG_TURN, emit: [{ kind: "text", paceMs: 2000, text: `Working through the refactor. ${words}` }] },
    { on: "sidebar", emit: [{ kind: "text", paceMs: 2000, text: `Looking at the sidebar. ${words}` }] },
  ]));

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const home = path.join(scratch, "home");
  electron = spawnLiveElectron([wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_FAKE_STANDS_IN: "claude",
      REALM_FAKE_SCRIPT: script,
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
  // The window opens behind whoever is at the Mac; without focus Realm goes quiet.
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  const api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const session = await until(async () => (await api.call("sessions.listAll", {}))[0] ?? null, 15000, "a session");
  await api.call("sessions.setAgent", { id: session.id, agentKind: "claude" });
  await api.call("sessions.setOptions", { id: session.id, ...TURN_ON });
  await api.call("sessions.send", { id: session.id, text: LONG_TURN });
  await until(() => evalIn(c, `!!document.querySelector('.composer-send[data-state="stop"]')`), 15000, "the long turn running");

  const viewports = { normal: { width: 1280, height: 820 }, narrow: { width: 700, height: 820 }, narrowest: { width: 560, height: 820 } };
  const setLook = async (look) => {
    await api.call("settings.set", { key: "ui.look", value: look });
    try {
      await until(() => evalIn(c, `(document.querySelector('.composer')?.dataset.look ?? 'plain') === ${JSON.stringify(look)} || null`), 3000, `look ${look}`);
    } catch {
      await c.send("Page.reload", {});
      // Four waiting fold to one line again on a fresh page, so the wait is for the head, then it opens.
      await until(() => evalIn(c, `(document.querySelector('.composer')?.dataset.look ?? 'plain') === ${JSON.stringify(look)} && !!document.querySelector('.queue-head') || null`), 20000, `look ${look} after reload`);
      if (await evalIn(c, `!!document.querySelector('.queue-fold[aria-expanded="false"]')`)) await evalIn(c, `(() => { document.querySelector('.queue-fold').click(); return true; })()`);
      await sleep(400);
    }
  };
  /** `hidden` draws the row as it was until now: the same build, with the new line taken out. */
  const hideRunsOn = (hidden) => evalIn(c, `(() => { document.getElementById('before')?.remove(); if (${hidden}) {
    const s = document.createElement('style'); s.id = 'before'; s.textContent = '.queue-runs { display: none !important; }'; document.head.append(s); } return true; })()`);
  const shoot = async (state, { looks = ["plain", "glass"], sizes = ["normal", "narrow"], hidden = false } = {}) => {
    for (const look of looks) {
      await setLook(look);
      await hideRunsOn(hidden);
      for (const vp of sizes) {
        await c.send("Emulation.setDeviceMetricsOverride", { ...viewports[vp], deviceScaleFactor: 2, mobile: false });
        await sleep(350);
        for (const mode of ["dark", "light"]) {
          await evalIn(c, `document.documentElement.dataset.mode = ${JSON.stringify(mode)}; true`);
          await sleep(350);
          const box = await evalIn(c, `(() => {
            const pane = document.querySelector('.session-pane').getBoundingClientRect();
            const card = document.querySelector('.composer').getBoundingClientRect();
            // Cut at the card's foot: the row under it names the Mac, which carries its owner's name.
            const top = Math.max(pane.top, card.top - 40);
            return { x: Math.round(pane.left), y: Math.round(top), width: Math.round(pane.width), height: Math.round(Math.min(pane.bottom, card.bottom + 2) - top), pane: Math.round(pane.width) }; })()`);
          const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } });
          const file = path.join(shots, `${state}-${look}-${vp}-${mode}.png`);
          fs.writeFileSync(file, Buffer.from(data, "base64"));
          console.log(`SHOT ${file} (pane ${box.pane}px)`);
        }
      }
    }
    await c.send("Emulation.setDeviceMetricsOverride", { ...viewports.normal, deviceScaleFactor: 2, mobile: false });
    await evalIn(c, `document.documentElement.dataset.mode = 'dark'; true`);
    await setLook("plain");
    await hideRunsOn(false);
    await sleep(250);
  };
  const rowCount = async () => Number((await evalIn(c, `document.querySelector('.composer-queue')?.dataset.count ?? "0"`)));
  const runsOn = () => evalIn(c, `[...document.querySelectorAll('.composer-queue-item:not([data-leaving])')].map((r) => r.querySelector('.queue-runs')?.textContent ?? null)`);
  /** Where each row's Send now and text sit, and whether its label is cut. */
  const layout = () => evalIn(c, `[...document.querySelectorAll('.composer-queue-item:not([data-leaving])')].map((r) => {
    const send = r.querySelector('.queue-send').getBoundingClientRect(); const text = r.querySelector('.queue-text').getBoundingClientRect();
    const label = r.querySelector('.queue-runs');
    return { sendRight: Math.round(send.right), sendWidth: Math.round(send.width), textWidth: Math.round(text.width),
      labelCut: label ? label.firstElementChild.scrollWidth > label.firstElementChild.clientWidth : null }; })`);

  const chip = () => evalIn(c, `document.querySelector('.model-chip')?.textContent ?? ""`);
  /* The person moves the picker in this window, which takes the server's answer as its own; moved
     from here instead, the window is asked to read its sessions again (an unchanged title is enough
     for `items.changed`), and the chip is waited for before anything is read. */
  const [item] = (await api.call("items.list", { spaceId: session.spaceId })).filter((it) => it.refId === session.id);
  const LABELS = { "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5" };
  const pick = async (o) => {
    await api.call("sessions.setOptions", { id: session.id, ...o });
    await api.call("items.update", { id: item.id, title: item.title });
    const want = `${LABELS[o.model]}${o.effort.charAt(0).toUpperCase()}${o.effort.slice(1)}`.replace("Xhigh", "XHigh");
    await until(async () => (await chip()) === want || null, 8000, `the chip on ${want}`);
  };
  const queueOn = async (i) => {
    await pick(QUEUED_ON[i]);
    await api.call("sessions.send", { id: session.id, text: MESSAGES[i], delivery: "queue" });
    await until(async () => (await rowCount()) === i + 1 || null, 8000, `queued row ${i + 1}`);
  };

  // The owner's case: the turn runs on Opus, the picker moves to Sonnet, one message is queued.
  await queueOn(0);
  await sleep(400);
  check("a message queued after the picker moved mid-turn names the model it will run on", JSON.stringify(await runsOn()) === JSON.stringify(["Sonnet 5.5"]), await runsOn());
  check("the picker says Sonnet while the turn runs on Opus", (await chip()).includes("Sonnet 5.5"), await chip());
  await shoot("0-moved-before", { hidden: true, sizes: ["normal"] });
  await shoot("0-moved-after", { sizes: ["normal"] });

  for (const i of [1, 2, 3]) await queueOn(i);
  await evalIn(c, `(() => { document.querySelector('.queue-fold').click(); return true; })()`);
  await until(async () => (await runsOn()).length === 4 || null, 5000, "all four rows open");
  await sleep(400);

  const labels = await runsOn();
  check("each row names only what differs from Opus 5.5 · Medium, and the matching row nothing",
    JSON.stringify(labels) === JSON.stringify(["Sonnet 5.5", "High effort", "Sonnet 5.5 · XHigh", null]), labels);
  check("the picker says what the session is on now", (await chip()).includes("Opus 5.5") && (await chip()).includes("Medium"), await chip());

  const wide = await layout();
  check("Send now sits at the same place on every row, labelled or not", new Set(wide.map((r) => r.sendRight)).size === 1, wide);
  check("the text keeps the same width on every row", new Set(wide.map((r) => r.textWidth)).size === 1, wide);
  check("at a normal width no label is cut", wide.every((r) => r.labelCut !== true), wide);

  await shoot("1-before", { hidden: true });
  await shoot("2-after");

  await c.send("Emulation.setDeviceMetricsOverride", { ...viewports.narrow, deviceScaleFactor: 2, mobile: false });
  await sleep(400);
  const narrow = await layout();
  const pane = await evalIn(c, `Math.round(document.querySelector('.session-pane').getBoundingClientRect().width)`);
  check("narrow, Send now still sits at one place on every row", new Set(narrow.map((r) => r.sendRight)).size === 1, { pane, narrow });
  check("narrow, the text keeps one width on every row", new Set(narrow.map((r) => r.textWidth)).size === 1, narrow);
  // Narrower still, the label is what gives way: it ends in an ellipsis, and the words and the
  // actions keep their places.
  await c.send("Emulation.setDeviceMetricsOverride", { ...viewports.narrowest, deviceScaleFactor: 2, mobile: false });
  await sleep(400);
  const narrowest = await layout();
  check("narrowest, the label is cut before the words or Send now move", narrowest[2].labelCut === true
    && new Set(narrowest.map((r) => r.sendRight)).size === 1 && new Set(narrowest.map((r) => r.textWidth)).size === 1, narrowest);
  await shoot("2-after-cut", { looks: ["plain"], sizes: ["narrowest"] });

  // Editing the third row: the label stays while the field is open, and the save keeps it.
  await evalIn(c, `(() => { document.querySelectorAll('.composer-queue-item .queue-edit-btn')[2].click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.queue-edit')`), 5000, "the edit field");
  await evalIn(c, `(() => { const ta = document.querySelector('.queue-edit');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ta.value + ' Link the PR in it.');
    ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(300);
  check("the label stays on the row being edited", (await runsOn())[2] === "Sonnet 5.5 · XHigh", await runsOn());
  await shoot("3-editing", { looks: ["plain"], sizes: ["normal"] });
  await evalIn(c, `(() => { document.querySelector('.queue-edit').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!document.querySelector('.queue-edit')`), 5000, "the edit saved");
  const saved = (await api.call("sessions.queued", { id: session.id })).queued[2];
  check("the edit saved the text and kept the model and level", saved.text.endsWith("Link the PR in it.") && saved.model === "claude-sonnet-5-5" && saved.effort === "xhigh", saved);

  const options = async () => { const r = await api.call("sessions.get", { id: session.id }); return { model: r.model, effort: r.effort }; };

  // Send now on the first row: it goes out on Sonnet, and the rest are read against that turn.
  await evalIn(c, `(() => { document.querySelectorAll('.composer-queue-item .queue-send')[0].click(); return true; })()`);
  await until(async () => (await rowCount()) === 3 || null, 10000, "the first row sent");
  await until(async () => (await chip()).includes("Sonnet 5.5") || null, 10000, "the chip on Sonnet");
  check("the message sent early ran on what it was queued with", JSON.stringify(await options()) === JSON.stringify(QUEUED_ON[0]), await options());
  await sleep(500);
  check("the rows left are read against the turn now running", JSON.stringify(await runsOn()) === JSON.stringify(["Opus 5.5 · High", "XHigh effort", "Opus 5.5"]), await runsOn());
  await shoot("4-after-send-now", { sizes: ["normal"] });

  // Stopped, the turn is over: the picker goes back to what it said before that message moved it.
  await evalIn(c, `(() => { document.querySelector('.composer-send[data-state="stop"]').click(); return true; })()`);
  await until(async () => (await chip()).includes("Opus 5.5") || null, 10000, "the chip back on Opus");
  check("after the turn the picker is back on what was chosen last", JSON.stringify(await options()) === JSON.stringify(TURN_ON), await options());
  await sleep(500);
  check("with no turn running the rows are read against the picker alone", JSON.stringify(await runsOn()) === JSON.stringify(["High effort", "Sonnet 5.5 · XHigh", null]), await runsOn());
  await shoot("5-picker-back", { sizes: ["normal"] });

  // The rest go on their own, each on its own options, and the picker ends on Opus · Medium.
  await evalIn(c, `(() => { document.querySelectorAll('.composer-queue-item .queue-send')[0].click(); return true; })()`);
  await until(async () => (await rowCount()) === 0 || null, 20000, "the queue drained");
  await until(async () => (await api.call("sessions.get", { id: session.id })).status === "idle" || null, 20000, "the session idle");
  await sleep(500);
  check("once the queue has drained the picker is where it was left", JSON.stringify(await options()) === JSON.stringify(TURN_ON) && (await chip()).includes("Opus 5.5"), { options: await options(), chip: await chip() });
  await shoot("6-drained", { looks: ["plain"], sizes: ["normal"] });

  api.close();
  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  c.close();
}

/** The server is a second Electron holding REALM_PORT; reaped by port, and only the ports chosen here. */
function reap() {
  electron?.kill();
  for (const port of [SERVER_PORT, CDP_PORT]) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid)); } catch {} }
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(() => { reap(); setTimeout(() => process.exit(process.exitCode ?? 0), 300); });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { reap(); process.exit(1); });
