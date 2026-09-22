/**
 * Live check for the question card's three shapes (run with: node apps/desktop/scripts/question-card-live.mjs)
 *
 * `question-card.test.tsx` renders the component. It cannot answer whether an AskUserQuestion coming
 * off the permission channel still reaches this card rather than the ordinary Allow/Deny one — that
 * decision is `questionCardFor` in Transcript, one layer above every unit test here.
 *
 * So this sends the fake agent's `ask me` trigger and reads what the real transcript draws: one card
 * paged through options-with-free-text, options-without, and a masked free-text answer. Screenshots
 * are written beside the assertions because a masked field is a claim about pixels — `type=password`
 * in the DOM and a row of dots on screen are two different statements.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9353), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8919);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-question-live-"));
const shots = path.join(repoRoot, ".playwright-cli", "question-card");
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  fs.mkdirSync(shots, { recursive: true });

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
  const rendererTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(rendererTarget.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  // The trigger goes in over the session's own channel, so the permission arrives the way a real
  // agent's does and the renderer decides for itself what to draw — which is the layer under test.
  const api = rpc(SERVER_PORT);
  await api.ready;
  const sessions = await until(async () => {
    const all = await api.call("sessions.listAll", {});
    return all.length ? all : null;
  }, 15000, "a session to drive");
  const sessionId = sessions[0].id;
  await api.call("sessions.setAgent", { id: sessionId, agentKind: "fake" });
  await api.call("sessions.send", { id: sessionId, text: "ask me", attachments: [], mentions: [] });
  await until(() => evalIn(c, `!!document.querySelector('.question-card')`), 25000, "question card");

  check("an AskUserQuestion draws the question card, not the permission card",
    await evalIn(c, `!document.querySelector('.permission-card')`));

  const shot = async (name) => {
    const data = (await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data;
    const file = path.join(shots, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return { file: path.relative(repoRoot, file), bytes: fs.statSync(file).size };
  };
  /** Row labels as the card actually renders them, which is what `allowOther` is visible as. */
  const rows = () => evalIn(c, `[...document.querySelectorAll('.question-card .question-option')]
    .map(el => el.getAttribute('aria-label')).filter(Boolean)`);
  const header = () => evalIn(c, `document.querySelector('.question-card .question-header')?.textContent ?? ""`);
  const click = (label) => evalIn(c, `(() => {
    const el = [...document.querySelectorAll('.question-card .question-option')].find(e => e.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!el) throw new Error("no row " + ${JSON.stringify(label)});
    el.click(); return true; })()`);

  const page1 = await rows();
  check("page 1 offers the options and the free-text row", JSON.stringify(page1) === JSON.stringify(["Postgres", "SQLite", "Something else"]), { rows: page1, shot: await shot("1-options-with-free-text") });

  await click("Postgres");
  await until(async () => (await rows()).includes("us-east-1"), 8000, "page 2");
  const page2 = await rows();
  check("page 2 drops the free-text row when the asker does not offer it", JSON.stringify(page2) === JSON.stringify(["us-east-1", "eu-west-1"]), { rows: page2, shot: await shot("2-options-only") });

  await click("us-east-1");
  await until(async () => (await rows()).join() === "Something else", 8000, "page 3");
  const page3 = await rows();
  check("page 3 is free text alone when the question has no options", JSON.stringify(page3) === JSON.stringify(["Something else"]), { rows: page3, shot: await shot("3-free-text-only") });

  await click("Something else");
  await until(() => evalIn(c, `!!document.querySelector('.question-other-input')`), 8000, "free-text field");
  await evalIn(c, `(() => {
    const input = document.querySelector('.question-other-input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'tok_live_SHOULD_NOT_BE_LEGIBLE'); input.dispatchEvent(new Event('input', { bubbles: true }));
    return true; })()`);
  await sleep(250);
  const field = await evalIn(c, `(() => {
    const input = document.querySelector('.question-other-input');
    return { type: input.type, value: input.value };
  })()`);
  check("a secret answer is typed into a masked field", field.type === "password", field);
  // The value is still readable to the page — masking is about the screen, not the DOM. What must
  // not happen is the secret turning up as rendered text somewhere else in the transcript.
  check("and the secret is not printed anywhere in the transcript",
    await evalIn(c, `!document.querySelector('.transcript')?.textContent.includes('SHOULD_NOT_BE_LEGIBLE')`),
    { shot: await shot("4-secret-masked") });

  // The negative: a question with no option and no free text has no row to answer on, so it must
  // come back as an ordinary permission. A card that rendered anyway would be a dead end.
  await evalIn(c, `(() => { document.querySelector('.question-card .question-close, .question-card [aria-label="Close"]')?.click(); return true; })()`);
  await api.call("sessions.send", { id: sessionId, text: "unanswerable", attachments: [], mentions: [] });
  const fellBack = await until(async () => evalIn(c, `(() => {
    const cards = [...document.querySelectorAll('.permission-card')];
    return cards.some(el => el.textContent.includes('AskUserQuestion')) ? 'permission' : null;
  })()`), 25000, "the fallback permission card").catch(() => null);
  check("a question with no option and no free text falls back to the permission card", fellBack === "permission", { shot: await shot("5-unanswerable-falls-back") });

  console.log("screenshots:", path.relative(repoRoot, shots));
  api.close();
  c.close();
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
