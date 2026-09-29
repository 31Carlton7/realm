/**
 * Live check for the streamed prose's arrival fade (run with: node apps/desktop/scripts/stream-fade-live.mjs
 * after `pnpm build` — this boots the BUILT app).
 *
 * jsdom proves the spans are made with the right delays; only a real engine can say the fade RUNS.
 * The thing most worth catching is the one the design exists for: the markup is rewritten on every
 * delta, so a fade that did not RESUME would restart at zero on each write — a span older than its
 * last write would show an animation clock near 0 instead of near its age. That is read here off
 * `getAnimations()` on the real spans, mid-stream.
 *
 * Also: reduced motion leaves the text fully opaque, and a transcript read back from history (a
 * reload) fades nothing. A frame mid-stream is saved for the eye.
 *
 * Touches only a scratch dir; kills only what it started, and reaps both ports on the way out —
 * the server is a second Electron that outlives a killed parent.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9234), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8794);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-stream-fade-"));
const shotDir = process.env.LIVE_SHOT_DIR ?? path.join(os.tmpdir(), "realm-stream-fade-shots");
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
    await sleep(50);
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

/** The server's own RPC socket. The session is switched to the scripted agent over the wire: the
 *  onboarding session takes the first engine this Mac can run, which is a real, billed model. */
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);


/**
 * Every arrival span on screen, as the ENGINE has it: its declared delay, the opacity it is painting
 * at, and its animation's clock — which starts when the span was made, i.e. at the last write, so
 * every span in one frame reads the same clock and only the delay says how old its text is. Null
 * clock: the fade is over and the animation gone. Read in one evaluation, so the numbers are one
 * frame's rather than a smear across several.
 */
const SAMPLE = `(() => [...document.querySelectorAll('.msg-assistant .md-arrival')].map((s) => {
  const a = s.getAnimations()[0];
  const cs = getComputedStyle(s);
  return { text: s.textContent, delay: s.style.animationDelay, opacity: Number(cs.opacity), name: cs.animationName,
    clock: a ? Math.round(a.currentTime) : null };
}))()`;

