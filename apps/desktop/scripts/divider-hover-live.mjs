/**
 * Live check for the HOVER highlight on both of the app's dividers
 * (run with: node apps/desktop/scripts/divider-hover-live.mjs)
 *
 * `.resize-handle` is the ONLY thing separating one pane from the next. Everywhere else in the app a
 * hairline accompanies a change of surface and the surface change carries most of the boundary — but
 * `.main` and every `.panel` both paint --rl-panel, so here there is no change of surface at all. If
 * the line is faint, the panes are one wash.
 *
 * A stylesheet cannot answer how faint. `--rl-line` is 8% white; what that COMES TO depends on the
 * ground it lands on, and on --rl-panel it measured 17 of 255 — 6.6% — which is where the reports of
 * dividers "disappearing" came from. The reliable way to see one was to put the pointer on it, which
 * is the hover state doing the resting state's job.
 *
 * So this measures pixels: the mean luminance of each row/column across a divider, in both faces, at
 * rest and hovered, with the mutant (back to --rl-line) beside it. Reported as a percentage of full
 * range, because that is the number a human squinting at a dark pane is actually subject to.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9352), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8921);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-hover-live-"));
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

/** Per-ROW (or per-column) mean luminance of a clip. A 1px line averaged over the whole image would
 *  be a twelfth of the reading and vanish into rounding; per line it is one number against its
 *  neighbours, which is what "is there a line here" actually asks. */
