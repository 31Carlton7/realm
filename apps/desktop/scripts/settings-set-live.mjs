/**
 * Live check: a look or theme set over RPC (`settings.set`) shows in the open window at once, with no
 * reload.
 *
 *   pnpm build && node apps/desktop/scripts/settings-set-live.mjs
 *
 * Boots the built app quietly on a scratch home with the scripted agent, with Settings ▸ Appearance
 * open. The page is marked first, so a reload would show. A theme row passes on the root's `data-mode`
 * changing to the value set. A look row passes on the look Settings shows as chosen changing to it,
 * and on the root's `data-glass` agreeing with that choice under what holds glass back (glass/look.ts):
 * where something does, the row says which, and the window must stay plain and Settings must name it.
 * Every row also needs the mark still there. Rows go to results.json in LIVE_OUT_DIR and LIVE_OUT,
 * with light.png and dark.png beside them.
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
    chosen: document.querySelector('fieldset[aria-label="Controls"] input:checked')?.value ?? null,
    heldText: document.querySelector('.settings-row[data-setting="look"] .settings-row-detail')?.textContent ?? null,
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
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4, key: ",", code: "Comma", windowsVirtualKeyCode: 188 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: ",", code: "Comma", windowsVirtualKeyCode: 188 });
  await until(() => page.eval(`!!document.querySelector(".settings-page-pane")`), 10_000, "settings");
  await page.eval(`(() => { const t = [...document.querySelectorAll(".settings-tab")].find((l) => l.textContent.trim() === "Appearance"); (t?.querySelector("input") ?? t)?.click(); return true; })()`);
  await until(() => page.eval(`!!document.querySelector('fieldset[aria-label="Controls"] input:checked')`), 10_000, "the Controls row");
  // CI's macOS runners have Reduce Transparency on, which holds glass back whatever the setting says.
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "no-preference" }] });
  await page.eval(`window.__settingsSetMark = ${JSON.stringify(MARK)}`);
  const api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;

  /* Each row passes only when the window moved: from what it showed just before the set to the value
     set, on the same document. A value the window already showed proves nothing, so a window that
     starts light is taken to dark first. */
  const step = async (name, key, value, read, capture, shownRight = () => true) => {
    const before = await applied();
    await api.call("settings.set", { key, value });
    const after = await waitFor((s) => read(s) === value && shownRight(s));
    if (capture) { await sleep(400); await app.screenshot(path.join(OUT, capture)); }
    row(name, read(before) !== value && read(after) === value && shownRight(after) && after.sameDocument, { before, after, ...(capture ? { capture } : {}) });
  };
  const chosen = (s) => s.chosen;
  const mode = (s) => s.mode;
  /* Where glass is held back anyway (Low Power Mode, or a renderer with no backdrop url), a look row
     checks the window stayed plain and Settings says why, instead of asking for glass it cannot draw. */
  const shownMatchesChoice = (s) => s.glassHeldBy.length && s.chosen === "glass"
    ? !s.glass && s.heldText !== null
    : s.glass === (s.chosen === "glass");

  await step("ui.look glass over rpc: Settings shows glass chosen, the root wears it unless held back, no reload", "ui.look", "glass", chosen, null, shownMatchesChoice);
  if ((await applied()).mode === "light") await step("ui.theme dark over rpc, from the light it started in: data-mode turns dark, no reload", "ui.theme", "dark", mode);
  await step("ui.theme light over rpc: data-mode turns light, no reload", "ui.theme", "light", mode, "light.png");
  await step("ui.theme dark over rpc: data-mode turns dark, no reload", "ui.theme", "dark", mode, "dark.png");
  await step("ui.look plain over rpc: Settings shows plain chosen, the root has no data-glass, no reload", "ui.look", "plain", chosen, null, shownMatchesChoice);

  for (const dir of outs.slice(1)) for (const f of ["light.png", "dark.png"]) fs.copyFileSync(path.join(OUT, f), path.join(dir, f));
  api.close();
} finally {
  writeRows();
  await app.stop();
  web.kill();
}
