/**
 * Live check for the assistant message's action bar
 * (run with: node apps/desktop/scripts/message-actions-live.mjs)
 *
 * Two of the bar's claims are claims about a real window, and jsdom can hold no opinion on either.
 * That the buttons are CLICKABLE is a claim about hit-testing: they sit 2px apart, they carry a
 * vertical-only overhang for exactly that reason, and only a real hit test at real coordinates can
 * say whether one button's pad steals the click of the next. That the bar costs the prose nothing
 * is a claim about layout, which jsdom reports as zero for every box on the page. The clipboard is
 * the third: jsdom's is a stub that records what it was handed.
 *
 * What this deliberately does NOT check is the bar staying away mid-stream. The fake adapter queues
 * a whole message's deltas in one burst — its delay is per script STEP, not per character — so
 * there is no streaming window here to observe, and a check that cannot fail is worse than none.
 * That gating is a logic claim, and message-actions.test.tsx owns it against a named mutant.
 *
 * Ports: env-overridable. Kills only the process it started, and writes only into a scratch dir with
 * ONE exception worth stating: clicking Copy puts the message on the real system clipboard, because
 * that is the thing being checked. It does not read the clipboard back — the value there before the
 * click belongs to whoever is at the machine, and a test has no business logging it.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9347), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8914);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-actions-live-"));
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
    await sleep(60);
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
  lastRow: () => [...document.querySelectorAll(".msg-assistant-row")].pop(),
  /** The bar's state and the geometry that explains it, in one read. */
  shot() {
    const row = window.__live.lastRow();
    if (!row) return null;
    const prose = row.querySelector(".md");
    const bar = row.querySelector(".msg-actions");
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }; };
    return {
      state: row.dataset.state,
      busy: row.getAttribute("aria-busy"),
      chars: (prose?.textContent ?? "").length,
      bar: bar ? r(bar) : null,
      prose: prose ? r(prose) : null,
      buttons: [...row.querySelectorAll(".msg-action")].map((b) => ({ label: b.getAttribute("aria-label"), ...r(b) })),
    };
  },
  /** Centre of a button, in viewport coordinates — what a real click needs. */
  centreOf(label) {
    const b = window.__live.lastRow()?.querySelector('.msg-action[aria-label="' + label + '"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  },
  copiedOn: (label) => !!window.__live.lastRow()?.querySelector('.msg-action[aria-label="' + label + '"][data-copied]'),
  pressed: (label) => window.__live.lastRow()?.querySelector('.msg-action[aria-label="' + label + '"]')?.getAttribute("aria-pressed"),
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** A real mouse press at real coordinates — the only thing that exercises hit-testing. */
async function clickAt(c, { x, y }) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await c.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

const check = (name, cond, detail) => {
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
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 820, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  const api = rpc(SERVER_PORT);
  await api.ready;
  const sessions = await until(async () => {
    const all = await api.call("sessions.listAll", {});
    return all.length ? all : null;
  }, 15000, "a session to drive");
  const sessionId = sessions[0].id;
  await api.call("sessions.setAgent", { id: sessionId, agentKind: "fake" });

  // Long enough to wrap several lines, so "the bar sits below the prose" is a measurement of a real
  // block rather than of a one-line message where every box would clear every other by accident.
  const LONG = `Explain the following at length. ${"This sentence exists to give the message some height on the page. ".repeat(6)}`;
  await api.call("sessions.send", { id: sessionId, text: LONG, attachments: [], mentions: [] });

  // ── 1. Settled: the bar arrives, below the prose, without moving it ──
  const done = await until(async () => {
    const s = await evalIn(c, `__live.shot()`);
    return s && s.state === "complete" && s.bar ? s : null;
  }, 30000, "the finished message and its bar");
  check("once complete the container drops aria-busy and the bar is there",
    done.state === "complete" && done.busy === "false" && done.bar.h > 0, { state: done.state, busy: done.busy, bar: done.bar });
  check("the bar sits below the prose, overlapping none of it", done.bar.y >= done.prose.bottom - 1,
    { proseBottom: done.prose.bottom, barY: done.bar.y });
  // The -6px optical inset must pull the glyph left WITHOUT widening the column the prose is in.
  check("the bar is optically aligned with the prose, not indented past it",
    Math.abs(done.buttons[0].x - done.prose.x) <= 8, { proseX: done.prose.x, firstButtonX: done.buttons[0].x });
  check("all four controls are drawn, each with a real box",
    done.buttons.length === 4 && done.buttons.every((b) => b.w >= 20 && b.h >= 20),
    done.buttons.map((b) => `${b.label} ${b.w}x${b.h}`));

  // ── 2. Hit-testing: adjacent buttons must not steal each other's clicks ──
  // This is the check the vertical-only overhang exists for. A shared -6px inset would have each
  // button's pad covering its neighbour, and the click below would land on the wrong control.
  // The window may not hold OS focus under CDP, and the first click into an inactive window is spent
  // activating it rather than reaching what is under the pointer. Spend it somewhere harmless.
  // Spent on the message's own prose: a click there sets a caret and changes nothing, where one
  // aimed at the chrome would navigate and take the message under test off screen.
  await c.send("Page.bringToFront");
  await clickAt(c, { x: done.prose.x + 20, y: done.prose.y + 8 });
  await sleep(120);

  const copyAt = await evalIn(c, `__live.centreOf("Copy message")`);
  await clickAt(c, copyAt);
  await sleep(120);
  const copied = await evalIn(c, `({ copy: __live.copiedOn("Copy message"), up: __live.pressed("Good response"), down: __live.pressed("Bad response") })`);
  check("clicking Copy at its real centre hits Copy and nothing beside it",
    copied.copy === true && copied.up === "false" && copied.down === "false", copied);

  // The neighbour, to prove the first result was not luck.
  const downAt = await evalIn(c, `__live.centreOf("Bad response")`);
  await clickAt(c, downAt);
  await sleep(150);
  const rated = await evalIn(c, `({ up: __live.pressed("Good response"), down: __live.pressed("Bad response") })`);
  check("clicking the thumb next to it presses that one alone", rated.down === "true" && rated.up === "false",
    { rated, copyCentre: copyAt, downCentre: downAt });

  // ── 3. The verdict is on disk, in the session's own log ──
  const rows = await until(async () => {
    const evs = await api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 2000 });
    const fb = evs.filter((e) => e.event.type === "feedback").map((e) => e.event.payload);
    return fb.length ? fb : null;
  }, 10000, "the feedback event on disk");
  check("the verdict is written to session_events, where a relaunch will find it",
    rows.at(-1).rating === "down", rows);

  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(os.tmpdir(), "realm-message-actions.png");
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