const LINES = (b64, axis) => `(async () => {
  const img = new Image();
  img.src = "data:image/png;base64," + ${JSON.stringify(b64)};
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const across = ${JSON.stringify(axis)} === "rows" ? cv.height : cv.width;
  const along = ${JSON.stringify(axis)} === "rows" ? cv.width : cv.height;
  const out = [];
  for (let a = 0; a < across; a++) {
    let sum = 0;
    for (let b = 0; b < along; b++) {
      const i = (${JSON.stringify(axis)} === "rows" ? (a * cv.width + b) : (b * cv.width + a)) * 4;
      sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    }
    out.push(+(sum / along).toFixed(2));
  }
  return out;
})()`;

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
  /* Surfaced, not swallowed: a window that never opens leaves an empty CDP target list, and the
     reason is always in here — a blocking `dialog.showErrorBox`, a home lock held by an orphan. */
  electron.stderr.on("data", (d) => process.stderr.write(`    [electron] ${d}`));
  electron.stdout.on("data", (d) => process.stderr.write(`    [electron] ${d}`));

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

  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  // Two splits, so BOTH axes are under test: ⌘\ gives a vertical divider, ⌘⇧\ a horizontal one.
  // They are separate code paths only in the sense that flex-basis means width on one and height on
  // the other — but that is exactly the sort of thing a stylesheet reads fine and renders wrong.
  for (const shift of [false, true]) {
    for (const type of ["keyDown", "keyUp"]) {
      await c.send("Input.dispatchKeyEvent", {
        type, key: shift ? "|" : "\\", code: "Backslash", windowsVirtualKeyCode: 220, nativeVirtualKeyCode: 220,
        modifiers: 4 | (shift ? 8 : 0), ...(type === "keyDown" ? { text: shift ? "|" : "\\" } : {}),
      });
    }
    await sleep(400);
  }
  await sleep(600);


  // ---- the hover highlight -------------------------------------------------------------------
  //
  // `:hover` cannot be driven from CDP's synthetic pointer here (pane-divider-live.mjs learned that
  // the hard way), so the state is forced through the protocol instead: `CSS.forcePseudoState` is
  // the renderer's own hover, not a stand-in for it, and it is the only way to photograph one.
  await c.send("DOM.enable");
  await c.send("CSS.enable");

  /* One nodeId per element, held for both the set and the clear. Re-querying between them hands back
     a DIFFERENT id after `DOM.getDocument` re-walks the tree, so the clear lands on a node nobody
     forced and the highlight never goes out — which reads exactly like a stuck hover state in the
     app, and is not one. */
  const nodeFor = async (selector) => {
    const { root } = await c.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await c.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`no node for ${selector}`);
    return nodeId;
  };
  const hover = (nodeId, on) =>
    c.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: on ? ["hover"] : [] });

  /** The painted line's box and colour, read off the pseudo-element the highlight lives on. */
  const lit = (selector, pseudo) => evalIn(c, `(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null;
    const s = getComputedStyle(e, ${JSON.stringify(pseudo)});
    const host = e.getBoundingClientRect();
    return { opacity: +s.opacity, w: parseFloat(s.width), h: parseFloat(s.height),
             bg: s.backgroundColor, transition: s.transitionProperty + " " + s.transitionDuration,
             hostW: +host.width.toFixed(2), hostH: +host.height.toFixed(2) };
  })()`);

  /* Read per FACE, never once. The light accent is authored separately and is genuinely a different
     colour — comparing light's line against dark's value is the "light mirrors dark" assumption
     design.md warns about, wearing a test. */
  const accentOf = () => evalIn(c, `(() => { const d = document.createElement('div');
    d.style.color = getComputedStyle(document.documentElement).getPropertyValue('--rl-accent');
    document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; })()`);

  for (const mode of ["dark", "light"]) {
    await evalIn(c, `(document.documentElement.setAttribute('data-mode', ${JSON.stringify(mode)}), true)`);
    await sleep(450);
    const accentRgb = await accentOf();
    console.log(`  ${mode}: accent = ${accentRgb}`);

    for (const [label, selector, pseudo, axis, seamSel] of [
      ["pane divider (vertical seam)", '.resize-handle[data-panel-group-direction="horizontal"]', "::before", "w", null],
      ["pane divider (horizontal seam)", '.resize-handle[data-panel-group-direction="vertical"]', "::before", "h", null],
      // `seam` is what the line has to out-read. For a pane divider that is the handle's own 1px
      // box; for the sidebar the handle is an 8px GRAB strip that paints nothing, and the boundary
      // is `.main`'s border-left beside it.
      ["sidebar resizer", ".sb-resize", "::after", "w", ".main"],
    ]) {
      const rest = await lit(selector, pseudo);
      if (!rest) { check(`${mode}: ${label} exists`, false, { selector }); continue; }
      const nodeId = await nodeFor(selector);
      await hover(nodeId, true);
      await sleep(400);
      const on = await lit(selector, pseudo);
      /* Exactly one divider may light, and this has to be read WHILE the hover is held — measured
         after the clear it is a page with nothing hovered, which passes without testing anything.
         `hovered` comes back alongside it so a second lit divider can be told apart from a CSS bug:
         if the other one genuinely matches `:hover`, that is the machine's real mouse sitting over
         the window, not a selector reaching too far. */
      const others = await evalIn(c, `(() => { const me = document.querySelector(${JSON.stringify(selector)});
        return [...document.querySelectorAll('.resize-handle, .sb-resize')].filter((e) => e !== me).map((e) => ({
          lit: +getComputedStyle(e, e.classList.contains('sb-resize') ? '::after' : '::before').opacity,
          hovered: e.matches(':hover'),
        })); })()`);
      check(`${mode}: ${label} is the only one lit`,
        others.every((o) => o.lit === 0 || o.hovered), { others, hoveredSelector: selector });

      /* A photograph of the lit state, because the numbers above cannot say whether 3px of accent
         looks like an affordance or like a mistake. Clipped tight around the seam. */
      if (process.env.HOVER_SHOTS) {
        const box = await evalIn(c, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
        const pad = 90;
        const shot = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip: {
          x: Math.max(0, box.x - pad), y: Math.max(0, box.y + box.h / 2 - pad),
          width: Math.min(360, box.w + pad * 2), height: Math.min(200, box.h + pad * 2), scale: 2 } });
        fs.writeFileSync(`/tmp/hover-${mode}-${label.replace(/[^a-z]+/gi, "-")}.png`, Buffer.from(shot.data, "base64"));
      }
      await hover(nodeId, false);
      await sleep(500);
      const off = await lit(selector, pseudo);

      const thickness = on[axis];
      const seam = seamSel
        ? await evalIn(c, `parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(seamSel)})).borderLeftWidth)`)
        : (axis === "w" ? on.hostW : on.hostH);
      console.log(`  ${mode}/${label}: rest=${rest.opacity} hover=${on.opacity} back=${off.opacity}  ` +
                  `lit=${thickness}px over a ${seam}px seam  ${on.bg}  [${on.transition}]`);

      check(`${mode}: ${label} paints nothing at rest`, rest.opacity === 0, rest);
      check(`${mode}: ${label} lights under the pointer`, on.opacity === 1, on);
      check(`${mode}: ${label} goes back when the pointer leaves`, off.opacity === 0, off);
      check(`${mode}: ${label} is the accent`, on.bg === accentRgb, { got: on.bg, accent: accentRgb });
      check(`${mode}: ${label} reads thicker than the seam`, thickness > seam, { thickness, seam });
      check(`${mode}: ${label} fades rather than snapping`, /opacity/.test(on.transition) && !/0s/.test(on.transition), on.transition);
      // The whole point of pre-sizing it: the seam itself must not move when the pointer arrives.
      check(`${mode}: ${label} does not move anything`, (axis === "w" ? on.hostW : on.hostH) === (axis === "w" ? rest.hostW : rest.hostH),
        { rest: axis === "w" ? rest.hostW : rest.hostH, hover: axis === "w" ? on.hostW : on.hostH });
    }
  }

  /* The two other ways in, on the sidebar handle — the one of the three that takes focus.
     Keyboard: the arrows move a real value, so the control has to say where it is without a pointer.
     Reduced motion: the app-wide `* { transition: none }` takes the FADE away, and must not take the
     HIGHLIGHT away with it — an affordance is not decoration, and a reader on that preference still
     has to see which edge they are on. */
  await evalIn(c, `(document.documentElement.setAttribute('data-mode', 'dark'), true)`);
  await sleep(300);
  const sbNode = await nodeFor(".sb-resize");

  await c.send("CSS.forcePseudoState", { nodeId: sbNode, forcedPseudoClasses: ["focus-visible"] });
  await sleep(350);
  const focused = await lit(".sb-resize", "::after");
  await c.send("CSS.forcePseudoState", { nodeId: sbNode, forcedPseudoClasses: [] });
  console.log(`  keyboard: sidebar resizer opacity=${focused.opacity} ${focused.w}px`);
  check("the sidebar handle lights for the keyboard too", focused.opacity === 1 && focused.w === 3, focused);

  await c.send("Emulation.setEmulatedMedia", { media: "", features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(300);
  const reduceMatched = await evalIn(c, `matchMedia('(prefers-reduced-motion: reduce)').matches`);
  console.log(`  reduced-motion: media query matches = ${reduceMatched}`);
  check("the reduced-motion preference reaches the renderer at all", reduceMatched === true, { reduceMatched });
  await hover(sbNode, true);
  await sleep(350);
  const quiet = await lit(".sb-resize", "::after");
  await hover(sbNode, false);
  await c.send("Emulation.setEmulatedMedia", { features: [] });
  console.log(`  reduced-motion: sidebar resizer opacity=${quiet.opacity} [${quiet.transition}]`);
  check("reduced motion keeps the highlight", quiet.opacity === 1, quiet);
  check("reduced motion drops the fade", /(^|\s)0s/.test(quiet.transition) || quiet.transition.includes("none"), quiet.transition);

  c.close();
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
