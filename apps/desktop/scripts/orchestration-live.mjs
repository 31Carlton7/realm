/**
 * Live check for work handed to other models (run with: pnpm build && node apps/desktop/scripts/orchestration-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent standing in for Claude and
 * Codex (REALM_FAKE_STANDS_IN), so a lead "on Claude Opus 5.5" can hand work to sub-agents "on
 * GPT-6 Luna" and "on Fable" and nothing anywhere runs a billed turn. The lead's script makes REAL
 * `agent_start` calls through its gateway (the fake's `call` step), so the model resolution, the
 * children, their permissions and their settling are the production path. Checks, in the window:
 *
 *   1. The session bar's Agents button opens the Agents tab as a tab of the session's side pane.
 *   2. "Build with…": two models picked (one through the chooser), split by model, sent — and what
 *      reached the lead is the brief naming both, as the user's own message.
 *   3. The children appear in the tab with their model, harness and task; their status moves —
 *      Working, Needs you (a permission held open), Done — and a done one shows its report.
 *   4. The lead's transcript draws each as one quiet "Subagent finished · <task>" line.
 *   5. A click on a card opens that child's transcript as a tab beside the lead.
 *   6. A click on a transcript line brings the Agents tab forward with that row lit.
 *   7. "Implement with…" on a plan opens the tab with the plan in the composer.
 *
 * Ports: LIVE_SERVER_PORT (8795), LIVE_CDP_PORT (9235). Screenshots go to LIVE_OUT_DIR (the system
 * temp dir unless set); the scratch home to LIVE_SCRATCH_DIR. Kills only what listens on its own ports.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { openSideTool } from "./lib/side-tools.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9235);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8795);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-orchestration-live-"));
const home = path.join(scratch, "home");
const TITLE = "Dark mode";
const VIEWPORT = { width: 1560, height: 940 };
const OUT = (tag) => path.join(OUT_DIR, `orchestration-${tag}.png`);
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

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

/** A React-controlled field, filled the way typing fills it. */
const fill = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true; })()`;
/** A button by its visible text inside `scope`. */
const clickText = (scope, text) => `(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => x.textContent.includes(${JSON.stringify(text)}));
  if (!b) return false; b.click(); return true; })()`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      // Claude and Codex are the scripted agent here, so the onboarding session and every child
      // below run the script — nothing reaches a real engine or an account.
      REALM_FAKE_STANDS_IN: "claude,codex",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
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

  // A window the script opened behind someone's work is not key: Realm greys its accent and goes
  // quiet. Focus is emulated, and the inactive mark held off, so what is captured is the app awake.
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
    new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`);

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
    new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`);

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  // The probe the panes make on mount, asked for once here so its answer is cached: the stand-ins
  // report their catalogs (GPT-6 Luna on Codex).
  await api.call("agents.probe", { force: false });
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "claude", model: "claude-opus-5-5", title: TITLE, permissionMode: "default" });
  const lead = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  // One pane: the lead alone, so every tab after this is one the check asked for.
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(500);

  // ── 1. The Agents tab opens as a tab of the session's side pane ───────────────────────────
  // From the session's side pane — its first opens on a new tab whose page lists the tools.
  const opened = await openSideTool(c, TITLE, "Agents").then(() => true, () => false);
  check("the session's side pane opens its Agents", opened);
  await until(() => evalIn(c, `!!document.querySelector('.subagents')`), 10_000, "agents tab");
  const tabs = () => evalIn(c, `[...document.querySelectorAll('.panehost .panel')].map((p) => ({ title: p.querySelector('.panel-title')?.textContent ?? null, tabs: [...p.querySelectorAll('[role=tab]')].map((t) => ({ name: t.textContent, selected: t.getAttribute('aria-selected') === 'true' })) }))`);
  const firstTabs = await tabs();
  note("panes with the tab", firstTabs);
  check("the tab is a tab of a side pane beside the session", firstTabs.length === 2 && firstTabs.some((p) => p.tabs.some((t) => t.name === "Agents" && t.selected)), firstTabs);
  await until(() => evalIn(c, `document.querySelectorAll('.subagents-pick').length >= 2`), 10_000, "model chips");
  await sleep(400);
  note("grounds before the first turn", await grounds(c));
  await shot(c, "1-tab-empty");
  // The empty state is one composition centred both ways in the space above the composer, at a
  // narrow pane and a wide one, in both faces — measured, because a centre is a number.
  const mode = await evalIn(c, `document.documentElement.dataset.mode`);
  for (const [tag, width, face] of [["1b-empty-narrow", 1100, "dark"], ["1c-empty-narrow-light", 1100, "light"], ["1d-empty-wide", 2200, "dark"], ["1e-empty-wide-light", 2200, "light"]]) {
    await c.send("Emulation.setDeviceMetricsOverride", { width, height: VIEWPORT.height, deviceScaleFactor: 2, mobile: false });
    await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(face)}; return true; })()`);
    await sleep(500);
    const m = await evalIn(c, `(() => {
      const box = document.querySelector('.subagents-scroll'), e = document.querySelector('.subagents-empty');
      const slot = document.querySelector('.subagents')?.closest('.pane-slot');
      if (!box || !e || !slot) return null;
      const b = box.getBoundingClientRect(), r = e.getBoundingClientRect(), st = getComputedStyle(box), s = slot.getBoundingClientRect();
      const top = b.top + parseFloat(st.paddingTop), bottom = b.bottom - parseFloat(st.paddingBottom);
      const left = b.left + parseFloat(st.paddingLeft), right = b.right - parseFloat(st.paddingRight);
      // Against the PANE as well as the column: a column narrower than its pane centres its content in
      // the wrong place while measuring perfectly against itself.
      return { pane: Math.round(s.width), column: Math.round(b.width), dx: +((r.left + r.right) / 2 - (s.left + s.right) / 2).toFixed(1), dy: +((r.top + r.bottom) / 2 - (top + bottom) / 2).toFixed(1),
        lines: Math.round(e.querySelector('.subagents-empty-line').getBoundingClientRect().height / 18) }; })()`);
    note(`empty state, ${tag}`, m);
    check(`the tab fills its pane, and the empty state is centred both ways in it (${tag})`, !!m && m.column === m.pane && Math.abs(m.dx) <= 1.5 && Math.abs(m.dy) <= 1.5, m);
    await shot(c, tag);
  }
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(mode ?? "dark")}; return true; })()`);
  await sleep(300);

  // ── 2. Build with: two models, split, sent ─────────────────────────────────────────────────
  check("GPT-6 Luna is offered as a chip", await evalIn(c, clickText(".subagents-pick", "GPT-6 Luna")));
  await evalIn(c, clickText(".subagents-pick", "More models"));
  await until(() => evalIn(c, `!!document.querySelector('.subagents-chooser [role=option]')`), 5_000, "chooser");
  await sleep(300);
  await shot(c, "2-chooser");
  const groups = await evalIn(c, `[...document.querySelectorAll('.subagents-chooser [role=group]')].map((g) => g.getAttribute('aria-label'))`);
  note("chooser groups", groups);
  check("the chooser lists the session's own model first, then each harness", groups[0] === "This session" && groups.includes("Codex") && groups.includes("Claude"), groups);
  check("Fable is pickable in the chooser", await evalIn(c, clickText(".subagents-chooser [role=option]", "Claude Fable 5.1")));
  await evalIn(c, `(() => { document.querySelector('.subagents-chooser input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  await sleep(300);
  await evalIn(c, fill(".subagents-work", "Add a dark-mode switch to the app settings, and keep the choice across launches."));
  await evalIn(c, clickText(".subagents-split", "Split by model"));
  await until(() => evalIn(c, `document.querySelectorAll('.subagents-task input').length === 2`), 5_000, "task fields");
  await evalIn(c, `(() => { const [a, b] = document.querySelectorAll('.subagents-task input'); a.setAttribute('data-live', 'a'); b.setAttribute('data-live', 'b'); return true; })()`);
  await evalIn(c, fill('.subagents-task input[data-live="a"]', "The switch in Settings ▸ App, and its tests"));
  await evalIn(c, fill('.subagents-task input[data-live="b"]', "Storing the choice, with a migration"));
  await sleep(300);
  await shot(c, "3-composer");
  await evalIn(c, `(() => { document.querySelector('.subagents-send').click(); return true; })()`);
  const brief = await until(async () => {
    const evs = await api.call("sessions.events", { id: lead, afterSeq: 0, limit: 2000 });
    return evs.find((e) => e.event.type === "user_message")?.event.payload.text ?? null;
  }, 10_000, "the brief");
  note("what reached the lead", brief);
  check("the lead was sent a brief naming the tool and both models", brief.startsWith("Build this with sub-agents, one per task below. Start each with agent_start and set constraints.model")
    && brief.includes("- GPT-6 Luna: The switch in Settings ▸ App, and its tests") && brief.includes("- Claude Fable 5.1: Storing the choice, with a migration"), brief.split("\n").slice(0, 4));

  // ── 3. The children appear, and their status moves ─────────────────────────────────────────
  const cards = () => evalIn(c, `[...document.querySelectorAll('.subagent')].map((li) => ({ state: li.dataset.state, model: li.querySelector('.subagent-model')?.textContent, harness: li.querySelector('.subagent-harness')?.textContent, task: li.querySelector('.subagent-task')?.textContent, status: li.querySelector('.subagent-state')?.textContent, doing: li.querySelector('.subagent-doing')?.textContent ?? null, report: li.querySelector('.subagent-report')?.textContent ?? null }))`);
  const two = await until(async () => { const cs = await cards(); return cs.length === 2 ? cs : null; }, 20_000, "two sub-agents in the tab").catch(async (e) => { note("cards at timeout", await cards()); throw e; });
  note("cards", two);
  check("GPT-6 Luna's child is listed on Codex, with its task", two.some((x) => x.model === "GPT-6 Luna" && x.harness === "Codex" && x.task?.startsWith("Build the dark-mode toggle")), two);
  check("Fable resolved to the newest Fable, on Claude", two.some((x) => x.model === "Claude Fable 5.1" && x.harness === "Claude" && x.task?.startsWith("Write the migration")), two);
  await until(async () => (await cards()).some((x) => x.state === "working"), 15_000, "a child working");
  await sleep(1200);
  await shot(c, "4-working");
  const waiting = await until(async () => { const cs = await cards(); return cs.find((x) => x.state === "waiting") ? cs : null; }, 40_000, "a child waiting on a permission");
  note("cards, one waiting", waiting);
  check("a child held on a permission says it needs you", waiting.some((x) => x.model === "GPT-6 Luna" && x.status?.startsWith("Needs you")), waiting);
  await shot(c, "5-needs-you");
  // Answered as the person would, on the child's own session — where its prompt surfaced.
  const kids = await api.call("delegation.children", { sessionId: lead });
  const luna = kids.children.find((k) => k.session.agentKind === "codex");
  const evs = await api.call("sessions.events", { id: luna.session.id, afterSeq: 0, limit: 2000 });
  const ask = evs.filter((e) => e.event.type === "permission_request").at(-1);
  check("the permission prompt surfaced on the child's own session", !!ask, evs.map((e) => e.event.type));
  await api.call("sessions.respondPermission", { id: luna.session.id, requestId: ask.event.payload.requestId, decision: "allow" });
  const done = await until(async () => { const cs = await cards(); return cs.every((x) => x.state === "done") ? cs : null; }, 60_000, "both done").catch(async (e) => { note("cards at timeout", await cards()); throw e; });
  note("cards, done", done);
  check("both children finish, and each shows its report", done.every((x) => x.status?.startsWith("Done") && (x.report ?? "").length > 20), done);
  await sleep(600);
  note("grounds once settled", await grounds(c));
  await shot(c, "6-done");

  // ── 4. The lead's transcript: one quiet line per sub-agent ───────────────────────────────────
  const settled = await until(async () => {
    const evs = await api.call("sessions.events", { id: lead, afterSeq: 0, limit: 2000 });
    return evs.some((e) => e.event.type === "assistant_text" && e.event.payload.text.startsWith("Both sub-agents are done")) ? evs : null;
  }, 30_000, "the lead's report");
  check("the lead collected both reports with agent_wait", settled.some((e) => e.event.type === "tool_result" && e.event.payload.content.startsWith("All 2 delegated agents finished")));
  const lines = await evalIn(c, `[...document.querySelectorAll('.delegation-line .tool-row')].map((b) => b.textContent)`);
  note("transcript lines", lines);
  check("the transcript draws each as 'Subagent finished · <task>'", lines.filter((l) => l.startsWith("Subagent finished")).length === 2, lines);
  check("…and the wait as one line that says what it collected", lines.includes("Collected 2 reports"), lines);
  await shot(c, "7-transcript");

  // ── 5. A card opens its child, beside the lead ─────────────────────────────────────────────
  await evalIn(c, `(() => { [...document.querySelectorAll('.subagent-card')].find((b) => b.textContent.includes('GPT-6 Luna')).click(); return true; })()`);
  const withChild = await until(async () => { const ps = await tabs(); return ps.some((p) => p.tabs.some((t) => t.name.startsWith("Agent: Build") && t.selected)) ? ps : null; }, 10_000, "child tab").catch(() => tabs());
  note("panes with the child open", withChild);
  check("the child's transcript opens as a tab of the same side pane", withChild.length === 2 && withChild.some((p) => p.tabs.some((t) => t.name.startsWith("Agent: Build") && t.selected)), withChild);
  await sleep(600);
  await shot(c, "8-child");

  // ── 6. A transcript line brings the tab forward, with its row lit ───────────────────────────
  await evalIn(c, `(() => { [...document.querySelectorAll('.delegation-line .tool-row')].find((b) => b.textContent.includes('Write the migration')).click(); return true; })()`);
  const lit = await until(() => evalIn(c, `document.querySelector('.subagent[data-flash] .subagent-model')?.textContent ?? null`), 5_000, "lit row").catch(() => null);
  check("a transcript line brings the Agents tab back with its row lit", lit === "Claude Fable 5.1", lit);
  await shot(c, "9-lit-row");

  // ── 7. Implement with… on a plan ────────────────────────────────────────────────────────────
  await api.call("sessions.send", { id: lead, text: "Write a plan for the mapper first.", attachments: [], mentions: [] });
  await until(() => evalIn(c, `!!document.querySelector('.plan-implement-with')`), 15_000, "plan card");
  await sleep(400);
  await evalIn(c, `(() => { document.querySelector('.plan-implement-with').click(); return true; })()`);
  const prefilled = await until(() => evalIn(c, `document.querySelector('.subagents-work')?.value || null`), 5_000, "prefilled composer").catch(() => null);
  check("Implement with… opens the tab with the plan in the composer", (prefilled ?? "").includes("Rework the mapper"), prefilled);
  await sleep(400);
  await shot(c, "10-plan-handoff");
  // The light face, by the attribute the theme setting writes on the root — the same tab, re-tokened.
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "light"; return true; })()`);
  await sleep(400);
  await shot(c, "11-light");
}

/** What the window's grounds are made of right now — the alphas the theme writes, and the root's
 *  state attributes — so a capture that reads differently from the next can be explained. */
const grounds = (c) => evalIn(c, `(() => { const cs = getComputedStyle(document.documentElement);
  return { attrs: [...document.documentElement.attributes].map((a) => a.name), groundAlpha: cs.getPropertyValue('--ground-alpha'), paneAlpha: cs.getPropertyValue('--pane-alpha'),
    sidebar: getComputedStyle(document.querySelector('.sidebar') ?? document.body).backgroundColor, app: [...(document.querySelector('.app')?.attributes ?? [])].map((a) => a.name),
    // What is on top over the sidebar and the lead's pane, with anything translucent or dimmed on it.
    over: [[200, 500], [800, 800]].map(([x, y]) => document.elementsFromPoint(x, y).slice(0, 6).map((el) => {
      const st = getComputedStyle(el);
      return [el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ").join(".") : ""), st.opacity, st.backgroundColor, st.filter].join(" ");
    })) }; })()`);

/** The window's material is not in the DOM, so a capture composites the translucent grounds over
 *  nothing and the PNG comes out see-through — measured: the sidebar at alpha 140. For the capture
 *  alone the root is painted with a ground that stands in for the material over a plain wallpaper,
 *  dark or light as the face is, and put back after. */
async function shot(c, tag) {
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
  await evalIn(c, `(() => { document.documentElement.style.background = ""; return true; })()`);
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
