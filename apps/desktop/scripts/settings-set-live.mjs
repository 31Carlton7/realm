/**
 * Live check: a look or theme set over RPC (`settings.set`) shows in the open window at once, with no
 * reload.
 *
 *   pnpm build && node apps/desktop/scripts/settings-set-live.mjs
 *
 * Boots the built app quietly on a scratch home with the scripted agent. The page is marked first, so
 * a reload would show. Each row passes on the window's root (`data-glass`, `data-mode`) changing to
 * the value set, and on the mark still being there. Rows go to results.json in LIVE_OUT_DIR and
 * LIVE_OUT, with light.png and dark.png beside them.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { desktopRoot, freePort, launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const outs = [...new Set([process.env.LIVE_OUT_DIR, process.env.LIVE_OUT].filter(Boolean))];
if (outs.length === 0) outs.push(path.join(os.tmpdir(), "realm-settings-set-live"));
for (const dir of outs) fs.mkdirSync(dir, { recursive: true });
const OUT = outs[0];

const rows = [];
const writeRows = () => { for (const dir of outs) fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(rows, null, 2)); };
const row = (name, pass, observed) => {
  rows.push({ name, pass, observed });
  if (!pass) process.exitCode = 1;
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(observed)}`);
  writeRows();
};

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
  });
  return {
    ready: new Promise((res) => ws.addEventListener("open", res)),
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

const MARK = `settings-set-${Date.now()}`;
// Over http, as the other checks that read data-glass are: from file:// the window falls back to plain.
const httpPort = await freePort();
const web = spawn("python3", ["-m", "http.server", String(httpPort), "--bind", "127.0.0.1"], { cwd: path.join(desktopRoot, "out/renderer"), stdio: "ignore" });
process.on("exit", () => web.kill());
const rendererUrl = `http://127.0.0.1:${httpPort}/index.html`;
await until(() => fetch(rendererUrl).then((r) => r.ok), 10_000, "the renderer over http");
const app = await launchLiveApp({ name: "settings-set", rendererUrl });
const page = app.page;
const applied = () => page.eval(`(() => {
  const root = document.documentElement;
  return {
    mode: root.dataset.mode ?? null,
    glass: root.hasAttribute("data-glass"),
    sameDocument: window.__settingsSetMark === ${JSON.stringify(MARK)},
    // What would hold glass back (glass/look.ts), so a plain reading says whether the look was refused.
    glassHeldBy: [
      matchMedia("(prefers-reduced-transparency: reduce)").matches && "reduce-transparency",
      root.hasAttribute("data-low-power-mode") && "low-power-mode",
      !CSS.supports("backdrop-filter", "url(#a)") && "no-backdrop-url",
    ].filter(Boolean),
  };
})()`);
/** Polls for `want`, and answers with the last reading either way: a row is written from what the
 *  window showed, not from whether the wait threw. */
async function waitFor(want, ms = 5_000) {
  const end = Date.now() + ms;
  let seen = await applied();
  while (!want(seen) && Date.now() < end) { await sleep(100); seen = await applied(); }
  return seen;
}

try {
  await until(() => page.eval(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await page.eval(`(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => page.eval(`!!document.querySelector('.composer')`), 30_000, "composer");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await page.eval(`window.__settingsSetMark = ${JSON.stringify(MARK)}`);
  const api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;

  /* Each row passes only when the window moved: from what it showed just before the set to the value
     set, on the same document. A value the window already showed proves nothing, so a window that
     starts light is taken to dark first. */
  const step = async (name, key, value, read, capture) => {
    const before = await applied();
    await api.call("settings.set", { key, value });
    const after = await waitFor((s) => read(s) === value);
    if (capture) { await sleep(400); await app.screenshot(path.join(OUT, capture)); }
    row(name, read(before) !== value && read(after) === value && after.sameDocument, { before, after, ...(capture ? { capture } : {}) });
  };
  const look = (s) => (s.glass ? "glass" : "plain");
  const mode = (s) => s.mode;

  await step("ui.look glass over rpc: the root takes data-glass, no reload", "ui.look", "glass", look);
  if ((await applied()).mode === "light") await step("ui.theme dark over rpc, from the light it started in: data-mode turns dark, no reload", "ui.theme", "dark", mode);
  await step("ui.theme light over rpc: data-mode turns light, no reload", "ui.theme", "light", mode, "light.png");
  await step("ui.theme dark over rpc: data-mode turns dark, no reload", "ui.theme", "dark", mode, "dark.png");
  await step("ui.look plain over rpc: data-glass goes, no reload", "ui.look", "plain", look);

  for (const dir of outs.slice(1)) for (const f of ["light.png", "dark.png"]) fs.copyFileSync(path.join(OUT, f), path.join(dir, f));
  api.close();
} finally {
  writeRows();
  await app.stop();
  web.kill();
}
