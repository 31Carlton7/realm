/**
 * Live check for the prompter's stick-to-bottom (run with: node apps/desktop/scripts/prompter-pin-live.mjs)
 *
 * The claim is that SENDING pins the transcript to the bottom, and jsdom cannot hold an opinion about
 * it: with no layout, `scrollHeight` and `clientHeight` are both 0, `scrollHeight - scrollTop -
 * clientHeight < 80` is true of every element on the page, and every scroller looks pinned already.
 * A jsdom test can stage those numbers — and one does — but only a real window can say whether the
 * transcript overflows in the first place, whether the composer's send reaches the scroller, and
 * whether the pin is still in force when the `user_message` block gets back from the server.
 *
 * The scripted adapter is the lever. Messages pushed straight over RPC arrive in the transcript
 * WITHOUT going through the prompter, which is both how the scrollback gets built and how the
 * control case is staged: a block the reader did not send must still raise the pill, or "sending
 * scrolls" would be indistinguishable from "everything scrolls".
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9344), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8911);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-pin-live-"));
/** Transcript.tsx's NEAR_BOTTOM_PX — the slack "at the bottom" is allowed. */
const NEAR_BOTTOM_PX = 80;
const results = {};
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
window.__live = window.__live ?? {
  setInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value").set;
    set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  scroller: () => document.querySelector(".transcript"),
  // What the component itself computes, plus the two facts that explain it.
  where() {
    const el = window.__live.scroller();
    if (!el) return null;
    return {
      top: Math.round(el.scrollTop),
      slack: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      overflow: Math.round(el.scrollHeight - el.clientHeight),
      pill: !!document.querySelector(".new-msgs-pill"),
    };
  },
  // The reader dragging the bar: move it, and let the component's own onScroll observe the move.
  readerScrollsTo(v) {
    const el = window.__live.scroller();
    el.scrollTop = v;
    el.dispatchEvent(new Event("scroll", { bubbles: false }));
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  results[name] = { pass: !!cond, ...(detail !== undefined ? { detail } : {}) };
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
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
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
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
    __live.setInput(input, "Live");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  // Short window on purpose: the transcript has to actually overflow, and a handful of echoed
  // messages is a cheaper way to get there than fifty.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 620, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  // `fake` is deliberately not in SELECTABLE_AGENT_KINDS, so the switch goes over RPC rather than
  // through the model chip — the same route media-live.mjs takes, for the same reason.
  const api = rpc(SERVER_PORT);
  await api.ready;
  const sessions = await until(async () => {
    const all = await api.call("sessions.listAll", {});
    return all.length ? all : null;
  }, 15000, "a session to drive");
  const sessionId = sessions[0].id;
  await api.call("sessions.setAgent", { id: sessionId, agentKind: "fake" });

  // Scrollback, pushed straight at the server: these never touch the prompter, so nothing here can
  // be confused for the gesture under test.
  const filler = (n) => `Turn ${n}. ${"The transcript needs enough height to have a top and a bottom that differ. ".repeat(4)}`;
  for (let i = 1; i <= 6; i++) await api.call("sessions.send", { id: sessionId, text: filler(i), attachments: [], mentions: [] });

  const deep = await until(async () => {
    const w = await evalIn(c, `__live.where()`);
    return w && w.overflow > 400 ? w : null;
  }, 25000, "a transcript with somewhere to scroll");
  check("the transcript overflows, so 'the bottom' is a place you can be away from", deep.overflow > 400, deep);

  // ── The control. A reader who has scrolled up gets the pill, not a yank ──
  await evalIn(c, `__live.readerScrollsTo(0)`);
  await sleep(150);
  await api.call("sessions.send", { id: sessionId, text: filler(7), attachments: [], mentions: [] });
  const control = await until(async () => {
    const w = await evalIn(c, `__live.where()`);
    return w && w.pill ? w : null;
  }, 15000, "the new-messages pill");
  check("a block the reader did not send raises the pill and leaves them where they were",
    control.pill && control.top === 0, control);

  // ── The gesture. Same reader, same place, but this time they send ──
  await until(() => evalIn(c, `!!document.querySelector('.composer-send[data-state="send"]')`), 20000, "an idle prompter");
  await evalIn(c, `__live.readerScrollsTo(0)`);
  await sleep(150);
  const before = await evalIn(c, `__live.where()`);
  check("the reader is genuinely at the top before sending", before.top === 0 && before.slack > NEAR_BOTTOM_PX, before);

  await evalIn(c, `(() => {
    __live.setInput(document.querySelector(".composer-input"), "and what about the send path");
    return true; })()`);
  await sleep(120);
  await evalIn(c, `(() => { document.querySelector('.composer-send').click(); return true; })()`);

  // Measured BEFORE the round trip lands: the pin is the gesture's, not the arriving block's.
  await sleep(120);
  const onSend = await evalIn(c, `__live.where()`);
  check("the send scrolls to the bottom immediately, before the server has answered",
    onSend.slack <= NEAR_BOTTOM_PX && !onSend.pill, onSend);

  // …and is still in force when the user's own message actually arrives, seconds later. The pill
  // here would mean the reader was notified about the message they had just typed.
  const landed = await until(async () => {
    const seen = await evalIn(c, `(() => {
      const last = [...document.querySelectorAll('.msg-user')].pop();
      return last && last.textContent.includes("and what about the send path") ? __live.where() : null;
    })()`);
    return seen;
  }, 20000, "the sent message in the transcript");
  check("the pin survives the round trip: the user's own message lands at the bottom, no pill",
    landed.slack <= NEAR_BOTTOM_PX && !landed.pill, landed);

  // The echo is a THIRD arrival, after the pin was set and after the block landed — still bottom.
  await sleep(1200);
  const echoed = await evalIn(c, `__live.where()`);
  check("the reply that follows keeps the reader at the bottom", echoed.slack <= NEAR_BOTTOM_PX && !echoed.pill, echoed);

  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(os.tmpdir(), "realm-prompter-pin.png");
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`SCREENSHOT ${out}`);

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
