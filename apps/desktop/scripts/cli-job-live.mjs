/**
 * Live check for the install-output panel's box (run with: node apps/desktop/scripts/cli-job-live.mjs)
 *
 * The panel is a monospace block of text nobody controls the size of — a package manager can print
 * two lines or two thousand, with single tokens longer than the pane is wide. Whether that stays
 * inside a floating card that sits in the composer dock is a question about BOXES, and jsdom answers
 * every box with zeros.
 *
 * It also pins the one fact no single-layer test can state: with the CLI genuinely absent from a
 * real PATH, a real probe, a real `cli.status` and a real card agree, and the card grows a button
 * offering the real install command.
 *
 * Then three boxes, all of them CSS:
 *
 *   1. The card stays inside its pane. The install card floats over the transcript, so a panel that
 *      grows without bound pushes the card's top off the top of the pane and the "Install" button
 *      out of reach — the exact failure the 180px cap exists to prevent.
 *   2. Long output SCROLLS rather than growing. `scrollHeight > clientHeight` with a clamped
 *      `clientHeight` is the shape that proves the cap is doing the work.
 *   3. A single unbroken 400-character token does not widen the card. `word-break: break-word` is
 *      the rule under test, and an npm error path or a base64 integrity hash is a real 400-char token.
 *
 * **It runs no package manager.** The panel's markup is injected into the real card, in the real
 * stylesheet, at a real viewport — so what is proven is the CSS, which is the only thing here that
 * can go wrong in a way a unit test cannot see. The behaviour that fills the panel is covered by
 * install.test.ts and cli-manager.test.ts against fakes.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9347), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8914);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-clijob-live-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let failures = 0;

const check = (label, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!cond) failures += 1;
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

const evalIn = async (c, expr) => (await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

/** The panel exactly as CliJobPanel and InstallCard build it — same elements, same classes, same
 *  nesting. Anything less would be measuring a box this stylesheet never draws. */
const INJECT = (text) => `(() => {
  const card = document.querySelector('.install-card');
  if (!card) return null;
  card.querySelector('.cli-job')?.remove();
  const job = document.createElement('div');
  job.className = 'cli-job';
  job.dataset.state = 'running';
  const head = document.createElement('div');
  head.className = 'cli-job-head';
  const state = document.createElement('span');
  state.className = 'cli-job-state';
  state.textContent = 'Running…';
  head.appendChild(state);
  const pre = document.createElement('pre');
  pre.className = 'cli-job-output';
  pre.textContent = ${JSON.stringify(text)};
  job.appendChild(head); job.appendChild(pre);
  card.insertBefore(job, card.querySelector('.install-actions'));
  return true;
})()`;

const MEASURE = `(() => {
  const box = (n) => { const b = n.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
  const pane = document.querySelector('.session-pane');
  const card = document.querySelector('.install-card');
  const pre = document.querySelector('.cli-job-output');
  const actions = document.querySelector('.install-actions');
  return {
    pane: box(pane), card: box(card), actions: box(actions),
    pre: pre ? { ...box(pre), scrollH: Math.round(pre.scrollHeight), clientH: Math.round(pre.clientHeight), scrollW: Math.round(pre.scrollWidth), clientW: Math.round(pre.clientWidth) } : null,
  };
})()`;

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
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
      // The whole point: the default agent's CLI must probe as MISSING, which is the one state that
      // draws the install card at all.
      REALM_CLAUDE_BIN: path.join(scratch, "no-such-claude"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const t = await until(async () => (await targets()).find((x) => x.type === "page" && x.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(t.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(input, "Live"); input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit();
    return true; })()`);

  // A short viewport on purpose: the card has the least room here, so this is where an uncapped
  // panel would push it out of the pane.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await until(() => evalIn(c, `!!document.querySelector('.install-card')`), 30000, "install card");
  await sleep(400);

  // Before any injection: the real chain, end to end. The probe found no claude, the server offered
  // an install, and the card grew a button — none of which a jsdom test can say together.
  console.log("== the offer, from a real probe ==");
  const offer = await evalIn(c, `(() => {
    const card = document.querySelector('.install-card');
    return {
      command: card.querySelector('.install-cmd code')?.textContent ?? null,
      buttons: [...card.querySelectorAll('button')].map((b) => b.textContent.trim()),
    };
  })()`);
  console.log(`  --    ${JSON.stringify(offer)}`);
  check("the card shows the real install command", offer.command === "npm install -g @anthropic-ai/claude-code", offer);
  check("the card offers to run it", offer.buttons.includes("Install"), offer);
  check("and still offers the terminal route it always had", offer.buttons.includes("Open in terminal"), offer);

  console.log("\n== the panel's box ==");
  const long = Array.from({ length: 400 }, (_, i) => `npm http fetch GET 200 https://registry.npmjs.org/pkg-${i} 812ms`).join("\n");
  check("the card injects", await evalIn(c, INJECT(long)) === true);
  await sleep(200);
  const m = await evalIn(c, MEASURE);
  console.log(`  --    pane ${m.pane.h}px, card ${m.card.h}px, pre ${m.pre.clientH}px of ${m.pre.scrollH}px`);
  check("400 lines of output scroll instead of growing", m.pre.scrollH > m.pre.clientH && m.pre.clientH <= 200, m.pre);
  check("the card stays inside its pane", m.card.top >= m.pane.top - 1 && m.card.bottom <= m.pane.bottom + 1, { card: m.card, pane: m.pane });
  check("the Install button is still inside the pane", m.actions.bottom <= m.pane.bottom + 1, m.actions);

  console.log("\n== a single unbreakable token ==");
  // A real one: npm prints integrity hashes and long registry URLs with no space to break at.
  const token = "sha512-" + "wbHDmit7SYvBGVX1DQmk13xtWblZ2cApeJpB7xDZ10C".repeat(9);
  await evalIn(c, INJECT(token));
  await sleep(200);
  const w = await evalIn(c, MEASURE);
  console.log(`  --    token ${token.length} chars, pre ${w.pre.clientW}px wide, content ${w.pre.scrollW}px`);
  check("the token wraps rather than widening the card", w.pre.scrollW <= w.pre.clientW + 1, w.pre);
  check("the card is no wider than the pane", w.card.w <= w.pane.w, { card: w.card.w, pane: w.pane.w });

  c.close();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
}

main()
  .catch((e) => { console.error(e); failures += 1; })
  .finally(() => {
    electron?.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(failures === 0 ? 0 : 1);
  });
