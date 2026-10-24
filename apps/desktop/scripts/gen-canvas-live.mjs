/**
 * Live check: a picture and a video being made, as the transcript draws them while the call is in
 * flight (run with: pnpm build && node apps/desktop/scripts/gen-canvas-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and seeds one session straight into its DB: a
 * `generate_image` call and an `ffmpeg` encode, neither with a result, in a session marked running —
 * so no agent runs and nothing is billed. Then it measures the canvases, samples the ring's turn
 * across frames, and captures both faces, a run of frames, Reduce motion and a quiet window.
 *
 * Ports: LIVE_SERVER_PORT (8793), LIVE_CDP_PORT (9233). Writes only under LIVE_SCRATCH (the OS temp
 * dir by default); LIVE_OUT keeps the captures.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9233);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8793);
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-gen-canvas-live-"));
const home = path.join(scratch, "home");
const OUTDIR = process.env.LIVE_OUT ?? path.join(scratch, "shots");
fs.mkdirSync(OUTDIR, { recursive: true });
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
    await sleep(150);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails?.exception?.description ?? "exception");
  });
  return {
    ready, errors,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
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

const HELPERS = `
globalThis.__live = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) }; },
  centre(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2) }; },
  pane: (asked) => [...document.querySelectorAll(".session-pane")].find((p) => [...p.querySelectorAll(".msg-user")].some((m) => m.textContent.includes(asked))) ?? null,
  card: (id) => document.querySelector('.tool-card[data-tool-use-id="' + id + '"]'),
  async show(el) { el?.scrollIntoView({ block: "center" }); await new Promise((r) => setTimeout(r, 350)); return __live.box(el); },
  /** A CSS colour of any syntax (oklch, color-mix) as sRGB bytes, by painting it. */
  rgb(css) { const cv = document.createElement("canvas"); cv.width = cv.height = 1; const x = cv.getContext("2d", { willReadFrequently: true });
    x.clearRect(0, 0, 1, 1); x.fillStyle = css; x.fillRect(0, 0, 1, 1); const d = x.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; },
  /** WCAG contrast of an element's ink against the pane's ground tokens — the authored grounds, since
   *  a CDP capture has none of the window's material under them. The worst of the two is the claim. */
  contrast(el) {
    const lum = ({ r, g, b }) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const probe = document.createElement("div"); el.parentElement.appendChild(probe);
    const token = (name) => { probe.style.background = "var(" + name + ")"; return __live.rgb(getComputedStyle(probe).backgroundColor); };
    const page = token("--page");
    const grounds = { panel: over(token("--rl-panel"), page), canvas: over(token("--canvas"), page), page };
    probe.remove();
    const ink = __live.rgb(getComputedStyle(el).color);
    const ratio = (g) => { const [a, b] = [lum(over(ink, g)), lum(g)].sort((x, y) => y - x); return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100; };
    const each = Object.fromEntries(Object.entries(grounds).map(([k, g]) => [k, ratio(g)]));
    return { ratio: Math.min(...Object.values(each)), each, ink: getComputedStyle(el).color };
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function shoot(c, tag, clip) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 2 } } : {}) });
  const out = path.join(OUTDIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}
const pad = (b, n = 12) => (b ? { x: Math.max(0, b.x - n), y: Math.max(0, b.y - n), w: b.w + 2 * n, h: b.h + 2 * n } : null);

