/**
 * Voice mode, end to end on the BUILT app with the real microphone and the real speakers:
 *
 *   LIVE_THEME=dark|light LIVE_SHOT_DIR=<dir> node apps/desktop/scripts/voice-mode-live.mjs
 *
 * A scratch home, one session on Claude Haiku (the cheapest model — two short turns a run, billed to
 * the signed-in account) and every other session on the fake agent, and the person's side played through the speakers with `say`, so it reaches
 * the app the way a voice does: through the air and the microphone. It records the window with
 * `screencapture` and the room with the app's own microphone, and muxes the two into one movie.
 *
 * What it shows, in either theme: words heard as they are said, the message sent when the speaker
 * stops, the reply read back with each sentence on screen as it is spoken, and a barge-in — talking
 * over the reply stops it, and what was said is sent and answered. Beside the movie it writes the
 * view's timeline (phase, bar levels, caption) and the helper's audio log, which is the evidence
 * that Realm's voice was produced and when.
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
const SAY_VOICE = process.env.LIVE_SAY_VOICE ?? "Samantha";
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
  const listeners = new Map();
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); else listeners.get(msg.method)?.(msg.params); });
  return { ready, close: () => ws.close(), on: (method, fn) => listeners.set(method, fn), send: (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result))); ws.send(JSON.stringify({ id: i, method, params })); }) };
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

/** LIVE_FEED=1: the person's side is synthesised to a file and played into the page as its microphone,
 *  for a room where the speakers are muted or nothing may be said aloud. Everything after the
 *  microphone — recognition, turn-taking, the reply, its speech and a barge-in — is the same. */
const FEED = process.env.LIVE_FEED === "1";
let page = null, said = 0;

/** The person, through the speakers (or the feed). Resolves when they stop talking. */
function say(text) {
  note("say", text);
  if (FEED) {
    const file = path.join(scratch, `say-${++said}.wav`);
    execFileSync("say", ["-v", SAY_VOICE, "-r", process.env.LIVE_SAY_RATE ?? "185", "-o", file, "--data-format=LEI16@48000", text]);
    return evalIn(page, `window.__feed(${JSON.stringify(fs.readFileSync(file).toString("base64"))})`);
  }
  return new Promise((resolve) => { const p = spawn("say", ["-v", SAY_VOICE, "-r", process.env.LIVE_SAY_RATE ?? "185", "-a", SPEAKERS, `[[volm ${process.env.LIVE_SAY_VOLUME ?? "0.35"}]] ${text}`]); p.on("close", resolve); });
}

let electron = null, recorder = null;

/** Records the page's frames for `seconds` into `out`, each held until the next arrived. Returns a
 *  recorder shaped like a child process: an exitCode, a close event, and kill. */
