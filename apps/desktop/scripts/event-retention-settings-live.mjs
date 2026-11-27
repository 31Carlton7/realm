/**
 * Live check: Settings ▸ General ▸ Storage reads and writes `storage.eventRetentionDays`.
 *
 *   pnpm build && node apps/desktop/scripts/event-retention-settings-live.mjs
 *
 * Boots the built app quietly on a scratch home with the scripted agent and opens Settings. The row
 * must start on Off with nothing stored; a click on 30 days must reach the server (read back over
 * `settings.get`); a value written over RPC (90) must show once Settings is opened again. Captures
 * the Storage section in light and dark (light.png, dark.png, unflattened, with pages.json) to LIVE_OUT_DIR. Ports: LIVE_SERVER_PORT
 * (8788) and LIVE_CDP_PORT (9223). Nothing is billed.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { desktopRoot, freePort, launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const OUT = process.env.LIVE_OUT_DIR ?? path.join(os.tmpdir(), "realm-event-retention-settings-live");
fs.mkdirSync(OUT, { recursive: true });
const KEY = "storage.eventRetentionDays";
/** Each capture's `--page`, which a viewer needs under the window's alpha. */
const pages = {};

const row = (name, pass, observed) => {
  if (!pass) process.exitCode = 1;
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(observed)}`);
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

// Over http, so the paint worklet draws the squircles the screenshots show.
const httpPort = await freePort();
const web = spawn("python3", ["-m", "http.server", String(httpPort), "--bind", "127.0.0.1"], { cwd: path.join(desktopRoot, "out/renderer"), stdio: "ignore" });
process.on("exit", () => web.kill());
const rendererUrl = `http://127.0.0.1:${httpPort}/index.html`;
await until(() => fetch(rendererUrl).then((r) => r.ok), 10_000, "the renderer over http");
const app = await launchLiveApp({
  name: "event-retention-settings", rendererUrl,
  serverPort: Number(process.env.LIVE_SERVER_PORT ?? 8788), cdpPort: Number(process.env.LIVE_CDP_PORT ?? 9223),
});
const page = app.page;
const shown = () => page.eval(`(() => {
  const set = document.querySelector('fieldset[aria-label="Trim old tool output"]');
  return set ? { checked: set.querySelector("input:checked")?.closest("label")?.textContent.trim() ?? null,
    detail: set.closest(".settings-row").querySelector(".settings-row-desc")?.textContent ?? null } : null;
})()`);
const openSettings = async () => {
  // Through the palette, typed rather than picked: the window is quiet, so ⌘, never reaches its menu.
  await page.eval(`(async () => {
    if (document.querySelector(".settings-page-pane")) return true;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector(".palette input"); i++) await new Promise((r) => setTimeout(r, 25));
    const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "settings");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 40; i++) {
      const hit = [...document.querySelectorAll(".palette-list [role=option], .palette-list button")].find((b) => /open settings/i.test(b.textContent));
      if (hit) { hit.click(); break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    return true;
  })()`);
  await until(() => page.eval(`!!document.querySelector(".settings-page-pane")`), 10_000, "settings");
  await page.eval(`(() => { const t = [...document.querySelectorAll(".settings-tab")].find((l) => l.textContent.trim() === "General"); (t?.querySelector("input") ?? t)?.click(); return true; })()`);
  return until(shown, 10_000, "the Storage row");
};
const capture = async (file) => {
  await page.eval(`document.querySelector('[data-setting="event-retention"]').scrollIntoView({ block: "center" })`);
  await sleep(500);
  // The window's ground is the Mac's material, which a DOM capture does not hold, so the PNG is left
  // clear and the theme's page colour is written beside it for whoever lays it over a ground.
  pages[file] = await page.eval(`(() => {
    const c = document.createElement("canvas").getContext("2d");
    c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim();
    c.fillRect(0, 0, 1, 1);
    return [...c.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  })()`);
  fs.writeFileSync(path.join(OUT, "pages.json"), JSON.stringify(pages));
  const box = await page.eval(`(() => {
    const row = document.querySelector('[data-setting="event-retention"]');
    const list = row.closest(".settings-list");
    const head = list.previousElementSibling;
    const a = head.getBoundingClientRect(), b = list.getBoundingClientRect();
    return { x: Math.floor(Math.min(a.left, b.left)) - 16, y: Math.floor(a.top) - 16, width: Math.ceil(b.width) + 32, height: Math.ceil(b.bottom - a.top) + 32 };
  })()`);
  return app.screenshot(path.join(OUT, file), box);
};

try {
  await until(() => page.eval(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await page.eval(`(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => page.eval(`!!document.querySelector('.composer')`), 30_000, "composer");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  const api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;

  const first = await openSettings();
  const stored = (await api.call("settings.get", { key: KEY })).value;
  row("unset, the row reads Off and says what it cuts", first.checked === "Off" && stored === null && /can't be undone/.test(first.detail ?? ""), { shown: first, stored });

  await page.eval(`(() => { const l = [...document.querySelectorAll('fieldset[aria-label="Trim old tool output"] label')].find((x) => x.textContent.trim() === "30 days"); l.querySelector("input").click(); return true; })()`);
  const written = await until(async () => { const v = (await api.call("settings.get", { key: KEY })).value; return v === 30 ? { v } : null; }, 5_000, "30 on the server").catch(() => null);
  const lit = await until(async () => { const s = await shown(); return s?.checked === "30 days" ? s : null; }, 5_000, "30 days lit").catch(() => shown());
  row("a click on 30 days writes 30 to the server", written?.v === 30 && lit?.checked === "30 days", { written, shown: lit });

  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await until(() => page.eval(`document.documentElement.dataset.mode === "light"`), 5_000, "light");
  await capture("light.png");
  await api.call("settings.set", { key: "ui.theme", value: "dark" });
  await until(() => page.eval(`document.documentElement.dataset.mode === "dark"`), 5_000, "dark");
  await capture("dark.png");

  // A value written elsewhere shows once the app reads it again (a reload, as at the next launch).
  await api.call("settings.set", { key: KEY, value: 90 });
  await page.send("Page.reload");
  await until(() => page.eval(`!!document.querySelector('.composer') || !!document.querySelector(".settings-page-pane")`), 30_000, "reload");
  await openSettings();
  // Boot reads the setting after the page can already be up, so the row is given a moment to land.
  const again = await until(async () => { const s = await shown(); return s?.checked === "90 days" ? s : null; }, 5_000, "90 days lit").catch(() => shown());
  row("a stored 90 reads as 90 days after a reload", again?.checked === "90 days", { shown: again });
  api.close();
} finally {
  await app.stop();
  web.kill();
}
console.log(`captures in ${OUT}`);
