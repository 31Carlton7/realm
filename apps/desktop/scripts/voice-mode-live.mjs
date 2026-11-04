/**
 * Voice mode, end to end on the BUILT app with the real microphone and the real speakers:
 *
 *   LIVE_THEME=dark|light LIVE_SHOT_DIR=<dir> node apps/desktop/scripts/voice-mode-live.mjs
 *
 * A scratch home, one session on Claude Haiku (the cheapest model — two short turns a run, billed to
 * the signed-in account), and the person's side played through the speakers with `say`, so it reaches
 * the app the way a voice does: through the air and the microphone. It records the window with
 * `screencapture` and the room with the app's own microphone, and muxes the two into one movie.
 *
 * What it shows: words heard as they are said, the message sent when the speaker stops, the reply read
 * back, and a barge-in — talking over the reply stops it.
 *
 * It TAKES OVER THE SCREEN: the window comes to the front for the recording. Keep hands off. The first
 * run on a Mac raises macOS's microphone prompt for the test Electron; the script waits for a person
 * to click Allow.
 *
 * Electron is launched through LaunchServices (`open`), so the microphone is asked of this Electron
 * rather than of whatever app ran the script.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9223), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8788);
const CMD_PORT = Number(process.env.LIVE_CMD_PORT ?? 9453);
const THEME = process.env.LIVE_THEME === "light" ? "light" : "dark";
const MODEL = process.env.LIVE_MODEL ?? "claude-haiku-4-5";
const shots = process.env.LIVE_SHOT_DIR ?? path.join(os.tmpdir(), "realm-voice-live");
const SAY_VOICE = process.env.LIVE_SAY_VOICE ?? "Daniel";
/** The Mac's own speakers and microphone, whatever the system's defaults are (headphones, often):
 *  the person's side has to cross the room to be heard. Matched by name, in `say` and in the page. */
const SPEAKERS = process.env.LIVE_SPEAKERS ?? "MacBook Pro Speakers";
const MIC_LABEL = process.env.LIVE_MIC_LABEL ?? "MacBook Pro Microphone";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-voice-live-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1);
const note = (name, detail) => console.log(`${at()}s INFO ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${at()}s ${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function portFree(port) {
  return new Promise((resolve) => { const s = connect({ port, host: "127.0.0.1" }); s.once("connect", () => { s.destroy(); resolve(false); }); s.once("error", () => resolve(true)); });
}
async function until(fn, ms, tag) {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - start > ms) throw new Error(`timeout:${tag}`); await sleep(100); }
}
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).split("\n").map((l) => Number(l.trim())).filter((n) => n > 0);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  } catch { /* none */ }
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return { ready, close: () => ws.close(), send: (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result))); ws.send(JSON.stringify({ id: i, method, params })); }) };
}
async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token)); let id = 0; const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return { ready, close: () => ws.close(), call: (method, params) => new Promise((res, rej) => { const i = String(++id); pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`)))); ws.send(JSON.stringify({ id: i, method, params })); }) };
}

/** Main's half: the window's place on screen, and bringing it to the front. */
const WRAPPER = [
  'import { app, BrowserWindow } from "electron";',
  'import net from "node:net";',
  'app.setPath("userData", process.env.LIVE_USER_DATA);',
  "const win = () => BrowserWindow.getAllWindows()[0];",
  "const run = (line) => {",
  "  const w = win();",
  "  if (line === 'front') { w.setBounds({ x: 160, y: 90, width: 1180, height: 780 }); app.focus({ steal: true }); w.show(); w.focus(); }",
  "  if (line === 'bounds') return JSON.stringify(w.getBounds());",
  "  return 'ok';",
  "};",
  "net.createServer((sock) => { let buf = ''; sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); let out; try { out = run(line); } catch (e) { out = 'error ' + e.message; } sock.write(out + '\\n'); } }); }).listen(Number(process.env.LIVE_CMD_PORT), '127.0.0.1');",
  "await import(process.env.LIVE_MAIN);",
].join("\n");

function ask(line) {
  return new Promise((resolve, reject) => {
    const sock = connect({ port: CMD_PORT, host: "127.0.0.1" });
    let buf = "";
    sock.on("data", (d) => { buf += d; if (buf.includes("\n")) { sock.end(); resolve(buf.trim()); } });
    sock.on("error", reject);
    sock.write(`${line}\n`);
  });
}

/** The person, through the speakers. Resolves when they stop talking. */
function say(text) {
  note("say", text);
  return new Promise((resolve) => { const p = spawn("say", ["-v", SAY_VOICE, "-r", "185", "-a", SPEAKERS, text]); p.on("close", resolve); });
}

