/**
 * What Realm spends a laptop's battery on, measured
 * (run with: node apps/desktop/scripts/power-audit.mjs)
 *
 * Energy questions get answered with lists of usual suspects — "blurs are expensive", "animations
 * cost" — and the list is never wrong and never ranked. This boots the REAL app on a scratch home,
 * puts it in the state that costs (several session panes with agents streaming into them), and then
 * measures the renderer and GPU processes with one candidate cost removed at a time.
 *
 * The measurement is CPU TIME over a window, not `ps`'s `%cpu`: that column is an average over the
 * process's whole life, so a process that pegged an hour ago and is idle now still reads high. Time
 * at the start, time at the end, divided by the wall clock, is what the battery actually pays.
 *
 * Each condition is applied as a stylesheet the page can take back, so one run walks every
 * condition against the same window, the same panes and the same agents — a second launch would
 * compare two different transcripts.
 *
 * REBUILD FIRST (`pnpm build`): this boots apps/desktop/out, not the sources.
 * Ports: env-overridable. Touches only a scratch dir; kills only the processes it started.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9391), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8961);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-power-"));
/** How long each condition is measured for. Long enough that a frame or two either way is noise. */
const WINDOW_MS = Number(process.env.POWER_WINDOW_MS ?? 12_000);
/** How many session panes to open. The user's own window had seven; four is enough to show whether a
 *  cost scales per pane, and fits a 1400px window without panes too narrow to render normally. */
const PANES = Number(process.env.POWER_PANES ?? 4);
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The conditions, each a stylesheet that takes ONE thing away.
 *
 * Removing rather than adding, so every condition is measured against the same app in the same
 * state: the difference between a condition and the baseline is what that thing costs.
 */
/**
 * The decoration a window like the user's actually carries, injected as a fixture.
 *
 * Measuring this against the app's own live state kept failing for the same reason twice: the window
 * is never twice in the same state. A streaming transcript grows between conditions, so the second
 * arm lays out more text than the first; an idle one may have no spinner mounted at all, so every
 * arm measures nothing. Neither comparison is about the thing being compared.
 *
 * So the content is held still. Seven orbs and fourteen status dots is what seven session panes with
 * agents in them carry — the same elements, the same stylesheet, the same compositor — and the only
 * thing that changes between arms is whether they are allowed to run.
 */
const FIXTURE = `(() => {
  document.getElementById("power-fixture")?.remove();
  const host = document.createElement("div");
  host.id = "power-fixture";
  host.style.cssText = "position:fixed;inset:0;z-index:9999;pointer-events:none;display:flex;flex-wrap:wrap;gap:24px;padding:24px;align-content:flex-start";
  const orb = document.querySelector(".spinner");
  for (let i = 0; i < 7; i++) {
    // A real orb, cloned from the app's own so the pose table and the keyframes are the real ones.
    if (orb) host.appendChild(orb.cloneNode(true));
    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.setAttribute("data-status", "running");
    host.appendChild(dot);
    const dot2 = document.createElement("span");
    dot2.className = "status-dot";
    dot2.setAttribute("data-status", "waiting_permission");
    host.appendChild(dot2);
  }
  document.body.appendChild(host);
  return host.querySelectorAll(".spinner").length + " orbs, " + host.querySelectorAll(".status-dot").length + " dots";
})()`;

const CONDITIONS = [
  {
    id: "running",
    label: "the decoration running (what a focused window pays)",
    css: "",
    idle: true,
    js: FIXTURE,
  },
  {
    id: "paused",
    label: "the same, paused — window unfocused, or Low power",
    css: "",
    idle: true,
    js: `document.documentElement.setAttribute("data-quiet", "unfocused");`,
    undo: `document.documentElement.removeAttribute("data-quiet");`,
  },
  {
    id: "pings-only",
    label: "…and with the orbs alone stopped (what seven orbs cost)",
    css: ".spinner-dot { animation: none !important; }",
    idle: true,
  },
  {
    id: "orbs-only",
    label: "…and with the pings alone stopped (what the dots cost)",
    css: ".status-dot::after, .strip-badge, .permission-dot { animation: none !important; }",
    idle: true,
  },
];

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

