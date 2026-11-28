/**
 * Count the RPCs the main window's renderer makes from load to first paint, and time that paint.
 *
 *   node apps/desktop/scripts/boot-rpcs-live.mjs --home <scratch home> --out <dir> \
 *     --renderer A=<out/renderer copy> --renderer B=<out/renderer copy> [--runs 5]
 *
 * Every run boots the BUILT main and server on `--home` (a scratch copy of a real home, never ~/Realm)
 * through `launchLiveApp`, serves one renderer build over http, and reloads the main window with
 * the socket and paint observers below installed before any of the page's own code runs. The builds
 * take turns, A B A B, so swap and other noise land on both alike.
 *
 * "First paint" is the boot mark coming down (`#boot[data-done]`, set when the store is `booted`):
 * the frame before it is the splash, the frame after is the app. Reported per run, then median and
 * spread per build, to `<out>/runs.jsonl` and `<out>/summary.json`.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { cdp, launchLiveApp, sleep, until } from "./lib/live-app.mjs";
import { stopDaemons } from "./lib/daemon-token.mjs";

const { values } = parseArgs({
  options: {
    home: { type: "string" },
    out: { type: "string" },
    renderer: { type: "string", multiple: true },
    runs: { type: "string", default: "5" },
    settle: { type: "string", default: "8000" },
  },
});
if (!values.home || !values.out || !values.renderer?.length) {
  process.stderr.write("usage: boot-rpcs-live.mjs --home <dir> --out <dir> --renderer NAME=<dir> [--renderer …] [--runs N]\n");
  process.exit(2);
}
const home = path.resolve(values.home);
if (home === path.join(process.env.HOME, "Realm")) throw new Error("refusing to run on the real ~/Realm");
const outDir = path.resolve(values.out);
fs.mkdirSync(outDir, { recursive: true });
const builds = values.renderer.map((r) => { const [name, dir] = r.split("="); return { name, dir: path.resolve(dir) }; });

/* Installed before the page's own scripts: wraps WebSocket so every frame to the server is logged with
   its method, size and time, and notes when the boot mark comes down. */
const INSTRUMENT = `(() => {
  const enc = new TextEncoder();
  const log = [];
  const marks = {};
  window.__bootRpcs = { log, marks };
  const Native = window.WebSocket;
  const byId = new Map();
  class Logged extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      this.addEventListener("message", (e) => {
        const t = performance.now();
        const raw = String(e.data);
        let m = null; try { m = JSON.parse(raw); } catch {}
        const bytes = enc.encode(raw).length;
        if (m && m.id !== undefined && byId.has(m.id)) { const c = byId.get(m.id); c.recv = t; c.inBytes = bytes; c.ok = m.ok; }
        else log.push({ kind: "event", event: m && m.event, t, inBytes: bytes });
      });
    }
    send(data) {
      try {
        const m = JSON.parse(data);
        const c = { kind: "call", id: m.id, method: m.method, key: m.method === "settings.get" ? m.params && m.params.key : undefined, sent: performance.now(), outBytes: enc.encode(data).length };
        byId.set(m.id, c); log.push(c);
      } catch {}
      return super.send(data);
    }
  }
  window.WebSocket = Logged;
  const watch = () => {
    const el = document.getElementById("boot");
    if (!el) return;
    new MutationObserver(() => {
      if (marks.booted === undefined && el.hasAttribute("data-done")) {
        marks.booted = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => { marks.frameAfter = performance.now(); }));
      }
    }).observe(el, { attributes: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch); else watch();
  new PerformanceObserver((l) => { for (const e of l.getEntries()) marks[e.name] = e.startTime; }).observe({ type: "paint", buffered: true });
})();`;

