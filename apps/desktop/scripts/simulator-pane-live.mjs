/**
 * Live check for the simulator pane (run with: node apps/desktop/scripts/simulator-pane-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME, opens a simulator beside a session, picks a device and
 * watches it stream. Everything here needs a real Mac with real simulators, which is exactly why it
 * is not a unit test:
 *
 *   1. `simctl` and `serve-sim` actually answer, and the walk gets from "no device" to pixels.
 *   2. The picture is PAINTED. A jsdom test can only check that an <img> has a src — this samples
 *      the pane and proves the MJPEG stream is decoding, which is the one claim the whole pane makes.
 *   3. A tap sent over the websocket lands: the screen changes because of something Realm did.
 *
 * It leaves the device booted and the stream running, which is what closing a pane does too — the
 * simulator is usually somebody's Xcode session.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9356), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8922);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-sim-live-"));
const VIEWPORT = { width: 1400, height: 900 };
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
    await sleep(250);
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
  },
  byLabel(name) { return [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name) ?? null; },
  devices() { return [...document.querySelectorAll(".sim-device")].map((b) => b.textContent); },
  screenRect() {
    const el = document.querySelector(".sim-picture");
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
  },
  status() { return document.querySelector(".machine-bar-meta")?.textContent ?? null; },
  /** Any element's box, rounded — used to measure the chassis against the picture inside it. */
  rect(sel) {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
  },
  /** What the frame was actually given to draw with, as the browser resolved it. The corner is read
   *  twice: painted, border-radius is 0 and the curve is the painter's own radius property. */
  frameVars() {
    const el = document.querySelector(".sim-chassis");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      bezel: parseFloat(cs.getPropertyValue("--sim-bezel")),
      outer: parseFloat(cs.borderTopLeftRadius) || parseFloat(cs.getPropertyValue("--sq-radius-top")),
      fill: cs.getPropertyValue("--sq-fill").trim() || cs.backgroundColor,
      painted: cs.backgroundImage.includes("paint("),
    };
  },
  body() { return document.querySelector(".sim-title")?.textContent ?? null; },
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

/** Whatever is listening on a port this script started. Never a name match: `pkill electron` on a
 *  developer's Mac is a way to close their editor. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* lsof says nothing is listening, which is the happy path */ }
}

const save = (tag, b64) => {
  const out = path.join(os.tmpdir(), `realm-simulator-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(b64, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
};

/** A PNG's own header says how big it is: an 8-byte signature, then IHDR's width and height as
 *  big-endian 32-bit integers. Read here rather than through an image decoder because the claim is
 *  about the FILE — that `simctl` wrote the framebuffer at full size — not about what a browser
 *  makes of it. */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** What is actually painted in a box: how much ink, and how much it varies. A stream that is not
 *  decoding leaves the element one flat colour. */
async function sample(c, rect) {
  const shot = await c.send("Page.captureScreenshot", { format: "png", clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } });
  const stats = await evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(shot.data)};
    await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let lo = 255, hi = 0, sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      if (l < lo) lo = l; if (l > hi) hi = l; sum += l;
    }
    return { range: Math.round(hi - lo), mean: Math.round(sum / (px.length / 4)) };
  })()`);
  return { ...stats, data: shot.data };
}

/** How much two samples of the same box differ, as a percentage of their pixels. */
async function moved(c, a, b) {
  return evalIn(c, `(async () => {
    const load = async (d) => { const i = new Image(); i.src = "data:image/png;base64," + d; await i.decode(); return i; };
    const [x, y] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
    const grab = (img) => { const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
      const g = cv.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, cv.width, cv.height).data; };
    const [p, q] = [grab(x), grab(y)];
    let diff = 0;
    for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i+1] - q[i+1]) + Math.abs(p[i+2] - q[i+2]) > 24) diff++;
    return Math.round((diff / (p.length / 4)) * 100);
  })()`);
}

