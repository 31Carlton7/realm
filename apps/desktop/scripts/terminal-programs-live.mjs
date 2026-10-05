/**
 * Live check for a terminal's tab naming what it runs, and for the colours a terminal is drawn in
 * (run with: pnpm build && node apps/desktop/scripts/terminal-programs-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent, opens four terminals as tabs of
 * one session's side pane, and starts a foreground program in three of them — none of which is an
 * agent. `claude` and `fx` here are symlinks to /bin/cat, which is exactly how Claude's native
 * installer looks to the kernel (a link whose target is named something else), so the tab is named
 * from argv the way it is for the real thing, and nothing is ever signed in to or billed. The fourth
 * runs a script that prints the sixteen colours, faint and bold text, 256-colour and truecolor
 * samples, and the prompts p10k's stock lean and rainbow styles draw (packages/ui/src/fixtures).
 *
 * Checks, in the real window:
 *   1. Each tab says what its terminal runs — "claude · realm" — and wears its mark: a tile in the
 *      vendor's colour for an agent, the app's glyph for a tool, the terminal glyph for the shell.
 *   2. Every mark is the same square, and a program starting moves nothing beside it.
 *   3. The colours xterm draws are the palette's, faint text reads at AA on the pane's ground, and
 *      "My shell's" in Settings puts xterm's own back into the open terminals.
 * …and screenshots the strip and the output, dark and light, under LIVE_OUT_DIR.
 *
 * Ports: LIVE_SERVER_PORT (8801), LIVE_CDP_PORT (9241). Scratch under LIVE_SCRATCH_DIR (os.tmpdir()).
 * Kills only what is listening on its own ports.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9241);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8801);
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH_DIR ?? os.tmpdir(), "realm-terminal-programs-live-"));
const home = path.join(scratch, "home");
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
const OUT = (tag) => path.join(OUT_DIR, `terminal-${tag}.png`);
const TITLE = "Terminal tabs live check";
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
    await sleep(200);
  }
}

function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
  });
  return { ws, ready, next: () => String(++id), pending };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      s.ws.send(JSON.stringify({ id: Number(i), method, params }));
    }),
  };
}

function rpc(port, token) {
  const s = socket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  return {
    ready: s.ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
  };
}

async function evalIn(c, expr) {
  if (process.env.LIVE_TRACE) console.log(`TRACE ${expr.slice(0, 90).replace(/\s+/g, " ")}`);
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

/** The terminal's pane filling the window (⌘⇧F, pane focus), shot, and put back: the reference's frame. */
async function focusedShot(c, tag) {
  const chord = async () => {
    for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, modifiers: 4 | 8, key: "F", code: "KeyF", windowsVirtualKeyCode: 70 });
  };
  await chord();
  await sleep(900);
  const box = await evalIn(c, `(() => { const p = [...document.querySelectorAll('.panehost .panel')].find((x) => x.querySelector('.terminal-pane')?.offsetParent);
    const r = p.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: Math.min(r.height, 640) }; })()`);
  await shot(c, tag, box);
  await chord();
  await sleep(700);
}

async function shot(c, tag, clip) {
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}), captureBeyondViewport: false });
  fs.writeFileSync(OUT(tag), Buffer.from(r.data, "base64"));
  note("screenshot", OUT(tag));
}