async function screencast(c, out, seconds) {
  const dir = fs.mkdtempSync(path.join(scratch, "cast-"));
  const frames = [];
  let done = false;
  const listeners = [];
  const rec = { exitCode: null, on: (_e, fn) => listeners.push(fn), kill: () => finish() };
  c.on("Page.screencastFrame", (f) => {
    if (done) return;
    const file = path.join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    void c.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await c.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1 });
  const finish = async () => {
    if (done) return;
    done = true;
    await c.send("Page.stopScreencast").catch(() => {});
    const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? f.t + 0.04) - f.t).toFixed(3)}`).join("\n");
    fs.writeFileSync(path.join(dir, "list.txt"), `ffconcat version 1.0\n${list}\nfile '${frames.at(-1)?.file}'\n`);
    if (frames.length) execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "list.txt"), "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", "-c:v", "libx264", out]);
    rec.exitCode = 0;
    for (const fn of listeners) fn();
  };
  setTimeout(() => void finish(), seconds * 1000);
  return rec;
}
/** The view's timeline, written even when a run fails part-way: it is what says why. */
let watcher = null, recordStart = 0;
function writeTimeline() {
  if (!watcher) return;
  watcher.stop();
  const lines = watcher.log.map((e) => `${((e.t - recordStart) / 1000).toFixed(1)} ${e.phase} [${e.side} ${e.bars.map((x) => x.toFixed(2)).join(" ")}]${e.quiet ? " quiet:" + e.quiet : ""} ${e.caption}`);
  fs.writeFileSync(path.join(shots, `${THEME}-timeline.txt`), lines.join("\n") + "\n");
}
/** LIVE_SPEECH=0: the views alone, on the fake agent — for a room where nothing may be said aloud. */
const SPEECH = process.env.LIVE_SPEECH !== "0";

async function uiOnly(c, api, id) {
  await sleep(800);
  await shot(c, "ui-1-listening");
  check("push-to-talk only: the view says to hold Space", /Hold Space/.test((await view(c)).state), (await view(c)).state);
  // A spoken message, as voice mode sends one, to the fake agent: its reply is read back.
  await api.call("sessions.send", { id, text: "What changed in the build today?", attachments: [], spoken: true });
  const speaking = await until(async () => { const v = await view(c); return v?.phase === "speaking" && v.live ? v : null; }, 30_000, "the reply read aloud");
  await sleep(400);
  await shot(c, "ui-2-speaking");
  check("the reply is read back, its sentence on screen", !!speaking.caption, speaking);
  await until(async () => (await view(c))?.phase === "listening", 60_000, "back to listening");
  await evalIn(c, `document.querySelector('.voice-key:first-child')?.click(), true`);
  await sleep(300);
  await shot(c, "ui-3-muted");
  await evalIn(c, `document.querySelector('.voice-key[data-key="end"]')?.click(), true`);
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

/** How the page's microphone frames arrived (every one should come about 21 ms after the last), and
 *  under LIVE_TAP the audio itself as a 16-bit WAV at the context's rate. */
async function saveTap(c, name) {
  const tap = await evalIn(c, `(() => { const t = window.__tap; const gaps = t.at.slice(1).map((x, i) => x - t.at[i]);
    let pcm = ''; if (t.chunks.length) { const n = t.chunks.reduce((a, x) => a + x.length, 0); const out = new Int16Array(n); let o = 0;
      for (const ch of t.chunks) for (let i = 0; i < ch.length; i++) out[o++] = Math.max(-32768, Math.min(32767, Math.round(ch[i] * 32767)));
      const b = new Uint8Array(out.buffer); for (let i = 0; i < b.length; i += 0x8000) pcm += String.fromCharCode(...b.subarray(i, i + 0x8000)); pcm = btoa(pcm); }
    t.chunks = [];
    return { frames: t.frames, rate: t.rate, span: t.at.length ? t.at.at(-1) - t.at[0] : 0, maxGap: Math.max(0, ...gaps), late: gaps.filter((g) => g > 60).length, pcm };
  })()`);
  note("microphone frames", { frames: tap.frames, rate: tap.rate, expectedFrames: Math.round(tap.span / 1000 * tap.rate / 1024), maxGapMs: Math.round(tap.maxGap), lateFrames: tap.late });
  if (!tap.pcm) return;
  const data = Buffer.from(tap.pcm, "base64");
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVEfmt ", 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(tap.rate, 24); head.writeUInt32LE(tap.rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(shots, `${THEME}-tap-${name}.wav`), Buffer.concat([head, data]));
}

async function shot(c, name) {
  const { data } = await c.send("Page.captureScreenshot", {});
  const file = path.join(shots, `${THEME}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  note("shot", file);
}

/** What the voice view shows now: its phase, the head, the caption, whose voice the bars follow and
 *  how high they stand, and whether the window has gone quiet (which would hold the bars still). */
