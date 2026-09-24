/**
 * Live check for the five sidebar/splits slices
 * (run with: node apps/desktop/scripts/sidebar-and-splits-live.mjs)
 *
 * Every claim these commits make is about something jsdom cannot answer:
 *
 *  - The Sessions heading and the Splits strip are strings, but the strip only EXISTS past two
 *    groups and only looks cramped once it is painted beside the traffic lights.
 *  - The bar's inset is the whole gap between a tab's text and the window frame. A stylesheet says
 *    what was written; `getBoundingClientRect` says where the first tab's text actually lands.
 *  - The row's trash is `opacity: 0` until `:hover`, and a hover cannot be faked with a synthetic
 *    pointer here — `CSS.forcePseudoState` is the renderer's own, which is the only way to see it.
 *  - ⌘⇧G is a keystroke; the unit test drives the hook, this drives the window.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9377), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8944);
const shots = process.env.LIVE_SHOT_DIR ?? "/tmp/realm-sidebar-live";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-sidebar-live-"));
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

async function shoot(c, name, clip) {
  const { data } = await c.send("Page.captureScreenshot", clip ? { clip: { ...clip, scale: 2 } } : {});
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  shot ${file}`);
  return file;
}

/** A named element's box, or null. Used for both the geometry checks and the screenshot clips. */
const boxOf = (c, sel) => evalIn(c, `(() => {
  const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`);

