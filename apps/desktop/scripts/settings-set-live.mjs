/**
 * Live check: a look or theme set over RPC (`settings.set`) shows in the open window at once, with no
 * reload.
 *
 *   pnpm build && node apps/desktop/scripts/settings-set-live.mjs
 *
 * Boots the built app quietly on a scratch home with the scripted agent. The page is marked first, so
 * a reload would show. Each row passes on what the window's root says afterwards (`data-glass`,
 * `data-mode`) and on the mark still being there. Rows go to results.json in LIVE_OUT_DIR and
 * LIVE_OUT, with light.png and dark.png beside them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { launchLiveApp, sleep, until } from "./lib/live-app.mjs";

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
const app = await launchLiveApp({ name: "settings-set" });
const page = app.page;
const applied = () => page.eval(`(() => {
  const root = document.documentElement;
  return {
    mode: root.dataset.mode ?? null,
    glass: root.hasAttribute("data-glass"),
    composerLook: document.querySelector(".composer")?.getAttribute("data-look") ?? null,
    sameDocument: window.__settingsSetMark === ${JSON.stringify(MARK)},
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

  const start = await applied();
  row("the window starts plain, on this document", !start.glass && start.sameDocument, start);

  await api.call("settings.set", { key: "ui.look", value: "glass" });
  const glass = await waitFor((s) => s.glass);
  row("ui.look glass over rpc: the root wears data-glass, no reload", glass.glass && glass.sameDocument, glass);

  await api.call("settings.set", { key: "ui.theme", value: "light" });
  const light = await waitFor((s) => s.mode === "light");
  await sleep(400);
  await app.screenshot(path.join(OUT, "light.png"));
  row("ui.theme light over rpc: data-mode is light, no reload", light.mode === "light" && light.sameDocument, { ...light, capture: "light.png" });

  await api.call("settings.set", { key: "ui.theme", value: "dark" });
  const dark = await waitFor((s) => s.mode === "dark");
  await sleep(400);
  await app.screenshot(path.join(OUT, "dark.png"));
  row("ui.theme dark over rpc: data-mode is dark, no reload", dark.mode === "dark" && dark.sameDocument, { ...dark, capture: "dark.png" });

  await api.call("settings.set", { key: "ui.look", value: "plain" });
  const plain = await waitFor((s) => !s.glass);
  row("ui.look plain over rpc: data-glass is gone, no reload", !plain.glass && plain.sameDocument, plain);

  for (const dir of outs.slice(1)) for (const f of ["light.png", "dark.png"]) fs.copyFileSync(path.join(OUT, f), path.join(dir, f));
  api.close();
} finally {
  writeRows();
  await app.stop();
}
