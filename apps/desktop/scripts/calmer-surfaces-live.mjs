/**
 * Live check for the calmer surfaces (run with: pnpm build && node apps/desktop/scripts/calmer-surfaces-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, as a scratch window that cannot take focus, with the
 * scripted agent standing in for Claude and Codex, so the lead and every sub-agent run the script and
 * nothing reaches an account. The lead runs "Orchestrate the theme work" (four delegated children)
 * and then "Restart the stalled agents" (the harness's own background agents, for the row over the
 * prompter). Then, in the window:
 *
 *   1. Selection: chrome does not select on a drag or a double-click; a drag inside a message's prose
 *      selects its words and does not light the chrome beside it; the content regions still select.
 *   2. The prompter with a picture and a file on it, dark and light, painted and flat.
 *   3. The cards: the transcript's sub-agent lines, the Agents tab's cards, a settings group.
 *   4. "What it reported": the pinned report's height in the viewer, for a one-line report and for a
 *      long one, against the viewer it sits in.
 *
 * Screenshots go to LIVE_OUT_DIR, named `<LIVE_TAG>-<what>-<face>.png`, so a run before a change and
 * one after it sit side by side. Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT. Kills only what listens on
 * its own ports, and only a process started from this checkout.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9241);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8801);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
const TAG = process.env.LIVE_TAG ?? "run";
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-calmer-surfaces-live-"));
const home = path.join(scratch, "home");
const TITLE = "Theme work";
const VIEWPORT = { width: 1440, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

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

/** Kill what listens on `port`, but only a process this checkout started. */
function killPort(port) {
  let pids = [];
  try {
    pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch { return; }
  for (const pid of pids) {
    let command = "";
    try { command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }); } catch { continue; }
    if (!command.includes(repoRoot)) { note("left alone", { port, pid, command: command.slice(0, 120) }); continue; }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

/** Helpers that live in the page, so each check reads as what it measures. */
const HELPERS = `globalThis.__live = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; },
  /* What a drag on the element does: user-select's USED value, the first one up the tree that is not auto. */
  selects(el) { for (let n = el; n; n = n.parentElement) { const v = getComputedStyle(n).userSelect; if (v && v !== "auto") return v; } return "text"; },
  /* Bring an element to the middle of its scroller, so a press aimed at it lands on it. */
  centre(el) { el.scrollIntoView({ block: "center" }); return el; },
  /* True when the topmost element at a point is el or inside it — a press there reaches it. */
  reaches(el, p) { const top = document.elementFromPoint(p.x, p.y); return !!top && (top === el || el.contains(top)); },
  /* The viewport point of a character in the first text node under el that holds 'word'. */
  pointOf(el, word, end) {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      const at = t.data.indexOf(word);
      if (at < 0) continue;
      const r = document.createRange(); const i = end ? at + word.length - 1 : at;
      r.setStart(t, i); r.setEnd(t, i + 1);
      const b = r.getBoundingClientRect();
      return { x: end ? b.right - 1 : b.left + 1, y: b.top + b.height / 2 };
    }
    return null;
  },
  files(specs) {
    const dt = new DataTransfer();
    for (const s of specs) dt.items.add(new File([Uint8Array.from(atob(s.b64), (ch) => ch.charCodeAt(0))], s.name, { type: s.mime }));
    return dt;
  },
  drop(sel, specs) {
    const dt = this.files(specs), el = document.querySelector(sel);
    for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  },
  async openSettings() {
    if (document.querySelector(".settings-page-pane")) return true;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector(".palette input"); i++) await new Promise((r) => setTimeout(r, 25));
    const input = document.querySelector(".palette input");
    if (input) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "settings"); input.dispatchEvent(new Event("input", { bubbles: true })); }
    for (let i = 0; i < 40; i++) {
      const hit = [...document.querySelectorAll(".palette-list [role=option], .palette-list button")].find((b) => /open settings/i.test(b.textContent));
      if (hit) { hit.click(); break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    for (let i = 0; i < 80 && !document.querySelector(".settings-page-pane"); i++) await new Promise((r) => setTimeout(r, 25));
    return !!document.querySelector(".settings-page-pane");
  },
}; true`;

/** A report long enough to need the room, sent to a child so its last words — what the viewer pins —
 *  are this. The fake agent answers an unscripted message by echoing it. */
const LONG_REPORT = [
  "Eleven surfaces read the theme, and three of them bypass the hook.",
  "",
  "The three that bypass it read `--rl-panel` straight off the root at mount, so a switch reaches them only after a reload:",
  "",
  "- the browser pane's new-tab page, which paints its own ground before the view loads",
  "- the simulator frame's bezel, which is drawn once into a canvas",
  "- the quick chat window, which is a second renderer and never subscribes",
  "",
  "Each one is a two-line change to call `useTheme()` instead. I have not made it: the quick chat needs the theme sent over its bridge first, and that is a decision about the bridge rather than the hook.",
  "",
  "The other eight already go through the hook and switch in place. The session pane, the documents pane, the settings page, the sidebar, the composer, the terminal, the code review page and the media viewer all re-render on the first frame after the switch.",
].join("\n");

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "1", REALM_HTML_MENUS: "1",
      // Claude and Codex are the scripted agent: the lead, every child, and onboarding's session.
      REALM_FAKE_STANDS_IN: "claude,codex",
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const awake = () => evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
    new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`);
  await awake();

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await awake();
  await evalIn(c, HELPERS);
  note("squircle", await evalIn(c, `document.documentElement.hasAttribute('data-squircle')`));

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  await api.call("agents.probe", { force: false });
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "claude", model: "claude-opus-5-5", title: TITLE, permissionMode: "default" });
  const lead = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(500);

  // ── The fan-out, answered in the viewer ───────────────────────────────────────────────────────
  await api.call("sessions.send", { id: lead, text: "Orchestrate the theme work.", attachments: [], mentions: [] });
  const kids = await until(async () => { const k = (await api.call("delegation.children", { sessionId: lead })).children; return k.length === 4 ? k : null; }, 30_000, "four children");
  const childOf = (prefix) => kids.find((k) => k.goal?.startsWith(prefix)).session.id;
  const tests = childOf("Run the settings"), survey = childOf("Survey every theme hook");
  await until(async () => (await api.call("sessions.get", { id: tests }))?.status === "waiting_permission", 30_000, "the test run waiting");
  await until(() => evalIn(c, `[...document.querySelectorAll('.transcript .delegation-line .tool-row')].length >= 4`), 15_000, "four lines");
  await evalIn(c, `(() => { [...document.querySelectorAll('.transcript .delegation-line .tool-row')].find((b) => b.getAttribute('aria-label').includes('settings test suite')).click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.subagent-view .permission-card button[data-decision="allow"]')`), 10_000, "the request in the viewer");
  await evalIn(c, `(() => { document.querySelector('.subagent-view .permission-card button[data-decision="allow"]').click(); return true; })()`);
  await evalIn(c, `(() => { [...document.querySelectorAll('.subagent-switch-tab')].find((t) => (t.getAttribute('aria-label') ?? '').includes('Choose the default')).click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.subagent-view .question-option')`), 15_000, "question in the viewer");
  await evalIn(c, `(() => { [...document.querySelectorAll('.subagent-view .question-option')].find((x) => x.textContent.includes("Dark")).click(); return true; })()`);
  await until(async () => { const k = (await api.call("delegation.children", { sessionId: lead })).children; return k.every((x) => x.outcome) ? k : null; }, 90_000, "all four settled");
  await until(async () => (await api.call("sessions.get", { id: lead }))?.status !== "running", 60_000, "lead turn over");
  // The long report: the survey child's last words become this.
  await api.call("sessions.send", { id: survey, text: LONG_REPORT, attachments: [], mentions: [] });
  await until(async () => { const k = (await api.call("delegation.children", { sessionId: lead })).children.find((x) => x.session.id === survey);
    return k?.report?.includes("re-render on the first frame") && (await api.call("sessions.get", { id: survey }))?.status === "idle"; }, 30_000, "the long report");
  await sleep(800);

  // ── 4. What it reported ──────────────────────────────────────────────────────────────────────
  const measureResult = () => evalIn(c, `(() => {
    const view = document.querySelector('.subagent-view'), res = document.querySelector('.subagent-view-result');
    if (!view || !res) return null;
    const scroll = res.querySelector('.subagent-view-result-scroll'), head = res.querySelector('.subagent-view-result-head'), body = document.querySelector('.subagent-view-body');
    const cs = getComputedStyle(res);
    return { view: Math.round(view.getBoundingClientRect().height), result: Math.round(res.getBoundingClientRect().height),
      head: Math.round(head.getBoundingClientRect().height), scrollShown: scroll.clientHeight, scrollContent: scroll.scrollHeight,
      body: Math.round(body.getBoundingClientRect().height), padding: cs.padding, headFont: getComputedStyle(head).fontSize + "/" + getComputedStyle(head).color,
      proseFont: getComputedStyle(res.querySelector('.md')).fontSize };
  })()`);
  const results = {};
  for (const [name, prefix] of [["short", "Run the settings"], ["long", "Survey every theme"]]) {
    await evalIn(c, `(() => { [...document.querySelectorAll('.subagent-switch-tab')].find((t) => (t.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(prefix)})).click(); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector('.subagent-view-result')`), 10_000, `${name} report pinned`);
    await sleep(700);
    results[name] = await measureResult();
    note(`result card, ${name} report`, results[name]);
    const reportSelects = await evalIn(c, `({ prose: __live.selects(document.querySelector('.subagent-view-result .md p')), head: __live.selects(document.querySelector('.subagent-view-result-head')), title: __live.selects(document.querySelector('.subagent-view-title')) })`);
    check(`the ${name} report's words select, and its heading and the viewer's title do not`, reportSelects.prose === "text" && reportSelects.head === "none" && reportSelects.title === "none", reportSelects);
    for (const face of ["dark", "light"]) {
      await setFace(c, face);
      await shotOf(c, ".subagent-view", `result-${name}`, face, { below: 0 });
    }
    await setFace(c, "dark");
  }
  check("the one-line report shows whole, with no scroll", results.short && results.short.scrollContent <= results.short.scrollShown + 1, results.short);
  check("the long report gets real room: at least a third of the viewer, or all of itself", results.long && (results.long.result >= results.long.view / 3 || results.long.scrollContent <= results.long.scrollShown + 1), results.long);
  check("…and the log under it keeps room too", results.long && results.long.body >= 160, results.long);

  // ── 3. The cards ─────────────────────────────────────────────────────────────────────────────
  await evalIn(c, `(() => { [...document.querySelectorAll('.subagent-switch-tab')][0].click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.subagent-card').length >= 4`), 10_000, "the Agents tab's cards");
  await sleep(500);
  for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, ".subagents-list", "agents-cards", face, { pad: 12 }); }
  await setFace(c, "dark");

  await api.call("sessions.send", { id: lead, text: "Restart the stalled agents.", attachments: [], mentions: [] });
  await until(() => evalIn(c, `[...document.querySelectorAll('.composer-overstrip .active-agent')].some((r) => r.textContent.includes('Teams rule engine'))`), 30_000, "agent on the row");
  await until(async () => (await api.call("sessions.get", { id: lead }))?.status !== "running", 30_000, "lead turn over");
  await sleep(800);
  await evalIn(c, `(() => { const t = document.querySelector('.panel .transcript'); t.scrollTop = t.scrollHeight; return true; })()`);
  await sleep(400);
  for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, ".panel .transcript-col", "transcript", face, { tail: 520 }); }
  await setFace(c, "dark");

  // ── 1. Selection ─────────────────────────────────────────────────────────────────────────────
  const probes = {
    "assistant prose": `[...document.querySelectorAll('.panel .msg-assistant p')].at(-1)`,
    "user message": `document.querySelector('.panel .msg-user')`,
    "composer field": `document.querySelector('.composer textarea')`,
    "a turn's closing line": `document.querySelector('.panel .msg-run')`,
    "a sub-agent line": `document.querySelector('.panel .delegation-line-task')`,
    "an agent on the prompter's row": `document.querySelector('.panel .composer-overstrip .active-agent .chip-label')`,
    "a pane's title": `document.querySelector('.panel-bar')`,
    "a user message's time": `document.querySelector('.panel .msg-user-at')`,
    "a card's task": `document.querySelector('.subagent-card .subagent-task')`,
    "a card's facts": `document.querySelector('.subagent-card .subagent-facts')`,
    "the Agents tab's head": `document.querySelector('.subagents-head')`,
    "a sidebar row": `document.querySelector('.sidebar .item-row')`,
  };
  const used = await evalIn(c, `(() => { const out = {}; for (const [k, sel] of Object.entries(${JSON.stringify(probes)})) { const el = (0, eval)(sel); out[k] = el ? __live.selects(el) : "missing"; } return out; })()`);
  note("selection, used value", used);
  for (const k of ["assistant prose", "user message", "composer field"]) check(`${k} selects`, used[k] === "text", used[k]);
  for (const k of ["a turn's closing line", "a sub-agent line", "an agent on the prompter's row", "a pane's title", "a user message's time", "a card's task", "a card's facts", "the Agents tab's head", "a sidebar row"]) {
    check(`${k} does not select`, used[k] === "none", used[k]);
  }

  const mouse = async (type, p, clickCount = 1) => c.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount });
  const drag = async (from, to) => {
    await evalIn(c, `getSelection().removeAllRanges(), true`);
    // In steps: Chromium starts a drag-select only once the pointer has moved by small increments.
    await mouse("mousePressed", from);
    for (let i = 1; i <= 8; i++) await mouse("mouseMoved", { x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8 });
    await mouse("mouseReleased", to);
    await sleep(150);
    return evalIn(c, `getSelection().toString()`);
  };
  // A drag across the last answer's words.
  const words = await evalIn(c, `(() => { const p = __live.centre([...document.querySelectorAll('.panel .msg-assistant p')].at(-1));
    const from = __live.pointOf(p, "restarted"), to = __live.pointOf(p, "stopped", true);
    return { text: p.textContent, from, to, reaches: !!from && __live.reaches(p, from) && __live.reaches(p, to) }; })()`).catch(() => null);
  note("drag targets", words);
  if (words?.from && words?.to) {
    const picked = await drag(words.from, words.to);
    check("a drag inside a message selects its words", picked.startsWith("restarted") && picked.endsWith("stopped"), picked);
  } else note("no prose to drag across", words);
  // …and on past its end, through the chrome under it.
  const spill = await evalIn(c, `(() => { const p = [...document.querySelectorAll('.panel .msg-assistant p')].at(-1), run = [...document.querySelectorAll('.panel .msg-run')].at(-1);
    const r = run?.getBoundingClientRect(); const to = r && { x: r.left + Math.min(40, r.width / 3), y: r.top + r.height / 2 };
    return p && r ? { from: __live.pointOf(p, "restarted"), to, run: run.textContent, reaches: __live.reaches(run, to) } : null; })()`);
  note("spill targets", spill);
  if (spill?.from) {
    const picked = await drag(spill.from, spill.to);
    const lit = await evalIn(c, `(() => { const s = getSelection(); const run = [...document.querySelectorAll('.panel .msg-run')].at(-1); return { containsRun: s.rangeCount ? s.getRangeAt(0).intersectsNode(run) : false }; })()`);
    note("drag from prose into the closing line", { picked, run: spill.run, ...lit });
    check("…and dragged on past it, the closing line's words are not lit with it", picked.startsWith("restarted") && !picked.includes(spill.run.trim().split(" ")[0]), { picked, run: spill.run });
    await shotOf(c, ".panel .transcript-col", "selection-spill", "dark", { tail: 360, keepSelection: true });
  }
  // A double-click on chrome selects nothing.
  for (const [name, sel] of [["closing line", ".panel .msg-run span"], ["sub-agent line", ".panel .delegation-line-task"], ["agent on the row", ".panel .composer-overstrip .active-agent .chip-label"], ["card task", ".subagent-card .subagent-task"], ["sidebar row", ".sidebar .item-row"]]) {
    const at = await evalIn(c, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; __live.centre(el); const r = el.getBoundingClientRect();
      const p = { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2 }; return __live.reaches(el, p) ? p : { miss: document.elementFromPoint(p.x, p.y)?.className ?? null }; })()`);
    if (!at || at.miss !== undefined) { note(`no ${name} to double-click`, { sel, at }); continue; }
    await evalIn(c, `getSelection().removeAllRanges(), true`);
    await mouse("mousePressed", at, 1); await mouse("mouseReleased", at, 1); await mouse("mousePressed", at, 2); await mouse("mouseReleased", at, 2);
    await sleep(120);
    const picked = await evalIn(c, `getSelection().toString()`);
    check(`a double-click on the ${name} selects nothing`, picked === "", picked);
  }
  await evalIn(c, `getSelection().removeAllRanges(), true`);

  // ── 2. The prompter, with a picture and a file on it ─────────────────────────────────────────
  const png = fs.readFileSync(path.join(repoRoot, "resources/icon.png")).toString("base64");
  const md = Buffer.from("# Theme notes\n\nWhich surfaces read the theme.\n").toString("base64");
  await evalIn(c, `__live.drop('.panel .composer', ${JSON.stringify([{ name: "hero.png", mime: "image/png", b64: png }, { name: "theme-notes.md", mime: "text/markdown", b64: md }])})`);
  await until(() => evalIn(c, `document.querySelectorAll('.panel .composer .attach-tile').length === 2 || null`), 15_000, "the dropped files' tiles");
  await sleep(1200);
  const painted = await evalIn(c, `document.documentElement.hasAttribute('data-squircle')`);
  for (const face of ["dark", "light"]) {
    await setFace(c, face);
    await evalIn(c, `(document.activeElement?.blur?.(), true)`);
    await sleep(200);
    await shotOf(c, ".panel .composer-dock, .panel .composer", "composer-rest", face, { pad: 28 });
    await evalIn(c, `document.querySelector('.panel .composer textarea').focus(), true`);
    await sleep(200);
    await shotOf(c, ".panel .composer-dock, .panel .composer", "composer", face, { pad: 28 });
    if (painted) {
      await evalIn(c, `document.documentElement.removeAttribute('data-squircle'), true`);
      await sleep(200);
      await shotOf(c, ".panel .composer-dock, .panel .composer", "composer-flat", face, { pad: 28 });
      await evalIn(c, `document.documentElement.setAttribute('data-squircle', ''), true`);
    }
  }
  await setFace(c, "dark");
  const composerEdge = await evalIn(c, `(() => { const k = document.querySelector('.panel .composer'), card = document.querySelector('.panel .attach-tile[data-layout="card"] .attach-open'), art = document.querySelector('.panel .attach-tile:not([data-layout="card"]) .attach-art');
    const s = (el) => el ? { shadow: getComputedStyle(el).boxShadow, filter: getComputedStyle(el).filter } : null;
    return { composer: s(k), lift: k ? getComputedStyle(k, '::before').filter : null, card: s(card), art: s(art) }; })()`);
  note("prompter edges", composerEdge);

  // ── A settings group, as a card ──────────────────────────────────────────────────────────────
  if (await until(() => evalIn(c, `__live.openSettings()`), 20_000, "settings").catch(() => false)) {
    await sleep(800);
    const settingsUsed = await evalIn(c, `(() => { const name = document.querySelector('.settings-row-name'), desc = document.querySelector('.settings-row-desc, .settings-row-note, .settings-row p');
      return { name: name ? __live.selects(name) : "missing", desc: desc ? __live.selects(desc) : "missing" }; })()`);
    check("a setting's name and its line do not select", settingsUsed.name === "none" && (settingsUsed.desc === "none" || settingsUsed.desc === "missing"), settingsUsed);
    for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, ".settings-page-pane .settings-group", "settings-card", face, { pad: 16 }); }
    await setFace(c, "dark");
  } else note("settings did not open", null);
}

async function setFace(c, face) {
  await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(face)}; return true; })()`);
  await sleep(350);
}

