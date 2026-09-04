/**
 * Live check for the prompter's control row across pane widths
 * (run with: node apps/desktop/scripts/composer-bar-live.mjs)
 *
 * The row's width depends on content nobody controls: a branch name is user data and can be any
 * length, and the pane it sits in can be a quarter of the window. Whether that row degrades or simply
 * gets cut in half is a question about BOXES, so it is asked here rather than in jsdom, where every
 * rect is zero and a chip sliced down the middle measures exactly like one that fits.
 *
 * The session is put on a scratch repo with a long branch, real +/- counts and dirty files, because
 * an all-clean repo with a branch called `main` is the one case the row was never going to fail on.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9345), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8912);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-bar-live-"));
/** Long, but not absurd — this is a branch name of the kind this repo's own worktrees carry. */
const BRANCH = "feature/prompter-composer-bar-responsive-overflow";
/** Window widths to sweep. The session pane is what the row answers to (and what its container
 *  queries measure), so these are a proxy for it: each one is reported with the pane width it
 *  produced, which is the same range a split reaches on a window that stays at its 900px minimum. */
const WIDTHS = (process.env.LIVE_WIDTHS ?? "1280,1040,900,780,700,620,560,500,440,400,360").split(",").map(Number);
/**
 * The narrowest pane this row is claimed to work at.
 *
 * Below it the row is over-subscribed by its FIXED controls alone — the "+", the mode chip, the model
 * chip and the send button come to ~220px before a branch name is mentioned — so nothing the branch
 * chip does can rescue it. That is a different repair (the mode chip needs the same fold into the
 * model menu the permission chip already has), and pretending otherwise here would hide it. Those
 * widths are still swept and printed, just not asserted on.
 */