let electron = null, recorder = null;
/** LIVE_SPEECH=0: the views alone, on the fake agent — for a room where nothing may be said aloud. */
const SPEECH = process.env.LIVE_SPEECH !== "0";

async function uiOnly(c, api, id) {
  await sleep(800);
  await shot(c, "ui-1-listening");
  check("push-to-talk only: the view says to hold Space", /Hold Space/.test((await view(c)).state), (await view(c)).state);
  // A spoken message, as voice mode sends one, to the fake agent: its reply is read back.
  await api.call("sessions.send", { id, text: "What changed in the build today?", attachments: [], spoken: true });
  const speaking = await until(async () => { const v = await view(c); return v?.phase === "speaking" && v.realm ? v : null; }, 30_000, "the reply read aloud");
  await sleep(400);
  await shot(c, "ui-2-speaking");
  check("the reply is read back, its sentence on screen", !!speaking.realm, speaking);
  await until(async () => (await view(c))?.phase === "listening", 60_000, "back to listening");
  await evalIn(c, `[...document.querySelectorAll('.voice-control')].find((b) => b.textContent.includes('Mute'))?.click(), true`);
  await sleep(300);
  await shot(c, "ui-3-muted");
  await evalIn(c, `[...document.querySelectorAll('.voice-control')].find((b) => b.textContent.includes('End'))?.click(), true`);
  await until(async () => !(await view(c)), 5_000, "voice mode to close");
  await sleep(800);
  await shot(c, "ui-4-transcript");
  check("the transcript marks the spoken message", (await evalIn(c, `document.querySelectorAll('.msg-spoken').length`)) === 1);
  await evalIn(c, `window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', metaKey: true, bubbles: true })), true`);
  await until(() => evalIn(c, `!!document.querySelector('.page-head')`), 10_000, "settings");
  await evalIn(c, `[...document.querySelectorAll('label, button, [role=tab], [role=radio]')].find((b) => b.textContent.trim() === 'Voice')?.click(), true`);
  await until(() => evalIn(c, `!!document.querySelector('[data-setting="voice-voice"]')`), 10_000, "the Voice page");
  await sleep(1500);
  await shot(c, "ui-5-settings");
}

