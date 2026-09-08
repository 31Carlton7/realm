/**
 * ⌘K and the search field (run with: node apps/desktop/scripts/cmdk-live.mjs)
 *
 * Two things jsdom cannot answer. Whether the palette ACTUALLY animates — a keyframe that is
 * declared but never applied looks identical in a stylesheet read and identical in a zero-rect DOM,
 * and "it just appeared" is the only symptom. And what the prompter's corner ratio actually IS,
 * which is a fact about the composer's rendered height rather than about any number in the source.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9369), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8935);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-ck-live-"));
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
  const out = path.join(os.tmpdir(), `realm-ck-live-${tag}.png`);
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

  /* ── 1. Does the palette animate at all? ────────────────────────────────── */
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(400);
  const anim = await evalIn(c, `(() => new Promise((resolve) => {
    const seen = [];
    const obs = () => {
      const p = document.querySelector('.palette');
      if (!p) return false;
      const running = p.getAnimations().map((a) => ({
        name: a.animationName, ms: Math.round(a.effect.getComputedTiming().duration), state: a.playState,
      }));
      seen.push(...running);
      return true;
    };
    // Open it the way a person does, then look at what is actually running on the element.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    requestAnimationFrame(() => { obs(); resolve({ seen, open: !!document.querySelector('.palette') }); });
  }))()`);
  check("the palette is on screen after cmd-K", anim.open, anim);
  check("…and something is actually animating it", anim.seen.length > 0, anim.seen);
  if (anim.seen.length) check("the enter is a real, finite duration", anim.seen.every((a) => a.ms > 0), anim.seen);

  await shot(c, "palette", { x: 380, y: 60, width: 640, height: 380 });
  await evalIn(c, `(() => { document.querySelector('.palette-backdrop').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  await sleep(300);

  /* ── 2. The prompter's corner ratio, measured ───────────────────────────── */
  const geom = await evalIn(c, `(() => {
    const el = (s) => document.querySelector(s);
    const box = (s) => { const n = el(s); return n ? __live.box(n) : null; };
    const rad = (s) => { const n = el(s); if (!n) return null;
      const cs = getComputedStyle(n);
      // The painted surfaces carry radius 0 and keep the real number in --sq-radius-top.
      const declared = cs.getPropertyValue('--sq-radius-top').trim() || cs.borderRadius;
      return declared; };
    return { composer: box('.composer'), composerR: rad('.composer'),
             search: box('.search'), searchR: rad('.search'),
             composerBg: getComputedStyle(el('.composer')).backgroundImage,
             searchBg: getComputedStyle(el('.search')).backgroundImage };
  })()`);
  console.log("GEOM " + JSON.stringify(geom));

  /* Buttons declare the curve but are NOT painted — a paint would need every hover/primary/danger
     fill re-declared as a worklet input, and any one forgotten is an invisible button. This is the
     check that the fills survived: a control whose background resolved to `paint(rl-squircle)` with
     no `--sq-fill` renders as nothing at all, and nothing in a stylesheet says so. */
  const btns = await evalIn(c, `(() => {
    const out = [];
    for (const sel of ['.btn', '.icon-btn', '.search']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const cs = getComputedStyle(el);
      out.push({ sel, bg: cs.backgroundImage, color: cs.backgroundColor, radius: cs.borderRadius,
                 painted: cs.backgroundImage.includes('rl-squircle'),
                 fill: cs.getPropertyValue('--sq-fill').trim() });
    }
    return out;
  })()`);
  for (const b of btns) {
    const ok = !b.painted || b.fill !== "";
    check(`${b.sel}: keeps a real fill (painted surfaces must supply one)`, ok, b);
  }
  const btn = btns.find((b) => b.sel === ".btn");
  if (btn) check("a text button wears the ratio corner, not the control rung", parseFloat(btn.radius) > 10, btn);

  /* The prompter's corner is a PROPORTION of its own height, and that is the thing a smaller control
     copies — 36px on a 30px field would be a pill. Measured rather than asserted from the source,
     because the composer's height is content-driven. */
  const ratio = parseFloat(geom.composerR) / geom.composer.h;
  const want = geom.search.h * ratio;
  const got = parseFloat(geom.searchR);
  check("the search field wears the prompter's corner RATIO, not its number",
    Math.abs(got - want) <= 1.5, { composer: `${geom.composerR} on ${geom.composer.h}px`, ratio: ratio.toFixed(3), want: want.toFixed(1), got });
  check("…and the prompter's surface, painted the same way", geom.searchBg === geom.composerBg, geom);
  await shot(c, "search", { x: 0, y: 24, width: 300, height: 70 });

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