async function paletteRow(c, label) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!hit) return null; hit.click(); return true; })()`), 3000, `palette row ${label}`);
}

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home, REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
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
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Generating");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

const ASKED = "Make the cover art and encode the teaser";

/** The turn, stopped mid-flight: two media calls with no result, in a session still running. */
function seed(sessionId) {
  let t = Date.now() - 20_000;
  const ev = [
    [t += 1_000, "user_message", { text: ASKED, attachments: [] }],
    [t += 1_000, "status", { status: "running" }],
    [t += 1_000, "assistant_text", { messageId: "m1", text: "Drawing the cover first." }],
    [t += 1_000, "tool_call", { toolUseId: "img1", name: "mcp__media__generate_image", input: { prompt: "a calm mountain lake at dawn, mist over the water" }, parentToolUseId: null }],
    [t += 1_000, "assistant_text", { messageId: "m2", text: "And the teaser, while that runs." }],
    [t += 1_000, "tool_call", { toolUseId: "vid1", name: "Bash", input: { command: "ffmpeg -i teaser.mov -vf scale=1920:1080 teaser.mp4", description: "Encode the teaser at 1080p" }, parentToolUseId: null }],
  ];
  const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
  const sql = ev.map(([ts, type, payload]) => `INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (${q(sessionId)}, ${ts}, ${q(type)}, ${q(JSON.stringify(payload))});`);
  sql.push(`UPDATE sessions SET status = 'running' WHERE id = ${q(sessionId)};`);
  execFileSync("sqlite3", ["-cmd", ".timeout 5000", path.join(home, "realm.db"), sql.join("\n")]);
}

const canvases = (c) => evalIn(c, `(() => [...document.querySelectorAll(".gen-canvas")].map((el) => {
  const spin = el.querySelector(".gen-spin"), glyph = el.querySelector(".gen-glyph"), mark = el.querySelector(".gen-mark");
  const cs = spin ? getComputedStyle(spin) : null, anim = spin?.getAnimations()[0];
  return { kind: el.dataset.kind, box: __live.box(el), mark: __live.box(mark), glyph: __live.box(glyph),
    spin: spin ? { display: cs.display, rotate: cs.rotate, state: anim?.playState ?? null, box: __live.box(spin) } : null,
    res: el.querySelector(".gen-res")?.textContent ?? null, label: el.parentElement.querySelector(".gen-label")?.textContent,
    detail: el.parentElement.querySelector(".gen-detail")?.textContent ?? null }; }))()`);

async function main() {
  const c = await boot();
  const [first] = await api.call("sessions.listAll", {});
  await api.call("sessions.setAgent", { id: first.id, agentKind: "fake" });
  const made = await api.call("sessions.create", { spaceId: first.spaceId, agentKind: "fake" });
  const id = made.session?.id ?? made.id;
  seed(id);
  await api.call("items.update", { id: made.itemId ?? made.item?.id, title: "Cover art" }).catch(() => {});
  await sleep(400);
  await evalIn(c, `(() => { const row = [...document.querySelectorAll(".item-row")].find((r) => r.textContent.includes("Cover art")); row?.click(); return !!row; })()`);
  await until(() => evalIn(c, `document.querySelectorAll(".gen-canvas").length === 2`), 20_000, "two generating canvases");
  await sleep(800);

  const [img, vid] = await canvases(c);
  note("canvases", { img, vid });
  check("the picture is a square and the encode its stated 16:9, with its frame size", Math.abs(img.box.w - img.box.h) <= 1 && Math.abs(vid.box.w / vid.box.h - 16 / 9) < 0.02 && vid.res === "1920 × 1080", { img: img.box, vid: vid.box, res: vid.res });
  check("each wears its kind's glyph, centred in the canvas and in its ring",
    img.kind === "image" && vid.kind === "video" && [img, vid].every((k) => Math.abs((k.mark.x + k.mark.w / 2) - (k.box.x + k.box.w / 2)) <= 1
      && Math.abs((k.mark.y + k.mark.h / 2) - (k.box.y + k.box.h / 2)) <= 1 && Math.abs((k.glyph.x + k.glyph.w / 2) - (k.mark.x + k.mark.w / 2)) <= 1), { img, vid });
  check("the caption says what is being made", img.label === "Generating image" && /mountain lake/.test(img.detail ?? "") && vid.label === "Encoding video", { img: img.label, vid: vid.label });

  // The turn, sampled: the ring advances across the samples (two reads may land on one frame).
  const turns = [];
  for (let i = 0; i < 6; i++) { turns.push(await evalIn(c, `document.querySelector(".gen-spin").getAnimations()[0].currentTime`)); await sleep(150); }
  const period = await evalIn(c, `document.querySelector(".gen-spin").getAnimations()[0].effect.getComputedTiming().duration`);
  note("turn", { period, turns });
  check("the ring is running, one turn every 1.8s", period === 1800 && turns.every((t, i) => i === 0 || t >= turns[i - 1]) && turns.at(-1) - turns[0] > 400, { period, turns });

  for (const face of ["dark", "light"]) {
    if (face === "light") { await paletteRow(c, "Theme: Light"); await sleep(800); }
    const col = await evalIn(c, `(async () => { const k = document.querySelector(".gen-wrap"); k.scrollIntoView({ block: "start" });
      const p = document.querySelector(".transcript"); p.scrollTop -= 60; await new Promise((r) => setTimeout(r, 400));
      const a = __live.box(document.querySelectorAll(".gen-wrap")[0]), b = __live.box(document.querySelectorAll(".gen-wrap")[1]), colb = __live.box(document.querySelector(".transcript-col"));
      return { x: colb.x, y: a.y - 40, w: colb.w, h: b.b - a.y + 52 }; })()`);
    await shoot(c, `transcript-${face}`, pad(col, 4));
    // A run of frames on the picture's ring, close up.
    const ring = await evalIn(c, `__live.box(document.querySelector(".gen-mark"))`);
    for (let i = 0; i < 4; i++) { await shoot(c, `ring-${face}-${i}`, pad(ring, 16)); await sleep(220); }
  }

  // Reduce motion: the ring goes, the glyph stays.
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(300);
  const [still] = await canvases(c);
  check("under Reduce motion the ring goes and the glyph stays", still.spin.display === "none" && still.glyph.w === 20, still);
  await shoot(c, "reduced-light", pad(await evalIn(c, `__live.box(document.querySelector(".gen-canvas"))`), 8));
  await c.send("Emulation.setEmulatedMedia", { features: [] });

  // A quiet window pauses the ring where it stands.
  await evalIn(c, `(document.documentElement.setAttribute("data-quiet", "blur"), true)`);
  await sleep(200);
  const [quiet] = await canvases(c);
  check("a quiet window pauses the ring", quiet.spin.state === "paused", quiet.spin);
  await evalIn(c, `(document.documentElement.removeAttribute("data-quiet"), true)`);

  await paletteRow(c, "Theme: Dark");
  check("no uncaught renderer exceptions", c.errors.length === 0, c.errors.slice(0, 3));
}

async function teardown() {
  try { api?.close(); } catch { /* gone */ }
  await stopDaemons(home).catch(() => {});
  try { electron?.kill("SIGTERM"); } catch { /* gone */ }
  await sleep(800);
  try { electron?.kill("SIGKILL"); } catch { /* gone */ }
  killPort(SERVER_PORT);
  killPort(CDP_PORT);
  if (!process.env.LIVE_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
process.exit(process.exitCode ?? 0);