const view = (c) => evalIn(c, `(() => {
  const v = document.querySelector('.voice-view');
  if (!v) return null;
  const caption = v.querySelector('.voice-caption');
  const bars = v.querySelector('.voice-bars');
  return { phase: v.dataset.phase, head: v.querySelector('.voice-name')?.textContent ?? '', caption: caption?.textContent ?? '',
    live: caption?.dataset.tone === 'live', side: bars?.dataset.side ?? '', state: v.querySelector('.voice-state')?.textContent ?? '',
    bars: [...(bars?.children ?? [])].map((b) => Number(b.style.getPropertyValue('--level') || 0)),
    quiet: document.documentElement.getAttribute('data-quiet') };
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
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer");
  const c = cdp(target.webSocketDebuggerUrl);
  page = c;
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
    if (process.env.LIVE_AGENT === "fake") await api.call("sessions.setAgent", { id: voiceSession.id, agentKind: "fake" });
    else {
      if (voiceSession.agentKind !== "claude") await api.call("sessions.setAgent", { id: voiceSession.id, agentKind: "claude" });
      await api.call("sessions.setOptions", { id: voiceSession.id, model: MODEL });
    }
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
  // without touching the defaults: the microphone is chosen in voice mode's own setting, and the
  // audio context is given the speakers as its sink.
  await evalIn(c, `(() => {
    const pick = async (kind, name) => (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === kind && d.label.includes(name))?.deviceId;
    // Which microphone the app opened, by its label: the proof that the setting chose it.
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (want) => {
      const stream = await gum(want);
      if (want?.audio?.echoCancellation) window.__liveMicLabel = stream.getAudioTracks()[0]?.label ?? null;
      return stream;
    };
    if (${FEED}) {
      const feed = new AudioContext({ sampleRate: 48000 });
      const into = feed.createMediaStreamDestination();
      window.__feed = async (b64) => {
        await feed.resume();
        const buffer = await feed.decodeAudioData(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer);
        const node = feed.createBufferSource();
        node.buffer = buffer;
        node.connect(into);
        node.start();
        return new Promise((resolve) => { node.onended = () => resolve(buffer.duration); });
      };
      window.__feedStream = into.stream;
      navigator.mediaDevices.getUserMedia = async (want) => {
        if (!want?.audio?.echoCancellation) return gum(want);
        window.__liveMicLabel = "feed";
        return into.stream.clone();
      };
    }
    // LIVE_TAP: keep what the page's microphone processor is handed, frame by frame, with the time
    // each frame arrived — what the recogniser was given, to listen to and to check for gaps.
    window.__tap = { frames: 0, chunks: [], at: [], rate: 0 };
    const make = AudioContext.prototype.createScriptProcessor;
    AudioContext.prototype.createScriptProcessor = function (...args) {
      const node = make.apply(this, args);
      const ctx = this;
      let handler = null;
      Object.defineProperty(node, "onaudioprocess", { configurable: true, get: () => handler, set: (fn) => {
        if (handler) node.removeEventListener("audioprocess", handler);
        handler = fn && ((e) => {
          const t = window.__tap; t.frames += 1; t.rate = ctx.sampleRate; t.at.push(performance.now());
          if (${process.env.LIVE_TAP === "1"}) t.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
          fn(e);
        });
        if (handler) node.addEventListener("audioprocess", handler);
      } });
      return node;
    };
    const Base = window.AudioContext;
    window.AudioContext = class extends Base {
      constructor(o) { super(o); void pick("audiooutput", ${JSON.stringify(SPEAKERS)}).then((id) => { window.__liveSink = id ?? null; if (id) return this.setSinkId(id); }); }
    };
    return true;
  })()`);
  window_mic: {
    const id = await evalIn(c, `(async () => (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "audioinput" && d.label.includes(${JSON.stringify(MIC_LABEL)}))?.deviceId ?? null)()`);
    if (!id) break window_mic;
    const prefs = (await api.call("settings.get", { key: "ui.voice" })).value ?? {};
    await api.call("settings.set", { key: "ui.voice", value: { ...prefs, microphone: id } });
    await evalIn(c, `window.__liveMic = ${JSON.stringify(id)}, true`);
  }
  const mic = (await evalIn(c, `window.realm.permissions.probe()`)).find((r) => r.id === "microphone");
  note("microphone grant before", mic?.state);
  if (mic?.state !== "granted") console.log("ACTION macOS is asking whether Electron may use the microphone: click Allow. (The script waits up to five minutes.)");

  // Realm's voice, as the helper hands it over: every run of audio with its length, and each sentence's
  // end — the evidence that sound was produced, beside the room recording that has it.
  await evalIn(c, `(() => { window.__tts = []; window.realm.voice.onEvent((e) => {
    if (e.t === 'audio') window.__tts.push({ t: Date.now(), e: 'audio', id: e.id, s: atob(e.pcm).length / 2 / e.rate });
    else if (e.t === 'spoken' || e.t === 'final') window.__tts.push({ t: Date.now(), e: e.t, id: e.id, text: e.text });
  }); return true; })()`);
  await evalIn(c, `document.querySelector('.composer-voice').click(), true`);
  const ready = await until(async () => { const v = await view(c); return v && v.phase !== "starting" ? v : null; }, 300_000, "voice mode to start");
  if (ready.phase === "unavailable") throw new Error(`voice mode did not start: ${ready.state}`);
  check("voice mode opens over the window, listening", ready.phase === "listening", ready);
  const devices = await evalIn(c, `({ mic: window.__liveMic, opened: window.__liveMicLabel, sink: window.__liveSink })`);
  if (FEED) check("the person's side is the feed, and Realm's voice goes to the Mac's own speakers", devices.opened === "feed" && !!devices.sink, devices);
  else check("the Mac's own microphone and speakers are in use", !!devices.mic && devices.opened?.includes(MIC_LABEL) && !!devices.sink, devices);
  if (!SPEECH) { await uiOnly(c, api, voiceSession.id); api.close(); return; }

  // The room, recorded by the app (it holds the microphone grant): no echo cancellation, so what the
  // movie hears is what the microphone heard — the person and Realm both.
  await evalIn(c, `(async () => {
    const stream = window.__feedStream?.clone() ?? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    window.__voiceTape = { rec, chunks: [], stream };
    rec.ondataavailable = (e) => window.__voiceTape.chunks.push(e.data);
    rec.start(1000);
    return true;
  })()`);
  await ask("front");
  await sleep(400);
  const b = JSON.parse(await ask("bounds"));
  const video = path.join(shots, `${THEME}-screen.mov`);
  const seconds = Number(process.env.LIVE_SECONDS ?? 95);
  // The window's own frames, as the renderer paints them (LIVE_SCREENCAST=0: the screen, with
  // screencapture). A locked or occluded screen records nothing but the lock screen; the
  // renderer's frames are the window's whatever is in front of it.
  if (process.env.LIVE_SCREENCAST === "0") recorder = spawn("screencapture", ["-v", "-x", "-V", String(seconds), "-R", `${b.x},${b.y},${b.width},${b.height}`, video]);
  else recorder = await screencast(c, video, seconds);
  recordStart = Date.now();
  await sleep(1500);
  const w = watch(c);
  watcher = w;

  // ── 1. A question, said aloud: its words appear as they are heard, and it goes when the speaker stops.
  const first = THEME === "dark" ? "Tell me a short story about a lighthouse keeper, in about six sentences." : "Describe a quiet morning at the beach, in about six sentences.";
  const saying = say(first);
  const partial = await until(async () => { const v = await view(c); return v?.phase === "hearing" && v.caption.split(" ").length >= 2 ? v : null; }, 15_000, "partial words");
  await shot(c, "2-partial-words");
  check("words appear as they are heard, under bars that follow the microphone", partial.side === "mine", partial);
  await saying;
  await saveTap(c, "first");
  const sent = await until(async () => {
    const ev = await api.call("sessions.events", { id: voiceSession.id });
    return ev.map((e) => e.event).find((e) => e.type === "user_message" && e.payload.spoken) ?? null;
  }, 15_000, "the spoken message");
  check("the message is sent once the speaker stops, marked spoken, as said", /lighthouse|beach/i.test(sent.payload.text), sent.payload.text);
  const reading = await until(async () => { const v = await view(c); return v?.phase === "speaking" && v.live && v.bars.some((x) => x > 0.15) ? v : null; }, 60_000, "the reply read aloud");
  await sleep(600);
  await shot(c, "3-reply-spoken");
  check("the reply is read aloud: its sentence under bars that follow Realm's voice", reading.side === "realm" && !!reading.caption, reading);

  // ── 2. A barge-in: talking over the reply stops it, and what was said is sent.
  await sleep(2500);
  const before = await view(c);
  const barge = Date.now();
  const interrupting = say("Actually, wait. What is two plus two?");
  void interrupting.then(() => saveTap(c, "barge"));
  const after = await until(async () => { const v = await view(c); return v && v.phase !== "speaking" ? v : null; }, 10_000, "speech to stop");
  note("barge-in", { stoppedAfterMs: Date.now() - barge, before: before.caption, after: after.phase });
  await shot(c, "4-barge-in");
  await interrupting;
  const second = await until(async () => {
    const ev = await api.call("sessions.events", { id: voiceSession.id });
    const spoken = ev.map((e) => e.event).filter((e) => e.type === "user_message" && e.payload.spoken);
    return spoken.length >= 2 ? spoken.at(-1) : null;
  }, 20_000, "the barge-in's message");
  check("talking over the reply sends what was said", /(two|2) plus (two|2)|2 \+ 2/i.test(second.payload.text), second.payload.text);
  await until(async () => { const v = await view(c); return v?.phase === "speaking" && v.live ? v : null; }, 60_000, "the answer read aloud");
  await sleep(800);
  await shot(c, "5-answer-spoken");
  await until(async () => (await view(c))?.phase === "listening", 60_000, "back to listening");
  await sleep(1500);
  await shot(c, "6-listening-again");
  writeTimeline();
  const tts = await evalIn(c, `window.__tts`);
  fs.writeFileSync(path.join(shots, `${THEME}-tts.log`), tts.map((e) => `${((e.t - recordStart) / 1000).toFixed(2)} ${e.e} ${e.id ?? ""} ${e.s ? e.s.toFixed(2) + "s of audio" : ""}${e.text ? " " + e.text : ""}`).join("\n") + "\n");
  check("Realm's voice was produced: seconds of synthesised audio arrived", tts.filter((e) => e.e === "audio").reduce((n, e) => n + e.s, 0) > 2);
  check("the bars moved with both voices", w.log.some((e) => e.side === "mine" && e.bars.some((x) => x > 0.15)) && w.log.some((e) => e.side === "realm" && e.bars.some((x) => x > 0.15)));
  check("the window never went quiet during the recording", w.log.every((e) => !e.quiet || e.quiet === "idle"), [...new Set(w.log.map((e) => e.quiet))]);

  // ── 3. Out of voice mode: the transcript holds all of it, the spoken messages marked.
  const elapsed = (Date.now() - recordStart) / 1000;
  if (elapsed < seconds) await sleep((seconds - elapsed) * 1000 + 800);
  const audio = await evalIn(c, `new Promise((resolve) => { const t = window.__voiceTape; t.rec.onstop = async () => { const blob = new Blob(t.chunks, { type: 'audio/webm' }); const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); t.stream.getTracks().forEach((x) => x.stop()); resolve(btoa(s)); }; t.rec.stop(); })`);
  const tape = path.join(shots, `${THEME}-room.webm`);
  fs.writeFileSync(tape, Buffer.from(audio, "base64"));
  await new Promise((r) => (recorder.exitCode !== null ? r() : recorder.on("close", r)));
  const movie = path.join(shots, `voice-mode-${THEME}.mov`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-i", tape, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-af", "apad", "-t", String(seconds), movie]);
  note("movie", movie);
  await evalIn(c, `document.querySelector('.voice-key[data-key="end"]')?.click(), true`);
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
  writeTimeline();
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