const HELPERS = `
window.__live = window.__live ?? {
  setInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  byLabel(name) { return [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name) ?? null; },
  condition(css) {
    document.getElementById("power-condition")?.remove();
    if (!css) return true;
    const st = document.createElement("style");
    st.id = "power-condition";
    st.textContent = css;
    document.head.appendChild(st);
    return true;
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** Every descendant of a pid, with its command — how the renderer and GPU helpers are found. */
function descendants(root) {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n");
  const byParent = new Map();
  const command = new Map();
  for (const line of rows) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, ppid, cmd] = m;
    if (!byParent.has(Number(ppid))) byParent.set(Number(ppid), []);
    byParent.get(Number(ppid)).push(Number(pid));
    command.set(Number(pid), cmd);
  }
  const out = [];
  const walk = (pid) => {
    for (const kid of byParent.get(pid) ?? []) { out.push({ pid: kid, command: command.get(kid) ?? "" }); walk(kid); }
  };
  walk(root);
  return out;
}

/** Total CPU seconds a process has used since it started. */
function cpuSeconds(pid) {
  try {
    const t = execFileSync("ps", ["-p", String(pid), "-o", "cputime="], { encoding: "utf8" }).trim();
    const parts = t.split(/[:.]/).map(Number);
    if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / 100;
    if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 100;
    return 0;
  } catch { return 0; }
}

/** CPU used over a window, as a fraction of ONE core, per process. */
async function measure(pids, ms) {
  const before = new Map(pids.map((p) => [p.pid, cpuSeconds(p.pid)]));
  const t0 = Date.now();
  await sleep(ms);
  const wall = (Date.now() - t0) / 1000;
  const out = {};
  for (const p of pids) out[p.role] = Math.max(0, (cpuSeconds(p.pid) - (before.get(p.pid) ?? 0)) / wall);
  return out;
}

const pct = (v) => `${(v * 100).toFixed(0)}%`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
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
    __live.setInput(input, "Power");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
  await sleep(600);

  // The two processes that matter. Main and the server barely register; these are the ones the
  // earlier sampling found pegged.
  const kids = descendants(electron.pid);
  const pids = [
    { role: "renderer", pid: kids.find((k) => /Renderer\)/.test(k.command))?.pid },
    { role: "gpu", pid: kids.find((k) => /GPU\)/.test(k.command))?.pid },
  ].filter((p) => p.pid);
  if (pids.length < 2) throw new Error(`could not find the renderer and GPU helpers (${kids.length} children)`);

  // ── Put the window in the state that costs: several panes, all streaming ──
  /* Through the pane menu rather than the ⌘\\ chord: a synthetic key event has to get past the
     window's own hotkey handling to land, and the menu item is the same action a person takes. */
  for (let i = 1; i < PANES; i++) {
    const split = await evalIn(c, `(async () => {
      const menu = [...document.querySelectorAll('.panel-bar button')].find((b) => /^Pane menu/.test(b.getAttribute("aria-label") ?? ""));
      if (!menu) return "no pane menu";
      menu.click();
      await new Promise((r) => setTimeout(r, 250));
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((m) => /^Split right/.test(m.textContent ?? ""));
      if (!item) return "no split item";
      item.click();
      return "ok"; })()`);
    if (split !== "ok") { console.log(`(split ${i}: ${split})`); break; }
    await sleep(1200);
  }
  const panes = await evalIn(c, `document.querySelectorAll(".session-pane").length`);
  console.log(`panes: ${panes}`);

  /** Point every session at the fake agent and give it something long to stream. */
  const startStreaming = async () => evalIn(c, `(async () => {
    const composers = [...document.querySelectorAll(".composer-input")];
    for (const el of composers) {
      __live.setInput(el, "stream");
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
    }
    return composers.length; })()`);

  /** Every animation the page is actually running, by name and by what it is on. `getAnimations`
   *  reports what the engine has scheduled, which is the only honest answer to "what is animating" —
   *  a stylesheet full of `infinite` says nothing about what is on screen right now. */
  const animating = async () => evalIn(c, `(() => {
    const out = {};
    for (const a of document.getAnimations()) {
      const name = a.animationName ?? a.constructor.name;
      const el = a.effect?.target;
      const where = el ? (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/)[0] : el.tagName.toLowerCase()) : "?";
      const key = name + " on " + where;
      out[key] = (out[key] ?? 0) + 1;
    }
    return out; })()`);

  const rows = [];
  for (const cond of CONDITIONS) {
    await evalIn(c, `__live.condition(${JSON.stringify(cond.css ?? "")})`);
    if (cond.js) await evalIn(c, cond.js);
    if (!cond.idle) {
      const sent = await startStreaming();
      if (sent === 0) console.log("(no composer to send from — is a pane focused?)");
      await sleep(1200); // let the stream get going before the window opens
    } else {
      await sleep(3000); // let whatever was streaming finish
    }
    const running = await animating();
    const used = await measure(pids, WINDOW_MS);
    rows.push({ ...cond, ...used, running });
    if (Object.keys(running).length > 0) {
      console.log(`  animating: ${Object.entries(running).map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ""}`).join(", ")}`);
    }
    if (cond.undo) await evalIn(c, cond.undo);
    console.log(`${cond.id.padEnd(14)} renderer ${pct(used.renderer).padStart(5)}   gpu ${pct(used.gpu).padStart(5)}   ${cond.label}`);
  }
  await evalIn(c, `__live.condition("")`);

  /* Against the FIRST condition, whatever it is: the list is edited every time a new suspicion comes
     up, and a summary that hunts for a row called "baseline" breaks the moment someone renames it. */
  const base = rows[0];
  console.log(`\n— against "${base.label}" —`);
  for (const r of rows.slice(1)) {
    const saved = (base.renderer + base.gpu) - (r.renderer + r.gpu);
    console.log(`${r.id.padEnd(14)} ${saved >= 0 ? "-" : "+"}${pct(Math.abs(saved)).padStart(5)} of a core   (${r.label})`);
  }
  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => {
      electron?.kill("SIGKILL");
      try {
        const pids = execFileSync("lsof", ["-nP", `-iTCP:${SERVER_PORT}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
          .split("\n").map((l) => Number(l.trim())).filter(Boolean);
        for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      } catch { /* nothing listening */ }
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      process.exit(process.exitCode ?? 0);
    }, 1200);
  });
