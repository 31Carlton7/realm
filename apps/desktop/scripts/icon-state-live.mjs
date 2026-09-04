/**
 * Live check for what an icon button does when its STATE changes
 * (run with: node apps/desktop/scripts/icon-state-live.mjs)
 *
 * Two claims, neither of which the suite can reach — styles.test.ts reads the stylesheet as text, so
 * it can say a rule exists but never that it wins, resolves, or interpolates:
 *
 *   1. `.icon-btn[aria-pressed="true"]` actually PAINTS. It is declared after `.icon-btn:hover` at
 *      the same specificity and deliberately overrides it, which is a cascade outcome rather than a
 *      declaration — and `var(--hover-2)` has to resolve to a fill the eye can tell from both the
 *      resting button and the hovered one, in whichever mode the app booted into.
 *   2. The icon swap CROSS-FADES. Both glyphs are in the DOM at once and the one that is down is
 *      scaled and blurred to nothing; the whole point is that the middle of the swap has two
 *      partly-visible glyphs rather than one being replaced by the other. Only a real animation
 *      clock has a middle. The send↔stop morph is the instance under test because it is reachable
 *      without an agent; `.icon-swap` and the copy tick are the same two rules.
 *
 * Each measurement is paired with a mutant that reproduces the bug it pins.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9343), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8909);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-icon-state-"));
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** A computed colour reduced to its channels, so two fills can be compared rather than two strings.
 *  Only ever used to compare readings the SAME engine produced for the same property — the app
 *  authors in oklch and mixes in sRGB, and a token read raw comes back in whichever space it was
 *  written in, which would make a cross-space comparison meaningless. A fully transparent colour
 *  reads as `null`: "no fill", whatever channels sit behind the zero alpha. */
const RGBA = `((s) => { const m = String(s).match(/[\\d.]+/g); if (!m) return null;
  const a = m.length > 3 ? Number(m[3]) : 1;
  return a === 0 ? null : { r: +m[0], g: +m[1], b: +m[2], a }; })`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }

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
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
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
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  /* ── 1. A pressed icon button paints, and paints past hover ───────────────────────────────── */
  // The terminal drawer's ⌘J is the reachable instance; the rich-text toolbar's Bold is the same
  // selector. Its rect is taken before the click, because toggling the drawer moves the bar.
  const TOGGLE = '.panel-bar .icon-btn[aria-pressed]';
  await until(() => evalIn(c, `!!document.querySelector(${JSON.stringify(TOGGLE)})`), 15000, "an aria-pressed icon button");
  const fills = await evalIn(c, `(async () => {
    const rgba = ${RGBA};
    const el = document.querySelector(${JSON.stringify(TOGGLE)});
    const bg = () => rgba(getComputedStyle(el).backgroundColor);
    const rest = bg();
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    el.click();
    await new Promise((r) => setTimeout(r, 250)); // past --dur-hover, so this is the settled fill
    return { pressed: el.getAttribute('aria-pressed'), rest, on: bg() };
  })()`);
  check("a pressed icon button takes a fill it does not have at rest",
    fills.pressed === "true" && fills.rest === null && fills.on !== null, fills);
  // The mutant this closes is the one the app shipped with: no rule at all, so the two are identical.
  check("MUTANT-CATCHER: on and rest are genuinely different colours, not the same one twice",
    fills.on && (fills.rest === null || fills.on.r !== fills.rest.r), fills);

  /* ── 2. The hover fill and the on fill are different pictures ─────────────────────────────── */
  // "On" sits one rung past hover on purpose: if the two resolved to the same colour, a hovered
  // button would be indistinguishable from a pressed one and the state would be unreadable exactly
  // while you point at it. Both are put through the same computed `background-color` — the app mixes
  // one in sRGB and writes the other in oklch, so comparing the raw token values would report a
  // difference no matter what they painted.
  const rungs = await evalIn(c, `(() => {
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    const resolved = (token) => {
      probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
      return getComputedStyle(probe).backgroundColor;
    };
    const hover = resolved('--rl-hover');
    probe.remove();
    return { hover, on: getComputedStyle(document.querySelector(${JSON.stringify(TOGGLE)})).backgroundColor };
  })()`);
  check("the on fill is a step past the hover fill, not the same one",
    !!rungs.hover && rungs.hover !== "rgba(0, 0, 0, 0)" && rungs.hover !== rungs.on, rungs);

  /* ── 3. The icon swap has a middle ────────────────────────────────────────────────────────── */
  // Both glyphs live in the send button at all times; `data-state` picks which is up. Driving the
  // attribute directly rather than running an agent: the claim under test is the shared rule, not
  // when the composer sets the state.
  const swap = await evalIn(c, `(async () => {
    const btn = document.querySelector('.composer-send');
    const read = () => ['.send-icon', '.stop-icon'].map((s) => {
      const cs = getComputedStyle(btn.querySelector(s));
      return { opacity: Number(cs.opacity), transform: cs.transform, filter: cs.filter };
    });
    const before = read();
    btn.setAttribute('data-state', 'stop');
    await new Promise((r) => setTimeout(r, 70)); // ~halfway through --dur-swap
    const during = read();
    await new Promise((r) => setTimeout(r, 300));
    const after = read();
    btn.setAttribute('data-state', 'send');
    return { present: btn.querySelectorAll('svg').length, before, during, after };
  })()`);
  check("both glyphs are in the button at once — the swap is a state, not a replacement",
    swap.present === 2, { svgs: swap.present });
  check("at rest exactly one glyph is up, and the other is scaled and blurred away",
    swap.before[0].opacity === 1 && swap.before[1].opacity === 0
      && swap.before[1].filter.includes("blur") && swap.before[1].transform !== "none", swap.before);
  // The whole claim: a middle exists. A hard swap would read 1/0 here and be indistinguishable from
  // a cross-fade in every jsdom assertion there is.
  check("MUTANT-CATCHER: halfway through, BOTH glyphs are partly visible — it cross-fades",
    swap.during[0].opacity < 1 && swap.during[0].opacity > 0
      && swap.during[1].opacity < 1 && swap.during[1].opacity > 0, swap.during);
  check("and it lands the other way up", swap.after[0].opacity === 0 && swap.after[1].opacity === 1, swap.after);

  /* ── 4. Reduced motion keeps both readings, and takes only the tween ──────────────────────── */
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const reduced = await evalIn(c, `(async () => {
    const btn = document.querySelector('.composer-send');
    btn.setAttribute('data-state', 'stop');
    await new Promise((r) => setTimeout(r, 40)); // well inside --dur-swap
    const cs = ['.send-icon', '.stop-icon'].map((s) => Number(getComputedStyle(btn.querySelector(s)).opacity));
    btn.setAttribute('data-state', 'send');
    return cs;
  })()`);
  check("under reduced motion the swap is instant but still a swap — the right glyph, no middle",
    reduced[0] === 0 && reduced[1] === 1, reduced);
  await c.send("Emulation.setEmulatedMedia", { features: [] });

  const bar = await c.send("Page.captureScreenshot", { format: "png", clip: { x: 280, y: 0, width: 920, height: 56, scale: 3 } });
  const out = path.join(os.tmpdir(), "realm-icon-state.png");
  fs.writeFileSync(out, Buffer.from(bar.data, "base64"));
  console.log(`SCREENSHOT pane bar, terminal toggle pressed ${out}`);

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
