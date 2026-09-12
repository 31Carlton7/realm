/**
 * Live check for the easter eggs (run with: node apps/desktop/scripts/easter-eggs-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME and proves the three things jsdom cannot, because all
 * three are about pixels rather than about the DOM:
 *
 *   1. The heavy-effort gradient PAINTS, and travels. jsdom will happily report a background-image
 *      on an element that draws nothing — `background-position: 130%` on an unanimated segment is
 *      exactly that, a gradient parked off its own box. This samples the segment, twice.
 *   2. The signature is ink rather than an empty <svg>. The paths are a 280-unit lockup inside a
 *      viewBox: wrong numbers put the glyphs off-canvas and every DOM assertion still passes.
 *   3. The konami sequence lands on a real window, through real key events, and the palette it pays
 *      out appears in a grid that was not offering it a moment earlier.
 *
 * Each is paired with the state that must NOT show it — the switch off, a light effort level — so a
 * passing sample cannot be vacuous.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9352), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8918);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-eggs-live-"));
const VIEWPORT = { width: 1280, height: 860 };
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
    const set = Object.getOwnPropertyDescriptor(proto, "value").set;
    set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  /** Settings → App, the tab the switch and the credit live on. */
  async openAppSettings() {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector(".palette-list"); i++) await new Promise((r) => setTimeout(r, 25));
    [...document.querySelectorAll(".palette-list [role=option], .palette-list button")]
      .find((b) => /settings/i.test(b.textContent))?.click();
    for (let i = 0; i < 80 && !document.querySelector(".settings-page-pane"); i++) await new Promise((r) => setTimeout(r, 25));
    [...document.querySelectorAll(".page-rail input")].find((r) => r.value === "app")?.click();
    for (let i = 0; i < 80 && !document.querySelector(".theme-grid"); i++) await new Promise((r) => setTimeout(r, 25));
    return !!document.querySelector(".theme-grid");
  },
  eggSwitch() {
    return [...document.querySelectorAll('input[role="switch"]')].find((s) => s.getAttribute("aria-label") === "Let Realm mess around") ?? null;
  },
  /** The palettes a face is offering right now, by the name printed on the card. */
  palettes(face) {
    const grid = [...document.querySelectorAll(".theme-grid")].find((g) => g.getAttribute("aria-label") === face);
    return grid ? [...grid.querySelectorAll(".theme-card-name")].map((n) => n.textContent) : null;
  },
  rect(sel) {
    const n = typeof sel === "string" ? document.querySelector(sel) : sel;
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
  },
  effortRect(label) {
    const group = [...document.querySelectorAll(".mp-seg-group")].find((g) => g.getAttribute("aria-label") === "Effort");
    const opt = group && [...group.querySelectorAll(".mp-seg-opt")].find((b) => b.textContent.trim() === label);
    return opt ? this.rect(opt) : null;
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** What a clipped region actually contains: how colourful its most saturated pixel is, and how much
 *  ink is on it. Colour is the aurora's whole signature — the segment under it is near-neutral. */
async function sample(c, rect) {
  const shot = await c.send("Page.captureScreenshot", { format: "png",
    clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } });
  const stats = await evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(shot.data)};
    await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let chroma = 0, lo = 255, hi = 0, sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
      chroma = Math.max(chroma, Math.max(r, g, b) - Math.min(r, g, b));
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      if (l < lo) lo = l; if (l > hi) hi = l;
      sum += l;
    }
    return { chroma, range: Math.round(hi - lo), mean: Math.round(sum / (px.length / 4)) };
  })()`);
  return { ...stats, data: shot.data };
}

/** How much two samples of the same box differ, as a share of their pixels. Travel, measured. */
async function moved(c, a, b) {
  return evalIn(c, `(async () => {
    const load = async (d) => { const i = new Image(); i.src = "data:image/png;base64," + d; await i.decode(); return i; };
    const [x, y] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
    const grab = (img) => { const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
      cv.getContext("2d").drawImage(img, 0, 0); return cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; };
    const [p, q] = [grab(x), grab(y)];
    let diff = 0;
    for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i+1] - q[i+1]) + Math.abs(p[i+2] - q[i+2]) > 12) diff++;
    return Math.round((diff / (p.length / 4)) * 100);
  })()`);
}

const save = (tag, b64) => {
  const out = path.join(os.tmpdir(), `realm-eggs-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(b64, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
};

async function moveTo(c, x, y) {
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await sleep(150);
}

