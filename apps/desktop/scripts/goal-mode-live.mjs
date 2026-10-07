/**
 * Live check for goal mode and the mode commands (run with: node apps/desktop/scripts/goal-mode-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME, against the SCRIPTED agent — `REALM_ENABLE_FAKE_AGENT`,
 * which echoes and settles. That is the whole reason this can exist: the thing being proved is that
 * a settled turn starts the next one by itself, and proving it against a real engine would mean
 * paying a model to loop.
 *
 * What only a live run can show:
 *
 *   1. **The loop closes.** A goal's turn settles, the server notices, and another turn goes out —
 *      through the real adapter pump, the real queue drain and the real event rail. Every unit test
 *      of this calls `onSettled` by hand.
 *   2. **It stops when told.** Pause takes effect on the NEXT settle, not the next repaint.
 *   3. **The prompter says so.** The strip is on screen with the objective and the turn count, and
 *      the continuation in the log is attributed rather than looking like something the user typed.
 *   4. **`/plan` and `/ask` move the session**, through the picker the user actually types into.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9358), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8924);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-goal-live-"));
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
    await sleep(200);
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

/** The server's own RPC socket — the fake agent has to be selected over the wire, and the goal's
 *  state is read from the same place the pane reads it. */
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
window.__live = window.__live ?? {
  type(value, caret) {
    const el = document.querySelector('.composer-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.setSelectionRange(caret ?? value.length, caret ?? value.length);
    el.dispatchEvent(new Event("select", { bubbles: true }));
    return true;
  },
  commands() { return [...document.querySelectorAll(".slash-row .mention-row-id")].map((n) => n.textContent); },
  pick(id) {
    const row = [...document.querySelectorAll(".slash-row")].find((r) => r.querySelector(".mention-row-id")?.textContent === "/" + id);
    if (!row) return false;
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  },
  enter() {
    const el = document.querySelector('.composer-input');
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  },
  strip() {
    const el = document.querySelector(".composer-goal");
    if (!el) return null;
    return {
      status: el.dataset.status,
      label: el.querySelector(".composer-goal-label")?.textContent ?? null,
      facts: el.querySelector(".composer-goal-facts")?.textContent ?? null,
      objective: el.querySelector(".composer-goal-objective")?.textContent ?? null,
      note: el.querySelector(".composer-goal-note")?.textContent ?? null,
    };
  },
  mode() { return document.querySelector(".composer")?.dataset.mode ?? null; },
  continuations() { return [...document.querySelectorAll(".msg-user-from")].map((n) => n.textContent); },
  userMessages() { return [...document.querySelectorAll(".msg-user-row")].length; },
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
const save = (tag, b64) => {
  const out = path.join(os.tmpdir(), `realm-goal-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(b64, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
};

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

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
      LIVE_MAIN: mainEntry,
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
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  const api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const sessions = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15000, "a session to drive");
  const sid = sessions[0].id;
  // The scripted agent, or every turn below would be a billed call to a real engine.
  await api.call("sessions.setAgent", { id: sid, agentKind: "fake" });
  await sleep(300);

  // ── 1. The mode commands ────────────────────────────────────────────────
  await evalIn(c, `__live.type("/")`);
  await sleep(200);
  const commands = await evalIn(c, `__live.commands()`);
  check("the picker offers the mode commands and /goal", ["/build", "/plan", "/ask", "/goal"].every((id) => commands.includes(id)), commands);

  await evalIn(c, `__live.pick("plan")`);
  await until(async () => (await evalIn(c, `__live.mode()`)) === "plan", 8000, "plan mode");
  check("/plan puts the prompter in Plan", (await evalIn(c, `__live.mode()`)) === "plan");
  await evalIn(c, `__live.type("/a")`);
  await sleep(200);
  await evalIn(c, `__live.pick("ask")`);
  await until(async () => (await evalIn(c, `__live.mode()`)) === "ask", 8000, "ask mode");
  check("/ask puts it in Ask", (await evalIn(c, `__live.mode()`)) === "ask");
  // …and the session row agrees, which is what the agent is actually started with.
  check("the session itself moved, not just the card",
    (await api.call("sessions.get", { id: sid })).permissionMode === "ask");
  await evalIn(c, `__live.type("/b")`);
  await sleep(200);
  await evalIn(c, `__live.pick("build")`);
  await until(async () => (await evalIn(c, `__live.mode()`)) === "build", 8000, "build mode");
  check("/build takes it back", (await evalIn(c, `__live.mode()`)) === "build");

  // ── 2. /goal arms, and Enter starts it ──────────────────────────────────
  await evalIn(c, `__live.type("/go")`);
  await sleep(200);
  await evalIn(c, `__live.pick("goal")`);
  await sleep(300);
  const armed = await evalIn(c, `document.querySelector('.composer-input').value`);
  check("/goal arms the box rather than starting an empty goal", armed === "/goal ", { armed });
  check("…and nothing has been started yet", (await api.call("goals.get", { sessionId: sid })).goal === null);

  await evalIn(c, `__live.type("/goal keep saying hello until I stop you")`);
  await evalIn(c, `__live.enter()`);
  const goal = await until(async () => (await api.call("goals.get", { sessionId: sid })).goal, 15000, "a goal");
  check("Enter starts the goal on what followed the command", goal.objective === "keep saying hello until I stop you", goal.objective);

  // ── 3. The loop closes: a settled turn starts the next one ──────────────
  const running = await until(async () => {
    const g = (await api.call("goals.get", { sessionId: sid })).goal;
    return g && g.turns >= 3 ? g : null;
  }, 60_000, "three turns of the goal");
  check("the goal keeps taking turns on its own", running.turns >= 3, { turns: running.turns });
  const strip = await evalIn(c, `__live.strip()`);
  check("the prompter says what is being pursued", strip?.label === "Pursuing" && strip.objective === "keep saying hello until I stop you", strip);
  check("…and how far along it is", /turns/.test(strip?.facts ?? ""), strip?.facts);
  const attributions = await evalIn(c, `__live.continuations()`);
  check("every continuation in the log is attributed, so none reads as the user's words",
    attributions.length >= 2 && attributions.every((t) => t === "Realm continued this goal"), attributions.slice(0, 3));
  save("pursuing", (await c.send("Page.captureScreenshot", { format: "png" })).data);

  // ── 4. Pause stops the loop ─────────────────────────────────────────────
  await api.call("goals.set", { sessionId: sid, status: "paused", note: "That is enough." });
  const atPause = (await api.call("goals.get", { sessionId: sid })).goal.turns;
  await until(async () => (await evalIn(c, `__live.strip()`))?.label === "Paused", 8000, "the strip to say paused");
  // Long enough for any turn still in flight to settle and for a continuation to have gone out.
  await sleep(4000);
  const after = (await api.call("goals.get", { sessionId: sid })).goal;
  check("pausing stops the loop rather than the display", after.status === "paused" && after.turns <= atPause + 1,
    { atPause, after: after.turns });
  const paused = await evalIn(c, `__live.strip()`);
  check("the strip says why it stopped", paused?.note === "That is enough.", paused);
  save("paused", (await c.send("Page.captureScreenshot", { format: "png" })).data);

  // ── 5. Resume picks it back up ──────────────────────────────────────────
  const before = (await api.call("goals.get", { sessionId: sid })).goal.turns;
  await api.call("goals.resume", { sessionId: sid });
  const resumed = await until(async () => {
    const g = (await api.call("goals.get", { sessionId: sid })).goal;
    return g.turns > before ? g : null;
  }, 30_000, "a turn after the resume");
  check("resume starts a turn straight away, because nothing else would", resumed.turns > before, { before, after: resumed.turns });
  await api.call("goals.set", { sessionId: sid, status: "complete", note: "Done." });
  await until(async () => (await evalIn(c, `__live.strip()`))?.label === "Done", 8000, "the strip to say done");
  check("a completed goal reads as finished", (await evalIn(c, `__live.strip()`)).status === "complete");

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  api.close();
  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { electron?.kill("SIGKILL"); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 1200);
  });