/** A capture of one element and a margin round it, over a ground standing in for the window's
 *  material (which is not in the DOM, so a capture of the translucent grounds comes out see-through). */
async function shotOf(c, selector, what, face, { pad = 8, tail = 0, below = 0, keepSelection = false } = {}) {
  const box = await evalIn(c, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  if (!box) { note(`nothing to capture for ${what}`, selector); return; }
  await evalIn(c, `(() => { const r = document.documentElement; const b = document.getElementById('live-scratch-banner'); if (b) b.style.display = 'none';
    r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; ${keepSelection ? "" : "getSelection().removeAllRanges();"} return true; })()`);
  let { x, y, w, h } = box;
  if (tail && h > tail) { y = y + h - tail; h = tail; }
  const clip = { x: Math.max(0, x - pad), y: Math.max(0, y - pad), width: Math.min(VIEWPORT.width, w + pad * 2), height: Math.min(VIEWPORT.height - Math.max(0, y - pad), h + pad * 2 + below), scale: 1 };
  const file = path.join(OUT_DIR, `${TAG}-${what}-${face}.png`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${what}-${face} ${file}`);
  } catch (e) { note("screenshot failed", String(e)); }
  await evalIn(c, `(() => { document.documentElement.style.background = ""; const b = document.getElementById('live-scratch-banner'); if (b) b.style.display = ''; return true; })()`);
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