async function shot(c, name) {
  const { data } = await c.send("Page.captureScreenshot", {});
  const file = path.join(shots, `${THEME}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  note("shot", file);
}

/** What the voice view shows now. */
const view = (c) => evalIn(c, `(() => {
  const v = document.querySelector('.voice-view');
  if (!v) return null;
  const words = (side) => v.querySelector('.voice-side[data-side=' + side + '] .voice-words')?.textContent ?? '';
  return { phase: v.dataset.phase, live: !!v.querySelector('.voice-words[data-live]'), mine: words('mine'), realm: words('realm'),
    state: v.querySelector('.voice-state')?.textContent ?? '' };
})()`);

/** Polls the view every 150 ms in the background, so a phase that lasts half a second is still seen. */
function watch(c) {
  const log = [];
  let on = true;
  (async () => {
    let last = "";
    while (on) {
      const v = await view(c).catch(() => null);
      const key = JSON.stringify(v);
      if (v && key !== last) { log.push({ t: Date.now(), ...v }); last = key; }
      await sleep(150);
    }
  })();
  return { log, stop: () => { on = false; } };
}

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT, CMD_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  if (!fs.existsSync(path.join(repoRoot, "apps/desktop/native/bin/realmvoice"))) throw new Error("native/bin/realmvoice is missing — run build-native.mjs");

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, WRAPPER);
  const userData = path.join(scratch, "userData");
  const env = {
    REALM_HOME: home, REALM_ENABLE_FAKE_AGENT: "1", REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
    REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), LIVE_CMD_PORT: String(CMD_PORT),
    REALM_VOICE_BIN: path.join(repoRoot, "apps/desktop/native/bin/realmvoice"),
    LIVE_USER_DATA: userData, LIVE_MAIN: mainEntry,
  };
  const app = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app");
  execFileSync("open", ["-n", ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]), app, "--args", wrapper, `--user-data-dir=${userData}`,
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"]);
  const pid = await until(() => { try { return Number(execFileSync("pgrep", ["-f", wrapper], { encoding: "utf8" }).split("\n")[0]) || null; } catch { return null; } }, 30_000, "electron");
  electron = { kill: (sig) => { try { process.kill(pid, sig); } catch { /* gone */ } } };
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const page = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer");
  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  const api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Voice"); input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  const sessions = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 30_000, "a session");
  // Every session but the one voice mode talks to is fake, so nothing else can bill.
  const [voiceSession, ...others] = sessions;
  for (const s of others) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  if (!SPEECH) {
    // Nothing is said aloud and nothing bills: the session is the fake agent, and voice mode listens
    // only to push-to-talk, so the room is never heard as a turn.
    await api.call("sessions.setAgent", { id: voiceSession.id, agentKind: "fake" });
    await api.call("settings.set", { key: "ui.voice", value: { handsFree: false } });
  } else {
    if (voiceSession.agentKind !== "claude") await api.call("sessions.setAgent", { id: voiceSession.id, agentKind: "claude" });
    await api.call("sessions.setOptions", { id: voiceSession.id, model: MODEL });
  }
  await api.call("settings.set", { key: "ui.theme", value: THEME });
  await c.send("Page.reload");
  await until(() => evalIn(c, `!!document.querySelector('.composer-voice')`), 30_000, "the prompter's mic");
  // Not key under CDP: hold the accent in its focused colour, as a window in front would show it.
  await evalIn(c, `(() => { const r = document.documentElement; const clear = () => r.removeAttribute('data-window-inactive'); clear(); new MutationObserver(clear).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await ask("front");
  await sleep(600);
  await shot(c, "1-prompter-mic");

  // The page's audio goes to the Mac's own microphone and speakers rather than the system defaults,
  // without touching the defaults: getUserMedia is given the device, and the audio context its sink.
  await evalIn(c, `(() => {
    const pick = async (kind, name) => (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === kind && d.label.includes(name))?.deviceId;
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (want) => {
      const id = await pick("audioinput", ${JSON.stringify(MIC_LABEL)});
      window.__liveMic = id ?? null;
      return gum(id && want?.audio ? { ...want, audio: { ...(typeof want.audio === "object" ? want.audio : {}), deviceId: { exact: id } } } : want);
    };
    const Base = window.AudioContext;
    window.AudioContext = class extends Base {
      constructor(o) { super(o); void pick("audiooutput", ${JSON.stringify(SPEAKERS)}).then((id) => { window.__liveSink = id ?? null; if (id) return this.setSinkId(id); }); }
    };
    return true;
  })()`);
  const mic = (await evalIn(c, `window.realm.permissions.probe()`)).find((r) => r.id === "microphone");
  note("microphone grant before", mic?.state);
  if (mic?.state !== "granted") console.log("ACTION macOS is asking whether Electron may use the microphone: click Allow. (The script waits up to five minutes.)");

  await evalIn(c, `document.querySelector('.composer-voice').click(), true`);
  const ready = await until(async () => { const v = await view(c); return v && v.phase !== "starting" ? v : null; }, 300_000, "voice mode to start");
  if (ready.phase === "unavailable") throw new Error(`voice mode did not start: ${ready.state}`);
  check("voice mode opens over the window, listening", ready.phase === "listening", ready);
  const devices = await evalIn(c, `({ mic: window.__liveMic, sink: window.__liveSink })`);
  check("the Mac's own microphone and speakers are in use", !!devices.mic && !!devices.sink, devices);
  if (!SPEECH) { await uiOnly(c, api, voiceSession.id); api.close(); return; }

  // The room, recorded by the app (it holds the microphone grant): no echo cancellation, so what the
  // movie hears is what the microphone heard — the person and Realm both.
  await evalIn(c, `(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    window.__voiceTape = { rec, chunks: [], stream };
    rec.ondataavailable = (e) => window.__voiceTape.chunks.push(e.data);
    rec.start(1000);
    return true;
  })()`);
  const b = JSON.parse(await ask("bounds"));
  const video = path.join(shots, `${THEME}-screen.mov`);
  const seconds = Number(process.env.LIVE_SECONDS ?? 95);
  recorder = spawn("screencapture", ["-v", "-x", "-V", String(seconds), "-R", `${b.x},${b.y},${b.width},${b.height}`, video]);
  const recordStart = Date.now();
  await sleep(1500);
  const w = watch(c);

  // ── 1. A question, said aloud: its words appear as they are heard, and it goes when the speaker stops.
  const first = THEME === "dark" ? "Tell me a short story about a lighthouse keeper, in about six sentences." : "Name three primary colors, in one short sentence.";
  const saying = say(first);
  await until(async () => { const v = await view(c); return v?.live && v.mine.split(" ").length >= 2 ? v : null; }, 15_000, "partial words");
  await shot(c, "2-partial-words");
  await saying;
  const sent = await until(async () => {
    const ev = await api.call("sessions.events", { id: voiceSession.id });
    return ev.map((e) => e.event).find((e) => e.type === "user_message" && e.payload.spoken) ?? null;
  }, 15_000, "the spoken message");
  check("the message is sent once the speaker stops, marked spoken", sent.payload.spoken === true, sent.payload.text);
  await until(async () => (await view(c))?.phase === "speaking", 60_000, "the reply read aloud");
  await sleep(1200);
  await shot(c, "3-reply-spoken");

  // ── 2. A barge-in.
  if (THEME === "dark") {
    await sleep(2500);
    const before = await view(c);
    const barge = Date.now();
    await say("Actually, wait. What is two plus two?");
    const after = await until(async () => { const v = await view(c); return v && v.phase !== "speaking" ? v : null; }, 10_000, "speech to stop");
    note("barge-in", { stoppedAfterMs: Date.now() - barge, before: before.realm, after: after.phase });
    await shot(c, "4-barge-in");
    const second = await until(async () => {
      const ev = await api.call("sessions.events", { id: voiceSession.id });
      const spoken = ev.map((e) => e.event).filter((e) => e.type === "user_message" && e.payload.spoken);
      return spoken.length >= 2 ? spoken.at(-1) : null;
    }, 20_000, "the barge-in's message");
    check("talking over the reply sends what was said", /two plus two/i.test(second.payload.text), second.payload.text);
  } else {
    await until(async () => (await view(c))?.phase === "listening", 60_000, "the reply to finish");
    await say("Now tell me a short story about a lighthouse keeper, in about six sentences.");
    await until(async () => (await view(c))?.phase === "speaking", 60_000, "the story read aloud");
    await sleep(3500);
    const barge = Date.now();
    await say("Stop.");
    const after = await until(async () => { const v = await view(c); return v && v.phase !== "speaking" && v.phase !== "hearing" ? v : null; }, 10_000, "speech to stop");
    note("barge-in", { stoppedAfterMs: Date.now() - barge, after: after.phase });
    await shot(c, "4-barge-in-stop");
    const ev = await api.call("sessions.events", { id: voiceSession.id });
    const spoken = ev.map((e) => e.event).filter((e) => e.type === "user_message" && e.payload.spoken);
    check("\"stop\" stops Realm and is not sent as a message", spoken.every((e) => !/^stop/i.test(e.payload.text)), spoken.map((e) => e.payload.text));
  }
  await until(async () => (await view(c))?.phase === "listening", 60_000, "back to listening");
  await sleep(1500);
  await shot(c, "5-listening-again");
  w.stop();
  const phases = w.log.map((e) => `${((e.t - recordStart) / 1000).toFixed(1)} ${e.phase}${e.live ? " live:" + e.mine : ""}${e.realm ? " realm:" + e.realm.slice(0, 50) : ""}`);
  fs.writeFileSync(path.join(shots, `${THEME}-timeline.txt`), phases.join("\n") + "\n");

  // ── 3. Out of voice mode: the transcript holds all of it, the spoken messages marked.
  const elapsed = (Date.now() - recordStart) / 1000;
  if (elapsed < seconds) await sleep((seconds - elapsed) * 1000 + 800);
  const audio = await evalIn(c, `new Promise((resolve) => { const t = window.__voiceTape; t.rec.onstop = async () => { const blob = new Blob(t.chunks, { type: 'audio/webm' }); const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); t.stream.getTracks().forEach((x) => x.stop()); resolve(btoa(s)); }; t.rec.stop(); })`);
  const tape = path.join(shots, `${THEME}-room.webm`);
  fs.writeFileSync(tape, Buffer.from(audio, "base64"));
  await new Promise((r) => (recorder.exitCode !== null ? r() : recorder.on("close", r)));
  const movie = path.join(shots, `voice-mode-${THEME}.mov`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-i", tape, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", movie]);
  note("movie", movie);
  await evalIn(c, `[...document.querySelectorAll('.voice-control')].find((b) => b.textContent.includes('End'))?.click(), true`);
  await until(async () => !(await view(c)), 5_000, "voice mode to close");
  await sleep(800);
  await shot(c, "6-transcript");
  const marks = await evalIn(c, `document.querySelectorAll('.msg-spoken').length`);
  check("the transcript keeps every spoken message, each marked", marks >= 2, marks);
  api.close();
}

try {
  await main();
} catch (e) {
  process.exitCode = 1;
  console.log(`${at()}s FAIL ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (recorder && recorder.exitCode === null) recorder.kill("SIGKILL");
  electron?.kill("SIGTERM");
  await sleep(1500);
  try { await stopDaemons(home); } catch { /* none */ }
  electron?.kill("SIGKILL");
  killPort(SERVER_PORT);
  killPort(CDP_PORT);
  killPort(CMD_PORT);
  fs.rmSync(scratch, { recursive: true, force: true });
}