const KONAMI = [
  ["ArrowUp", 38], ["ArrowUp", 38], ["ArrowDown", 40], ["ArrowDown", 40],
  ["ArrowLeft", 37], ["ArrowRight", 39], ["ArrowLeft", 37], ["ArrowRight", 39],
  ["b", 66], ["a", 65],
];

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
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
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  // ── 1. The tab as it arrives: switch off, credit on screen anyway ───────
  await until(() => evalIn(c, `__live.openAppSettings()`), 20000, "app settings");
  const arrival = await evalIn(c, `(() => {
    const sw = __live.eggSwitch();
    const link = document.querySelector('.settings-attribution-line a');
    return {
      switchOn: sw ? sw.checked : null,
      hasSwitch: !!sw,
      href: link?.getAttribute('href') ?? null,
      credit: document.querySelector('.settings-attribution-line')?.textContent ?? null,
      dark: __live.palettes("Dark theme"),
    };
  })()`);
  check("the App tab carries the switch, and it is off", arrival.hasSwitch && arrival.switchOn === false, { on: arrival.switchOn });
  check("the credit is on screen with the eggs off", /Carlton Aikins/.test(arrival.credit ?? "") && arrival.href === "https://x.com/31Carlton7", arrival.credit);
  check("the konami palette is not in the grid yet", arrival.dark && !arrival.dark.includes("Phosphor"), arrival.dark);

  // ── 2. The signature is ink ─────────────────────────────────────────────
  await until(() => evalIn(c, `!!document.querySelector('.settings-attribution')`), 10000, "attribution");
  // The tab is taller than the window, and a clip that runs off the bottom of the viewport samples
  // black — which reads exactly like an <svg> that drew nothing. Scroll until the box is on screen.
  const sigRect = await until(async () => {
    await evalIn(c, `(() => { document.querySelector('.settings-attribution').scrollIntoView({ block: "center", behavior: "instant" }); return true; })()`);
    const r = await evalIn(c, `__live.rect('.settings-signature')`);
    return r && r.y > 0 && r.y + r.h < VIEWPORT.height ? r : null;
  }, 10000, "signature on screen");
  check("the signature has a box on the page", sigRect && sigRect.w > 100 && sigRect.h > 10, sigRect);
  const sig = await sample(c, sigRect);
  // Filled outlines on the tab's ground: an empty viewBox would be one flat colour end to end.
  check("the signature actually paints glyphs", sig.range > 12, { range: sig.range, mean: sig.mean });
  save("signature", sig.data);

  // ── 3. Flip the switch ──────────────────────────────────────────────────
  await evalIn(c, `(() => { __live.eggSwitch().click(); return true; })()`);
  await until(() => evalIn(c, `__live.eggSwitch().checked`), 5000, "switch on");

  // ── 4. The gradient, sampled rather than asserted ────────────────────────
  await evalIn(c, `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  await evalIn(c, `(() => { document.querySelector('button[aria-label="New session"]').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('button[aria-label="Model"]')`), 20000, "model chip");
  await evalIn(c, `(() => { document.querySelector('button[aria-label="Model"]').click(); return true; })()`);
  /* Opened with a retry, and the retry earns its place: on a FRESH home the first press lands while
     the pane is still settling after the space's first session was created, and the popover is torn
     down with the layout it anchored to. Pressing again on a settled pane is what a person does, and
     it is not what this check is about. */
  /* Reopened on demand rather than once, because on a FRESH home the agent probe lands a second or
     two after the pane mounts and swaps the prompter for (and back from) the install card — which
     takes the popover with it. That is the app's own behaviour on a cold start and not what any of
     these checks are about, so every step below asks for the picker rather than assuming it. */
  const openPicker = async (why) => {
    await until(async () => {
      if (await evalIn(c, `!!document.querySelector('.model-picker')`)) return true;
      await evalIn(c, `(() => { document.querySelector('button[aria-label="Model"]')?.click(); return true; })()`);
      await sleep(500);
      return evalIn(c, `!!document.querySelector('.model-picker')`);
    }, 20000, why);
    await sleep(250);
  };
  await openPicker("the model picker");
  check("the picker opens", true);

  /** Two samples of the same box with no interaction between them, taken only if the picker stayed
   *  up for both — otherwise the "movement" measured is the popover re-entering, not the field. */
  const twice = async (rect, gapMs) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await openPicker("the picker, to measure it");
      const a = await sample(c, rect);
      await sleep(gapMs);
      if (!(await evalIn(c, `!!document.querySelector('.model-picker')`))) continue;
      return { a, b: await sample(c, rect) };
    }
    throw new Error("the picker would not stay open long enough to measure twice");
  };

  /* Measured on the SELECTED level rather than a hovered one, and that is the better test as well as
     the steadier one: the field is what a session in Max looks like for as long as it stays there,
     while a hover lasts as long as a pointer sits still. Picking closes the popover (that is what
     picking does here), so each sample reopens it. */
  const pickEffort = async (label) => {
    await openPicker(`the picker, for ${label}`);
    await evalIn(c, `(() => {
      const g = [...document.querySelectorAll('.mp-seg-group')].find((x) => x.getAttribute('aria-label') === 'Effort');
      [...g.querySelectorAll('.mp-seg-opt')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click();
      return true; })()`);
    await sleep(500);
    await openPicker(`the picker again, after ${label}`);
    await sleep(250);
    return evalIn(c, `__live.rect('.mp-seg')`);
  };

  const coldRect = await pickEffort("Low");
  check("the effort strip is laid out", !!coldRect && coldRect.w > 100, coldRect);
  const cold = await sample(c, coldRect);
  const hotRect = await pickEffort("Max");
  const hot = await twice(hotRect, 900);
  // Asserted HERE rather than at the first open: this is the moment we know the picker is up, and
  // every rule in the field hangs off this one attribute.
  check("the picker wears the one attribute every egg rule hangs off",
    await evalIn(c, `document.querySelector('.model-picker')?.hasAttribute('data-eggs') ?? false`));
  check("choosing the heaviest level lights the whole strip", hot.a.chroma > cold.chroma + 20,
    { hot: hot.a.chroma, cold: cold.chroma });
  check("a light level leaves it the plain control it always was", cold.chroma < 25, { chroma: cold.chroma });
  const travel = await moved(c, hot.a.data, hot.b.data);
  check("the field moves rather than sitting still", travel > 5, { changed: travel });
  save("aurora", (await c.send("Page.captureScreenshot", { format: "png" })).data);

  // The light face, which the palette the gradient is derived from changes completely. The theme
  // pref is System here, so the OS question is the one to emulate.
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await until(() => evalIn(c, `document.documentElement.dataset.mode === "light"`), 8000, "light face");
  await sleep(500);
  await openPicker("the picker, on the light face");
  const light = await sample(c, hotRect);
  check("the field survives the light face, where the accent it is derived from moves", light.chroma > 18, { chroma: light.chroma });
  save("aurora-light", (await c.send("Page.captureScreenshot", { format: "png" })).data);
  await c.send("Emulation.setEmulatedMedia", { features: [] });
  await until(() => evalIn(c, `document.documentElement.dataset.mode === "dark"`), 8000, "dark face again");
  await sleep(400);

  // Reduced motion: no travel, but the option must still READ as the heavy one.
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(500);
  const still = await twice(hotRect, 900);
  check("reduced motion parks the field instead of hiding it", still.a.chroma > 18, { chroma: still.a.chroma });
  const drift = await moved(c, still.a.data, still.b.data);
  check("…and nothing moves while it is parked", drift < 3, { changed: drift });
  save("aurora-reduced", (await c.send("Page.captureScreenshot", { format: "png" })).data);
  await c.send("Emulation.setEmulatedMedia", { features: [] });
  await evalIn(c, `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  await sleep(300);

  // ── 5. The sequence, on a real window ───────────────────────────────────
  await until(() => evalIn(c, `__live.openAppSettings()`), 20000, "app settings again");
  const before = await evalIn(c, `__live.palettes("Dark theme")`);
  check("the palette is still withheld before the sequence", before && !before.includes("Phosphor"), before);
  for (const [key, code] of KONAMI) {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await c.send("Input.dispatchKeyEvent", { type, key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: key.length === 1 && type === "rawKeyDown" ? key : undefined });
    }
    await sleep(40);
  }
  const after = await until(async () => {
    const p = await evalIn(c, `__live.palettes("Dark theme")`);
    return p && p.includes("Phosphor") ? p : null;
  }, 8000, "phosphor unlocked").catch(() => null);
  check("the sequence pays out the hidden palette", !!after, after);

  // ── 6. Turning the switch back off ──────────────────────────────────────
  await evalIn(c, `(() => { __live.eggSwitch().click(); return true; })()`);
  await until(async () => (await evalIn(c, `__live.eggSwitch().checked`)) === false, 5000, "switch off");
  const kept = await evalIn(c, `__live.palettes("Dark theme")`);
  check("what was earned survives the switch going off", kept && kept.includes("Phosphor"), kept);
  save("settings", (await c.send("Page.captureScreenshot", { format: "png" })).data);

  // ── 7. And what it pays out, worn ───────────────────────────────────────
  // The ground here is the seed's whole argument: the tube face cannot go below the band the
  // decorative wash is pinned under (grain-contrast.test.ts reads the lift off the ink), so this is
  // the check that a palette built to that constraint still looks like a phosphor tube.
  await evalIn(c, `(() => {
    const card = [...document.querySelectorAll('.theme-grid[aria-label="Dark theme"] .theme-card')]
      .find((l) => l.querySelector('.theme-card-name').textContent === "Phosphor");
    card.querySelector('input').click();
    return true; })()`);
  await until(() => evalIn(c, `document.documentElement.dataset.theme === "phosphor"`), 8000, "phosphor applied").catch(() => null);
  await sleep(600);
  check("the window wears the palette it just unlocked",
    await evalIn(c, `document.documentElement.dataset.theme === "phosphor"`));
  save("phosphor", (await c.send("Page.captureScreenshot", { format: "png" })).data);

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { electron?.kill("SIGKILL"); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 1200);
  });
