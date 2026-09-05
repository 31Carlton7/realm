/**
 * Live check for chip interaction in the prompter (run with: node apps/desktop/scripts/chip-hover-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME and proves the two things the jsdom tests cannot,
 * because both need glyphs that have actually been laid out:
 *
 *   1. A real click on the painted pill selects the whole token. The composer never looks at where
 *      the click was — it reads `selectionStart`, which the browser resolved from the point using the
 *      TEXTAREA's metrics, while the pill the user aimed at was drawn by the MIRROR. The two agreeing
 *      is the mirror's whole premise, and this is the only place it can be observed.
 *   2. The hover affordance does not move a glyph. The stylesheet guardrail in `styles.test.ts` can
 *      only check which properties are written; this measures the run's box with the state on and off.
 *
 * Each is paired with a mutant applied at runtime, so a passing measurement cannot be vacuous.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9341), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8907);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-chip-live-"));
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

const DRAFT = 'make @[button "Sign in"] blue';
const CHIP = { start: DRAFT.indexOf("@["), end: DRAFT.indexOf("]") + 1 };

/** The painted run's box, rounded to a tenth of a pixel — enough to catch a 1px border. */
const CHIP_RECT = `(() => {
  const r = document.querySelector('.ch-element').getBoundingClientRect();
  return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
})()`;

async function clickAt(c, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await c.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
  }
  await sleep(120);
}

async function moveTo(c, x, y) {
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await sleep(120);
}

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
    __live.setInput(input, "Live");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  await c.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await evalIn(c, `(() => { __live.setInput(document.querySelector('.composer-input'), ${JSON.stringify(DRAFT)}); return true; })()`);
  await sleep(400);

  const rest = await evalIn(c, CHIP_RECT);
  check("the chip run is laid out with a real box", rest && rest.w > 40 && rest.h > 10, rest);

  // ── 1. A real click on the pill selects the token ───────────────────────
  const mid = { x: rest.x + rest.w / 2, y: rest.y + rest.h / 2 };
  await clickAt(c, mid.x, mid.y);
  const onChip = await evalIn(c, `(() => { const t = document.querySelector('.composer-input'); return [t.selectionStart, t.selectionEnd]; })()`);
  check("a click on the painted pill selects the whole token", onChip[0] === CHIP.start && onChip[1] === CHIP.end, { got: onChip, want: [CHIP.start, CHIP.end] });

  // The mutant for the click: the same gesture aimed at the prose after the chip. If THAT selected
  // the token too, the check above would be measuring nothing.
  await clickAt(c, rest.x + rest.w + 20, mid.y);
  const offChip = await evalIn(c, `(() => { const t = document.querySelector('.composer-input'); return [t.selectionStart, t.selectionEnd]; })()`);
  check("a click in the prose beside it leaves an ordinary caret", offChip[0] === offChip[1] && offChip[0] > CHIP.end, { got: offChip });

  // What the selection buys: the browser's own Backspace, with no handler involved, takes the token.
  await clickAt(c, mid.x, mid.y);
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await sleep(250);
  const afterDelete = await evalIn(c, `document.querySelector('.composer-input').value`);
  check("one Backspace on the selected chip removes the whole token", afterDelete === "make  blue", { value: afterDelete });

  await evalIn(c, `(() => { __live.setInput(document.querySelector('.composer-input'), ${JSON.stringify(DRAFT)}); return true; })()`);
  await sleep(300);

  // ── 2. Hover lights the chip and moves nothing ─────────────────────────
  const lit = () => evalIn(c, `document.querySelector('.ch-element').hasAttribute('data-hot')`);
  /** A move to where the pointer already is may never be delivered, so every hover starts off the run. */
  const settles = async (want) => {
    for (let i = 0; i < 20; i++) { if ((await lit()) === want) return true; await sleep(100); }
    return false;
  };

  await moveTo(c, rest.x - 60, mid.y);
  const before = await evalIn(c, CHIP_RECT);
  await moveTo(c, mid.x, mid.y);
  check("the pointer lights the chip it is over", await settles(true));
  const during = await evalIn(c, CHIP_RECT);
  check("lighting it moves no glyph", JSON.stringify(before) === JSON.stringify(during), { before, during });

  await moveTo(c, rest.x + rest.w + 60, mid.y);
  check("the light goes out when the pointer leaves the run", await settles(false));

  // The mutant for the measurement: give the hover state a padding — the exact class of change the
  // stylesheet guardrail exists to forbid — and confirm the box really does move when one is added.
  await evalIn(c, `(() => {
    const s = document.createElement('style');
    s.textContent = '.ch-element[data-hot] { padding: 2px; }';
    document.head.append(s);
    return true; })()`);
  await moveTo(c, rest.x - 60, mid.y);
  await moveTo(c, mid.x, mid.y);
  await settles(true);
  const mutated = await evalIn(c, CHIP_RECT);
  check("the mutant reproduces the drift (a padded hover state moves the run)",
    JSON.stringify(before) !== JSON.stringify(mutated), { before, mutated });

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