/** WCAG contrast between two sRGB triples, 0..255. */
const contrast = (a, b) => {
  const L = ([r, g, bl]) => [r, g, bl].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
    .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [x, y] = [L(a), L(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** The printable part of a captured prompt: its SGR and its text, without the cursor moves and
 *  clears a live zsh draws it with, up to the first command typed at it — and with the gap before the
 *  right prompt closed up, so the whole prompt fits a narrow pane. */
function promptOf(fixture) {
  const raw = fs.readFileSync(path.join(repoRoot, "packages/ui/src/fixtures", fixture), "utf8");
  return raw.slice(0, raw.indexOf("\x1b[?2004h"))
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[1m\x1b\[7m%\x1b\[27m\x1b\[1m\x1b\[0m\s+/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, (m) => (m.endsWith("m") ? m : ""))
    .replace(/\r/g, "").split("\n")
    .map((l) => l.replace(/ {6,}/g, "   "))
    .filter((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()).join("\n");
}

/** What the session's terminal prints: the sixteen four ways, the reference's faint tree, the colours
 *  past the sixteen, the prompt icons, and p10k's two stock prompts — all inside 64 columns. */
function writeSample(dir) {
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  const row = (sgr) => "  " + names.map((n, i) => `\x1b[${sgr(i)}m${n.padEnd(8)}\x1b[0m`).join("");
  const sample = [
    "",
    "  \x1b[2mthe sixteen · bright · faint · bold\x1b[0m",
    row((i) => `3${i}`), row((i) => `9${i}`), row((i) => `2;3${i}`), row((i) => `1;3${i}`),
    "  " + Array.from({ length: 16 }, (_, i) => `\x1b[${i < 8 ? 40 + i : 92 + i}m${String(i).padStart(3)} \x1b[0m`).join(""),
    "",
    "  ● 3 tool calls \x1b[2m· 2 commands · 1 list\x1b[0m",
    "  \x1b[2m├ Matched */rex*/.git\x1b[0m",
    "  \x1b[2m├ Observed\x1b[0m pwd; gh \x1b[2mpr view 97\x1b[0m --repo \x1b[2msuperlogical/rex\x1b[0m",
    "  \x1b[2m└ Ran\x1b[0m ls -la .",
    "",
    "  " + [16, 52, 88, 124, 160, 196, 202, 208, 214, 220, 226, 190, 154, 118, 82, 46, 48, 50, 51, 45, 39, 33, 27, 21, 57, 93]
      .map((n) => `\x1b[48;5;${n}m  `).join("") + "\x1b[0m  256",
    "  " + Array.from({ length: 26 }, (_, i) => `\x1b[48;2;${Math.round(i * 10)};${Math.round(255 - i * 10)};190m  `).join("") + "\x1b[0m  truecolor",
    "  \x1b[38;2;217;119;87mtruecolor ink\x1b[0m   \x1b[2;38;2;217;119;87mfaint truecolor ink\x1b[0m",
    "  \x1b[38;5;31m38;5;31\x1b[0m  \x1b[38;5;76m38;5;76\x1b[0m  \x1b[38;5;178m38;5;178\x1b[0m  \x1b[38;5;242m38;5;242\x1b[0m",
    "  icons:  main   folder   git   branch  ❯",
    "",
    "  \x1b[2mp10k lean\x1b[0m",
    promptOf("p10k-lean.ans").split("\n").map((l) => "  " + l).join("\n"),
    "",
    "  \x1b[2mp10k rainbow\x1b[0m",
    promptOf("p10k-rainbow.ans").split("\n").map((l) => "  " + l).join("\n"),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "sample.txt"), sample + "\x1b[0m\n");
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  // The folders the terminals start in, and the programs that will run in them.
  const bin = path.join(scratch, "bin");
  for (const d of ["realm", "api", "notes", "bin"]) fs.mkdirSync(path.join(scratch, d), { recursive: true });
  for (const name of ["claude", "fx"]) fs.symlinkSync("/bin/cat", path.join(bin, name));
  writeSample(scratch);

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_HTML_MENUS: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  // The window opens behind whatever the user has in front; unfocused, Realm quiets itself.
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 900, deviceScaleFactor: 2, mobile: false });
  // Not key, the window greys its accent; hold that off so the screenshots show the app in use.
  await evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute('data-window-inactive');
    new MutationObserver(() => r.hasAttribute('data-window-inactive') && r.removeAttribute('data-window-inactive')).observe(r, { attributes: true }); return true; })()`);

  // Onboarding makes the space. Its first session runs a REAL engine, so nothing is typed there.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE });
  await api.call("sessions.send", { id: session.id, text: "Run the parser tests and tell me which ones fail.", attachments: [], mentions: [] });
  await until(async () => (await api.call("sessions.events", { id: session.id, afterSeq: 0, limit: 200 })).some((e) => e.event.type === "assistant_text"), 20_000, "the agent's answer");

  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.panehost .panel').length === 1`), 10_000, "the session alone");

  // ── The session's own terminal, as the first tab of its side pane ───────────────────────────
  const OPEN = `Open the terminal beside ${TITLE}`;
  await until(() => evalIn(c, `!!document.querySelector('.panel-bar button[aria-label=${JSON.stringify(OPEN)}]')`), 10_000, "terminal button");
  await evalIn(c, `(() => { document.querySelector('.panel-bar button[aria-label=${JSON.stringify(OPEN)}]').click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.pane-tabs [role=tab]').length === 1`), 15_000, "the terminal's tab");
  const own = (await api.call("items.list", { spaceId: space.id })).find((i) => i.kind === "terminal");

  // ── Three more, each in its own folder, joined to the same strip from the palette ───────────
  const opened = { own: own.refId };
  for (const folder of ["realm", "api", "notes"]) {
    const { terminalId } = await api.call("terminals.create", { spaceId: space.id, cwd: path.join(scratch, folder), cols: 100, rows: 30 });
    opened[folder] = terminalId;
    // The side pane focused, so the palette's open joins it as a tab (a tool opened with the
    // keyboard in a side pane joins it).
    await evalIn(c, `(() => { document.querySelector('.pane-tabs [role=tab][aria-selected=true]').click(); return true; })()`);
    await sleep(300);
    // In short steps polled from here, so no promise is held open in the page across a re-render.
    await until(() => evalIn(c, `!document.querySelector(".palette")`), 5_000, "no palette open");
    await evalIn(c, `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5_000, "the palette");
    await evalIn(c, `(() => { const input = document.querySelector(".palette input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(folder)});
      input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(folder)}));
      if (!hit) return false; hit.click(); return true; })()`), 5_000, `the palette row for ${folder}`);
    await until(() => evalIn(c, `[...document.querySelectorAll('.pane-tabs [role=tab]')].some((t) => t.textContent.endsWith(${JSON.stringify(folder)}))`), 10_000, `the ${folder} tab`);
  }
  const tabs = () => evalIn(c, `[...document.querySelectorAll('.pane-tabs .pane-tab')].map((t) => {
    const label = t.querySelector('[role=tab]');
    const mark = label.querySelector('.program-mark');
    const visible = mark && (mark.hasAttribute('data-on') ? mark.querySelector(':scope > .swap-on') : mark.querySelector(':scope > .swap-off'));
    const tile = visible?.querySelector('.program-tile');
    const title = label.querySelector('.pane-tab-title');
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; };
    return { text: label.textContent, title: label.getAttribute('title'), selected: label.getAttribute('aria-selected') === 'true',
      mark: box(mark), tile: tile ? { fill: getComputedStyle(tile.querySelector('.program-tile-fill')).fill, brand: tile.querySelector('[data-brand]')?.getAttribute('data-brand') ?? null } : null,
      glyph: visible?.querySelector('svg')?.getAttribute('data-brand') ?? (visible ? 'stroke' : null), titleLeft: title ? Math.round(title.getBoundingClientRect().left * 10) / 10 : null };
  })`);
  note("the strip, before anything runs", await tabs());

  // ── Start the programs ──────────────────────────────────────────────────────────────────────
  const type = (terminalId, text) => api.call("terminals.write", { terminalId, data: text });
  const exportPath = ` export PATH=${JSON.stringify(bin)}:$PATH; clear\r`;
  for (const id of Object.values(opened)) await type(id, exportPath);
  await sleep(1500);
  const before = await tabs();
  await type(opened.realm, "claude\r");
  await type(opened.api, "python3 -c 'import time; time.sleep(600)'\r");
  await type(opened.notes, "fx\r");
  await type(opened.own, ` cat ${JSON.stringify(path.join(scratch, "sample.txt"))}\r`);
  const programs = await until(async () => {
    const p = await api.call("terminals.programs", {});
    return p[opened.realm]?.id === "claude" && p[opened.api]?.id === "python" && p[opened.notes]?.id === "fx" ? p : null;
  }, 20_000, "the three programs").catch(async () => api.call("terminals.programs", {}));
  note("terminals.programs", programs);
  // python3 here is the Command Line Tools shim, which re-execs the framework's `Python` — so its
  // argv[0] says "Python", and the label is the language's.
  check("the server names each terminal's foreground program — the two symlinked agents by argv, python by its language, the shell as nothing",
    programs[opened.realm]?.id === "claude" && programs[opened.notes]?.id === "fx" && programs[opened.api]?.id === "python" && !programs[opened.own], programs);
  await sleep(1200); // past the icon swap

  const strip = await tabs();
  note("the strip, with the programs running", strip);
  const byFolder = (f) => strip.find((t) => t.text.endsWith(f));
  check("each tab says the program before its folder", byFolder("realm")?.text === "claude · realm" && /^python3? · api$/.test(byFolder("api")?.text ?? "")
    && byFolder("notes")?.text === "fx · notes", strip.map((t) => t.text));
  check("…and its tooltip says the same", byFolder("realm")?.title === "claude · realm", byFolder("realm")?.title);
  check("Claude wears a coral tile with its own mark, fx a near-black one with its own", byFolder("realm")?.tile?.brand === "claude"
    && /217, 119, 87|d97757/i.test(byFolder("realm")?.tile?.fill ?? "") && byFolder("notes")?.tile?.brand === "fx", { realm: byFolder("realm")?.tile, notes: byFolder("notes")?.tile });
  check("python keeps a bare glyph, the shell the terminal glyph — no tile for either", !byFolder("api")?.tile && !strip.find((t) => !t.text.includes("·"))?.tile);
  check("every mark is the same 14px square", strip.every((t) => t.mark?.[0] === 14 && t.mark?.[1] === 14), strip.map((t) => t.mark));
  check("a program starting moved no title: each title starts where it did at the prompt",
    strip.every((t, i) => t.titleLeft === before[i]?.titleLeft), { before: before.map((t) => t.titleLeft), after: strip.map((t) => t.titleLeft) });

  // The strip, close, and the window. The sample is the session's own terminal — bring it forward.
  const stripBox = await evalIn(c, `(() => { const r = document.querySelector('.pane-strip').getBoundingClientRect(); return { x: r.left - 8, y: r.top - 6, width: Math.min(r.width + 16, 760), height: r.height + 12 }; })()`);
  await shot(c, "tabs-dark", stripBox);
  await evalIn(c, `(() => { [...document.querySelectorAll('.pane-tabs [role=tab]')].find((t) => !t.textContent.includes('·')).click(); return true; })()`);
  await sleep(800);
  await shot(c, "window-dark");
  const termBox = await evalIn(c, `(() => { const p = [...document.querySelectorAll('.panehost .panel')].find((x) => x.querySelector('.terminal-pane')); const r = p.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
  await shot(c, "output-dark", termBox);
  await focusedShot(c, "focus-dark");

  // ── What xterm actually drew ────────────────────────────────────────────────────────────────
  const COLORS = `(() => {
    // The terminal on screen: a side pane keeps its other tabs' panes mounted.
    const pane = [...document.querySelectorAll('.panehost .terminal-pane')].find((p) => p.offsetParent !== null);
    const host = pane.querySelector('.terminal-host');
    const rows = host.querySelector('.xterm-rows');
    const canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
    const rgb = (css) => { const g = document.createElement('canvas').getContext('2d'); g.fillStyle = css; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    /* A computed colour, as channels and an alpha — Chromium writes color-mix() back as color(srgb …). */
    const parse = (css) => {
      let m = css.match(/color\\(srgb ([\\d.]+) ([\\d.]+) ([\\d.]+)(?: \\/ ([\\d.]+))?\\)/);
      if (m) return { rgb: [m[1], m[2], m[3]].map((v) => Math.round(Number(v) * 255)), a: m[4] === undefined ? 1 : Number(m[4]) };
      m = css.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
      return m ? { rgb: [m[1], m[2], m[3]].map(Number), a: m[4] === undefined ? 1 : Number(m[4]) } : null;
    };
    /* As the eye gets it: the glyphs' fill (which is the colour unless a rule set the fill) at its
       alpha over the pane's ground. */
    const seen = (el) => { const cs = getComputedStyle(el); const p = parse(cs.webkitTextFillColor || cs.color); const g = rgb(canvas);
      return p.rgb.map((v, i) => Math.round(v * p.a + g[i] * (1 - p.a))); };
    const inline = (e) => /(^|;)color:/.test(e.getAttribute('style') ?? '');
    const dims = [...rows.querySelectorAll('.xterm-dim')];
    const dim = dims.find((e) => !/xterm-fg-/.test(e.className) && !inline(e) && e.textContent.includes('Matched'));
    const rgbDim = dims.find((e) => inline(e) && e.textContent.includes('faint truecolor'));
    const dimRed = rows.querySelector('.xterm-fg-1.xterm-dim');
    const fg4 = rows.querySelector('.xterm-fg-4:not(.xterm-dim)'), fg8 = rows.querySelector('.xterm-fg-8:not(.xterm-dim)');
    return { canvas: rgb(canvas), dimShare: getComputedStyle(host).getPropertyValue('--term-dim'),
      ink: seen(rows), blue: fg4 ? seen(fg4) : null, brightBlack: fg8 ? seen(fg8) : null,
      dim: dim ? seen(dim) : null, dimRed: dimRed ? seen(dimRed) : null,
      rgbDim: rgbDim ? { seen: seen(rgbDim), fill: getComputedStyle(rgbDim).webkitTextFillColor, ink: getComputedStyle(rgbDim).color } : null,
      font: getComputedStyle(rows).fontFamily };
  })()`;
  const dark = await evalIn(c, COLORS);
  note("dark: what xterm drew", dark);
  const ratio = (face, key) => (face[key] ? +contrast(face.canvas, face[key]).toFixed(2) : null);
  check("blue and bright black are the palette's own, and both read at AA on the pane's ground",
    dark.blue?.join() === "82,147,233" && ratio(dark, "blue") >= 4.5 && ratio(dark, "brightBlack") >= 4.5,
    { blue: [dark.blue, ratio(dark, "blue")], brightBlack: [dark.brightBlack, ratio(dark, "brightBlack")] });
  check("faint text is the secondary ink: at AA on the ground, and well under the ink it was dimmed from",
    ratio(dark, "dim") >= 4.5 && ratio(dark, "dim") < ratio(dark, "ink") / 1.8, { dim: [dark.dim, ratio(dark, "dim")], ink: ratio(dark, "ink") });
  // Its own ink is the 217,119,87 it was written in; faint, it has to come out nearer the ground.
  check("faint truecolor is faint too — xterm's DOM renderer drew it at full strength",
    !!dark.rgbDim && contrast(dark.canvas, dark.rgbDim.seen) < contrast(dark.canvas, [217, 119, 87]) / 1.3, dark.rgbDim);

  // ── My shell's: xterm's own palette, into the terminal already open ─────────────────────────
  const settings = async (tab, sel) => {
    for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, modifiers: 4, key: ",", code: "Comma", windowsVirtualKeyCode: 188 });
    await until(() => evalIn(c, `!!document.querySelector('.settings-page-pane')`), 10_000, "settings");
    await evalIn(c, `(() => { [...document.querySelectorAll('.page-rail input')].find((r) => r.value === ${JSON.stringify(tab)}).click(); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector(${JSON.stringify(sel)})`), 8_000, sel);
    await evalIn(c, `(() => { document.querySelector(${JSON.stringify(sel)}).click(); return true; })()`);
    await sleep(500);
  };
  const closeSettings = async () => {
    await evalIn(c, `(() => { document.querySelector('.page-overlay button[aria-label^="Close"]').click(); return true; })()`);
    await until(() => evalIn(c, `!document.querySelector('.settings-page-pane')`), 5_000, "back");
    await sleep(600);
  };
  await settings("general", "input[name=settings-terminal-colors][value=shell]");
  // The Terminals group is below the fold of General; a clip outside the viewport captures nothing.
  await evalIn(c, `(() => { document.querySelector('[data-setting=terminal-colors]').scrollIntoView({ block: "center" }); return true; })()`);
  await sleep(500);
  const row = await evalIn(c, `(() => { const r = document.querySelector('[data-setting=terminal-colors]'); const b = r.getBoundingClientRect(); return { text: r.textContent, x: b.left - 12, y: b.top - 10, width: b.width + 24, height: b.height + 20 }; })()`);
  check("Settings offers Realm's colours or the shell's, beside the cursor's shape", row.text.includes("Terminal colours") && row.text.includes("Realm's") && row.text.includes("My shell's"), row.text);
  await shot(c, "setting", row);
  await closeSettings();
  const shell = await evalIn(c, COLORS);
  note("My shell's: what xterm drew", shell);
  check("My shell's puts xterm's own blue into the terminal that was already open", shell.blue?.join() === "52,101,164", shell.blue);
  await shot(c, "output-shell-colours", termBox);
  await settings("general", "input[name=settings-terminal-colors][value=realm]");
  await closeSettings();

  // ── The light face ──────────────────────────────────────────────────────────────────────────
  await settings("appearance", "fieldset[aria-label=Theme] input[value=light]");
  await closeSettings();
  const light = await evalIn(c, COLORS);
  note("light: what xterm drew", light);
  check("on the light face blue and bright black still read at AA", ratio(light, "blue") >= 4.5 && ratio(light, "brightBlack") >= 4.5,
    { blue: [light.blue, ratio(light, "blue")], brightBlack: [light.brightBlack, ratio(light, "brightBlack")] });
  check("faint text on the light face reads at AA too, and is still faint", ratio(light, "dim") >= 4.5 && ratio(light, "dim") < ratio(light, "ink") / 1.8,
    { dim: [light.dim, ratio(light, "dim")], ink: ratio(light, "ink") });
  await shot(c, "output-light", termBox);
  await focusedShot(c, "focus-light");
  await shot(c, "window-light");
  await shot(c, "tabs-light", stripBox);

  // ── The shell comes back: the tab follows ───────────────────────────────────────────────────
  await type(opened.realm, "\x04"); // ^D: cat sees end of input and exits
  await until(async () => !(await api.call("terminals.programs", {}))[opened.realm], 10_000, "claude to exit").catch(() => {});
  await sleep(900);
  const back = (await tabs()).find((t) => t.text.endsWith("realm"));
  check("when the program exits the tab goes back to its folder and the terminal glyph", back?.text === "realm" && !back.tile, back);
}

main()
  .catch((e) => { console.log(`FAIL harness ${e.message}`); process.exitCode = 1; })
  .finally(async () => {
    try { electron?.kill("SIGKILL"); } catch {}
    await sleep(200);
    await stopDaemons(home);
    for (const p of [CDP_PORT, SERVER_PORT]) killPort(p);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
