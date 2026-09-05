/**
 * Live check for the background transparency control (run with:
 * node apps/desktop/scripts/transparency-live.mjs)
 *
 * Boots the REAL built app on a scratch REALM_HOME, drives the slider in Settings → App, and reads
 * what the cascade actually produces.
 *
 * Note what this deliberately does NOT do: sample the sidebar off a screenshot. The macOS material
 * is composited by the window server BELOW the web contents, so `Page.captureScreenshot` never sees
 * it — a translucent sidebar comes back as the overlay colour over nothing. The claim that can be
 * measured is therefore the one that matters anyway: how much of the ground the sidebar paints, and
 * which surfaces are translucent at all. What is behind it is macOS's business.
 *
 * Three things nothing in vitest can establish, because jsdom has no cascade, no `color-mix()` and
 * no media emulation:
 *   1. The slider reaches the sidebar. `--ground-alpha` → `--sidebar-ground` → `.sidebar`, resolved
 *      by Chromium, with the alpha coming out where it was put.
 *   2. The scope holds. Every pane stays fully opaque at every setting — the reason the control is
 *      allowed to exist at all is that text never renders over the desktop.
 *   3. `prefers-reduced-transparency: reduce` wins over the user's value, which is only true because
 *      the composition lives in CSS. THE mutant: compose `--sidebar-ground` inline in applyTheme.
 *      Everything still looks right until someone turns Reduce Transparency on, and then nothing
 *      happens — an inline custom property beats every media query there is.
 *
 * REBUILD FIRST (`pnpm build`): this boots apps/desktop/out, not the sources.
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9342), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8908);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-transparency-live-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The default and the ends of the range, from packages/ui/src/theme.ts. */
const DEFAULT_ALPHA = 82, MIN_ALPHA = 55, MAX_ALPHA = 100;

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
  const events = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      events.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });
  return {
    ready, events,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

const HELPERS = `
window.__live = window.__live ?? {
  setInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  },
  /** Any CSS colour as [r,g,b,a] on 0..255 / 0..1. Painting it is the only way to read a
   *  color-mix() result back as numbers — the computed value is still a color-mix() expression. */
  rgba(color) {
    const g = (this._cv ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true }));
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = color;
    g.fillRect(0, 0, 1, 1);
    const [r, gr, b, a] = g.getImageData(0, 0, 1, 1).data;
    return [r, gr, b, +(a / 255).toFixed(3)];
  },
  openSettings() {
    const hit = [...document.querySelectorAll(".sidebar button")].find((b) => b.textContent.trim() === "Settings");
    if (!hit) throw new Error("no Settings nav item");
    hit.click();
    return true;
  },
  slider() { return document.querySelector('input[aria-label="Background transparency"]'); },
  toggle() { return document.querySelector('input[aria-label="Translucent sidebar"]'); },
  /** The settings tabs are radio INPUTS inside labels, so the visible word is on the label. */
  tab(name) {
    const hit = [...document.querySelectorAll("label")].find((l) => l.textContent.trim() === name && l.querySelector('input[type="radio"]'));
    if (!hit) throw new Error("no settings tab: " + name + " — have " + [...document.querySelectorAll("label input[type=radio]")].map((i) => i.closest("label").textContent.trim()).join("|"));
    hit.querySelector("input").click();
    return true;
  },
  probe() {
    const root = getComputedStyle(document.documentElement);
    const sidebar = document.querySelector(".sidebar");
    const pane = document.querySelector(".panel") ?? document.querySelector(".main");
    return {
      alphaToken: root.getPropertyValue("--ground-alpha").trim(),
      page: this.rgba(root.getPropertyValue("--page").trim()),
      sidebar: this.rgba(getComputedStyle(sidebar).backgroundColor),
      pane: this.rgba(getComputedStyle(pane).backgroundColor),
      sliderValue: this.slider()?.value ?? null,
      // Scoped to THIS slider's row. The readout class is shared with the contrast control, which sits
      // above this one in the same form — a bare querySelector reads that one instead and passes or
      // fails on a number belonging to a different setting.
      readout: this.slider()?.parentElement?.querySelector(".slider-value")?.textContent ?? null,
    };
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) { failures++; process.exitCode = 1; }
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper], {
    env: {
      ...process.env,
      REALM_HOME: path.join(scratch, "home"),
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const rendererTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(rendererTarget.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.setInput(input, "Live");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  const rest = await evalIn(c, `__live.probe()`);
  check("out of the box the sidebar paints the shipped 82% of the window ground",
    rest.alphaToken === `${DEFAULT_ALPHA}%` && near(rest.sidebar[3], DEFAULT_ALPHA / 100, 0.01), rest);
  check("and the ground it paints is --page, not a colour of the sidebar's own",
    rest.sidebar.slice(0, 3).every((v, i) => near(v, rest.page[i], 2)), { sidebar: rest.sidebar, page: rest.page });

  await evalIn(c, `__live.openSettings()`);
  await until(() => evalIn(c, `!!document.querySelector('label input[type="radio"]')`), 10000, "settings page");
  await evalIn(c, `__live.tab("App")`);
  await until(() => evalIn(c, `!!__live.slider()`), 10000, "the slider");

  // 1. The slider reaches the sidebar, at both ends of its range and in the middle.
  for (const alpha of [MAX_ALPHA, MIN_ALPHA, 64]) {
    // The control is labelled by TRANSPARENCY and stores OPACITY, so the value it takes is flipped.
    await evalIn(c, `__live.setInput(__live.slider(), "${MIN_ALPHA + MAX_ALPHA - alpha}")`);
    await sleep(200);
    const p = await evalIn(c, `__live.probe()`);
    check(`at ${alpha}% opaque the sidebar's ground carries that alpha`,
      p.alphaToken === `${alpha}%` && near(p.sidebar[3], alpha / 100, 0.01), { token: p.alphaToken, sidebar: p.sidebar, readout: p.readout });
    // 2. The scope: whatever the slider says, a pane is opaque. This is the claim that lets the
    //    control ship at all — pane text never renders over the desktop, so its contrast is the
    //    theme's business and not the wallpaper's.
    check(`at ${alpha}% opaque the panes are still fully opaque`, p.pane[3] === 1, { pane: p.pane });
    check(`the readout is the complement of what is stored`, p.readout === `${100 - alpha}%`, { readout: p.readout, alpha });
  }

  // 3. Reduced transparency wins, and does not eat the value.
  // 3. The switch and the amount are one number. Fully opaque IS off, so the switch has to read the
  //    ground rather than a boolean of its own — two stored states could disagree, and the pair of
  //    them sit on the same row where the disagreement would be visible.
  await evalIn(c, `__live.setInput(__live.slider(), "${MIN_ALPHA}")`);
  await sleep(300);
  let t = await evalIn(c, `({ on: __live.toggle().checked, disabled: __live.slider().disabled, token: getComputedStyle(document.documentElement).getPropertyValue("--ground-alpha").trim() })`);
  check("dragging the amount to nothing turns the switch off — that IS off", t.on === false && t.token === "100%", t);
  check("...and the amount goes inert rather than showing a value nothing is using", t.disabled === true, t);
  await evalIn(c, `__live.toggle().click()`);
  await sleep(300);
  t = await evalIn(c, `({ on: __live.toggle().checked, disabled: __live.slider().disabled, token: getComputedStyle(document.documentElement).getPropertyValue("--ground-alpha").trim() })`);
  check("switching it back on restores a translucent ground", t.on === true && t.token === "82%" && t.disabled === false, t);

  await evalIn(c, `__live.setInput(__live.slider(), "${MIN_ALPHA + MAX_ALPHA - MIN_ALPHA}")`);
  await sleep(200);
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  await sleep(250);
  const reduced = await evalIn(c, `__live.probe()`);
  check("Reduce Transparency makes the sidebar opaque however far the slider is pushed",
    reduced.sidebar[3] === 1, { sidebar: reduced.sidebar, token: reduced.alphaToken });
  check("...and the sidebar is still the window ground, not a fallback colour",
    reduced.sidebar.slice(0, 3).every((v, i) => near(v, reduced.page[i], 2)), { sidebar: reduced.sidebar, page: reduced.page });
  check("...and the user's value is kept rather than reset by the preference",
    reduced.alphaToken === `${MIN_ALPHA}%`, reduced.alphaToken);

  await c.send("Emulation.setEmulatedMedia", { features: [] });
  await sleep(250);
  const back = await evalIn(c, `__live.probe()`);
  check("turning the preference off restores the setting untouched",
    near(back.sidebar[3], MIN_ALPHA / 100, 0.01), back.sidebar);

  const shot = (await c.send("Page.captureScreenshot", { format: "png" })).data;
  const out = path.join(os.tmpdir(), "realm-transparency-settings.png");
  fs.writeFileSync(out, Buffer.from(shot, "base64"));
  console.log(`SCREENSHOT settings ${out}`);

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  console.log(failures === 0 ? "\nALL CLEAR" : `\n${failures} failures`);
  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { electron?.kill("SIGKILL"); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 1200);
  });