const MIN_PANE = 320;
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
  box: (n) => { const b = n.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; },
  // Everything the row's fitness depends on, in one read: what each control got, what it wanted,
  // and whether it ends inside the box that is allowed to draw it.
  row() {
    const bar = document.querySelector(".composer-bar");
    const opts = document.querySelector(".composer-opts");
    const acts = document.querySelector(".composer-actions");
    if (!bar || !opts) return null;
    const optsBox = __live.box(opts);
    const chip = (n) => {
      const label = n.querySelector(".chip-label");
      return {
        cls: n.className.replace("ghost-chip", "").trim() || n.className,
        ...__live.box(n),
        // A label whose text is wider than its box is ellipsized; one whose right edge is past the
        // group's is amputated by overflow:hidden, which looks nothing like truncation.
        cut: Math.round(__live.box(n).r) > optsBox.r + 1,
        ellipsis: !!label && label.scrollWidth > label.clientWidth + 1,
        text: (n.textContent || "").trim().slice(0, 40),
      };
    };
    return {
      pane: __live.box(document.querySelector(".session-pane")).w,
      bar: __live.box(bar).w,
      opts: { ...optsBox, need: Math.round(opts.scrollWidth), have: Math.round(opts.clientWidth), collapsed: opts.hasAttribute("data-collapsed") },
      acts: acts ? __live.box(acts) : null,
      // The git button's own children too: shrinking the BUTTON below its content's minimum spills
      // the branch chip out through the group's clip, which reads identically to the button being
      // sliced and is invisible if only the outer box is measured.
      items: [...opts.children, ...(opts.querySelector(".composer-git")?.children ?? [])].map(chip),
      // The two controls that must survive every width: you can always send, and you can always
      // see which model you are sending to.
      send: !!document.querySelector(".composer-send") && __live.box(document.querySelector(".composer-send")).r <= __live.box(bar).r + 1,
      model: document.querySelector(".model-chip") ? __live.box(document.querySelector(".model-chip")) : null,
      git: document.querySelector(".composer-git") ? { ...__live.box(document.querySelector(".composer-git")), text: document.querySelector(".composer-git").textContent.trim() } : null,
      gitTitle: document.querySelector(".composer-git")?.title ?? null,
    };
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

/** A repo the git chip has something to say about: long branch, real diff counts, dirty files. */
function seedRepo(dir) {
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  fs.mkdirSync(dir, { recursive: true });
  git("init", "-q", "-b", BRANCH);
  git("config", "user.email", "live@example.com");
  git("config", "user.name", "Live");
  fs.writeFileSync(path.join(dir, "a.txt"), Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "kept\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  fs.writeFileSync(path.join(dir, "a.txt"), Array.from({ length: 60 }, (_, i) => `changed ${i}`).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "c.txt"), "new\n");
}

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

  const api = rpc(SERVER_PORT);
  await api.ready;
  const sessions = await until(async () => {
    const all = await api.call("sessions.listAll", {});
    return all.length ? all : null;
  }, 15000, "a session to drive");
  const session = sessions[0];
  // `fake` keeps the send from needing a login; the send itself is only here to make the store
  // re-read git for this session's cwd, which is event-driven.
  await api.call("sessions.setAgent", { id: session.id, agentKind: "fake" });
  seedRepo(session.cwd);
  // The chip can only be as good as what the server reads; separating the two makes a failure here
  // say which half broke. Polled because opening the session already asked once, before the repo
  // existed, and GitInfoService holds that `null` for its 3s TTL.
  const serverGit = await until(async () => {
    const g = await api.call("workspace.gitInfo", { cwd: session.cwd });
    return g?.branch === BRANCH ? g : null;
  }, 20000, "the server to see the scratch repo");
  check("the server reads the scratch repo the session sits in",
    serverGit.branch === BRANCH && serverGit.dirty > 0, { cwd: session.cwd, serverGit });
  // A finished turn is what makes the store re-read git for this cwd (the refresh is event-driven).
  await api.call("sessions.send", { id: session.id, text: "hello", attachments: [], mentions: [] });

  const gitReady = await until(async () => {
    const r = await evalIn(c, `__live.row()`);
    return r?.git ? r : null;
  }, 25000, "the branch chip");
  check("the branch chip is showing a real repo's branch, diff and dirty count",
    gitReady.git.text.includes("prompter") && /\d/.test(gitReady.git.text), { text: gitReady.git.text, title: gitReady.gitTitle });

  const sweep = [];
  for (const width of WIDTHS) {
    await c.send("Emulation.setDeviceMetricsOverride", { width, height: 860, deviceScaleFactor: 2, mobile: false });
    // Two frames: the ResizeObserver that decides the collapse runs after layout, and the row it
    // then re-renders has to be laid out again before it can be measured.
    await sleep(400);
    const row = await evalIn(c, `__live.row()`);
    sweep.push({ width, ...row });
    const cutItems = row.items.filter((i) => i.cut).map((i) => i.cls);
    console.log(`WIDTH ${String(width).padStart(4)} pane=${String(row.pane).padStart(4)} opts need=${String(row.opts.need).padStart(4)} have=${String(row.opts.have).padStart(4)} collapsed=${row.opts.collapsed ? "y" : "n"} cut=[${cutItems.join(" ")}] git=${row.git ? row.git.w : "-"} model=${row.model ? row.model.w : "-"}`);
  }
  fs.writeFileSync(path.join(os.tmpdir(), "realm-composer-bar.json"), JSON.stringify(sweep, null, 2));

  // ── What the row must be true of at every width it is claimed at ─────────
  const room = sweep.filter((s) => s.pane >= MIN_PANE);
  for (const s of sweep.filter((s) => s.pane < MIN_PANE)) {
    console.log(`INFO pane=${s.pane} is below the claimed floor (${MIN_PANE}px) — fixed controls alone do not fit`);
  }
  const amputated = room.filter((s) => s.items.some((i) => i.cut));
  check("no control is ever sliced by the group's overflow — a chip either fits or is not on the row",
    amputated.length === 0, amputated.map((s) => ({ width: s.width, cut: s.items.filter((i) => i.cut).map((i) => i.cls) })));

  const branchless = room.filter((s) => !s.git);
  check("the branch chip is present at every width it is offered at", branchless.length === 0, branchless.map((s) => s.width));

  const truncated = room.filter((s) => s.git && s.items.some((i) => i.cls.includes("git-branch") && i.ellipsis));
  check("a branch too long for the pane is ellipsized rather than dropped or clipped",
    truncated.length > 0, { panes: truncated.map((s) => s.pane) });
  // The point of capping against the pane rather than at a flat 160px: a wide pane spends its slack
  // on the name, a narrow one takes it back.
  const widest = room[0], narrowest = room[room.length - 1];
  check("the branch chip uses the room it has — wider pane, more name",
    widest.git.w > narrowest.git.w + 100, { widest: { pane: widest.pane, git: widest.git.w }, narrowest: { pane: narrowest.pane, git: narrowest.git.w } });

  check("the full branch name is always one hover away", /prompter-composer-bar-responsive-overflow/.test(gitReady.gitTitle ?? ""), gitReady.gitTitle);

  const sendLost = room.filter((s) => !s.send);
  check("the send button is inside the card at every width", sendLost.length === 0, sendLost.map((s) => s.width));

  const modelLost = room.filter((s) => !s.model || s.model.w < 40);
  check("the model chip keeps a usable width at every pane size", modelLost.length === 0, modelLost.map((s) => ({ width: s.width, model: s.model })));

  // Narrow but supported: the pane where the numbers have gone and the name is down to a few
  // characters, which is the width the row used to be cut in half at.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 700, height: 860, deviceScaleFactor: 2, mobile: false });
  await sleep(400);
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(os.tmpdir(), "realm-composer-bar.png");
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`SCREENSHOT ${out}`);
  console.log(`SWEEP ${path.join(os.tmpdir(), "realm-composer-bar.json")}`);

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
