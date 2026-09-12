/**
 * Live check for two things jsdom and the stylesheet tests both answer wrongly by construction
 * (run with: node apps/desktop/scripts/caret-and-system-enter-live.mjs)
 *
 *   1. **What this Chromium can do to a caret.** The prompter's caret is the TEXTAREA's own
 *      (`.composer-input`, `caret-color: var(--rl-accent)`), and a VS Code-style cursor setting has
 *      to know whether `caret-shape` / `caret-animation` exist here before a single line of it is
 *      designed: if they ship, `line|block|underline` is three declarations; if they do not, every
 *      style and every blink needs a synthetic caret positioned off the mirror layer, which is a
 *      different feature at a different size. `CSS.supports` is the only honest answer and it can
 *      only be asked of a real engine.
 *
 *   2. **Whether a system line's entrance actually runs.** `styles.test.ts` asserts the declaration
 *      TEXT (`animation: rl-fade-in …`) and `transcript-enter.test.tsx` asserts the `data-enter`
 *      mark. Both pass today while the animation is reported as not showing — which is exactly the
 *      gap those two tests leave: neither can see whether the browser accepted the shorthand, what
 *      it resolved the tokens to, or whether an animation is running on the element at the moment it
 *      is inserted. This reads `getAnimations()` on the real node, both for a synthetic insertion
 *      (the CSS rule in isolation) and for the `.msg-working` line the app mounts on its own.
 *
 * Read-only: it measures, it does not fix. Touches only a scratch dir; kills only what it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9361), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8931);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-caret-"));
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
const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);

/** What the engine will accept on a caret, and what the prompter's textarea currently resolves to. */
const CARET = `(() => {
  const ta = document.querySelector('.composer-input');
  const cs = ta ? getComputedStyle(ta) : null;
  return {
    supports: {
      caretShapeBlock: CSS.supports('caret-shape', 'block'),
      caretShapeBar: CSS.supports('caret-shape', 'bar'),
      caretShapeUnderscore: CSS.supports('caret-shape', 'underscore'),
      caretAnimationManual: CSS.supports('caret-animation', 'manual'),
      caretColor: CSS.supports('caret-color', 'red'),
    },
    textarea: cs && { tag: ta.tagName, caretColor: cs.caretColor, caretShape: cs.caretShape ?? '(unsupported)' },
  };
})()`;

/**
 * The CSS rule in isolation: insert each system line into the real column and read what the engine
 * resolved. `animationName: 'none'` would mean the shorthand was dropped; a name with a 0s duration
 * would mean a token did not resolve. Removed again so the transcript is left as it was found.
 */
const SYNTHETIC = `(() => {
  const col = document.querySelector('.transcript-col');
  if (!col) return null;
  const out = [];
  for (const cls of ['msg-run muted', 'msg-handoff', 'msg-error', 'msg-working muted']) {
    const el = document.createElement('div');
    el.className = cls;
    if (!cls.startsWith('msg-working')) el.setAttribute('data-enter', '');
    el.textContent = 'probe';
    col.appendChild(el);
    const cs = getComputedStyle(el);
    out.push({
      cls,
      name: cs.animationName, duration: cs.animationDuration, fill: cs.animationFillMode,
      easing: cs.animationTimingFunction,
      opacity: cs.opacity,
      running: el.getAnimations().map((a) => ({ n: a.animationName, s: a.playState })),
    });
    el.remove();
  }
  return out;
})()`;

/** Record every element the app itself adds to the column, with its animations AT INSERTION. */
const WATCH = `(() => {
  const col = document.querySelector('.transcript-col');
  if (!col) return false;
  window.__added = [];
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      const cs = getComputedStyle(n);
      window.__added.push({
        cls: n.className, enter: n.hasAttribute('data-enter'),
        name: cs.animationName, duration: cs.animationDuration, fill: cs.animationFillMode,
        running: n.getAnimations().map((a) => ({ n: a.animationName, s: a.playState })),
      });
    }
  }).observe(col, { childList: true });
  return true;
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
  await sleep(500);

  /* ── 1. What the engine will do to a caret ────────────────────────────────────────────────── */
  const caret = await evalIn(c, CARET);
  note("caret capabilities in this Chromium", caret.supports);
  note("the prompter's caret today", caret.textarea);
  check("the prompter's caret is the textarea's own, so only caret-color is styled today",
    caret.textarea?.tag === "TEXTAREA" && caret.supports.caretColor === true, caret.textarea);

  /* ── 2. The system-line entrance, as the engine resolved it ───────────────────────────────── */
  const synth = await evalIn(c, SYNTHETIC);
  if (!synth) { check("a transcript column exists to measure", false); }
  else {
    note("system lines, synthetically inserted", synth);
    for (const row of synth) {
      check(`${row.cls} resolves a real animation (not 'none', not 0s)`,
        row.name !== "none" && row.duration !== "0s", row);
      // The gap `styles.test.ts` cannot see: an animation that is declared, accepted, and NOT
      // running on the node is an animation nobody will ever watch.
      check(`${row.cls} is actually running at insertion`, row.running.length > 0, row.running);
    }
  }

  /* ── 3. The lines the app mounts by itself, during a real turn ─────────────────────────────── */
  check("mutation watcher installed on the column", (await evalIn(c, WATCH)) === true);
  await evalIn(c, `(() => {
    const ta = document.querySelector('.composer-input');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, 'plan something'); ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true; })()`);
  await until(() => evalIn(c, `window.__added.length > 0`), 20000, "the turn to put something in the column");
  await sleep(1200); // let the turn run so the working line and the assistant text both land
  const added = await evalIn(c, `window.__added`);
  note("what the app added to the column, with animations at insertion", added);
  const working = added.filter((a) => String(a.cls).includes("msg-working"));
  check("the working line mounted at least once during the turn", working.length > 0, working.length);
  if (working.length > 0) {
    check("MUTANT-CATCHER: the working line is animating when it mounts, not appearing fully opaque",
      working.every((w) => w.running.length > 0), working);
  }
}

main()
  .catch((e) => { console.log(`FAIL harness ${e.message}`); process.exitCode = 1; })
  .finally(async () => {
    try { electron?.kill("SIGKILL"); } catch {}
    await sleep(200);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