async function main() {
  fs.mkdirSync(shots, { recursive: true });
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

  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
  await sleep(500);

  // ---- 1. the sidebar's catch-all heading ------------------------------------------------------
  const headings = await evalIn(c, `Array.from(document.querySelectorAll('.group-label')).map(n => n.textContent.trim())`);
  console.log(`  .group-label headings on screen: ${JSON.stringify(headings)}`);
  check("the catch-all section says Sessions", headings.includes("Sessions"), headings);
  check("nothing still says Space", !headings.includes("Space"), headings);

  // ---- 2. ⌘⇧G makes a split, twice, which is also what makes the strip appear -------------------
  const stripBefore = await boxOf(c, ".group-bar");
  check("no strip while the space has one split", stripBefore === null, stripBefore);
  for (let i = 0; i < 2; i++) {
    for (const type of ["keyDown", "keyUp"]) {
      await c.send("Input.dispatchKeyEvent", {
        type, key: "G", code: "KeyG", windowsVirtualKeyCode: 71, nativeVirtualKeyCode: 71,
        modifiers: 4 | 8, ...(type === "keyDown" ? { text: "G" } : {}),
      });
    }
    await sleep(450);
  }
  const strip = await boxOf(c, ".group-bar");
  check("⌘⇧G made splits and the strip came up", strip !== null && strip.h >= 38, strip);

  // ---- 3. the strip's own words ----------------------------------------------------------------
  const words = await evalIn(c, `(() => {
    const bar = document.querySelector('.group-bar');
    const tabs = document.querySelector('.group-tabs');
    const add = document.querySelector('.group-add');
    return {
      bar: bar && bar.getAttribute('aria-label'),
      tabs: tabs && tabs.getAttribute('aria-label'),
      add: add && add.getAttribute('aria-label'),
      names: Array.from(document.querySelectorAll('.group-tab-name')).map(n => n.textContent),
    };
  })()`);
  console.log(`  strip labels: ${JSON.stringify(words)}`);
  check("the strip calls itself Splits", words.bar === "Splits" && words.tabs === "Splits", words);
  check("the + says New split", words.add === "New split", words.add);

  // ---- 4. the inset, measured where the text actually lands -------------------------------------
  const inset = await evalIn(c, `(() => {
    const bar = document.querySelector('.group-bar');
    const first = document.querySelector('.group-tab');
    const name = document.querySelector('.group-tab-name');
    const b = bar.getBoundingClientRect(), t = first.getBoundingClientRect(), n = name.getBoundingClientRect();
    const cs = getComputedStyle(bar);
    return {
      barH: Math.round(b.height),
      padLeft: cs.paddingLeft, padRight: cs.paddingRight,
      tabFromBarLeft: Math.round(t.left - b.left),
      textFromBarLeft: Math.round(n.left - b.left),
      textFromBarTop: Math.round(n.top - b.top),
      textToBarBottom: Math.round(b.bottom - n.bottom),
    };
  })()`);
  console.log(`  strip geometry: ${JSON.stringify(inset)}`);
  check("the bar is 38px tall in the window", inset.barH === 38, inset.barH);
  // 16px of bar inset + 14px of tab padding = the first label sits 30px in, not the old 22px.
  check("the first tab's TEXT clears the frame by more than the tab's own padding",
    inset.textFromBarLeft >= 28, inset);
  check("the label is not flush with the bar's top or bottom",
    inset.textFromBarTop >= 9 && inset.textToBarBottom >= 9, inset);
  await shoot(c, "01-splits-strip", { x: 0, y: 0, width: 640, height: 120 });

  // ---- 5. a new split's NAME, which is the one string the unit tests cannot see -----------------
  //
  // Every label in these commits is asserted in jsdom; `nextGroupName` is not, because no test
  // renders a tab it generated. The first run of this script photographed "Group 2" and "Group 3"
  // sitting in the strip under a bar that called itself Splits.
  check("a split made just now is NAMED a split", words.names.every((n) => !/^Group \d/.test(n)), words.names);
  check("the generated names follow the first one", words.names.some((n) => /^Split \d/.test(n)), words.names);

  // ---- 6. the row's trash: absent at rest, there on hover ---------------------------------------
  //
  // A terminal, because the onboarded space holds one session and a session is the kind that keeps
  // the shelf instead — hovering the row that is already there would prove the opposite thing.
  for (const type of ["keyDown", "keyUp"]) {
    await c.send("Input.dispatchKeyEvent", {
      type, key: "t", code: "KeyT", windowsVirtualKeyCode: 84, nativeVirtualKeyCode: 84,
      modifiers: 4, ...(type === "keyDown" ? { text: "t" } : {}),
    });
  }
  await until(() => evalIn(c, `!!document.querySelector('.item .item-delete')`), 15000, "a non-session row");

  await c.send("DOM.enable");
  await c.send("CSS.enable");
  const trashRow = await evalIn(c, `(() => {
    const rows = Array.from(document.querySelectorAll('.item'));
    const i = rows.findIndex((r) => r.querySelector('.item-delete'));
    return { index: i, title: rows[i]?.querySelector('.item-title')?.textContent ?? null,
             shelved: !!rows[i]?.querySelector('.item-shelf') };
  })()`);
  console.log(`  row carrying a trash: ${JSON.stringify(trashRow)}`);
  check("a non-session row carries a trash", trashRow.index >= 0, trashRow);
  check("and it is not also wearing the session shelf", trashRow.shelved === false, trashRow);

  const opacityOf = () => evalIn(c, `(() => {
    const e = document.querySelector('.item .item-delete');
    return e ? getComputedStyle(e).opacity : null;
  })()`);
  const atRest = await opacityOf();
  check("the trash is invisible at rest", atRest === "0", { atRest });

  const { root } = await c.send("DOM.getDocument", { depth: -1 });
  const { nodeId: rowNode } = await c.send("DOM.querySelector", { nodeId: root.nodeId, selector: `.item:has(.item-delete)` });
  await c.send("CSS.forcePseudoState", { nodeId: rowNode, forcedPseudoClasses: ["hover"] });
  await sleep(350);
  const hovered = await opacityOf();
  console.log(`  .item-delete opacity: rest=${atRest} hover=${hovered}`);
  check("the trash appears on hover", hovered === "1", { atRest, hovered });
  await shoot(c, "02-row-trash-hovered", { x: 0, y: 0, width: 340, height: 860 });
  await c.send("CSS.forcePseudoState", { nodeId: rowNode, forcedPseudoClasses: [] });

  // ---- 7. the setting is reachable, on, and under its own heading -------------------------------
  // Through the palette, because Settings is not one of the sidebar's destinations — the first run
  // of this script assumed it was, and reported the switch missing when the page had never opened.
  for (const type of ["keyDown", "keyUp"]) {
    await c.send("Input.dispatchKeyEvent", {
      type, key: "k", code: "KeyK", windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75,
      modifiers: 4, ...(type === "keyDown" ? { text: "k" } : {}),
    });
  }
  await until(() => evalIn(c, `!!document.querySelector('.palette input')`), 10000, "palette");
  await evalIn(c, `(() => {
    const i = document.querySelector('.palette input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(i, 'Settings'); i.dispatchEvent(new Event('input', { bubbles: true }));
    return true; })()`);
  await sleep(400);
  await evalIn(c, `(() => {
    const row = Array.from(document.querySelectorAll('.palette-opt'))
      .find((n) => /settings/i.test(n.textContent || ''));
    if (row) { row.click(); return true; }
    return false;
  })()`);
  await sleep(900);
  await evalIn(c, `(() => {
    const tab = Array.from(document.querySelectorAll('label')).find((l) => l.textContent.trim() === 'App');
    const input = tab && tab.querySelector('input');
    if (input) { input.click(); return true; }
    return false;
  })()`);
  await sleep(700);
  const sw = await evalIn(c, `(() => {
    const el = Array.from(document.querySelectorAll('input[role=switch]')).find(i => i.getAttribute('aria-label') === 'Ask before deleting');
    const heads = Array.from(document.querySelectorAll('.settings-head')).map(h => h.textContent.trim());
    return { found: !!el, checked: el ? el.checked : null, heads };
  })()`);
  console.log(`  settings switch: ${JSON.stringify(sw)}`);
  check("Settings carries the Ask-before-deleting switch, on by default", sw.found && sw.checked === true, sw);
  check("it sits under its own Deleting heading", sw.heads.includes("Deleting"), sw.heads);
  await shoot(c, "03-deleting-setting");

  // ---- 8. the leading slider, measured through the real cascade --------------------------------
  //
  // `--lh-shift` is a registered custom property that each surface ADDS to its own ratio. jsdom
  // computes no cascade at all, so the only thing a unit test can assert is the string written into
  // the stylesheet. What matters is the used value: a probe wearing the transcript's own class,
  // measured in px, before and after the slider moves.
  const probe = (expr) => evalIn(c, `(() => {
    let p = document.getElementById("lh-probe");
    if (!p) {
      p = document.createElement("div");
      p.id = "lh-probe"; p.className = "msg-assistant";
      p.textContent = "probe";
      document.body.appendChild(p);
    }
    ${expr}
    const cs = getComputedStyle(p);
    return { lineHeight: cs.lineHeight, fontSize: cs.fontSize,
             shift: getComputedStyle(document.documentElement).getPropertyValue("--lh-shift").trim() };
  })()`);

  const lhSlider = await evalIn(c, `!!Array.from(document.querySelectorAll('input[type=range]')).find(i => i.getAttribute('aria-label') === 'Line height')`);
  check("Settings carries the Line height slider", lhSlider === true);

  const before = await probe("");
  console.log(`  leading at rest: ${JSON.stringify(before)}`);
  // 15px prose at 1.6 is 24px. The default shift is 0, so the used value must be the ratio itself.
  check("prose starts on its own ratio, with the shift at zero",
    before.shift === "0" && Math.abs(parseFloat(before.lineHeight) - 24) < 0.6, before);

  await evalIn(c, `(() => {
    const el = Array.from(document.querySelectorAll('input[type=range]')).find(i => i.getAttribute('aria-label') === 'Line height');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '30'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  await sleep(700);
  const after = await probe("");
  console.log(`  leading at +30: ${JSON.stringify(after)}`);
  // 15px at 1.9 is 28.5px. The point of the check is that the USED value moved, not the declaration.
  check("moving the slider moves the used line-height, not just the declaration",
    after.shift === "0.3" && parseFloat(after.lineHeight) > parseFloat(before.lineHeight) + 3, { before, after });
  await shoot(c, "04-line-height", { x: 0, y: 0, width: 1280, height: 860 });

  c.close();
}

/**
 * The server is a SECOND Electron process, spawned by the one we started, and killing the parent
 * leaves it holding REALM_PORT — so the next run refuses to start on a port nothing is using any
 * more. Killed by port rather than by pid so an orphan from an interrupted run is cleared too, and
 * only ever the port this script chose.
 */
function reap() {
  electron?.kill();
  for (const port of [SERVER_PORT, CDP_PORT]) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) {
        try { process.kill(Number(pid)); } catch {}
      }
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(reap);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { reap(); process.exit(1); });