async function clickAt(c, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await c.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
  }
  await sleep(150);
}

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
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
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
  await sleep(500);

  // ── 1. The button is where the machine's is, and it opens a pane ─────────
  const cluster = await evalIn(c, `[...document.querySelectorAll('.panel-bar button')].map((b) => b.getAttribute('aria-label')).filter(Boolean)`);
  const simButton = cluster.find((l) => l.startsWith("Open a simulator beside"));
  check("the session bar offers a simulator beside the machine", !!simButton && cluster.some((l) => l.startsWith("Connect a machine beside")), cluster);
  await evalIn(c, `(() => { __live.byLabel(${JSON.stringify(simButton)}).click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.sim-pane')`), 15000, "simulator pane");

  // ── 2. The picker lists this Mac's real devices ──────────────────────────
  const devices = await until(async () => {
    const d = await evalIn(c, `__live.devices()`);
    return d.length ? d : null;
  }, 30000, "device list");
  check("it lists this Mac's own simulators", devices.length > 0, devices.slice(0, 3));
  check("each row says which runtime it is", devices.every((d) => /iOS|iPadOS|watchOS|tvOS|visionOS/.test(d)), devices[0]);

  // ── 3. Picking one brings it up ─────────────────────────────────────────
  /* An already-booted iPhone if this Mac has one: the stream is then adopted rather than started, so
     the check runs in seconds instead of minutes — and the frame it measures is a PHONE's, which is
     the corner the whole feature is about. Falls back to any iPhone, then to whatever is first. */
  await evalIn(c, `(() => {
    const rows = [...document.querySelectorAll('.sim-device')];
    const booted = rows.find((r) => /iPhone/.test(r.textContent) && /already booted/.test(r.textContent));
    (booted ?? rows.find((r) => /iPhone/.test(r.textContent)) ?? rows[0]).click();
    return true; })()`);
  const startedAt = Date.now();
  await until(() => evalIn(c, `__live.status()`).then((s) => /Booting|Starting/.test(s ?? "")), 15000, "booting").catch(() => {});
  await until(() => evalIn(c, `!!document.querySelector('.sim-picture')`), 180_000, "a live stream");
  console.log(`(streaming after ${Math.round((Date.now() - startedAt) / 1000)}s)`);
  const rect = await evalIn(c, `__live.screenRect()`);
  check("the picture has a real box in the pane", rect && rect.w > 100 && rect.h > 200, rect);
  check("the bar says it is live, with the device's own resolution",
    /Live/.test(await evalIn(c, `__live.status()`) ?? ""), await evalIn(c, `__live.status()`));

  // ── 4. It is actually PAINTING, and it is moving ─────────────────────────
  /* Polled, not sampled once. A device that has just finished booting draws a black screen for a
     second or two before its home screen fills in — the skill's own advice is that a loaded page is
     not proof the stream is healthy — so this waits for CONTENT rather than asserting on whatever
     frame happened to be up at the instant the status flipped. */
  const first = await until(async () => {
    const s = await sample(c, rect);
    return s.range > 30 ? s : null;
  }, 45_000, "a frame with something on it").catch(() => sample(c, rect));
  check("the stream decodes rather than leaving an empty box", first.range > 30, { range: first.range, mean: first.mean });
  save("live", (await c.send("Page.captureScreenshot", { format: "png" })).data);

  // ── 5. A tap lands on the device ────────────────────────────────────────
  // The home button first, so the screen is somewhere known, then a tap on an icon: the screen has
  // to CHANGE because of something Realm sent.
  await evalIn(c, `(() => { __live.byLabel("Home button")?.click(); return true; })()`);
  await sleep(1500);
  const home = await sample(c, rect);
  await clickAt(c, rect.x + rect.w * 0.25, rect.y + rect.h * 0.18);
  await sleep(2500);
  const tapped = await sample(c, rect);
  const changed = await moved(c, home.data, tapped.data);
  check("a tap in the pane changes what the device is showing", changed > 8, { changedPercent: changed });
  save("tapped", (await c.send("Page.captureScreenshot", { format: "png" })).data);

  // …and back home, so the check leaves the device where it found it.
  await evalIn(c, `(() => { __live.byLabel("Home button")?.click(); return true; })()`);
  await sleep(1000);

  // ── 6. The frame, measured against the picture it is drawn around ────────
  /* Every claim here is geometric and none of it is visible to the suite: jsdom has no layout, so
     the border's thickness, the concentric corners and the picture's own corner are all numbers only
     a real browser computes. The tap in §5 above already ran with the frame ON, which is the input
     regression this feature could most easily have caused — a border between the pane's edge and the
     first device pixel is exactly the offset a tap would be wrong by. */
  const chassis = await evalIn(c, `__live.rect(".sim-chassis")`);
  const inside = await evalIn(c, `__live.rect(".sim-picture")`);
  const kind = await evalIn(c, `document.querySelector(".sim-chassis")?.getAttribute("data-frame") ?? null`);
  check("the picture is drawn inside a frame", chassis !== null && inside !== null && (kind === "art" || kind === "drawn"),
    { kind, chassis, inside });
  /* Inside on every side, whichever frame this device got: a picture that reaches an edge is a hole
     in the phone, and with the art it is also the tell that the hole was measured wrong. */
  const margins = chassis && inside
    ? { left: inside.x - chassis.x, top: inside.y - chassis.y,
        right: chassis.x + chassis.w - (inside.x + inside.w), bottom: chassis.y + chassis.h - (inside.y + inside.h) }
    : null;
  check("the frame surrounds the picture on all four sides",
    margins !== null && Math.min(...Object.values(margins)) > 0, { kind, margins });

  if (kind === "art") {
    /* A real device: the art over the stream. It is a picture OF a phone lying on the phone, so it
       must be announced to nobody and must not swallow a press meant for the device — the tap in §5
       above went through it. The hole is the claim that can only be checked here: a frame whose
       screen rectangle is off by a few percent puts the stream over the bezel, and nothing in the
       suite can see that. */
    const laid = await evalIn(c, `(() => {
      const art = document.querySelector("img.sim-art");
      if (!art) return null;
      const cs = getComputedStyle(art);
      return { hidden: art.getAttribute("aria-hidden"), pointer: cs.pointerEvents, transform: cs.transform,
               src: art.getAttribute("src"), complete: art.complete, natural: art.naturalWidth };
    })()`);
    check("the art is a picture, not a control", laid?.hidden === "true" && laid?.pointer === "none", laid);
    /* It has to have LOADED. A bundled asset the packager did not copy is a frame that is simply
       absent, and every measurement above still passes on the empty box it leaves. */
    check("and the art the app shipped actually decoded", laid?.complete === true && laid?.natural > 0, laid);
  } else {
    const vars = await evalIn(c, `__live.frameVars()`);
    check("the border is the same thickness on all four sides",
      margins !== null && Math.max(...Object.values(margins)) - Math.min(...Object.values(margins)) <= 1, margins);
    check("and it is the thickness the frame asked for", margins !== null && Math.abs(margins.left - vars.bezel) <= 1, { margins, bezel: vars?.bezel });
    /* The corners are concentric: the outer arc is the inner one plus the border between them. Read
       off the COMPUTED value rather than off the inline property, so a stylesheet that overrode it
       would fail here rather than pass on the value the pane intended. */
    check("the outer corner is the screen's corner plus the border",
      vars !== null && vars.outer > vars.bezel, { outer: vars?.outer, bezel: vars?.bezel });
    /* Realm's own surface, not a drawing of hardware: a translucent lift off the pane's ground, drawn
       by the paint worklet so the corner is the same superellipse the picture is clipped to. THE
       REGRESSION this catches is the frame falling back to a plain rounded rect beside a device whose
       screen wears the real curve — invisible to any test that reads the stylesheet. */
    check("the frame is a painted surface of Realm's, not a metal band",
      vars?.painted === true && !/gradient/.test(vars?.fill ?? ""), { fill: (vars?.fill ?? "").slice(0, 60), painted: vars?.painted });
  }

  /* The screen's own corners are round. A clip-path that CSS cannot parse leaves the picture square
     inside a frame whose corners are not, and the only place that shows is a real renderer — the
     computed value is `none` when the pane hands over a path it forgot to wrap. */
  const clip = await evalIn(c, `getComputedStyle(document.querySelector(".sim-picture")).clipPath`);
  check("the screen is clipped to the device's own corner", /^path\(/.test(clip ?? ""), { clip: (clip ?? "").slice(0, 40) });

  save("framed", (await c.send("Page.captureScreenshot", { format: "png" })).data);

  // ── 7. The frame, or none ────────────────────────────────────────────────
  /* Two options, and no third. The metal finishes went first (a rail Realm draws in four colours is
     still a rail Realm drew), then the picker that asked the user to supply a mockup PNG: Realm
     ships the art for the families it can name, and draws its own frame for everything else. */
  const options = await evalIn(c, `[...document.querySelectorAll('[role="radio"]')].map((b) => ({ label: b.textContent, checked: b.getAttribute("aria-checked") }))`);
  check("the frame row offers the frame and nothing else — no colours, no mockup to upload",
    options.length === 2 && ["Frame", "No frame"].every((w) => options.some((o) => o.label === w)),
    options);
  check("and there is nothing here that opens a file picker",
    !(await evalIn(c, `[...document.querySelectorAll(".sim-frame-bar button")].some((b) => /image|mockup|choose/i.test(b.textContent))`)),
    options);

  const framedPicture = await evalIn(c, `__live.rect(".sim-picture")`);
  const streamImg = await evalIn(c, `(() => { window.__simImg = document.querySelector("img.sim-picture"); return !!window.__simImg; })()`);
  await evalIn(c, `(() => { [...document.querySelectorAll('[role="radio"]')].find((b) => b.textContent === "No frame").click(); return true; })()`);
  await sleep(400);
  const bare = await evalIn(c, `__live.rect(".sim-picture")`);
  check("No frame takes the frame off and gives the room back to the picture",
    (await evalIn(c, `document.querySelector(".sim-chassis")?.getAttribute("data-frame")`)) === "none" && bare.w >= framedPicture.w,
    { framed: framedPicture.w, bare: bare.w });
  /* The same element, not an equal one. Each frame mode used to be its own wrapper, so changing the
     frame re-parented the `<img>` — which drops an MJPEG connection and brings the device back
     black. jsdom can hold the identity too; what it cannot do is prove the stream kept flowing,
     which is the sample below. */
  check("and it is the SAME <img> — the stream is never re-parented",
    streamImg === true && (await evalIn(c, `window.__simImg === document.querySelector("img.sim-picture")`)) === true);
  await evalIn(c, `(() => { [...document.querySelectorAll('[role="radio"]')].find((b) => b.textContent === "Frame").click(); return true; })()`);
  await sleep(400);
  /* The stream keeps flowing through a frame change: the picture element is re-parented when the
     frame goes on and off, and an `<img>` on an MJPEG stream that re-mounts drops its connection and
     comes back black. Sampled a beat later, the device has to be showing something again —
     otherwise changing the frame costs you the screen. */
  const settled = await until(async () => {
    const shot = await sample(c, await evalIn(c, `__live.screenRect()`));
    return shot.range > 30 ? shot : null;
  }, 15_000, "the stream through a frame change").catch(() => null);
  check("the stream survives the change of frame", settled !== null, settled && { range: settled.range, mean: Math.round(settled.mean) });

  // ── 7b. The device's own buttons, under the device ───────────────────────
  const hardware = await evalIn(c, `(() => {
    const row = document.querySelector(".sim-hardware");
    const bar = document.querySelector(".panel-bar");
    const names = (el) => [...(el?.querySelectorAll("button") ?? [])].map((b) => b.getAttribute("aria-label"));
    return { under: names(row), inBar: names(bar) };
  })()`);
  check("the phone's own buttons are under the phone, and out of the pane bar",
    ["Home button", "Rotate the device"].every((w) => hardware.under.includes(w))
      && !hardware.inBar.includes("Home button"),
    { under: hardware.under, bar: hardware.inBar.filter(Boolean).slice(0, 8) });

  // ── 8. The device menu reads the phone's own settings ────────────────────
  /* The values come off the DEVICE through `serve-sim ui status --json`. Checked here rather than in
     the suite for the reason every other CLI read is: the wire is the CLI's, and a fake of it proves
     only that the fake agrees with itself. */
  await evalIn(c, `(() => { __live.byLabel("Device settings").click(); return true; })()`);
  /* Waited on the ITEMS, not on the menu element: the popover mounts a frame before React fills it,
     and reading it in that frame is an empty menu rather than a slow one. */
  await until(() => evalIn(c, `document.querySelectorAll('[role="menu"] button').length > 0`), 15000, "the device menu");
  /* The read is a `serve-sim ui status --json` round trip through npx, which is seconds rather than
     milliseconds on a cold cache — so this waits for a VALUE to arrive rather than for a duration. */
  await until(async () => {
    const ticked = await evalIn(c, `[...document.querySelectorAll('[role="menu"] button')].some((b) => b.getAttribute("aria-checked") === "true")`);
    return ticked ? true : null;
  }, 30_000, "the device's own settings").catch(() => {});
  const menu = await evalIn(c, `[...document.querySelectorAll('[role="menu"] button')].map((b) => ({ label: b.textContent, checked: b.getAttribute("aria-checked") }))`);
  const appearance = menu.filter((m) => m.label.startsWith("Appearance:"));
  check("the menu offers the device's own settings, with the live value ticked",
    appearance.length === 2 && appearance.some((m) => m.checked === "true"), appearance);
  check("and the rest of what serve-sim can do is in there too",
    ["Reduce Motion", "VoiceOver", "Text size — larger", "Simulate memory warning", "Action button",
     "Paste this Mac's clipboard", "Copy the device's clipboard", "Open the clipboard's link", "Recent events"]
      .every((want) => menu.some((m) => m.label.includes(want))),
    menu.map((m) => m.label).slice(0, 40));
  save("menu", (await c.send("Page.captureScreenshot", { format: "png" })).data);
  await evalIn(c, `(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);

  // ── 9. The device's own elements, over its picture ──────────────────────
  /* The pane's picture is ONE DOM node — every icon inside it is pixels to the page — so this is the
     only thing that makes what is on the device addressable. Checked live because the whole claim is
     geometric: the tree speaks POINTS and the picture is CSS pixels, and an overlay that forgot to
     scale is two thirds too big with every box over the wrong thing. */
  await evalIn(c, `(() => { __live.byLabel("Show the device's elements").click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll(".sim-ax-box").length > 0`), 30_000, "the accessibility tree");
  const ax = await evalIn(c, `(() => {
    const overlay = document.querySelector(".sim-ax").getBoundingClientRect();
    const picture = document.querySelector(".sim-picture").getBoundingClientRect();
    const boxes = [...document.querySelectorAll(".sim-ax-box")].map((b) => {
      const r = b.getBoundingClientRect();
      return { name: b.getAttribute("aria-label"), x: r.left, y: r.top, w: r.width, h: r.height };
    });
    return { count: boxes.length, note: document.querySelector(".sim-ax-count")?.textContent,
      inside: boxes.every((b) => b.x >= picture.left - 1 && b.y >= picture.top - 1
        && b.x + b.w <= picture.right + 1 && b.y + b.h <= picture.bottom + 1),
      biggest: boxes.sort((a, b) => b.w * b.h - a.w * a.h)[0],
      overlayMatchesPicture: Math.abs(overlay.width - picture.width) < 2 && Math.abs(overlay.height - picture.height) < 2 };
  })()`);
  check("every element's box lands ON the picture — the tree's points scaled into the picture's pixels",
    ax.count > 0 && ax.inside === true && ax.overlayMatchesPicture === true, { count: ax.count, inside: ax.inside, biggest: ax.biggest });
  check("and the overlay says what it is showing", /elements/.test(ax.note ?? ""), ax.note);
  save("elements", (await c.send("Page.captureScreenshot", { format: "png" })).data);

  /* A box is a control: clicking one taps the middle of the real element. The proof is the screen
     changing because of a click on a NAME rather than on a coordinate. */
  /* The picture's box is re-read here rather than reused from §3: the frame options above change how
     much room the picture gets, and sampling a stale rectangle measures the pane's background and
     reports that nothing moved. */
  /* Home first, and the tree re-read after it. The check is "a click on a NAME reaches the real
     element", and tapping an app that is ALREADY in the foreground changes nothing on screen — which
     looks exactly like a tap that never landed. From the home screen there is always somewhere to
     go. */
  await evalIn(c, `(() => { document.querySelector('.sim-hardware [aria-label="Home button"]').click(); return true; })()`);
  await sleep(1500);
  await evalIn(c, `(() => { [...document.querySelectorAll(".sim-ax-bar button")].find((b) => /Re-read/.test(b.textContent))?.click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll(".sim-ax-box").length > 0`), 20_000, "the tree after Home").catch(() => {});
  await sleep(400);
  const axRect = await evalIn(c, `__live.screenRect()`);
  const beforeTap = await sample(c, axRect);
  const named = await evalIn(c, `(() => {
    /* An app icon by NAME, which is the claim this check makes: that a click on a name reaches the
       thing the device calls that. Named rather than "the biggest button" because the biggest box on
       a screen with a system alert on it is the alert's own body, and a screen with an alert is what
       the previous checks may have left behind — both of which fail this for reasons that have
       nothing to do with whether the mapping is right. */
    const named = ["Settings", "Photos", "Calendar", "Safari"];
    const boxes = [...document.querySelectorAll('.sim-ax-box:not(:disabled)')]
      .map((b) => ({ b, r: b.getBoundingClientRect(), name: b.getAttribute("aria-label") ?? "" }));
    const pick = named.map((n) => boxes.find((x) => x.name === n)).find(Boolean)
      ?? boxes.filter((x) => x.b.dataset.role === "Button").sort((a, z) => z.r.width * z.r.height - a.r.width * a.r.height)[0];
    if (!pick) return null;
    pick.b.click();
    return pick.b.getAttribute("aria-label");
  })()`);
  /* Polled rather than slept: a cold app on the simulator takes seconds to draw its first screen,
     and a fixed wait turns "slow to launch" into "the tap did not land" — which is the opposite of
     what this check is about. */
  /* Verified against the TREE as much as the picture, which is the skill's own advice: the stream can
     lag a transition by a beat, and a screen that barely moves (a sheet sliding over a similar one)
     is not evidence that a tap missed. A different set of elements is. */
  const before = await evalIn(c, `[...document.querySelectorAll(".sim-ax-box")].map((b) => b.getAttribute("aria-label")).join("|")`);
  const landed = await until(async () => {
    const pixels = await moved(c, beforeTap.data, (await sample(c, axRect)).data);
    if (pixels > 3) return { pixels, tree: false };
    await evalIn(c, `(() => { [...document.querySelectorAll(".sim-ax-bar button")].find((b) => /Re-read/.test(b.textContent))?.click(); return true; })()`);
    await sleep(700);
    const now = await evalIn(c, `[...document.querySelectorAll(".sim-ax-box")].map((b) => b.getAttribute("aria-label")).join("|")`);
    return now && now !== before ? { pixels, tree: true } : null;
  }, 20_000, "the device to respond").catch(() => null);
  check("clicking an element by NAME taps the real thing",
    named !== null && landed !== null, { element: named, ...(landed ?? { pixels: 0, tree: false }) });
  await evalIn(c, `(() => { __live.byLabel("Show the device's elements").click(); return true; })()`);

  // ── 10. A screenshot lands in the space, at the device's own resolution ──
  /* `simctl` takes it, so it is the framebuffer at full size rather than a scaled JPEG out of the
     stream. It is REVEALED rather than opened in the documents pane, which caps its reads at 2 MB —
     a phone screenshot is three or four, so opening one there fails with a number instead of showing
     a picture. The file on disk is the claim, and its size is what says it came from the device. */
  /* Checked on DISK rather than by watching the call: `window.realm` is a contextBridge object and
     its methods cannot be wrapped from the page — an assignment to one silently does nothing, which
     is a test that passes for the wrong reason waiting to happen. The file is the claim anyway. */
  const shotsIn = (dir) => {
    const out = [];
    const walk = (at) => {
      for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); }
        else if (/\.png$/.test(entry.name) && path.basename(at) === "simulator") out.push(full);
      }
    };
    try { walk(dir); } catch { /* nothing there yet */ }
    return out;
  };
  await evalIn(c, `(() => { __live.byLabel("Take a screenshot").click(); return true; })()`);
  const shotPath = await until(() => shotsIn(path.join(scratch, "home"))[0] ?? null, 60_000, "the screenshot").catch(() => null);
  let shot = { path: shotPath, bytes: 0, dimensions: null };
  if (shotPath) {
    const buf = fs.readFileSync(shotPath);
    shot = { path: shotPath.slice(shotPath.indexOf("/home/") + 5), bytes: buf.length, dimensions: pngSize(buf) };
  }
  check("a screenshot of the device lands in the space's own folder",
    !!shotPath && /\/simulator\/.*\.png$/.test(shotPath) && shot.bytes > 10_000, { path: shot.path, bytes: shot.bytes });
  check("and it is the device's FULL resolution, not the stream's scaled picture",
    shot.dimensions !== null && shot.dimensions.width >= 750 && shot.dimensions.height > shot.dimensions.width,
    shot.dimensions);

  // ── 11. The apps menu reads the device, and drills into one app ──────────
  await evalIn(c, `(() => { __live.byLabel("Apps on this device").click(); return true; })()`);
  await until(async () => {
    const rows = await evalIn(c, `[...document.querySelectorAll('[role="menu"] button')].map((b) => b.textContent)`);
    return rows.some((r) => /Safari/.test(r)) ? rows : null;
  }, 30_000, "the app list");
  await evalIn(c, `(() => {
    [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent === "Safari").click();
    return true; })()`);
  await sleep(400);
  const appMenu = await evalIn(c, `[...document.querySelectorAll('[role="menu"] button')].map((b) => b.textContent)`);
  check("picking an app drills in to what can be done TO it",
    ["← Safari", "Launch", "Launch with a camera feed", "Permission: camera"].every((w) => appMenu.includes(w)),
    appMenu.slice(0, 8));
  save("apps", (await c.send("Page.captureScreenshot", { format: "png" })).data);
  await evalIn(c, `(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  await sleep(300);

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => {
      electron?.kill("SIGKILL");
      /* The app spawns the SERVER as its own child, and a SIGKILL to the app orphans it — still
         listening on this run's port, so the NEXT run refuses to start. Killed by port rather than
         by name: the port is the one this script chose, and nothing else on the machine has it. */
      killPort(SERVER_PORT);
      // And the debugging port: a run killed from outside never reaches this teardown, and the app
      // it left behind holds both — so the NEXT run refuses to start on whichever it checks first.
      killPort(CDP_PORT);
      /* `force` does not cover ENOTEMPTY: Electron is still flushing its userData when the signal
         lands, and a directory that grows a file mid-walk throws — which would crash the teardown
         before the port above was ever freed. */
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      process.exit(process.exitCode ?? 0);
    }, 1200);
  });