function serve(dir) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(dir, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

/** The main window's page: two page targets share its URL (the quick chat panel is the other). */
async function mainPage(app, url) {
  return until(async () => {
    for (const t of (await app.targets()).filter((x) => x.type === "page" && x.url.startsWith(url))) {
      const c = await cdp(t.webSocketDebuggerUrl);
      const w = await c.eval("innerWidth").catch(() => 0);
      if (w > 600) return c;
      c.close();
    }
    return null;
  }, 30_000, "the main window's page");
}

async function oneRun(build, url, i) {
  const app = await launchLiveApp({
    name: "boot-rpcs",
    rendererUrl: url,
    env: { REALM_HOME: home, REALM_LAYA_VENV: path.join(home, "laya/venv"), REALM_LAYA_HF_HOME: path.join(home, "laya/hf") },
    timeoutMs: 60_000,
  });
  try {
    const page = await mainPage(app, url);
    await page.send("Page.enable");
    // Let the first load and the server's own start-up work finish before the measured reload.
    await until(() => page.eval(`!!document.getElementById("boot")?.hasAttribute("data-done") || !document.getElementById("boot")`), 60_000, "the first boot");
    await sleep(Number(values.settle));
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
    await page.send("Page.reload", { ignoreCache: false });
    await sleep(500);
    await until(() => page.eval(`window.__bootRpcs?.marks.booted !== undefined`), 60_000, "the boot mark to come down");
    await sleep(3000);
    const { log, marks } = await page.eval(`window.__bootRpcs`);
    page.close();
    return summarize(build.name, i, log, marks);
  } finally {
    await stopDaemons(home).catch(() => {});
    await app.stop();
  }
}

function summarize(build, run, log, marks) {
  const calls = log.filter((c) => c.kind === "call");
  const before = calls.filter((c) => c.sent < marks.booted);
  const byMethod = {};
  for (const c of before) {
    const m = (byMethod[c.method] ??= { n: 0, outBytes: 0, inBytes: 0, ms: 0 });
    m.n++; m.outBytes += c.outBytes; m.inBytes += c.inBytes ?? 0; m.ms += (c.recv ?? marks.booted) - c.sent;
  }
  const after = {};
  for (const c of calls) if (c.sent >= marks.booted) after[c.method] = (after[c.method] ?? 0) + 1;
  const keys = {};
  for (const c of before) if (c.key) keys[c.key] = (keys[c.key] ?? 0) + 1;
  return {
    build, run, booted: marks.booted, frameAfter: marks.frameAfter ?? null, fcp: marks["first-contentful-paint"] ?? null,
    callsBefore: before.length, callsAfter3s: calls.length - before.length,
    bytesBefore: before.reduce((s, c) => s + c.outBytes + (c.inBytes ?? 0), 0),
    eventsBefore: log.filter((e) => e.kind === "event" && e.t < marks.booted).length,
    byMethod, afterByMethod: after, settingsKeys: keys,
    calls: before.map(({ method, key, sent, recv, outBytes, inBytes }) => ({ method, key, sent: +sent.toFixed(1), recv: recv === undefined ? null : +recv.toFixed(1), outBytes, inBytes })),
  };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

const served = await Promise.all(builds.map((b) => serve(b.dir)));
const runsFile = path.join(outDir, "runs.jsonl");
const results = [];
try {
  for (let i = 0; i < Number(values.runs); i++) {
    for (const [k, build] of builds.entries()) {
      const r = await oneRun(build, served[k].url, i);
      results.push(r);
      fs.appendFileSync(runsFile, `${JSON.stringify(r)}\n`);
      process.stdout.write(`${build.name}#${i} booted=${r.booted.toFixed(0)}ms calls=${r.callsBefore} settings.get=${r.byMethod["settings.get"]?.n ?? 0} bytes=${r.bytesBefore}\n`);
    }
  }
} finally {
  for (const s of served) s.server.close();
}
const summary = {};
for (const b of builds) {
  const rs = results.filter((r) => r.build === b.name);
  const stat = (f) => { const xs = rs.map(f).filter((x) => x !== null); return { median: median(xs), min: Math.min(...xs), max: Math.max(...xs) }; };
  summary[b.name] = { runs: rs.length, booted: stat((r) => r.booted), fcp: stat((r) => r.fcp), callsBefore: stat((r) => r.callsBefore), bytesBefore: stat((r) => r.bytesBefore), settingsGet: stat((r) => r.byMethod["settings.get"]?.n ?? 0) };
}
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