const ANSWER_END = "reads exactly as it did.";
const finished = `[...document.querySelectorAll('.msg-assistant')].some((m) => m.textContent.includes(${JSON.stringify(ANSWER_END)}))
  && !document.querySelector('.msg-assistant-row[data-state="streaming"]')`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  fs.mkdirSync(shotDir, { recursive: true });

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
  const rendererTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(rendererTarget.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 820, deviceScaleFactor: 2, mobile: false });
  await sleep(500);

  const api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const sessions = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15000, "a session to drive");
  const sessionId = sessions[0].id;
  await api.call("sessions.setAgent", { id: sessionId, agentKind: "fake" });
  const send = (text) => api.call("sessions.send", { id: sessionId, text, attachments: [], mentions: [] });

  /* ── 1. A real stream: sample the spans the engine is animating ─────────────────────────────── */
  await send("stream slowly");
  await until(() => evalIn(c, `!!document.querySelector('.msg-assistant-row[data-state="streaming"]')`), 20000, "the answer to start streaming");
  const samples = [];
  let shot = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const s = await evalIn(c, SAMPLE);
    if (s.length) samples.push(s);
    if (!shot && s.length >= 4) {
      // A frame for the eye, mid-stream: the frontier words should be visibly lighter than the rest.
      const png = await c.send("Page.captureScreenshot", { format: "png" });
      shot = path.join(shotDir, "stream-fade-midstream.png");
      fs.writeFileSync(shot, Buffer.from(png.data, "base64"));
    }
    if (await evalIn(c, finished)) break;
    await sleep(25);
  }
  note("samples taken mid-stream", samples.length);
  const all = samples.flat();
  check("arrival spans existed while the answer streamed", all.length > 0, all.length);
  check("every span the engine resolved runs the fade (rl-fade-in), not 'none'", all.every((s) => s.name === "rl-fade-in"), [...new Set(all.map((s) => s.name))]);
  check("some span was caught mid-fade — painting below full opacity", all.some((s) => s.opacity < 0.95), Math.min(...all.map((s) => s.opacity)));
  /* THE point of the design, read off the engine. Within one frame every span still fading was
     rebuilt by the same write, so fades that RESTARTED on a write would all stand at one opacity.
     Resumed, older text is further along: opacity rises with age, oldest to newest, with a real
     spread between them. */
  const fading = samples.map((f) => f.filter((s) => s.clock !== null)).filter((f) => f.length >= 3);
  const byAge = (f) => [...f].sort((a, b) => Number.parseFloat(a.delay) - Number.parseFloat(b.delay)); // oldest first
  const resumed = fading.filter((f) => {
    const o = byAge(f);
    return o.every((s, i) => i === 0 || s.opacity <= o[i - 1].opacity + 1e-6) && o[0].opacity - o.at(-1).opacity > 0.3;
  });
  const example = fading.length ? byAge(fading[Math.floor(fading.length / 2)]).map((s) => [s.delay, Number(s.opacity.toFixed(3))]) : null;
  check("a fade carried across a rewrite resumes at its age: in every frame, older text is further along",
    fading.length > 0 && resumed.length === fading.length, { frames: fading.length, resumed: resumed.length, example });
  if (shot) note("mid-stream frame", shot);

  await until(() => evalIn(c, finished), 20000, "the answer to finish");
  const text = await evalIn(c, `[...document.querySelectorAll('.msg-assistant')].at(-1).textContent`);
  for (const bit of ["The mapper reads each SDK message once", "Plans travel as their own event.", "apps/server/src/sessions/service.ts", ANSWER_END]) {
    check(`the finished answer reads in full: "${bit.slice(0, 32)}…"`, text.includes(bit));
  }
  await sleep(1100); // past the horizon: every fade is over
  const settled = await evalIn(c, SAMPLE);
  check("once the answer settles, everything on screen is at full opacity", settled.every((s) => s.opacity === 1), settled.map((s) => s.opacity));

  /* ── 2. Reduced motion: the text is simply there ─────────────────────────────────────────────── */
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await send("stream slowly");
  await until(() => evalIn(c, `document.querySelectorAll('.msg-assistant-row[data-state="streaming"]').length > 0`), 20000, "the second answer to start");
  const reduced = [];
  const t1 = Date.now();
  while (Date.now() - t1 < 4000) { reduced.push(...(await evalIn(c, SAMPLE))); await sleep(40); }
  check("with reduced motion, no span animates and none is below full opacity",
    reduced.length > 0 && reduced.every((s) => s.name === "none" && s.opacity === 1), { n: reduced.length, names: [...new Set(reduced.map((s) => s.name))] });
  await c.send("Emulation.setEmulatedMedia", { features: [] });
  await until(() => evalIn(c, `document.querySelectorAll('.msg-assistant').length >= 2 && !document.querySelector('.msg-assistant-row[data-state="streaming"]')`), 20000, "the second answer to finish");

  /* ── 3. History is still: a reload reads the transcript back and fades none of it ─────────────── */
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.querySelectorAll('.msg-assistant').length >= 2`), 20000, "the transcript after reload");
  await sleep(300);
  const afterReload = await evalIn(c, SAMPLE);
  check("a transcript read back from history has no arrival spans at all", afterReload.length === 0, afterReload.length);
}

main()
  .catch((e) => { console.log(`FAIL harness ${e.message}`); process.exitCode = 1; })
  .finally(async () => {
    try { electron?.kill("SIGKILL"); } catch {}
    await sleep(300);
    for (const p of [SERVER_PORT, CDP_PORT]) {
      try { execSync(`lsof -ti tcp:${p} | xargs kill -9`, { stdio: "ignore" }); } catch {}
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
