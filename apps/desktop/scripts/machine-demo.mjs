/**
 * A demo of the machine pane, against a REAL guest (Plan 25).
 *
 * Not a test — nothing here asserts. It boots the built app on a scratch home, drives the connect
 * flow the way a person would, and captures what the pane looks like at each state: the connect
 * form, the image picker, the download, the boot, and a Linux guest running in a Realm pane.
 *
 * Run:  node apps/desktop/scripts/machine-demo.mjs
 * Rebuild first — this boots the BUILT app.
 *
 * Hygiene: scratch REALM_HOME + userData under mkdtemp, removed at exit unless DEMO_KEEP is set.
 * The guest is torn down with the app. Never point this at the real ~/Realm.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.DEMO_CDP_PORT ?? 9391), SERVER_PORT = Number(process.env.DEMO_SERVER_PORT ?? 8951);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-machine-demo-"));
const outDir = process.env.DEMO_OUT ?? path.join(os.tmpdir(), "realm-machine-demo-shots");
/** A pre-fetched ISO to seed the image store with, so the demo does not wait on a CDN. Optional. */
const SEED_ISO = process.env.DEMO_ISO ?? null;
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${tag}`);
    await sleep(200);
  }
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return {
    ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
  };
}
async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
let shotN = 0;
/**
 * Type at the guest.
 *
 * This goes in at the TOP of the renderer — a real key event on the focused canvas — so it exercises
 * every link in the chain the plan built: noVNC's key handling, the KeyEvent message, the websocket
 * relay, the RFB stream, and QEMU's usb-kbd. Writing to the guest any other way would prove nothing
 * about the pane.
 *
 * `code` is the physical key and `key` is the character; noVNC reads both, and a handler given only
 * one of them silently drops the keystroke.
 */
async function typeInGuest(c, text) {
  const KEYS = { "\n": { key: "Enter", code: "Enter", vk: 13, text: "\r" } };
  for (const ch of text) {
    const k = KEYS[ch] ?? { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch };
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, text: k.text });
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
    await sleep(90);
  }
}

async function shot(c, tag) {
  fs.mkdirSync(outDir, { recursive: true });
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(outDir, `${String(++shotN).padStart(2, "0")}-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`  shot: ${out}`);
  return out;
}
const step = (s) => console.log(`\n▸ ${s}`);

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const home = path.join(scratch, "home");

  // Seed the image store, so the demo shows a boot rather than a progress bar for a minute. The
  // store is content-addressed, so the file's own hash IS its name — the same thing a real download
  // would have produced, arrived at a different way.
  if (SEED_ISO && fs.existsSync(SEED_ISO)) {
    const { createHash } = await import("node:crypto");
    const bytes = fs.readFileSync(SEED_ISO);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const imagesDir = path.join(home, "machines", "images");
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, `${sha}.iso`), bytes);
    fs.writeFileSync(path.join(imagesDir, `${sha}.json`), JSON.stringify({ name: "Alpine 3.21", kind: "iso" }));
    console.log(`[demo] seeded ${(bytes.length / 1024 ** 2) | 0}MB image as ${sha.slice(0, 12)}…`);
    process.env.DEMO_SEEDED_SHA = sha;
  }

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.DEMO_USER_DATA);',
    "await import(process.env.DEMO_MAIN);",
  ].join("\n"));
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      DEMO_USER_DATA: path.join(scratch, "userData"),
      DEMO_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stdout.on("data", (d) => { const s = d.toString(); if (/machine|qemu/i.test(s)) process.stdout.write(`  [app] ${s}`); });
  electron.stderr.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 40000, "renderer");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  step("first run");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30000, "onboarding");
  await evalIn(c, `(() => {
    const i = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Machines');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30000, "composer");
  await sleep(600);

  step("the session bar's machine button");
  await evalIn(c, `(() => {
    const b = [...document.querySelectorAll('.panel-actions .icon-btn')].find((x) => /Connect a machine/.test(x.getAttribute('aria-label') ?? ''));
    if (!b) throw new Error('no machine button — have: ' + [...document.querySelectorAll('.panel-actions .icon-btn')].map((x) => x.getAttribute('aria-label')).join(' | '));
    b.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.machine-connect')`), 20000, "connect flow");
  await sleep(500);
  await shot(c, "connect-flow");

  step("what this Mac can offer");
  const routes = await evalIn(c, `[...document.querySelectorAll('.machine-routes button')].map((b) => b.textContent.trim())`);
  console.log(`  routes offered: ${routes.join(" · ")}`);

  if (routes.some((r) => /Linux VM/.test(r))) {
    step("A Linux VM here");
    await evalIn(c, `(() => { [...document.querySelectorAll('.machine-routes button')].find((b) => /Linux VM/.test(b.textContent)).click(); return true; })()`);
    await until(() => evalIn(c, `document.querySelectorAll('.machine-guest').length > 0`), 15000, "image list");
    await sleep(400);
    await shot(c, "image-picker");

    await evalIn(c, `(() => {
      const g = [...document.querySelectorAll('.machine-guest')].find((x) => /Alpine/.test(x.textContent));
      if (!g) throw new Error('no Alpine entry');
      g.click(); return true; })()`);
    await sleep(300);
    await shot(c, "image-chosen");

    step("download and install");
    await evalIn(c, `(() => { document.querySelector('.machine-connect').requestSubmit(); return true; })()`);
    // The download body, if the image was not seeded.
    const sawDownload = await until(async () => {
      const s = await evalIn(c, `(() => {
        const t = document.querySelector('.machine-title')?.textContent ?? '';
        return { title: t, meter: !!document.querySelector('.machine-meter'), facts: document.querySelector('.machine-facts')?.textContent ?? '' };
      })()`);
      return s.meter || /Starting|Connecting|Could not/.test(s.title) ? s : null;
    }, 30000, "download or boot").catch(() => null);
    if (sawDownload?.meter) { console.log(`  downloading: ${sawDownload.facts}`); await shot(c, "downloading"); }

    step("booting the guest");
    let lastReport = "";
    await until(async () => {
      const s = await evalIn(c, `(() => {
        const st = document.querySelector('.machine-title')?.textContent ?? '';
        const facts = document.querySelector('.machine-facts')?.textContent ?? '';
        const reason = document.querySelector('.machine-reason')?.textContent ?? '';
        const detail = document.querySelector('.machine-detail')?.textContent ?? '';
        const bar = document.querySelector('.machine-bar-meta')?.textContent ?? '';
        return { screen: !!document.querySelector('.machine-screen'), st, facts, reason, detail, bar };
      })()`);
      const report = `${s.st} | ${s.facts} | ${s.bar} ${s.reason ? "· " + s.reason : ""}${s.detail ? " · " + s.detail.slice(0, 160) : ""}`;
      if (report !== lastReport) { console.log(`  … ${report}`); lastReport = report; }
      return s.screen;
    }, 240000, "screen");
    await sleep(1500);
    await shot(c, "booting");

    step("waiting for the guest's own screen");
    const got = await until(async () => {
      const s = await evalIn(c, `(() => {
        const cv = document.querySelector('.machine-host canvas');
        if (!cv || cv.width < 2) return null;
        const g = cv.getContext('2d');
        const count = (x, y, w, h) => {
          const d = g.getImageData(x, y, w, h).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 90) n++;
          return n;
        };
        // WHERE the pixels are is what tells the two screens apart. QEMU's own "Display output is
        // not active." is a single line centred in the framebuffer; a booted Linux writes its
        // console from the TOP-LEFT corner down. Counting lit pixels anywhere cannot distinguish
        // them — both are a few thousand — and an earlier version screenshotted the placeholder
        // four times over while reporting success.
        return { w: cv.width, h: cv.height, lit: count(0, 0, cv.width, Math.min(cv.height, 200)), corner: count(0, 0, 420, 110) };
      })()`);
      if (s) process.stdout.write(`\r    lit ${s.lit} corner ${s.corner}   `);
      return s && s.corner > 150 ? s : null;
    }, 240000, "guest pixels").catch(() => null);
    console.log(got ? `\n  guest framebuffer ${got.w}x${got.h}, ${got.corner} lit pixels in the console corner` : "\n  guest never drew its own console");
    await sleep(1200);
    await shot(c, "guest-running");

    if (got) {
      step("logging in, to show the pane is a machine and not a picture");
      await evalIn(c, `(() => { const cv = document.querySelector('.machine-host canvas'); cv?.focus(); return document.activeElement?.tagName; })()`);
      await typeInGuest(c, "root\n");
      const shell = await until(async () => {
        // The prompt Alpine gives root is `localhost:~#`. Finding the `#` means the keystrokes
        // crossed the relay, reached usb-kbd, and the guest acted on them.
        const n = await evalIn(c, `(() => {
          const cv = document.querySelector('.machine-host canvas');
          const d = cv.getContext('2d').getImageData(0, 100, 420, 60).data;
          let lit = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 90) lit++;
          return lit;
        })()`);
        return n > 40 ? n : null;
      }, 45000, "root shell").catch(() => null);
      console.log(shell ? `  the guest answered the keyboard — a shell prompt drew (${shell} px)` : "  no shell prompt appeared");
      await sleep(900);
      await shot(c, "logged-in");
    }

    const bar = await evalIn(c, `(() => ({
      meta: document.querySelector('.machine-bar-meta')?.textContent ?? null,
      title: document.querySelector('.panel-title')?.textContent ?? null,
    }))()`);
    console.log(`  pane bar: ${bar.title} — ${bar.meta}`);
  } else {
    console.log("  (no QEMU on this Mac, so the local-VM route is absent — that is the design)");
  }

  step("the sidebar row carries the state with the pane closed");
  const row = await evalIn(c, `(() => {
    const r = [...document.querySelectorAll('.item-row')].find((x) => /machine|Alpine|New machine/i.test(x.getAttribute('aria-label') ?? ''));
    return r ? r.getAttribute('aria-label') : null;
  })()`);
  console.log(`  sidebar: ${row}`);
  await shot(c, "final");
}

/**
 * Take the guests down with the app.
 *
 * SIGKILL on Electron alone leaks QEMU. The app's `closeAll` is what stops a guest, and a killed
 * process does not run it — so the VM is reparented to launchd and keeps running, holding the lock
 * on a qcow2 inside a scratch home this function is about to delete. A demo run that ends this way
 * leaves a guest burning a core until someone notices.
 *
 * SIGTERM first, to give `closeAll` its chance, then the hammer; and then any qemu still naming this
 * run's scratch directory in its argv, which is precise enough that it cannot touch a guest the user
 * started themselves.
 */
const cleanup = () => {
  try { electron?.kill("SIGTERM"); } catch { /* gone */ }
  try { execFileSync("/bin/sh", ["-c", `pkill -f ${JSON.stringify(scratch)} 2>/dev/null; sleep 1; pkill -KILL -f ${JSON.stringify(scratch)} 2>/dev/null; true`], { stdio: "ignore" }); } catch { /* best effort */ }
  try { electron?.kill("SIGKILL"); } catch { /* gone */ }
  if (!process.env.DEMO_KEEP) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } }
};
const bail = setTimeout(() => { console.error("[demo] TIMEOUT"); cleanup(); process.exit(2); }, 1_200_000);
main()
  .catch((e) => console.error(`\n[demo] failed: ${e?.stack ?? e}`))
  .finally(() => { clearTimeout(bail); console.log(`\n[demo] shots in ${outDir}`); cleanup(); process.exit(0); });
