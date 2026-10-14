/**
 * Live check for Realm's video player and for opening the files an agent generates
 * (run with: node apps/desktop/scripts/video-player-live.mjs, after `pnpm build`).
 *
 * Boots the BUILT app on a scratch REALM_HOME with every session on the scripted agent, which echoes
 * what it is sent — so a report naming files the "agent" generated outside the space comes back as
 * a real assistant message through the real transcript. Then:
 *
 *   1. a video in a folder with a space and an accent in its name, outside the space, opens from the
 *      transcript's path menu into Realm's player in the documents pane — never the OS;
 *   2. the player seeks by keyboard and lands, which needs the scheme's 206 answers;
 *   3. main reads the paths agents write — `file://`, `:42`, relative to the session's directory;
 *   4. a file in the session's directory opens by a relative name with a line on it, as `docs_open`
 *      sends it (`documents.openPath` with the session's cwd);
 *   5. a ProRes `.mov`, which Chromium cannot decode, says so and plays once ffmpeg makes a copy;
 *   6. screenshots of the player, dark and light.
 *
 * Ports: REALM_PORT 8800, CDP 9240 (override with env). Refuses to run if either is taken. Touches
 * only its scratch dir; kills only the process it started. Needs ffmpeg for the fixtures.
 */
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.REALM_DEVTOOLS_PORT ?? 9240), SERVER_PORT = Number(process.env.REALM_PORT ?? 8800);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-video-live-"));
const OUT = process.env.LIVE_OUT ?? path.join(scratch, "shots");
fs.mkdirSync(OUT, { recursive: true });
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portFree = (port) => new Promise((resolve) => {
  const s = connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});

async function until(fn, ms, tag) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not ready */ }
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${tag}`);
    await sleep(150);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
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

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
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

const HELPERS = `globalThis.__live = globalThis.__live ?? {
  setInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
}; void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function shot(c, name) {
  const data = (await c.send("Page.captureScreenshot", { format: "png" })).data;
  const file = path.join(OUT, `video-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${name} ${file}`);
}

async function setMode(c, mode) {
  await evalIn(c, `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.palette input')`), 5000, "palette");
  const label = `Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`;
  await evalIn(c, `(() => { __live.setInput(document.querySelector(".palette input"), ${JSON.stringify(label)}); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === ${JSON.stringify(label)});
    if (!hit) return null; hit.click(); return true; })()`), 3000, label);
  await until(async () => (await evalIn(c, `document.documentElement.dataset.mode`)) === mode, 10000, `${mode} mode`);
}

