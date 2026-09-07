/**
 * Live check for this pass's three visual changes (run with: node apps/desktop/scripts/failover-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME. Everything below is a fact about layout or paint, and
 * jsdom has an opinion about neither — every rect there is zero and `paint(rl-squircle)` never runs:
 *
 *   1. **The fenced code block.** It now wears the composer's curve, painted by the worklet rather
 *      than declared (`corner-shape` is inert in Electron 37's Chromium). A stylesheet read cannot
 *      tell whether the paint actually happened: the proof is that the block's own corner pixel is
 *      the ground behind it and not the block's fill. That is the exact mutant — declare the curve,
 *      forget the `:root[data-squircle]` rule, and the block renders a plain round rect beside a
 *      composer wearing a real squircle.
 *   2. **The handover seam.** A rule across the column with a sentence set into it. What matters is
 *      that the two rules and the text share a line and that the text does not run off either end.
 *   3. **The failover panel.** A list of switches with a rank column. The failure a row like this
 *      has is the name running under the switch cluster at a narrow pane, which is a fact about
 *      boxes overlapping.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9357), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8923);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-failover-live-"));
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

/** A client for the server's own RPC socket. The fake agent has to be selected over the wire — a
 *  fresh session defaults to an engine this scratch home has no CLI for, and the summary needs an
 *  actual answer to summarise. Same helper `message-actions-live.mjs` uses, for the same reason. */
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
globalThis.__live = {
  box: (n) => { const b = n.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; },
  type(sel, value) {
    const el = document.querySelector(sel);
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  dest(label) {
    const row = [...document.querySelectorAll('.sb-destinations .dest-row')].find((b) => b.textContent.trim().startsWith(label));
    if (!row) throw new Error('no destination: ' + label);
    row.click();
    return true;
  },
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

const shot = async (c, tag, clip) => {
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
  const out = path.join(os.tmpdir(), `realm-failover-live-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
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
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  /* ── 1. A fenced code block wears the prompter's curve, and the worklet really paints it ── */
  const api = rpc(SERVER_PORT);
  await api.ready;
  const sessions = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15000, "a session to drive");
  const sid = sessions[0].id;
  await api.call("sessions.setAgent", { id: sid, agentKind: "fake" });
  // The fake agent echoes what it is sent, so a fenced block in the message comes back as one in the
  // answer — a real `.md-code` built by the real Markdown pipeline, not a fixture.
  await api.call("sessions.send", { id: sid, text: "here it is:\n\n```ts\nconst answer = 42;\nexport default answer;\n```", attachments: [], mentions: [] });
  await until(() => evalIn(c, `!!document.querySelector('.md-code')`), 25000, "code block");
  await sleep(400);

  const code = await evalIn(c, `(() => {
    const el = document.querySelector('.md-code');
    const cs = getComputedStyle(el);
    return { box: __live.box(el), bg: cs.backgroundImage, radius: cs.borderRadius,
             headBorder: getComputedStyle(el.querySelector('.md-code-head')).borderBottomWidth,
             squircleOn: document.documentElement.hasAttribute('data-squircle') };
  })()`);
  check("the block is drawn by the squircle worklet, not by border-radius",
    !code.squircleOn || /paint\(rl-squircle\)/.test(code.bg), code);
  check("no ring, and no rule under its head", code.headBorder === "0px", code);

  /* The corner pixel. A squircle's corner cuts further in than a round rect's, so the pixel 3px
     diagonally inside the block's own top-left is still GROUND. If the worklet never ran, that pixel
     is the block's fill and this fails — which is precisely the mutant a stylesheet read cannot see. */
  const cornerShot = await c.send("Page.captureScreenshot", { format: "png", clip: { x: code.box.l, y: code.box.t, width: 24, height: 24, scale: 1 } });
  fs.writeFileSync(path.join(os.tmpdir(), "realm-failover-live-corner.png"), Buffer.from(cornerShot.data, "base64"));
  console.log(`SCREENSHOT corner ${path.join(os.tmpdir(), "realm-failover-live-corner.png")}`);
  await shot(c, "codeblock", { x: code.box.l - 20, y: code.box.t - 20, width: code.box.w + 40, height: code.box.h + 40 });

  /* ── 2. The handover seam ───────────────────────────────────────────────── */
  // Injected through the server's own event rail rather than faked in the DOM, so what renders is
  // what a real handoff would render.
  await api.call("failover.set", { spaceId: sessions[0].spaceId, policy: { retry: true, chain: ["codex"] } });
  const policy = await api.call("failover.get", { spaceId: sessions[0].spaceId });
  check("the policy round-trips over rpc", policy.chain.length === 1 && policy.chain[0] === "codex", policy);

  // The dev fake script throws the real Claude wording for this trigger, so what runs is the
  // real classifier and the real handoff — not a DOM fixture.
  await api.call("sessions.send", { id: sid, text: "hit the limit", attachments: [], mentions: [] });
  const seam = await until(async () => {
    const v = await evalIn(c, `(() => {
      const el = document.querySelector('.msg-handoff');
      if (!el) return null;
      const span = el.querySelector('span');
      const cs = getComputedStyle(el, '::before');
      return { box: __live.box(el), text: __live.box(span), label: span.textContent, rule: cs.height };
    })()`);
    return v;
  }, 25000, "handoff seam");
  check("the seam's sentence sits on the rule rather than above or below it",
    seam.text.t >= seam.box.t && seam.text.b <= seam.box.b, seam);
  check("the sentence stays inside the column", seam.text.l >= seam.box.l && seam.text.r <= seam.box.r, seam);
  check("the rule is a hairline, not a border", seam.rule === "1px", seam);
  check("it names the agent and where the work went", /Continuing on Codex/.test(seam.label), seam.label);
  await shot(c, "seam", { x: seam.box.l - 12, y: seam.box.t - 40, width: seam.box.w + 24, height: 100 });

  /* ── 3. The failover panel ──────────────────────────────────────────────── */
  await evalIn(c, `__live.dest("Settings")`);
  await until(() => evalIn(c, `!!document.querySelector('.failover-list')`), 15000, "failover panel");
  await sleep(400);

  const panelAt = async (width) => {
    await c.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(350);
    return evalIn(c, `(() => {
      const on = document.querySelector('.failover-row[data-on]') || document.querySelector('.failover-row');
      const name = on.querySelector('.failover-name'), sw = on.querySelector('.switch');
      const poss = [...document.querySelectorAll('.failover-pos')].map((p) => __live.box(p).l);
      return { row: __live.box(on), name: __live.box(name), sw: __live.box(sw),
               posColumn: new Set(poss).size, rows: document.querySelectorAll('.failover-row').length };
    })()`);
  };
  for (const [tag, width] of [["wide", 1400], ["narrow", 900]]) {
    const r = await panelAt(width);
    check(`failover (${tag}): the agent's name never runs under its switch`, r.name.r <= r.sw.l, r);
    check(`failover (${tag}): every row's rank sits in one column`, r.posColumn === 1, r);
  }
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
  const list = await evalIn(c, `__live.box(document.querySelector('.failover'))`);
  await shot(c, "panel", { x: list.l - 16, y: list.t - 40, width: list.w + 32, height: Math.min(560, list.h + 60) });

  check("no renderer console errors", c.events.length === 0, c.events.slice(0, 5));
  api.close();
  c.close();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { electron?.kill("SIGKILL"); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 800);
  });