const ffmpeg = (args, what) => {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg could not make ${what}: ${r.stderr || r.error?.message}`);
};

/** The player in the documents pane, as main and the decoder see it. */
const paneVideo = (c) => evalIn(c, `(() => {
  const v = document.querySelector('.documents-video video');
  if (!v) return null;
  const r = v.getBoundingClientRect();
  return { src: v.getAttribute('src'), ready: v.readyState, w: v.videoWidth, h: v.videoHeight, t: Math.round(v.currentTime * 10) / 10,
    duration: Math.round((v.duration || 0) * 10) / 10, box: [Math.round(r.width), Math.round(r.height)],
    failed: document.querySelector('.documents-video .video-failed')?.textContent ?? null };
})()`);

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  // What the "agent" generated, outside the space: a folder with a space in it, a name with an accent.
  const made = path.join(scratch, "agent out");
  fs.mkdirSync(made);
  const clip = path.join(made, "rendér clip.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip], "the h264 clip");
  const prores = path.join(made, "take.mov");
  ffmpeg(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=2", "-c:v", "prores_ks", "-profile:v", "3", prores], "the ProRes take");

  const home = path.join(scratch, "home");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    // A scratch window must never take the owner's typing.
    'app.on("browser-window-created", (_e, w) => { w.setFocusable(false); w.setTitle("SCRATCH — video check");',
    '  w.on("page-title-updated", (e) => e.preventDefault()); });',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...process.env, REALM_HOME: home, REALM_HTML_MENUS: "1", REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 40000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.setInput(input, "Renders"); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30000, "composer");
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);

  const api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  // The onboarding session runs the first engine this Mac has — a real, billed one. Fake, first.
  const sessions = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15000, "a session");
  for (const s of sessions) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  const session = sessions[0];
  // …and something it "generated" in its own working directory.
  const cwdFile = path.join(session.cwd, "plot.py");
  fs.writeFileSync(cwdFile, Array.from({ length: 60 }, (_, i) => `print(${i})`).join("\n") + "\n");
  const cwdClip = path.join(session.cwd, "preview.webm");
  ffmpeg(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=15:duration=3", "-c:v", "libvpx-vp9", "-b:v", "200k", cwdClip], "the webm in the session's directory");

  const report = [
    "Done. The render is at `" + clip + "`, the raw take is `" + prores + "`,",
    "and the script I ran is `plot.py:12` in this folder.",
  ].join("\n");
  await api.call("sessions.send", { id: session.id, text: report, attachments: [], mentions: [] });

  // 1. The transcript's path → Open → the player in the documents pane.
  const pathMark = await until(() => evalIn(c, `(() => {
    const el = [...document.querySelectorAll('.md-path')].find((e) => e.getAttribute('data-path') === ${JSON.stringify(clip)});
    if (!el) return null; el.click(); return el.getAttribute('data-path'); })()`), 30000, "the path in the transcript");
  check("the path with a space and an accent is marked whole", pathMark === clip, pathMark);
  const openItem = await until(() => evalIn(c, `(() => { const item = [...document.querySelectorAll('[role=menuitem]')].find((m) => /^Open rendér clip\\.mp4/.test(m.textContent.trim()));
    if (!item) return null; item.click(); return item.textContent.trim(); })()`), 8000, "the Open row");
  check("the path menu offers Open for the video", !!openItem, openItem);
  const played = await until(async () => { const v = await paneVideo(c); return v && v.ready >= 1 ? v : null; }, 20000, "the pane's player");
  check("the video opened in Realm's player in the documents pane", played.w === 640 && played.h === 360 && Math.abs(played.duration - 8) < 0.5, played);
  const tabTitles = await evalIn(c, `[...document.querySelectorAll('.documents-tab-label')].map((b) => b.title)`);
  check("its outside tab is the absolute path", tabTitles.includes(clip), tabTitles);

  // 2. Keyboard seek lands — the scheme answered the Range request.
  await evalIn(c, `(() => { const p = document.querySelector('.documents-video .video-player'); p.focus();
    for (const key of ['l', 'ArrowRight']) p.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); return true; })()`);
  const seeked = await until(async () => { const v = await paneVideo(c); return v && v.t >= 7.5 ? v : null; }, 8000, "the seek").catch(() => null);
  const after = seeked ?? await paneVideo(c);
  check("L and → seek 15s, clamped to the 8s clip, and land", after && after.t >= 7.5, after);
  await evalIn(c, `(() => { const v = document.querySelector('.documents-video video'); v.currentTime = 3; return true; })()`);
  await sleep(600);
  await evalIn(c, `(() => { const p = document.querySelector('.documents-video .video-player'); p.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })); return true; })()`);
  await setMode(c, "dark");
  await sleep(500);
  await shot(c, "pane-dark");
  await setMode(c, "light");
  await sleep(500);
  await shot(c, "pane-light");

  // 3. Main reads the paths agents write.
  const resolved = await evalIn(c, `(async () => ({
    url: await window.realm.files.resolve(${JSON.stringify("file://" + encodeURI(clip))}),
    line: await window.realm.files.resolve("plot.py:12", ${JSON.stringify(session.cwd)}),
    tilde: await window.realm.files.resolve("~/definitely-not-here-${Date.now()}.mp4"),
  }))()`);
  check("main resolves a file:// URL, a :line relative to the session, and refuses nothing-there", resolved.url === clip && resolved.line === cwdFile && resolved.tilde === null, resolved);

  // 4. As docs_open sends it: relative to the session's directory, with a line.
  const opened = await api.call("documents.openPath", { spaceId: session.spaceId, environmentId: session.environmentId, path: "preview.webm", base: session.cwd, openedBy: session.id });
  check("a relative video in the session's directory opens as docs_open sends it", opened.path.endsWith("preview.webm"), opened);
  const webm = await until(async () => { const v = await paneVideo(c); return v && v.ready >= 1 && v.src.includes("preview.webm") ? v : null; }, 15000, "the webm").catch(() => null);
  check("…and plays in the player", webm && webm.w === 320, webm);

  // 5. ProRes: the honest failure, then a playable copy.
  await api.call("documents.openPath", { spaceId: session.spaceId, environmentId: session.environmentId, path: prores, openedBy: session.id });
  const failed = await until(async () => { const v = await evalIn(c, `document.querySelector('.documents-video .video-failed')?.textContent ?? null`); return v; }, 20000, "the failure").catch(() => null);
  check("a ProRes .mov says Realm cannot play its format, with the ways out", !!failed && /cannot play the video format/.test(failed) && /Reveal in Finder/.test(failed), failed);
  await shot(c, "prores-light");
  await until(() => evalIn(c, `(() => { const b = [...document.querySelectorAll('.documents-video button')].find((x) => x.textContent === 'Make a playable copy'); if (!b) return null; b.click(); return true; })()`), 8000, "the copy button");
  const copy = await until(async () => { const v = await paneVideo(c); return v && v.ready >= 1 && !v.failed ? v : null; }, 60000, "the playable copy").catch(() => null);
  check("ffmpeg's copy plays in the player", copy && copy.w === 320 && /playable/.test(copy.src), copy);
  await setMode(c, "dark");
  await sleep(400);
  await shot(c, "copy-dark");

  console.log(`\nShots in ${OUT}`);
  c.close(); api.close();
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  try { electron?.kill("SIGTERM"); } catch { /* gone */ }
  setTimeout(() => {
    // The server is a second Electron holding the port; reap it by port, never by name.
    const r = spawnSync("lsof", ["-ti", `tcp:${SERVER_PORT}`], { encoding: "utf8" });
    for (const pid of r.stdout.split("\n").filter(Boolean)) try { process.kill(Number(pid), "SIGTERM"); } catch { /* gone */ }
    if (!process.env.LIVE_KEEP) fs.rmSync(path.join(scratch, "home"), { recursive: true, force: true });
    process.exit();
  }, 1500);
});
